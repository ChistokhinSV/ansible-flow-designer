// AFD-26: playbooks imported as is: the fictional netops repository end to end (golden file, clean
// validation, code generation, secrets) and each mapping on small playbooks.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { flowText } from '../../../src/core/flow/text';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import type { SourceIO } from '../../../src/core/import/read';
import type { ImportResult } from '../../../src/core/import/result';
import { readPlaybook } from '../../../src/core/import/source';
import { fsSource, NETOPS } from './helpers';

const schema = createSchemaValidator();
const GOLDEN = join(__dirname, '../../fixtures/import/netops-site.flow.yaml');

function memory(files: Record<string, string>): SourceIO {
  return {
    async read(path) {
      return files[path];
    },
    async list() {
      return [];
    },
  };
}

async function load(io: SourceIO, path: string, newId = createIdFactory()): Promise<ImportResult> {
  const read = await readPlaybook(io, path);
  if (!read.playbook) throw new Error(read.notes.join('\n'));
  return importPlaybook(
    read.playbook,
    { key: 'imported', newId, generatedDir: 'flows/imported/generated' },
    read.notes,
  );
}

/** The flow as text and parsed back, with its findings and the generated code. */
function check(result: ImportResult) {
  const text = flowText(result.doc);
  const doc = parse(text) as FlowDocument;
  const findings = validateFlow(doc, schema(doc)).findings;
  const generated = optionA.generate(doc, { source: 'imported.flow.yaml' });
  return { text, doc, findings, generated };
}

function node(doc: FlowDocument, key: string): FlowNode {
  for (const { node } of buildModel(doc).nodes.values()) if (node.key === key) return node;
  throw new Error(`no node ${key}`);
}

describe('the netops repository (site.yml)', () => {
  it('matches the golden import (fixed ids), validates without errors and generates', async () => {
    let i = 0;
    const seq = () => `01JDPBK${String(++i).padStart(19, '0')}`;
    const result = await load(fsSource(NETOPS), 'site.yml', seq);
    const { text, findings, generated } = check(result);
    if (process.env.AFD_UPDATE_GOLDEN) writeFileSync(GOLDEN, text);
    expect(text).toBe(readFileSync(GOLDEN, 'utf8'));
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    // Only the honest gaps: failures nothing in the playbook handles.
    expect(findings.map((f) => f.code)).toEqual(['open-fail-port', 'open-fail-port']);
    expect(generated.ok).toBe(true);
    expect(result.counts).toEqual({ steps: 21, implemented: 21, drafts: 0 });
    expect(result.notes).toEqual([
      'Imported by name only (vault, prompted or secret-looking): enable_secret, snmp_community. Give them when running.',
    ]);
  });

  it('never copies the vault value or its ciphertext', async () => {
    const { text, generated } = check(await load(fsSource(NETOPS), 'site.yml'));
    const all = [text, ...generated.files.map((f) => f.text)].join('\n');
    expect(all).not.toContain('$ANSIBLE_VAULT');
    expect(all).not.toContain('3337333763');
    expect(all).not.toContain('public-example-ro');
    expect(all).not.toContain('afd-test-vault-pass');
    const doc = parse(text) as FlowDocument;
    expect(doc.flow.inputs?.snmp_community).toEqual({ type: 'string', required: true });
    expect(doc.flow.inputs?.enable_secret).toEqual({ type: 'string', required: true });
  });

  it('maps plays, blocks, roles, handlers, files and data', async () => {
    const { doc } = check(await load(fsSource(NETOPS), 'site.yml'));
    expect(doc.flow).toMatchObject({
      name: 'site',
      imported_from: { kind: 'playbook', path: 'site.yml' },
    });
    expect(doc.flow.inputs?.devices).toMatchObject({
      type: 'host_list',
      targets: true,
      default: ['edge'],
    });
    // Two imported playbooks; the second has two plays, the Report one on its own hosts.
    expect(doc.nodes.map((n) => n.key)).toEqual(['start', 'pre-checks', 'baseline', 'done']);
    expect(node(doc, 'report').settings).toEqual({ inventory_target: 'local' });
    expect(node(doc, 'gather-facts').impl?.ref).toBe('ansible.builtin.gather_facts');
    // Block with rescue and always: subflow, rescue from failed_hosts, one always chain for both
    // paths; hosts that failed are marked first and fail after it (AFD-178).
    expect(node(doc, 'push-the-baseline').type).toBe('subflow');
    const edge = node(doc, 'edge-baseline');
    const wires = (edge.subflow?.edges ?? []).map((e) => {
      const k = (id: string) => edge.subflow?.nodes?.find((n) => n.id === id)?.key;
      return `${k(e.from.node)}.${e.from.port} -> ${k(e.to.node)}`;
    });
    expect(wires).toEqual(
      expect.arrayContaining([
        'push-the-baseline.failed_hosts -> record-the-rollback',
        'push-the-baseline.ok_hosts -> record-the-attempt',
        'record-the-rollback.ok_hosts -> record-the-attempt',
        'record-the-rollback.failed_hosts -> mark-the-failure-of-push-the-baseline',
        'mark-the-failure-of-push-the-baseline.ok_hosts -> record-the-attempt',
        'record-the-attempt.ok_hosts -> push-the-baseline-failed',
        'push-the-baseline-failed.false -> check-the-enable-secret-was-given',
      ]),
    );
    expect(wires.filter((w) => w.includes('after-failure'))).toEqual([]);
    expect(edge.subflow?.boundary?.outputs?.failed_hosts).toEqual([
      expect.objectContaining({
        port: 'true',
        reason: 'Push the baseline: failed before the always steps',
      }),
    ]);
    // Split role: a subflow bound to the role, one step per task file.
    const push = node(doc, 'apply-the-ntp-and-aaa-baseline');
    expect(push.impl).toEqual({ kind: 'role', ref: 'push_baseline' });
    expect(push.subflow?.nodes?.map((n) => n.impl?.params)).toEqual([
      { tasks_from: 'ntp' },
      { tasks_from: 'aaa' },
    ]);
    expect(node(doc, 'netops-backup').impl).toEqual({ kind: 'role', ref: 'netops_backup' });
    // Handlers after the tasks, when a notifying step changed something.
    expect(node(doc, 'save-config').impl?.keywords?.when).toBe(
      '(render_the_motd_result | default({})) is changed or (configure_the_uplinks_result | default({})) is changed',
    );
    // Local files are found from the repository root the generated plays set (AFD-176).
    expect(node(doc, 'render-the-motd').impl?.params?.src).toBe(
      '{{ afd_repo_root }}/playbooks/templates/motd.j2',
    );
    expect(node(doc, 'load-baseline-yml').impl?.params?.file).toBe(
      '{{ afd_repo_root }}/vars/baseline.yml',
    );
    // Data: registered results and loaded variables reach the steps that read them.
    expect(node(doc, 'check-the-version-is-supported').inputs).toEqual({
      version_check: { type: 'dict', from: 'read-the-software-version.version_check' },
    });
    expect(node(doc, 'read-the-ntp-status').inputs?.ntp_servers).toEqual({
      type: 'any',
      from: 'load-baseline-yml.ntp_servers',
    });
    expect(node(doc, 'push-the-baseline').outputs?.render_the_motd_result).toEqual({
      type: 'any',
      from: 'render-the-motd.render_the_motd_result',
    });
  });

  it('imports the other playbooks of the repository cleanly', async () => {
    for (const path of [
      'playbooks/prechecks.yml',
      'playbooks/baseline.yml',
      'playbooks/rollback.yml',
    ]) {
      const { findings, generated } = check(await load(fsSource(NETOPS), path));
      expect(
        findings.filter((f) => f.severity === 'error'),
        path,
      ).toEqual([]);
      expect(generated.ok, path).toBe(true);
    }
  });
});

describe('mappings', () => {
  it('a single play is the top level; facts are gathered by default', async () => {
    const r = await load(
      memory({ 'p.yml': '- name: One\n  hosts: web:db\n  tasks:\n    - ping:\n' }),
      'p.yml',
    );
    const { doc } = check(r);
    expect(doc.flow.name).toBe('One');
    expect(doc.flow.inputs?.devices?.default).toEqual(['web', 'db']);
    expect(doc.nodes.map((n) => n.key)).toEqual(['start', 'gather-facts', 'ping', 'done']);
  });

  it('AFD-210: several plays: the flow is named after the largest, not a helper play first', async () => {
    const book = [
      '- name: Resolve target devices',
      '  hosts: localhost',
      '  tasks:',
      '    - ping:',
      '- name: Health check',
      '  hosts: all',
      '  tasks:',
      '    - ping:',
      '    - block:',
      '        - ping:',
      '      rescue:',
      '        - ping:',
      '',
    ].join('\n');
    const { doc } = check(await load(memory({ 'p.yml': book }), 'p.yml'));
    expect(doc.flow.name).toBe('Health check');
  });

  it('plays settings onto each step, with a note', async () => {
    const r = await load(
      memory({
        'p.yml':
          '- name: P\n  hosts: all\n  gather_facts: no\n  serial: 2\n  any_errors_fatal: true\n  tasks:\n    - ping:\n',
      }),
      'p.yml',
    );
    expect(node(check(r).doc, 'ping').settings).toEqual({ serial: 2, max_fail_percentage: 0 });
    expect(r.notes).toContain(
      'Play "P": serial and max_fail_percentage now apply to each of its steps, not to the play as a whole (any_errors_fatal became max_fail_percentage 0).',
    );
  });

  it('turns what has no flow equivalent into drafts with notes', async () => {
    const r = await load(
      memory({
        'p.yml': `
- hosts: all
  gather_facts: false
  tasks:
    - include_tasks: "{{ os }}.yml"
    - name: Odd module
      frobnicate: {x: 1}
    - meta: end_host
    - name: Ask
      pause:
        prompt: Continue?
    - name: Tolerant
      ping:
      ignore_unreachable: true
      throttle: 2
      any_errors_fatal: true
`,
      }),
      'p.yml',
    );
    const { doc, findings } = check(r);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(node(doc, 'include-os-yml').status).toBe('draft');
    // Bound, so implemented in format 2 (AFD-50); the import counts it to check, with a note.
    expect(node(doc, 'odd-module')).toMatchObject({
      status: 'implemented',
      impl: { ref: 'frobnicate' },
    });
    expect(r.counts?.drafts).toBeGreaterThan(0);
    expect(node(doc, 'ask').type).toBe('approval');
    expect(node(doc, 'tolerant')).toMatchObject({
      ports: ['unreachable'],
      impl: { keywords: { throttle: 2 } },
    });
    // Unreachable hosts continue, as with ignore_unreachable.
    const done = node(doc, 'done');
    const into = doc.edges.filter((e) => e.to.node === done.id).map((e) => e.from.port);
    expect(into.sort()).toEqual(['ok_hosts', 'unreachable']);
    expect(r.notes).toEqual([
      'include-os-yml: {{ os }}.yml is not read in because its file name is templated: a draft step.',
      'odd-module: module frobnicate is not fully qualified and not known here; check the binding (draft).',
      // AFD-180: end_host ends those hosts; what follows it never runs for them.
      "ended-end-host: meta end_host became an end node. In the flow it ends these hosts' run.",
      'ended-end-host: the steps after an unconditional meta end_host never run; they stay in the flow without a wire into them.',
      'ask: the pause with a prompt became an approval (approved locally, asked in AWX).',
      'tolerant: any_errors_fatal have no place in a flow and were left out.',
    ]);
  });

  it('keeps per-play values of a shared variable on that play steps', async () => {
    const r = await load(
      memory({
        'p.yml':
          '- hosts: a\n  gather_facts: no\n  vars: {mode: fast}\n  tasks: [{name: A, debug: "msg={{ mode }}"}]\n- hosts: a\n  gather_facts: no\n  vars: {mode: slow}\n  tasks: [{name: B, debug: "msg={{ mode }}"}]\n',
      }),
      'p.yml',
    );
    const { doc } = check(r);
    expect(doc.flow.inputs?.mode).toEqual({ type: 'string', default: 'fast' });
    expect(node(doc, 'a').impl?.keywords).toBeUndefined();
    expect(node(doc, 'b').impl?.keywords).toEqual({ vars: { mode: 'slow' } });
  });

  it('notes roles generated plays cannot find', async () => {
    const r = await load(
      memory({
        'pb/p.yml': '- hosts: all\n  gather_facts: no\n  roles: [own]\n',
        'pb/roles/own/tasks/main.yml': '- ping:\n',
      }),
      'pb/p.yml',
    );
    expect(r.notes).toEqual([
      'Role own is in pb/roles/own, which generated plays do not search: add its folder to roles_path in ansible.cfg.',
    ]);
  });
});

describe('AFD-149: include_tasks with when', () => {
  it('becomes a decision checked once: true runs the file, false goes around it', async () => {
    const r = await load(
      memory({
        'pb/play.yml': [
          '- name: P',
          '  hosts: all',
          '  tasks:',
          '    - name: Checks',
          '      include_tasks: tasks/checks.yml',
          '      when: run_checks',
          '    - name: After',
          '      ansible.builtin.ping:',
          '',
        ].join('\n'),
        'pb/tasks/checks.yml': '- name: Inner\n  ansible.builtin.ping:\n',
      }),
      'pb/play.yml',
    );
    const { doc, findings, generated } = check(r);
    expect(findings.filter((f) => f.severity === 'error')).toEqual([]);
    expect(generated.ok).toBe(true);
    const gate = [...buildModel(doc).nodes.values()].find((e) => e.node.type === 'decision')?.node;
    expect(gate?.condition).toBe('run_checks');
    const sub = node(doc, 'checks');
    const after = node(doc, 'after');
    const wires = doc.edges.map((e) => `${e.from.node}.${e.from.port}>${e.to.node}`);
    expect(wires).toContain(`${gate?.id}.true>${sub.id}`);
    expect(wires).toContain(`${gate?.id}.false>${after.id}`);
    expect(wires).toContain(`${sub.id}.ok_hosts>${after.id}`);
    // The inner task does not repeat the condition.
    const inner = sub.subflow?.nodes?.[0];
    expect(inner?.impl?.keywords?.when).toBeUndefined();
  });
});

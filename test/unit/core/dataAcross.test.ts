// AFD-21: data across subflow boundaries, polling with until, bare expressions, pattern ends and
// local approvals. The fixture is written by key; Complete IDs fills the IDs first.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { refChoices } from '../../../src/core/catalog/draft';
import { inputVars, outputVar } from '../../../src/core/engine/binding';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { completeIds } from '../../../src/core/flow/completeIds';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample, readFixture } from './helpers';

const newId = createIdFactory();
const fixture = () => completeIds(readFixture('data-across.flow.yaml'), newId).text;
const docOf = (text: string) => parse(text) as FlowDocument;

function entry(doc: FlowDocument, path: string) {
  const model = buildModel(doc);
  const keys = path.split('/');
  let level = ROOT;
  let found: { node: FlowNode; level: string } | undefined;
  for (const key of keys) {
    const node = model.levels.get(level)?.nodes.find((n) => n.key === key);
    if (!node) throw new Error(`no ${path}`);
    found = { node, level };
    level = node.id;
  }
  return { model, ...(found as { node: FlowNode; level: string }) };
}

const codes = (doc: FlowDocument, code: string) =>
  validateFlow(doc).findings.filter((f) => f.code === code);

function run(text: string, cmd: FlowCommand) {
  return planCommand(text, cmd, { newId });
}

describe('data across subflows', () => {
  it('an inner step reads its subflow input; outputs lift the inner output of the same name', () => {
    const doc = docOf(fixture());
    // rollback/restore reads rollback.backup_file, which reads backup.backup_file (lifted by
    // name from backup/store, whose value is the registered copy result's dest).
    expect(codes(doc, 'from-unresolved')).toEqual([]);
    expect(codes(doc, 'subflow-output-unset')).toEqual([]);
    expect(codes(doc, 'binding-unknown-var')).toEqual([]);
    const backup = entry(doc, 'backup');
    expect(outputVar(backup.node, 'backup_file')).toBe('store_result.dest');
    const restore = entry(doc, 'rollback/restore');
    expect(inputVars(restore.model, restore.level, restore.node)).toEqual({
      file: '{{ store_result.dest }}',
    });
    // inventory_target reads outputs from the first arriving host, extra vars as they are.
    expect(inputVars(restore.model, restore.level, restore.node, 'hostvars[h]')).toEqual({
      file: '{{ hostvars[h].store_result.dest }}',
    });
    const wait = entry(doc, 'rollback/wait');
    expect(inputVars(wait.model, wait.level, wait.node, 'hostvars[h]')).toEqual({
      want: '{{ target_version }}',
    });
  });

  it('unresolved references say how to fix them', () => {
    const text = fixture();
    const doc = docOf(text);
    const restore = entry(doc, 'rollback/restore').node;
    const set = (from: string) => {
      (restore.inputs as Record<string, { type: 'string'; from?: string }>).file = {
        type: 'string',
        from,
      };
      return codes(doc, 'from-unresolved').map((f) => f.message);
    };
    expect(set('rollback.nope')).toEqual([
      expect.stringContaining('inside subflow rollback, rollback.<name> reads its input'),
    ]);
    expect(set('precheck.fos_platform')).toEqual([
      expect.stringContaining(
        'precheck does not lift fos_platform; its step facts has it: give precheck an output fos_platform (from: facts.fos_platform)',
      ),
    ]);
    expect(set('precheck/facts.fos_platform')).toEqual([
      expect.stringContaining('reads a step inside subflow precheck'),
    ]);
    // A subflow output nothing inside sets.
    const backup = entry(doc, 'backup').node;
    (backup.outputs as Record<string, { type: 'string' }>).missing = { type: 'string' };
    expect(codes(doc, 'subflow-output-unset').map((f) => f.message)).toEqual([
      expect.stringContaining('no inner step has an output missing'),
    ]);
  });

  it('a path to a step inside another subflow is lifted, once, in the same edit', () => {
    const text = fixture();
    const doc = docOf(text);
    const restore = entry(doc, 'rollback/restore').node;
    const r = run(text, {
      kind: 'setContractField',
      target: restore.id,
      side: 'inputs',
      name: 'platform',
      field: { type: 'string', from: 'precheck/facts.fos_platform' },
    });
    expect(r.notes).toEqual(['precheck now lifts facts.fos_platform as its output fos_platform']);
    const after = docOf(r.text);
    expect(entry(after, 'precheck').node.outputs?.fos_platform).toEqual({
      type: 'string',
      from: 'facts.fos_platform',
    });
    expect(entry(after, 'rollback/restore').node.inputs?.platform?.from).toBe(
      'precheck.fos_platform',
    );
    expect(codes(after, 'from-unresolved')).toEqual([]);
    // Lifting again reuses the output; a lifted-by-name output counts as lifted.
    const again = run(r.text, {
      kind: 'setBinding',
      id: restore.id,
      impl: restore.impl ?? null,
      inputs: { base: { type: 'dict', from: 'precheck/capture.baseline' } },
    });
    expect(again.notes).toBeUndefined();
    expect(entry(docOf(again.text), 'rollback/restore').node.inputs?.base?.from).toBe(
      'precheck.baseline',
    );
    expect(() =>
      run(text, {
        kind: 'setContractField',
        target: restore.id,
        side: 'inputs',
        name: 'x',
        field: { type: 'string', from: 'precheck/nope.x' },
      }),
    ).toThrow('subflow precheck has no step nope (steps: facts, capture)');
  });

  it('renaming a subflow input rewrites the inner reads; renaming an output does not', () => {
    const text = fixture();
    const rollback = entry(docOf(text), 'rollback').node;
    const renamed = run(text, {
      kind: 'setContractField',
      target: rollback.id,
      side: 'inputs',
      name: 'backup_file',
      rename: 'config_file',
      field: { type: 'string', from: 'backup.backup_file' },
    });
    const doc = docOf(renamed.text);
    expect(entry(doc, 'rollback/restore').node.inputs?.file?.from).toBe('rollback.config_file');
    expect(codes(doc, 'from-unresolved')).toEqual([]);
    // An output of the same name as the input: inner reads mean the input and stay.
    const withOut = run(renamed.text, {
      kind: 'setContractField',
      target: rollback.id,
      side: 'outputs',
      name: 'config_file',
      field: { type: 'string', from: 'restore.file' },
    });
    const out = run(withOut.text, {
      kind: 'setContractField',
      target: rollback.id,
      side: 'outputs',
      name: 'config_file',
      rename: 'restored',
      field: { type: 'string', from: 'restore.file' },
    });
    expect(entry(docOf(out.text), 'rollback/restore').node.inputs?.file?.from).toBe(
      'rollback.config_file',
    );
  });

  it('the @ picker offers the subflow inputs and lifts inner outputs of earlier subflows', () => {
    const doc = docOf(fixture());
    const wait = entry(doc, 'rollback/wait');
    const choices = refChoices(wait.model, wait.node);
    const byLabel = new Map(choices.map((c) => [c.label, c]));
    expect(byLabel.get('rollback.backup_file')?.detail).toBe(
      'input of subflow "Rollback" · adds a node input',
    );
    expect(byLabel.get('precheck/facts.fos_platform')?.detail).toBe(
      'output of "Normalize facts" inside "Pre-checks" · lifts it to precheck',
    );
    // Lifted already (by name): offered as precheck.baseline only.
    expect(byLabel.has('precheck.baseline')).toBe(true);
    expect(byLabel.has('precheck/capture.baseline')).toBe(false);
  });
});

describe('polling and bare expressions', () => {
  it('until and delay reach the task; until reads the result and inputs', () => {
    const doc = docOf(fixture());
    const out = optionA.generate(doc, { source: 'data-across.flow.yaml' });
    expect(out.ok).toBe(true);
    const level = out.files.find((f) => f.name.endsWith('.rollback.yml'))?.text ?? '';
    expect(level).toContain('retries: 30\n');
    expect(level).toContain('delay: 10\n');
    expect(level).toContain('until: wait_result.meta.version == want\n');
    expect(codes(doc, 'condition-unknown-var')).toEqual([]);
    const wait = entry(doc, 'rollback/wait').node;
    wait.settings = { retries: 30, until: 'result.ok and ready' };
    expect(codes(doc, 'condition-unknown-var').map((f) => f.message)).toEqual([
      '"Wait for the version" until reads "result", which is not its result (wait_result) or an input of this node',
      '"Wait for the version" until reads "ready", which is not its result (wait_result) or an input of this node',
    ]);
    wait.impl = { kind: 'role', ref: 'acme.fw.wait' };
    expect(codes(doc, 'until-not-module')).toHaveLength(1);
  });

  it('plain retries keep stopping on success', () => {
    const doc = docOf(fixture());
    const wait = entry(doc, 'rollback/wait').node;
    wait.settings = { retries: 3 };
    const level = optionA
      .generate(doc, { source: 'x' })
      .files.find((f) => f.name.endsWith('.rollback.yml'))?.text;
    expect(level).toContain('until: wait_result is succeeded');
    expect(level).not.toContain('delay:');
  });

  it('assert that, debug var and decision conditions are checked like parameters', () => {
    const doc = docOf(fixture());
    const capture = entry(doc, 'precheck/capture').node;
    capture.impl = {
      kind: 'module',
      ref: 'ansible.builtin.assert',
      params: { that: ['post.status == "up"', "item in ['a']"], fail_msg: '{{ why }}' },
    };
    expect(codes(doc, 'binding-unknown-var').map((f) => f.message)).toEqual([
      '"Capture baseline" reads "why", which is not an input of this node',
      '"Capture baseline" reads "post", which is not an input of this node',
    ]);
    const decision: FlowNode = {
      id: newId(),
      key: 'same',
      type: 'decision',
      title: 'Already there?',
      condition: 'fos_platform == target_version',
    };
    doc.nodes.push(decision);
    doc.edges.push({
      id: newId(),
      from: { node: entry(doc, 'backup').node.id, port: 'failed_hosts' },
      to: { node: decision.id, port: 'in' },
    });
    expect(codes(doc, 'condition-unknown-var').map((f) => [f.severity, f.message])).toEqual([
      [
        'warning',
        '"Already there?" condition reads "fos_platform", which is not an input of this node; precheck/facts sets it: add input fos_platform from precheck/facts.fos_platform with the AI tools or the @ picker, which lift it to precheck',
      ],
      [
        'info',
        '"Already there?" condition reads flow input "target_version" directly: add it as a node input (from: flow.target_version) to show the dependency',
      ],
    ]);
  });
});

describe('pattern ends', () => {
  const flow = () => {
    const text = completeIds(
      [
        'schema_version: 1',
        'flow:',
        '  key: p',
        '  name: P',
        '  version: 1',
        'nodes:',
        ...[
          ['start', 'start', 'Start'],
          ['approve', 'approval', 'Approve'],
          ['change', 'task', 'Change'],
          ['rolled-back', 'end', 'Rolled back', 'failed'],
          ['done', 'end', 'Done', 'success'],
        ].flatMap(([key, type, title, outcome]) => [
          `- key: ${key}`,
          `  type: ${type}`,
          `  title: ${title}`,
          ...(outcome ? [`  outcome: ${outcome}`] : []),
        ]),
        'edges:',
        ...[
          ['start', 'ok_hosts', 'approve'],
          ['approve', 'approved', 'change'],
          ['change', 'ok_hosts', 'done'],
        ].flatMap(([from, port, to]) => [
          '- from:',
          `    node: ${from}`,
          `    port: ${port}`,
          '  to:',
          `    node: ${to}`,
          '    port: in',
        ]),
        '',
      ].join('\n'),
      newId,
    ).text;
    return { text, doc: docOf(text) };
  };

  it('stop and notify-stop do not reuse an end with another key; an end can be named', () => {
    const { text, doc } = flow();
    const approve = doc.nodes.find((n) => n.key === 'approve') as FlowNode;
    const change = doc.nodes.find((n) => n.key === 'change') as FlowNode;
    const rolled = doc.nodes.find((n) => n.key === 'rolled-back') as FlowNode;
    const stop = run(text, {
      kind: 'applyPattern',
      pattern: 'stop',
      from: { node: approve.id, port: 'rejected' },
    });
    expect(stop.notes).toEqual(['stop: the hosts end at stopped (a new end node)']);
    const notify = run(stop.text, {
      kind: 'applyPattern',
      pattern: 'notify-stop',
      from: { node: change.id, port: 'failed_hosts' },
    });
    expect(notify.notes).toEqual(['notify-stop: the hosts end at stopped (an existing end node)']);
    const named = run(text, {
      kind: 'applyPattern',
      pattern: 'stop',
      from: { node: approve.id, port: 'rejected' },
      end: rolled.id,
    });
    const edges = docOf(named.text).edges;
    expect(edges.some((e) => e.from.node === approve.id && e.to.node === rolled.id)).toBe(true);
    const done = doc.nodes.find((n) => n.key === 'done') as FlowNode;
    expect(() =>
      run(text, {
        kind: 'applyPattern',
        pattern: 'stop',
        from: { node: approve.id, port: 'rejected' },
        end: done.id,
      }),
    ).toThrow('"stop" ends hosts with outcome failed, and done has outcome success');
  });
});

describe('approvals in local runs', () => {
  it('afd_approvals picks the outcome; the header says how', () => {
    const out = optionA.generate(docOf(readExample('os-upgrade.flow.yaml')), {
      source: 'os-upgrade.flow.yaml',
    });
    const whole = out.files[0]?.text ?? '';
    expect(whole).toContain(
      `# Local runs pass approvals [change-approval] automatically; choose another outcome with -e '{"afd_approvals": {"change-approval": "rejected"}}'.`,
    );
    expect(whole).toContain(
      `afd_approval: "{{ (afd_approvals | default({}))['change-approval'] | default('approved') }}"`,
    );
    expect(whole).toContain("when: afd_approval not in ['approved', 'rejected', 'timeout']");
  });
});

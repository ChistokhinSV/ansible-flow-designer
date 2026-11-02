// AFD-19: the MCP server as terminal agents start it: dist/mcp.js over stdio in a Git repository,
// driven by the MCP SDK client. Edits land on disk like a save: version bump against HEAD and
// generated/ refreshed without overwriting hand edits. `just test-mcp` builds it first.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../src/core/flow/types';

const ROOT = join(__dirname, '../..');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const FLOW = 'flows/edge-baseline/edge-baseline.flow.yaml';
let repo: string;
let client: Client;

const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });
const disk = () => readFileSync(join(repo, FLOW), 'utf8');

async function call(name: string, args: Record<string, unknown>) {
  const r = (await client.callTool({ name, arguments: args })) as {
    content: { type: string; text: string }[];
    isError?: boolean;
  };
  const text = r.content.map((c) => c.text).join('\n');
  expect(text).not.toMatch(ULID);
  return { text, isError: r.isError === true };
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'afd-mcp-'));
  mkdirSync(join(repo, 'flows/edge-baseline'), { recursive: true });
  cpSync(join(ROOT, 'examples/edge-baseline.flow.yaml'), join(repo, FLOW));
  writeFileSync(join(repo, 'README.md'), '# not a flow\n');
  // AFD-27: an Ansible repository around the flow (the import fixture).
  cpSync(join(ROOT, 'test/fixtures/import/netops'), join(repo, 'netops'), { recursive: true });
  git('init', '-q');
  git('config', 'user.name', 'Test Author');
  git('config', 'user.email', 'author@example.net');
  git('add', '.');
  git('commit', '-qm', 'flow');
  client = new Client({ name: 'afd-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [join(ROOT, 'dist/mcp.js')],
      cwd: repo,
      stderr: 'pipe',
    }),
  );
}, 30_000);

afterAll(async () => {
  await client?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('MCP server', () => {
  it('offers the flow tools with hints and instructions', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      [
        'flow_complete_ids',
        'flow_describe',
        'flow_edit',
        'flow_export',
        'flow_list',
        'flow_new',
        'flow_import',
        'flow_reference',
        'flow_validate',
        'source_outline',
      ].sort(),
    );
    expect(tools.find((t) => t.name === 'flow_describe')?.annotations?.readOnlyHint).toBe(true);
    expect(tools.find((t) => t.name === 'flow_edit')?.annotations?.readOnlyHint).toBe(false);
    expect(client.getInstructions()).toContain('flow_describe before changing it');
    expect((await call('flow_list', {})).text).toContain(`${FLOW}: "Edge baseline"`);
  });

  it('an edit is written like a save: version bumped once against HEAD, generated/ refreshed', async () => {
    const d = await call('flow_describe', {});
    const revision = /Revision: (\w+)/.exec(d.text)?.[1];
    const r = await call('flow_edit', {
      revision,
      ops: [
        { op: 'add_node', type: 'task', title: 'Check NTP', on_wire: 'precheck.ok_hosts' },
        { op: 'leave_open', at: 'check-ntp.failed_hosts', reason: 'Read-only check' },
      ],
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('Created: check-ntp');
    expect(r.text).toMatch(/generated\/: wrote edge-baseline\.yml/);
    const doc = parse(disk()) as FlowDocument;
    expect(doc.flow.version).toBe(4);
    expect(doc.nodes.some((n) => n.key === 'check-ntp')).toBe(true);
    expect(
      doc.decisions?.find((x) => x.port === 'failed_hosts' && x.reason === 'Read-only check')?.by,
    ).toBe('Test Author');
    const generated = readFileSync(
      join(repo, 'flows/edge-baseline/generated/edge-baseline.yml'),
      'utf8',
    );
    expect(generated).toContain('Check NTP');
    // A second edit before a commit keeps the version: it moves once per commit.
    await call('flow_edit', {
      ops: [{ op: 'update_node', node: 'check-ntp', intent: 'Compare peers' }],
    });
    expect((parse(disk()) as FlowDocument).flow.version).toBe(4);
  });

  it('wave 4: a format 1 file explains the upgrade, is upgraded by an op and edited in format 2', async () => {
    const refused = await call('flow_edit', {
      ops: [
        {
          op: 'accept',
          at: 'validate',
          finding: 'check:binding-unknown-var',
          reason: 'Set in group_vars',
        },
      ],
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/Upgrade Flow Format|upgrade_format/);
    const up = await call('flow_edit', { ops: [{ op: 'upgrade_format' }] });
    expect(up.isError).toBe(false);
    expect((parse(disk()) as FlowDocument).schema_version).toBe(2);
    // Format 2 edits: a pattern writes purpose, Retry sets retries on the step, a warning is accepted.
    const r = await call('flow_edit', {
      ops: [
        { op: 'apply_pattern', at: 'check-ntp.failed_hosts', pattern: 'notify-stop' },
        {
          op: 'update_node',
          node: 'push-baseline',
          settings: { become: true, become_user: 'netops' },
        },
      ],
    });
    expect(r.isError).toBe(false);
    const doc = parse(disk()) as FlowDocument;
    const notify = doc.nodes.find((n) => n.title === 'Notify on-call' || n.purpose === 'notify');
    expect(notify?.purpose).toBe('notify');
    expect(notify?.handler).toBeUndefined();
    expect(doc.nodes.find((n) => n.key === 'push-baseline')?.settings?.become_user).toBe('netops');
    const described = await call('flow_describe', {});
    expect(described.text).toContain('purpose: notify');
  });

  it('AFD-64: a note on a step and a section change no version and are described by key', async () => {
    git('add', '.');
    git('commit', '-qm', 'format 2');
    const before = parse(disk()) as FlowDocument;
    const r = await call('flow_edit', {
      ops: [
        { op: 'annotate', on: 'precheck', text: 'Read-only: **safe** to rerun' },
        {
          op: 'annotate',
          kind: 'section',
          text: 'Change',
          position: { x: 0, y: 200 },
          width: 400,
          height: 300,
        },
      ],
    });
    expect(r.isError).toBe(false);
    const doc = parse(disk()) as FlowDocument;
    expect(doc.annotations?.map((a) => a.key)).toEqual(['note-1', 'section-1']);
    expect(doc.flow.version).toBe(before.flow.version);
    const d = await call('flow_describe', {});
    expect(d.text).toContain('note-1 (note on precheck): "Read-only: safe to rerun"');
  });

  it('generated files edited by hand are kept', async () => {
    const file = join(repo, 'flows/edge-baseline/generated/edge-baseline.yml');
    writeFileSync(file, `${readFileSync(file, 'utf8')}\n# my tweak\n`);
    const r = await call('flow_edit', {
      ops: [{ op: 'update_node', node: 'check-ntp', title: 'Check NTP peers' }],
    });
    expect(r.text).toContain('kept edge-baseline.yml (edited by hand)');
    expect(readFileSync(file, 'utf8')).toContain('# my tweak');
  });

  it('refuses files outside the repository, other files and stale revisions', async () => {
    const before = disk();
    expect((await call('flow_describe', { path: '../outside.flow.yaml' })).text).toMatch(/outside/);
    expect((await call('flow_describe', { path: 'README.md' })).text).toMatch(/not a flow file/);
    const stale = await call('flow_edit', {
      path: FLOW,
      revision: 'old',
      ops: [{ op: 'delete', nodes: ['precheck'] }],
    });
    expect(stale.isError).toBe(true);
    expect(stale.text).toMatch(/^The flow changed since revision old/);
    const bad = await call('flow_edit', {
      ops: [{ op: 'connect', from: 'nowhere.ok_hosts', to: 'done' }],
    });
    expect(bad.isError).toBe(true);
    expect(disk()).toBe(before);
  });

  it('creates a flow and completes a hand-written one', async () => {
    const n = await call('flow_new', {
      path: 'flows/vlan/vlan-audit.flow.yaml',
      name: 'VLAN audit',
    });
    expect(n.text).toContain('Flow "VLAN audit" (key vlan-audit, version 1)');
    expect(readFileSync(join(repo, 'flows/vlan/generated/vlan-audit.yml'), 'utf8')).toContain(
      'GENERATED',
    );
    cpSync(
      join(ROOT, 'test/fixtures/flows/hand-written.flow.yaml'),
      join(repo, 'flows/ntp.flow.yaml'),
    );
    const c = await call('flow_complete_ids', { path: 'flows/ntp.flow.yaml' });
    expect(c.text).toContain('7 node(s), 5 wire(s), 15 reference(s)');
    expect(readFileSync(join(repo, 'flows/ntp.flow.yaml'), 'utf8')).toMatch(ULID);
  });

  it('AFD-24: positions on the MCP server: describe shows them, move stores them with ELK', async () => {
    const path = 'flows/vlan/vlan-audit.flow.yaml';
    const d = await call('flow_describe', { path, layout: true });
    expect(d.text).toMatch(/start \(start\) "Start" · auto -?\d+,-?\d+/);
    const m = await call('flow_edit', {
      path,
      ops: [{ op: 'move', nodes: { done: { below: 'start', gap: 120 } } }],
    });
    expect(m.text).toContain('Applied 1 op(s)');
    const after = await call('flow_describe', { path, layout: true });
    expect(after.text).toMatch(/start \(start\) "Start" · at -?\d+,-?\d+/);
    expect(after.text).toMatch(/done \(end\) "Done" · outcome: success · at -?\d+,-?\d+/);
  });

  it('AFD-25: flow_export writes draw.io and SVG files inside the root, nowhere else', async () => {
    const before = disk();
    const d = await call('flow_export', { path: FLOW });
    expect(d.isError).toBe(false);
    const drawio = readFileSync(join(repo, 'flows/edge-baseline/edge-baseline.drawio'), 'utf8');
    expect(drawio).toMatch(/^<mxfile [^>]*><diagram id="afd-root"/);
    expect(drawio).toContain('key="push-baseline"');
    const s = await call('flow_export', {
      path: FLOW,
      format: 'svg',
      out: 'docs/pics/edge.drawio.svg',
    });
    expect(s.text).toContain('Wrote docs/pics/edge.drawio.svg');
    expect(readFileSync(join(repo, 'docs/pics/edge.drawio.svg'), 'utf8')).toContain(
      'content="&lt;mxfile',
    );
    const outside = await call('flow_export', { path: FLOW, out: '../outside.drawio' });
    expect(outside.isError).toBe(true);
    expect(outside.text).toMatch(/outside/);
    // Exports leave the flow as it was.
    expect(disk()).toBe(before);
  });

  it('AFD-27: outlines playbooks and imports one as is; reads only Ansible files inside the root', async () => {
    const o = await call('source_outline', {
      path: 'netops/site.yml',
      flow: 'flows/site/site.flow.yaml',
    });
    expect(o.isError).toBe(false);
    expect(o.text).toContain('#6 Render the MOTD · ansible.builtin.template · notify Save config');
    expect(o.text).toContain('{{ playbook_dir }}/../../../netops/playbooks/templates/motd.j2');
    expect(o.text).not.toContain('ANSIBLE_VAULT');
    expect((await call('source_outline', { path: 'netops' })).text).toContain('top level');
    // Not YAML, or outside the root: never read.
    expect((await call('source_outline', { path: 'netops/.vault-pass' })).text).not.toContain(
      'afd-test-vault-pass',
    );
    expect((await call('source_outline', { path: '../outside.yml' })).text).toMatch(/not found/);
    const r = await call('flow_import', {
      source: 'netops/site.yml',
      path: 'flows/site/site.flow.yaml',
    });
    expect(r.isError).toBe(false);
    // The repository root has no ansible.cfg, so netops/roles is not searched: two draft role steps.
    expect(r.text).toMatch(
      /^Created flows\/site\/site.flow.yaml from netops\/site.yml: 20 step\(s\), 18 ready to run, 2 to check/,
    );
    expect(r.text).toContain('Role netops_backup was not found in the repository');
    expect(readFileSync(join(repo, 'flows/site/site.flow.yaml'), 'utf8')).not.toContain(
      'ANSIBLE_VAULT',
    );
    // A creation is a save: generated/ is written, and its plays find the template.
    const generated = readFileSync(
      join(repo, 'flows/site/generated/site.baseline.edge-baseline.push-the-baseline.yml'),
      'utf8',
    );
    expect(generated).toContain('{{ playbook_dir }}/../../../netops/playbooks/templates/motd.j2');
  });
});

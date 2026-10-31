// AFD-19: the AI tools by key. Nothing they say contains an ID, edits are all or nothing, and a
// flow written by hand is completed before the first edit.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  type FlowIO,
  revisionOf,
  runTool,
  type ToolResult,
} from '../../../../src/core/ai/handlers';
import { checkOps, OP_SPECS } from '../../../../src/core/ai/specs';
import { createIdFactory } from '../../../../src/core/flow/ids';
import { createSchemaValidator } from '../../../../src/core/flow/schema';
import type { FlowDocument } from '../../../../src/core/flow/types';
import { validateFlow } from '../../../../src/core/flow/validate';

const read = (p: string) => readFileSync(join(__dirname, '../../../..', p), 'utf8');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const EDGE = 'examples/edge-baseline.flow.yaml';
const HAND = 'flows/ntp-check.flow.yaml';
const schema = createSchemaValidator();

function memoryIO(): FlowIO & { files: Map<string, string>; writes: number } {
  const newId = createIdFactory();
  const files = new Map([
    [EDGE, read(EDGE)],
    [HAND, read('test/fixtures/flows/hand-written.flow.yaml')],
  ]);
  const io = {
    files,
    writes: 0,
    list: async () => [...files.keys()],
    read: async (p: string) => {
      const t = files.get(p);
      if (t === undefined) throw new Error(`No flow ${p}`);
      return t;
    },
    write: async (p: string, _before: string, after: string) => {
      io.writes++;
      files.set(p, after);
      return { text: after, notes: [] };
    },
    create: async (p: string, t: string) => {
      if (files.has(p)) throw new Error(`${p} exists`);
      files.set(p, t);
      return { text: t, notes: [] };
    },
    ops: () => ({ newId }),
    schema,
  };
  return io;
}

async function call(io: FlowIO, name: string, input: unknown): Promise<ToolResult> {
  const r = await runTool(io, name, input);
  expect(r.text).not.toMatch(ULID);
  return r;
}

const errorsOf = (text: string) =>
  validateFlow(parse(text) as FlowDocument, schema(parse(text))).findings.filter(
    (f) => f.severity === 'error',
  );

describe('AI tools', () => {
  it('describe and validate name nodes by key, with the revision to edit against', async () => {
    const io = memoryIO();
    const d = await call(io, 'flow_describe', { path: EDGE });
    expect(d.isError).toBeUndefined();
    expect(d.text).toContain('backup-config.ok_hosts -> push-baseline');
    expect(d.text).toContain(
      'open fail ports (wire, apply_pattern or leave_open): precheck.failed_hosts',
    );
    expect(d.text).toContain(`Revision: ${revisionOf(read(EDGE))}`);
    const v = await call(io, 'flow_validate', { path: EDGE });
    expect(v.text).toMatch(/warning open-fail-port at precheck: .* Fix: /);
    expect((await call(io, 'flow_list', {})).text).toContain('"Edge baseline" (key edge-baseline');
    expect((await call(io, 'flow_describe', {})).isError).toBe(true);
  });

  it('an edit batch: nodes created early are used later; one write; no new errors', async () => {
    const io = memoryIO();
    const before = io.files.get(EDGE) as string;
    const r = await call(io, 'flow_edit', {
      path: EDGE,
      revision: revisionOf(before),
      ops: [
        { op: 'add_node', type: 'task', title: 'Check NTP', on_wire: 'precheck.ok_hosts' },
        { op: 'apply_pattern', at: 'check-ntp.failed_hosts', pattern: 'notify-stop' },
        { op: 'leave_open', at: 'validate.failed_hosts', reason: 'Validation only reports' },
        {
          op: 'set_io',
          node: 'check-ntp',
          side: 'outputs',
          name: 'ntp_ok',
          field: { type: 'boolean' },
        },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(io.writes).toBe(1);
    expect(r.text).toContain('Created: check-ntp, notify-on-call');
    expect(r.text).toContain('solved by this edit: 1 warning(s)');
    expect(r.text).toContain('notify-stop: the hosts end at failed (an existing end node)');
    const after = io.files.get(EDGE) as string;
    expect(errorsOf(after)).toEqual([]);
    const doc = parse(after) as FlowDocument;
    const check = doc.nodes.find((n) => n.key === 'check-ntp');
    expect(check?.outputs?.ntp_ok).toEqual({ type: 'boolean' });
    expect(doc.edges.some((e) => e.from.node === check?.id && e.from.port === 'failed_hosts')).toBe(
      true,
    );
    // The describe after the edit shows the new wiring.
    const d = await call(io, 'flow_describe', { path: EDGE });
    expect(d.text).toContain('precheck.ok_hosts -> check-ntp');
    expect(d.text).toContain('check-ntp.ok_hosts -> backup-config');
  });

  it('all or nothing: a failing op writes nothing and says how to fix it', async () => {
    const io = memoryIO();
    const before = io.files.get(EDGE);
    const r = await call(io, 'flow_edit', {
      path: EDGE,
      ops: [
        { op: 'add_node', type: 'task', title: 'Check NTP', on_wire: 'precheck.ok_hosts' },
        { op: 'connect', from: 'chek-ntp.ok_hots', to: 'done' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain(
      'op 2 (connect chek-ntp.ok_hots -> done): No node "chek-ntp"; did you mean check-ntp?',
    );
    expect(r.text).toContain('Nothing was written');
    expect(io.files.get(EDGE)).toBe(before);
    expect(io.writes).toBe(0);
    const port = await call(io, 'flow_edit', {
      path: EDGE,
      ops: [{ op: 'connect', from: 'precheck.ok_hots', to: 'done' }],
    });
    expect(port.text).toContain(
      'precheck has no port "ok_hots" (task ports: in, ok_hosts, failed_hosts',
    );
    const end = await call(io, 'flow_edit', {
      path: EDGE,
      ops: [{ op: 'add_node', type: 'end', title: 'Stopped', after: 'precheck.ok_hosts' }],
    });
    expect(end.text).toContain(
      'precheck.ok_hosts is already wired to backup-config: rewire it to the new end node',
    );
    expect(io.writes).toBe(0);
  });

  it('AFD-21: paths into subflows are lifted, every solved problem counts, pattern ends can be named', async () => {
    const io = memoryIO();
    const path = 'flows/data-across.flow.yaml';
    io.files.set(path, read('test/fixtures/flows/data-across.flow.yaml'));
    // Three unknown names in one node's assert: three warnings, not one.
    const broken = await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'bind',
          node: 'rollback/restore',
          impl: {
            kind: 'module',
            ref: 'ansible.builtin.assert',
            params: { that: ['a == b', 'c'] },
          },
        },
      ],
    });
    expect(broken.text.match(/warning binding-unknown-var at rollback\/restore/g)).toHaveLength(3);
    const fixed = await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'bind',
          node: 'rollback/restore',
          impl: {
            kind: 'module',
            ref: 'fortinet.fortios.fortios_monitor',
            params: { file: '{{ file }}', platform: '{{ platform }}' },
          },
        },
        {
          op: 'set_io',
          node: 'rollback/restore',
          side: 'inputs',
          name: 'platform',
          field: { type: 'string', from: 'precheck/facts.fos_platform' },
        },
      ],
    });
    expect(fixed.isError, fixed.text).toBeUndefined();
    expect(fixed.text).toContain(
      'precheck now lifts facts.fos_platform as its output fos_platform',
    );
    expect(fixed.text).toContain('solved by this edit: 3 warning(s)');
    expect(fixed.text).not.toContain('New problems');
    const ended = await call(io, 'flow_edit', {
      path,
      ops: [
        { op: 'add_node', type: 'end', title: 'Manual recovery', key: 'manual', outcome: 'failed' },
        { op: 'apply_pattern', at: 'rollback.failed_hosts', pattern: 'notify-stop', end: 'manual' },
      ],
    });
    expect(ended.text).toContain('notify-stop: the hosts end at manual (an existing end node)');
    const d = await call(io, 'flow_describe', { path });
    expect(d.text).toContain('outputs: backup_file<-store.backup_file (same name)');
    expect(d.text).toContain('register: wait_result');
    expect(d.text).toContain('inputs: file<-rollback.backup_file, platform<-precheck.fos_platform');
  });

  it('AFD-20: a chain built with after on a new flow; on_wire inside a subflow stays there', async () => {
    const io = memoryIO();
    const path = 'flows/fortigate-upgrade/fortigate-upgrade.flow.yaml';
    const n = await call(io, 'flow_new', { path, name: 'FortiGate firmware upgrade' });
    // The file name is the key; the answer says how to add the first step.
    expect(n.text).toContain('(key fortigate-upgrade, version 1)');
    expect(n.text).toContain('add_node with after: "start.ok_hosts" puts the first step');
    const r = await call(io, 'flow_edit', {
      path,
      ops: [
        // null for an optional field counts as not given (models send it).
        {
          op: 'add_node',
          type: 'subflow',
          title: 'Pre-checks',
          after: 'start.ok_hosts',
          failed_to: null,
        },
        { op: 'add_node', type: 'task', title: 'Upgrade', after: 'pre-checks.ok_hosts' },
        { op: 'add_node', type: 'task', title: 'Post-checks', after: 'upgrade.ok_hosts' },
        { op: 'add_node', in: 'pre-checks', type: 'task', title: 'Check HA' },
        { op: 'set_entry', subflow: 'pre-checks', node: 'check-ha' },
        {
          op: 'add_node',
          type: 'task',
          title: 'Check disk',
          after: 'pre-checks/check-ha.ok_hosts',
        },
        { op: 'add_exit', from: 'pre-checks/check-disk.ok_hosts', port: 'ok_hosts' },
        {
          op: 'add_node',
          type: 'task',
          title: 'Check license',
          on_wire: 'pre-checks/check-ha.ok_hosts',
        },
      ],
    });
    expect(r.isError, r.text).toBeUndefined();
    expect(r.text).toContain(
      'pre-checks went on the wire start.ok_hosts -> done (the port was wired already)',
    );
    expect(r.text).toContain(
      'Created: pre-checks, pre-checks/check-ha, pre-checks/check-disk, pre-checks/check-license, upgrade, post-checks',
    );
    const d = await call(io, 'flow_describe', { path });
    expect(d.text).toContain('start.ok_hosts -> pre-checks');
    expect(d.text).toContain('pre-checks.ok_hosts -> upgrade');
    expect(d.text).toContain('upgrade.ok_hosts -> post-checks');
    expect(d.text).toContain('post-checks.ok_hosts -> done');
    const inner = await call(io, 'flow_describe', { path, level: 'pre-checks' });
    expect(inner.text).toContain('pre-checks/check-ha.ok_hosts -> pre-checks/check-license');
    expect(inner.text).toContain('pre-checks/check-license.ok_hosts -> pre-checks/check-disk');
    const both = await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'add_node',
          type: 'task',
          title: 'Y',
          after: 'upgrade.ok_hosts',
          on_wire: 'start.ok_hosts',
        },
      ],
    });
    expect(both.text).toContain('pass after or on_wire, not both');
  });

  it('bad op fields, tested and stale revisions are refused before anything runs', async () => {
    const io = memoryIO();
    const shape = await call(io, 'flow_edit', {
      path: EDGE,
      ops: [{ op: 'conect' }, { op: 'connect', fro: 'a.ok_hosts' }],
    });
    expect(shape.text.split('\n')).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^op 1: unknown op "conect"; ops: add_node, /),
        'op 2 (connect): missing field "from"',
        'op 2 (connect): unknown field "fro"',
      ]),
    );
    const tested = await call(io, 'flow_edit', {
      path: EDGE,
      ops: [{ op: 'update_node', node: 'precheck', status: 'tested' }],
    });
    expect(tested.text).toContain('status: must be one of "draft", "specified", "implemented"');
    const stale = await call(io, 'flow_edit', {
      path: EDGE,
      revision: 'old',
      ops: [{ op: 'delete', nodes: ['precheck'] }],
    });
    expect(stale.text).toMatch(/^The flow changed since revision old; nothing was written/);
    expect(stale.text).toContain('backup-config.ok_hosts -> push-baseline');
    expect(io.writes).toBe(0);
    const dry = await call(io, 'flow_edit', {
      path: EDGE,
      dry_run: true,
      ops: [{ op: 'update_node', node: 'precheck', title: 'Pre-flight checks' }],
    });
    expect(dry.text).toContain('nothing was written');
    expect(dry.text).toContain('-   title: Pre-checks\n+   title: Pre-flight checks');
    expect(io.writes).toBe(0);
  });

  it('a flow written by hand: described by key, completed on the first edit, subflow paths work', async () => {
    const io = memoryIO();
    const d = await call(io, 'flow_describe', { path: HAND });
    expect(d.text).toContain('Subflow fix-ntp (inner level)');
    expect(d.text).toContain('entry: fix-ntp/push');
    expect(d.text).toContain('exit ok_hosts <- fix-ntp/verify.ok_hosts');
    expect(d.text).toMatch(/Problems: \d+ error/);
    const r = await call(io, 'flow_edit', {
      path: HAND,
      ops: [
        { op: 'add_node', in: 'fix-ntp', type: 'task', title: 'Backup', key: 'backup' },
        { op: 'set_entry', subflow: 'fix-ntp', node: 'backup' },
        { op: 'connect', from: 'fix-ntp/backup.ok_hosts', to: 'push' },
        { op: 'leave_open', at: 'fix-ntp/backup.failed_hosts', reason: 'No change made yet' },
      ],
    });
    expect(r.isError).toBeUndefined();
    expect(r.text).toContain('Completed IDs: 7 node(s), 5 wire(s), 15 reference(s) by key');
    expect(r.text).toContain('Created: fix-ntp/backup');
    const after = io.files.get(HAND) as string;
    expect(after.startsWith('# Written by hand')).toBe(true);
    expect(errorsOf(after)).toEqual([]);
    expect((await call(io, 'flow_describe', { path: HAND, level: 'fix-ntp' })).text).toContain(
      'entry: fix-ntp/backup',
    );
  });

  it('complete IDs and new flows', async () => {
    const io = memoryIO();
    const c = await call(io, 'flow_complete_ids', { path: HAND });
    expect(c.text).toContain('7 node(s), 5 wire(s), 15 reference(s)');
    expect((await call(io, 'flow_complete_ids', { path: HAND })).text).toMatch(
      /^Nothing to complete/,
    );
    const n = await call(io, 'flow_new', {
      path: 'flows/vlan/vlan-audit.flow.yaml',
      name: 'VLAN audit',
      goal: 'Report VLANs that differ from the standard',
    });
    expect(n.text).toContain('Flow "VLAN audit" (key vlan-audit, version 1)');
    expect(n.text).toContain('Goal: Report VLANs that differ from the standard');
    expect(errorsOf(io.files.get('flows/vlan/vlan-audit.flow.yaml') as string)).toEqual([]);
    expect((await call(io, 'flow_new', { path: 'flows/x.yaml', name: 'X' })).isError).toBe(true);
  });

  it('every op example is a valid op', () => {
    expect(checkOps(OP_SPECS.map((s) => s.example))).toEqual([]);
  });
});

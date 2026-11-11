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
import { optionA } from '../../../../src/core/engine/optionA';
import { flowLayoutProblems } from '../../../../src/core/export/layoutCheck';
import { scenesOf } from '../../../../src/core/export/scene';
import { createIdFactory } from '../../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../../src/core/flow/model';
import { openFailPorts } from '../../../../src/core/flow/openPorts';
import { createSchemaValidator } from '../../../../src/core/flow/schema';
import type { FlowDocument } from '../../../../src/core/flow/types';
import { validateFlow } from '../../../../src/core/flow/validate';
import { layoutLevel, shownPositions } from '../../../../src/node/autoLayout';
import { fsSource, NETOPS } from '../helpers';

const read = (p: string) => readFileSync(join(__dirname, '../../../..', p), 'utf8');
const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;
const EDGE = 'examples/edge-baseline.flow.yaml';
const HAND = 'flows/ntp-check.flow.yaml';
const schema = createSchemaValidator();

function memoryIO(): FlowIO & {
  files: Map<string, string>;
  writes: number;
  exports: Map<string, string>;
} {
  const newId = createIdFactory();
  const files = new Map([
    [EDGE, read(EDGE)],
    [HAND, read('test/fixtures/flows/hand-written.flow.yaml')],
  ]);
  const exports = new Map<string, string>();
  const io = {
    files,
    writes: 0,
    exports,
    writeExport: async (p: string, t: string) => {
      if (!/[.](drawio|svg)$/.test(p)) throw new Error(`${p}: exports are .drawio or .svg files`);
      exports.set(p, t);
      return p;
    },
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
    ops: () => ({ newId, layout: layoutLevel, positions: shownPositions }),
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
    // AFD-209: source_outline's name for the flow works here too.
    const named = await call(io, 'flow_describe', { flow: EDGE });
    expect(named.isError).toBeUndefined();
    expect(named.text).toContain('backup-config.ok_hosts -> push-baseline');
    expect((await call(io, 'flow_validate', { flow: EDGE })).text).toContain('open-fail-port');
  });

  it('AFD-219: an edit that grows a level past 8 steps hints at a subflow; other edits do not', async () => {
    const io = memoryIO();
    const edit = async (ops: unknown[]) => {
      const r = await call(io, 'flow_edit', {
        path: EDGE,
        revision: revisionOf(io.files.get(EDGE) as string),
        ops,
      });
      expect(r.isError, r.text).toBeUndefined();
      return r.text;
    };
    // Five steps: one more is no hint yet.
    expect(
      await edit([
        { op: 'add_node', type: 'task', title: 'Report A', on_wire: 'validate.ok_hosts' },
      ]),
    ).not.toContain('Hint:');
    const grown = await edit([
      { op: 'add_node', type: 'task', title: 'Report B', after: 'report-a.ok_hosts' },
      { op: 'add_node', type: 'task', title: 'Report C', after: 'report-b.ok_hosts' },
      { op: 'add_node', type: 'task', title: 'Report D', after: 'report-c.ok_hosts' },
    ]);
    expect(grown).toContain('Hint: the top level has 9 steps (precheck, backup-config,');
    expect(grown).toContain('report-a, report-b, report-c, report-d');
    expect(grown).toContain('extract_subflow');
    // Not growing the level: no hint, even though it is long.
    expect(
      await edit([{ op: 'update_node', node: 'report-d', title: 'Report done' }]),
    ).not.toContain('Hint:');
    expect(
      await edit([
        {
          op: 'extract_subflow',
          nodes: ['report-a', 'report-b', 'report-c', 'report-d'],
          title: 'Report',
        },
      ]),
    ).not.toContain('Hint:');
  });

  it('AFD-211: a step that ignores errors gets info, not a warning; one accept takes several ports', async () => {
    const io = memoryIO();
    const r = await call(io, 'flow_edit', {
      path: EDGE,
      revision: revisionOf(io.files.get(EDGE) as string),
      ops: [
        { op: 'add_node', type: 'task', title: 'Show facts', on_wire: 'precheck.ok_hosts' },
        {
          op: 'bind',
          node: 'show-facts',
          impl: {
            kind: 'module',
            ref: 'ansible.builtin.debug',
            params: { msg: 'hello' },
            keywords: { ignore_errors: true },
          },
        },
      ],
    });
    expect(r.isError, r.text).toBeUndefined();
    const v = (await call(io, 'flow_validate', { path: EDGE })).text;
    expect(v).toMatch(/info open-fail-port at show-facts: .*ignores errors/);
    expect(v).toMatch(/warning open-fail-port at precheck/);
    const accepted = await call(io, 'flow_edit', {
      path: EDGE,
      revision: revisionOf(io.files.get(EDGE) as string),
      ops: [
        {
          op: 'accept',
          at: ['precheck.failed_hosts', 'show-facts.failed_hosts'],
          reason: 'Read-only steps; the report lists these hosts',
        },
      ],
    });
    expect(accepted.isError, accepted.text).toBeUndefined();
    const after = (await call(io, 'flow_validate', { path: EDGE })).text;
    expect(after).not.toContain('open-fail-port at precheck');
    expect(after).not.toContain('open-fail-port at show-facts');
    const doc = parse(io.files.get(EDGE) as string) as FlowDocument;
    expect(JSON.stringify(doc.decisions)).toContain(
      'Read-only steps; the report lists these hosts',
    );
  });

  it('set_io writes a flow input with its description (AFD-100)', async () => {
    const io = memoryIO();
    const r = await call(io, 'flow_edit', {
      path: EDGE,
      revision: revisionOf(io.files.get(EDGE) as string),
      ops: [
        {
          op: 'set_io',
          node: 'flow',
          side: 'inputs',
          name: 'change_ticket',
          field: { type: 'string', required: true, description: 'Approved change ticket' },
        },
      ],
    });
    expect(r.isError, r.text).toBeUndefined();
    const doc = parse(io.files.get(EDGE) as string) as FlowDocument;
    expect(doc.flow.inputs?.change_ticket?.description).toBe('Approved change ticket');
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

  it('AFD-24: agents place nodes on create and later; the rest freezes; overlaps are reported', async () => {
    const io = memoryIO();
    const path = 'flows/layout-check/layout-check.flow.yaml';
    await call(io, 'flow_new', { path, name: 'Layout check' });
    const doc = () => parse(io.files.get(path) as string) as FlowDocument;
    const at = (key: string) => {
      const d = doc();
      const id = d.nodes.find((n) => n.key === key)?.id as string;
      return d.layout?.[id];
    };
    // No position: placed by the canvas, nothing stored.
    await call(io, 'flow_edit', {
      path,
      ops: [{ op: 'add_node', type: 'task', title: 'Check', after: 'start.ok_hosts' }],
    });
    expect(doc().layout).toBeUndefined();
    const before = await call(io, 'flow_describe', { path, layout: true });
    expect(before.text).toContain('Layout: Positions are per level');
    expect(before.text).toMatch(/check \(task, draft\) "Check" · auto -?\d+,-?\d+/);
    // A position on create stores it, and the shown positions of the others (nothing moves).
    const shown = await shownPositions(buildModel(doc()));
    const placed = await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'add_node',
          type: 'task',
          title: 'Report',
          after: 'check.failed_hosts',
          position: { right_of: 'check' },
        },
      ],
    });
    expect(placed.isError, placed.text).toBeUndefined();
    const check = shown.auto[doc().nodes.find((n) => n.key === 'check')?.id as string];
    expect(at('check')).toEqual(check);
    expect(at('report')).toEqual({ x: (check?.x ?? 0) + 208 + 48, y: check?.y });
    expect(Object.keys(doc().layout ?? {})).toHaveLength(4);
    // Relative places step aside; an absolute one is taken as given and reported when it overlaps.
    const moved = await call(io, 'flow_edit', {
      path,
      ops: [
        { op: 'add_node', type: 'task', title: 'Notify', position: { right_of: 'check' } },
        { op: 'move', nodes: { done: { x: at('check')?.x ?? 0, y: at('check')?.y ?? 0 } } },
      ],
    });
    expect(at('notify')?.y).toBeGreaterThan(at('report')?.y ?? 0);
    expect(moved.text).toContain('done at ');
    expect(moved.text).toMatch(/done at -?\d+,-?\d+ overlaps check/);
    // A pattern's handler goes where asked; its new end goes below it.
    await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'apply_pattern',
          at: 'notify.failed_hosts',
          pattern: 'notify-stop',
          position: { x: 900, y: 600 },
        },
      ],
    });
    expect(at('notify-on-call')).toEqual({ x: 900, y: 600 });
    expect(at('stopped')?.y).toBeGreaterThan(600);
    const described = await call(io, 'flow_describe', { path, layout: true });
    expect(described.text).toContain('notify-on-call (task, draft) "Notify on-call"');
    expect(described.text).toContain('at 900,600');
    // Unplace hands a level back to the canvas.
    await call(io, 'flow_edit', { path, ops: [{ op: 'unplace', level: 'top' }] });
    expect(doc().layout).toBeUndefined();
    // Errors: a place needs x and y, or one relation on the same level.
    const bad = await call(io, 'flow_edit', {
      path,
      ops: [{ op: 'move', nodes: { check: { x: 10 } } }],
    });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain('position needs both x and y');
    const two = await call(io, 'flow_edit', {
      path,
      ops: [{ op: 'move', nodes: { check: { below: 'start', right_of: 'start' } } }],
    });
    expect(two.text).toContain('exactly one of below, above, right_of, left_of');
  });

  it('AFD-69: the layout check names a wire through a node, and a move clears it', async () => {
    const io = memoryIO();
    const path = 'flows/wires/wires.flow.yaml';
    await call(io, 'flow_new', { path, name: 'Wires' });
    // AFD-70: wires step round nodes, except where there is no room: B sits 20 px under A's
    // ok_hosts port, so the wire to C has nowhere to turn and runs through B.
    const laid = await call(io, 'flow_edit', {
      path,
      ops: [
        {
          op: 'add_node',
          type: 'task',
          title: 'A',
          after: 'start.ok_hosts',
          position: { x: 1000, y: 100 },
        },
        { op: 'add_node', type: 'task', title: 'B', position: { x: 1000, y: 196 } },
        {
          op: 'add_node',
          type: 'task',
          title: 'C',
          after: 'a.ok_hosts',
          position: { x: 1000, y: 400 },
        },
      ],
    });
    expect(laid.text).toContain('Layout check of the top level: 1 problem(s). Fix wires through');
    expect(laid.text).toContain('\n  wire a.ok_hosts -> c runs through b');
    const d = await call(io, 'flow_describe', { path, layout: true });
    expect(d.text).toContain('  layout problems:\n    wire a.ok_hosts -> c runs through b');
    expect(d.text).toContain('Layout check: 1 problem(s), listed per level.');
    // AFD-213: the total comes before the levels, so page 1 of a long answer has it.
    expect(d.text.indexOf('Layout check:')).toBeLessThan(d.text.indexOf('Top level'));
    expect((await call(io, 'flow_describe', { path })).text).not.toContain('Layout check');
    // The hint works: the node in the way goes beside the wire.
    const moved = await call(io, 'flow_edit', {
      path,
      ops: [{ op: 'move', nodes: { b: { right_of: 'a', gap: 96 } } }],
    });
    expect(moved.text).toContain('Layout check of the top level: no problems.');
    // A clean ELK level says so.
    expect((await call(io, 'flow_describe', { path: EDGE, layout: true })).text).toContain(
      'Layout check: no problems',
    );
  });

  it('AFD-70: after tidy_up no wire runs through a node, on the canvas and in exports', async () => {
    const io = memoryIO();
    // As in an AI import (product-owner report, AFD-69): fail wires into a rescue step skip
    // steps, and tidy_up staggered those steps in one column; the wires went round them (AFD-70).
    // AFD-192: ELK knows the ports now, so tidy_up stands the steps in one straight column with
    // Rollback beside it, and no wire has a node in its way (export.test.ts has routed wires).
    const rescue = 'flows/rescue/rescue.flow.yaml';
    await call(io, 'flow_new', { path: rescue, name: 'Rescue' });
    const tidied = await call(io, 'flow_edit', {
      path: rescue,
      ops: [
        { op: 'add_node', type: 'task', title: 'Render', after: 'start.ok_hosts' },
        { op: 'add_node', type: 'task', title: 'Write', after: 'render.ok_hosts' },
        { op: 'add_node', type: 'task', title: 'Refuse', after: 'write.ok_hosts' },
        { op: 'add_node', type: 'task', title: 'Rollback', after: 'refuse.failed_hosts' },
        { op: 'connect', from: 'render.failed_hosts', to: 'rollback' },
        { op: 'connect', from: 'write.failed_hosts', to: 'rollback' },
        { op: 'add_node', type: 'task', title: 'Attempt', after: 'refuse.ok_hosts' },
        { op: 'connect', from: 'rollback.ok_hosts', to: 'attempt' },
        { op: 'tidy_up', level: 'top' },
      ],
    });
    expect(tidied.text).toContain('Layout check of the top level: no problems.');
    // The check reads the scene the exports draw (the canvas routes with the same function):
    // no crossings either, now that the fail wires stay right of the column.
    const doc = parse(io.files.get(rescue) as string) as FlowDocument;
    const model = buildModel(doc);
    const shown = await shownPositions(model);
    const problems = flowLayoutProblems(model, shown).get(ROOT) ?? [];
    expect(problems).toEqual([]);
    // Every wire keeps its smooth step: none needs to go round a node.
    const scene = scenesOf({ doc, shown, findings: [], openPorts: openFailPorts(model) })[0];
    const routed = [...(scene?.wires.values() ?? [])].filter((w) => w.bends);
    expect(routed).toHaveLength(0);
    // So draw.io has no waypoints to keep.
    await call(io, 'flow_export', { path: rescue });
    const drawio = io.exports.get('flows/rescue/rescue.drawio') as string;
    expect(drawio.match(/<Array as="points">/g)).toBeNull();
    // Moving Rollback beside Refuse by hand keeps the level clean.
    const fixed = await call(io, 'flow_edit', {
      path: rescue,
      ops: [{ op: 'move', nodes: { rollback: { right_of: 'refuse', gap: 96 } } }],
    });
    expect(fixed.text).toContain('Layout check of the top level: no problems.');
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

  it('AFD-25: flow_export writes a draw.io file next to the flow, or SVGs of its levels', async () => {
    const io = memoryIO();
    const FW = 'flows/firewall-upgrade/firewall-upgrade.flow.yaml';
    io.files.set(FW, read('samples/firewall-upgrade.flow.yaml'));
    const d = await call(io, 'flow_export', { path: FW });
    expect(d.isError).toBeFalsy();
    expect(d.text).toMatch(
      /^Wrote flows\/firewall-upgrade\/firewall-upgrade[.]drawio: \d+ page\(s\)/,
    );
    const file = io.exports.get('flows/firewall-upgrade/firewall-upgrade.drawio') ?? '';
    expect(file.match(/<diagram /g)?.length).toBeGreaterThan(3);
    // The flow file itself does not change.
    expect(io.writes).toBe(0);
    const all = await call(io, 'flow_export', { path: FW, format: 'svg', level: 'all' });
    expect(all.isError).toBeFalsy();
    const svgs = [...io.exports.keys()].filter((k) => k.endsWith('.drawio.svg'));
    expect(svgs).toContain('flows/firewall-upgrade/firewall-upgrade.drawio.svg');
    expect(svgs).toContain('flows/firewall-upgrade/firewall-upgrade--upgrade.drawio.svg');
    expect(svgs.length).toBe(file.match(/<diagram /g)?.length);
    const one = await call(io, 'flow_export', {
      path: FW,
      format: 'svg',
      level: 'upgrade',
      out: 'docs/upgrade.svg',
    });
    expect(one.text).toMatch(/^Wrote docs\/upgrade[.]svg[.]/);
    expect(io.exports.get('docs/upgrade.svg')).toMatch(
      /^<[?]xml[\s\S]*<svg [^>]*content="&lt;mxfile/,
    );
    // Refusals say what to do instead.
    expect((await call(io, 'flow_export', { path: FW, format: 'png' })).text).toMatch(
      /Export as Image in VS Code/,
    );
    expect((await call(io, 'flow_export', { path: FW, out: 'x.png' })).text).toMatch(/[.]drawio/);
    expect(
      (await call(io, 'flow_export', { path: FW, format: 'svg', level: 'backup/export' })).text,
    ).toMatch(/not a subflow/);
    expect((await call(io, 'flow_export', { path: HAND })).text).toMatch(/flow_complete_ids/);
  });
});

describe('AFD-27: import tools', () => {
  /** memoryIO with the netops repository readable as Ansible sources. */
  function withSource() {
    const io = memoryIO();
    return Object.assign(io, {
      source: (path: string) => ({ io: fsSource(NETOPS), path, prefix: '' }),
    });
  }

  it('source_outline outlines a folder, a playbook (bindings to copy), one task, a role', async () => {
    const io = withSource();
    const folder = (await call(io, 'source_outline', { path: '.' })).text;
    expect(folder).toContain('- site.yml · "site.yml" · top level');
    expect(folder).toContain('- push_baseline (roles/push_baseline) · split into task files');
    const book = (
      await call(io, 'source_outline', { path: 'site.yml', flow: 'flows/edge/edge.flow.yaml' })
    ).text;
    // AFD-176: paths from the repository root the generated plays set.
    expect(book).toContain('Paths in impl are written from {{ afd_repo_root }}');
    expect(book).toContain('they run from flows/edge/generated');
    expect(book).toContain(
      '#2 Read the software version · ansible.builtin.command · register version_check · changed_when',
    );
    expect(book).toContain('"src":"{{ afd_repo_root }}/playbooks/templates/motd.j2"');
    expect(book).toContain('rescue (runs for hosts that failed in the block');
    expect(book).toContain('#15 role push_baseline "Apply the NTP and AAA baseline"');
    expect(book).toContain('snmp_community=<secret snmp_community>');
    // What the as-is import adds itself is spelled out too: vars files, gathered facts, split roles.
    expect(book).toContain(
      'step impl: {"kind":"module","ref":"ansible.builtin.include_vars","params":{"file":"{{ afd_repo_root }}/vars/baseline.yml"}}',
    );
    expect(book).toContain(
      'gathers facts first: step impl: {"kind":"module","ref":"ansible.builtin.gather_facts"}',
    );
    expect(book).toContain(
      'step "AAA" impl: {"kind":"role","ref":"push_baseline","params":{"tasks_from":"aaa"}}',
    );
    expect(book).not.toContain('ANSIBLE_VAULT');
    expect(book).toContain('An as-is import (flow_import) would make 21 step(s)');
    const one = (await call(io, 'source_outline', { path: 'site.yml', focus: '#7' })).text;
    expect(one).toMatch(
      /^#7 Configure the uplinks · play "Edge baseline" · playbooks\/baseline.yml:34/,
    );
    expect(one).toContain('"loop": "{{ uplinks }}"');
    // AFD-190: a list or range of tasks in one call.
    const some = (await call(io, 'source_outline', { path: 'site.yml', focus: '#2,#5-#7' })).text;
    expect(some.match(/^#\d+ /gm)).toEqual(['#2 ', '#5 ', '#6 ', '#7 ']);
    expect((await call(io, 'source_outline', { path: 'site.yml', focus: 'seven' })).text).toMatch(
      /focus takes task numbers/,
    );
    expect((await call(io, 'source_outline', { path: 'roles/push_baseline' })).text).toContain(
      'argument_specs main: ntp_servers',
    );
    // A task's impl copies into a step that validates and binds the same module.
    const impl = JSON.parse(/impl: (\{.*\})$/m.exec(book)?.[1] ?? '{}');
    expect(impl).toEqual({
      kind: 'module',
      ref: 'ansible.builtin.file',
      params: { path: '{{ out_dir }}/{{ inventory_hostname }}', state: 'directory', mode: '0755' },
    });
  });

  it('flow_import makes the as-is flow from a playbook or an AWX export', async () => {
    const io = withSource();
    const r = await call(io, 'flow_import', { source: 'site.yml' });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(
      /^Created flows\/site\/site.flow.yaml from site.yml: 21 step\(s\), 21 ready to run, 0 to check/,
    );
    expect(r.text).toContain('Imported by name only');
    const text = io.files.get('flows/site/site.flow.yaml') as string;
    expect(errorsOf(text)).toEqual([]);
    expect(text).not.toContain('ANSIBLE_VAULT');
    expect((await call(io, 'flow_import', { source: 'site.yml' })).text).toMatch(/exists/);
    expect((await call(io, 'flow_import', { source: 'playbooks/tasks/verify.yml' })).isError).toBe(
      true,
    );
  });

  it('flow_import takes an AWX template, expanding playbooks of the repository', async () => {
    const io = withSource();
    const src = fsSource(NETOPS);
    const exportJson = JSON.stringify({
      job_templates: [
        { name: 'Edge pre-checks', playbook: 'playbooks/prechecks.yml', limit: 'edge' },
      ],
    });
    Object.assign(io, {
      source: (path: string) => ({
        io: { ...src, read: async (p: string) => (p === 'awx.json' ? exportJson : src.read(p)) },
        path,
        prefix: '',
      }),
    });
    const r = await call(io, 'flow_import', {
      source: 'awx.json',
      path: 'flows/pre/pre.flow.yaml',
    });
    expect(r.text).toMatch(/^Created flows\/pre\/pre.flow.yaml from awx.json: 4 step\(s\)/);
    const doc = parse(io.files.get('flows/pre/pre.flow.yaml') as string) as FlowDocument;
    expect(doc.flow.imported_from).toMatchObject({
      kind: 'awx_job_template',
      template: 'Edge pre-checks',
    });
    const outline = (await call(io, 'source_outline', { path: 'awx.json' })).text;
    expect(outline).toContain('playbooks/prechecks.yml (in this repository)');
  });

  it('say so where Ansible files cannot be read', async () => {
    const io = memoryIO();
    expect((await call(io, 'source_outline', { path: 'site.yml' })).text).toMatch(
      /not available here/,
    );
    expect((await call(io, 'flow_import', { source: 'site.yml' })).text).toMatch(
      /not available here/,
    );
  });
});

describe('large flows and mechanical edits (AFD-189, AFD-191, AFD-196)', () => {
  const OS = 'examples/os-upgrade.flow.yaml';
  const withOs = () => {
    const io = memoryIO();
    io.files.set(OS, read(OS));
    return io;
  };

  it('flow_validate filters by code and node, and sums up by code', async () => {
    const io = memoryIO();
    const all = (await call(io, 'flow_validate', { path: EDGE })).text;
    const open = (await call(io, 'flow_validate', { path: EDGE, code: ['open-fail-port'] })).text;
    expect(open).toMatch(/\(showing \d+: code open-fail-port\)/);
    expect(open.match(/^- /gm)?.every((l) => l)).toBe(true);
    expect(open).not.toMatch(/^- (error|warning|info) (?!open-fail-port)/m);
    const sum = (await call(io, 'flow_validate', { path: EDGE, summary: true })).text;
    expect(sum).toMatch(/^- warning open-fail-port ×\d+ at \d+ place\(s\): /m);
    expect(sum.length).toBeLessThanOrEqual(all.length + 200);
  });

  it('every answer stays under the cap, with a hint to ask for less', async () => {
    const io = withOs();
    const big = 'x'.repeat(50_000);
    io.files.set(OS, read(OS).replace('title: Upgrade OS', `title: Upgrade OS\n  intent: ${big}`));
    const d = await call(io, 'flow_describe', { path: OS });
    expect(d.text.length).toBeLessThanOrEqual(40_000);
    expect(d.text).toMatch(
      /Ask for less: level <subflow>, nodes, detail: brief|call again with page 2/,
    );
  });

  it('flow_describe with nodes and detail brief shows just those, one line each', async () => {
    const io = withOs();
    const d = (
      await call(io, 'flow_describe', { path: OS, nodes: ['upgrade-os'], detail: 'brief' })
    ).text;
    expect(d).toContain('upgrade-os (subflow');
    expect(d).toContain('step(s)');
    expect(d).not.toContain('backup-config (task');
  });

  it('replace_text changes bindings in one op and fails when nothing matches', async () => {
    const io = withOs();
    const r = await call(io, 'flow_edit', {
      path: OS,
      ops: [{ op: 'replace_text', find: 'boot system flash:', replace: 'boot system bootflash:' }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.text).toMatch(/replace_text changed \d+ step\(s\): /);
    expect(io.files.get(OS)).toContain('boot system bootflash:{{ target_image }}');
    const none = await call(io, 'flow_edit', {
      path: OS,
      ops: [{ op: 'replace_text', find: 'no-such-text-anywhere', replace: 'x' }],
    });
    expect(none.isError).toBe(true);
    expect(none.text).toContain('is in no binding');
  });

  it('rename takes a key map; regenerate needs no change to the flow', async () => {
    const io = withOs();
    const r = await call(io, 'flow_edit', {
      path: OS,
      ops: [{ op: 'rename', keys: { 'backup-config': 'backup', 'post-checks': 'verify' } }],
    });
    expect(r.isError).toBeFalsy();
    const doc = parse(io.files.get(OS) as string) as FlowDocument;
    expect(doc.nodes.map((n) => n.key)).toEqual(expect.arrayContaining(['backup', 'verify']));
    const gen: string[] = [];
    const io2 = Object.assign(withOs(), {
      generate: async (p: string) => {
        gen.push(p);
        return ['generated/: wrote os-upgrade-edge.yml'];
      },
    });
    const again = await call(io2, 'flow_edit', { path: OS, ops: [{ op: 'regenerate' }] });
    expect(again.text).toContain('The flow is unchanged.');
    expect(again.text).toContain('generated/: wrote os-upgrade-edge.yml');
    expect(gen).toEqual([OS]);
  });

  it('dissolve_subflow moves the steps up and keeps the flow valid', async () => {
    const io = withOs();
    const before = parse(io.files.get(OS) as string) as FlowDocument;
    const inner = before.nodes
      .find((n) => n.key === 'upgrade-os')
      ?.subflow?.nodes?.map((n) => n.key);
    const r = await call(io, 'flow_edit', {
      path: OS,
      ops: [{ op: 'dissolve_subflow', subflow: 'upgrade-os' }],
    });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('upgrade-os dissolved:');
    const text = io.files.get(OS) as string;
    const doc = parse(text) as FlowDocument;
    expect(doc.nodes.some((n) => n.key === 'upgrade-os')).toBe(false);
    for (const k of inner ?? []) expect(doc.nodes.some((n) => n.key === k)).toBe(true);
    expect(errorsOf(text)).toEqual([]);
    // Wires that entered the subflow now enter its entry step.
    const keyOf = (id: string) => doc.nodes.find((n) => n.id === id)?.key;
    expect(
      doc.edges.map((e) => `${keyOf(e.from.node)}.${e.from.port}->${keyOf(e.to.node)}`),
    ).toEqual(expect.arrayContaining(['drain-traffic.ok_hosts->stage-image']));
  });
});

describe('named subflow exits (AFD-181)', () => {
  it('add_exit with a new name gives the subflow a port the parent wires', async () => {
    const OS = 'examples/os-upgrade.flow.yaml';
    const io = memoryIO();
    io.files.set(OS, read(OS));
    const r = await call(io, 'flow_edit', {
      path: OS,
      ops: [
        {
          op: 'add_node',
          type: 'decision',
          title: 'Dry run',
          in: 'upgrade-os',
          condition: 'dry_run | bool',
        },
        { op: 'add_node', type: 'task', title: 'Report dry run', after: 'upgrade-os/dry-run.true' },
        { op: 'rewire', from: 'upgrade-os/stage-image.ok_hosts', to: 'upgrade-os/dry-run' },
        { op: 'connect', from: 'upgrade-os/dry-run.false', to: 'upgrade-os/verify-checksum' },
        { op: 'add_exit', from: 'upgrade-os/report-dry-run.ok_hosts', port: 'dry_run_done' },
        { op: 'connect', from: 'upgrade-os.dry_run_done', to: 'done' },
      ],
    });
    expect(r.isError).toBeFalsy();
    const text = io.files.get(OS) as string;
    expect(errorsOf(text)).toEqual([]);
    const d = (await call(io, 'flow_describe', { path: OS, nodes: ['upgrade-os'], detail: 'full' }))
      .text;
    expect(d).toContain('+dry_run_done');
    expect(d).toContain('upgrade-os.dry_run_done -> done');
    const doc = parse(text) as FlowDocument;
    const gen = optionA.generate(doc, { source: 'os-upgrade.flow.yaml' });
    expect(gen.ok).toBe(true);
    expect(gen.files.map((f) => f.text).join('\n')).toMatch(/dry_run_done/);
    // A port name a node type uses is not a named exit.
    const bad = await call(io, 'flow_edit', {
      path: OS,
      ops: [{ op: 'add_exit', from: 'upgrade-os/report-dry-run.ok_hosts', port: 'approved' }],
    });
    expect(bad.isError).toBe(true);
  });
});

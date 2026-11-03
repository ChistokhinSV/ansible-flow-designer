// M2: port disclosure catalog, failure patterns, open-on-purpose decisions, rewire and insert.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { PATTERN_IDS, patternFits } from '../../../src/core/flow/patterns';
import { nextFrom, patternTarget, portMenu } from '../../../src/core/flow/portMenu';
import { legalPorts, portsFor } from '../../../src/core/flow/ports';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { semanticKey } from '../../../src/core/flow/semantic';
import type { Decision, FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { applyEdits } from '../../../src/core/yaml';
import { exampleFlows, readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };

const docOf = (text: string) => parse(text) as FlowDocument;
const apply = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  expect(schema(docOf(r.text))).toEqual([]);
  return r;
};
const refuse = (text: string, cmd: FlowCommand, code: string) => {
  try {
    planCommand(text, cmd, ctx);
  } catch (e) {
    expect(e).toBeInstanceOf(CommandError);
    expect((e as CommandError).code).toBe(code);
    return;
  }
  throw new Error(`${cmd.kind} was not refused`);
};
const id = (text: string, key: string) =>
  docOf(text).nodes.find((n) => n.key === key)?.id as string;
const node = (text: string, key: string) => docOf(text).nodes.find((n) => n.key === key);
const edgesFrom = (text: string, key: string) =>
  docOf(text).edges.filter((e) => e.from.node === id(text, key));
const keyOf = (text: string, nid: string) => docOf(text).nodes.find((n) => n.id === nid)?.key;
const openCount = (text: string) => openFailPorts(buildModel(docOf(text))).length;

describe('legal ports (D-14 reveal)', () => {
  it('a task reveals every port of its type in slot order, defaults enabled', () => {
    const ports = legalPorts({ type: 'task', ports: ['unreachable'] });
    expect(ports.map((p) => p.name)).toEqual([
      'in',
      'always',
      'ok_hosts',
      'unchanged',
      'failed_hosts',
      'unreachable',
      'timeout',
    ]);
    // AFD-54: undo and cancelled were never built; a node that has one still shows it.
    expect(legalPorts({ type: 'task', ports: ['undo'] }).map((p) => p.name)).toContain('undo');
    expect(ports.filter((p) => p.enabled).map((p) => p.name)).toEqual([
      'in',
      'ok_hosts',
      'failed_hosts',
      'unreachable',
    ]);
  });

  it('enabled legal ports are exactly portsFor', () => {
    for (const { text } of exampleFlows()) {
      for (const n of docOf(text).nodes) {
        const enabled = legalPorts(n)
          .filter((p) => p.enabled)
          .map((p) => p.name);
        expect(enabled.sort()).toEqual(
          portsFor(n)
            .map((p) => p.name)
            .sort(),
        );
      }
    }
  });
});

describe('failure patterns (D-16): one edit, existing IDs kept', () => {
  it('notify and stop: handler plus both outputs to the reused failed end', () => {
    const r = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'notify-stop',
      from: { node: id(EDGE, 'precheck'), port: 'failed_hosts' },
      position: { x: 500, y: 200 },
    });
    const notify = docOf(r.text).nodes.find((n) => n.id === r.created);
    expect(notify).toMatchObject({ type: 'task', handler: 'notify', status: 'draft' });
    const out = docOf(r.text).edges.filter((e) => e.from.node === r.created);
    expect(out.map((e) => [e.from.port, keyOf(r.text, e.to.node)])).toEqual([
      ['ok_hosts', 'failed'],
      ['failed_hosts', 'failed'],
    ]);
    expect(docOf(r.text).layout?.[r.created as string]).toEqual({ x: 500, y: 200 });
    expect(openCount(r.text)).toBe(openCount(EDGE) - 1);
    for (const e of docOf(EDGE).edges) expect(docOf(r.text).edges).toContainEqual(e);
  });

  it('rollback reuses the level Rollback (matched by key when it has no handler marker)', () => {
    const before = docOf(EDGE).nodes.length;
    const r = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'rollback',
      from: { node: id(EDGE, 'validate'), port: 'failed_hosts' },
    });
    expect(docOf(r.text).nodes).toHaveLength(before);
    expect(edgesFrom(r.text, 'validate').map((e) => keyOf(r.text, e.to.node))).toContain(
      'rollback',
    );
  });

  it('rollback creates handler and failed end when the level has neither', () => {
    const text = apply(EDGE, { kind: 'deleteNode', id: id(EDGE, 'rollback') }).text;
    const noFailed = apply(text, { kind: 'deleteNode', id: id(text, 'failed') }).text;
    const r = apply(noFailed, {
      kind: 'applyPattern',
      pattern: 'rollback',
      from: { node: id(noFailed, 'validate'), port: 'failed_hosts' },
      position: { x: 600, y: 400 },
    });
    const doc = docOf(r.text);
    const rollback = doc.nodes.find((n) => n.id === r.created);
    expect(rollback).toMatchObject({ key: 'rollback', handler: 'rollback' });
    const failed = doc.nodes.find((n) => n.key === 'failed');
    expect(failed).toMatchObject({ type: 'end', outcome: 'failed' });
    expect(doc.layout?.[failed?.id as string]).toEqual({ x: 600, y: 550 });
  });

  it('rollback is never attached to unreachable (D-09, check 3)', () => {
    refuse(
      EDGE,
      {
        kind: 'applyPattern',
        pattern: 'rollback',
        from: { node: id(EDGE, 'precheck'), port: 'unreachable' },
      },
      'pattern-port',
    );
  });

  it('retry sets retries on the step itself; its failed_hosts stays open (AFD-52)', () => {
    const before = docOf(EDGE).nodes.length;
    const r = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'retry',
      from: { node: id(EDGE, 'validate'), port: 'failed_hosts' },
    });
    expect(r.created).toBeUndefined();
    expect(docOf(r.text).nodes).toHaveLength(before);
    const validate = docOf(r.text).nodes.find((n) => n.key === 'validate');
    expect(validate?.settings).toMatchObject({ retries: 3, delay: 10 });
    expect(r.notes).toContain(
      'retry: validate tries again up to 3 times, 10 s apart; hosts that still fail leave by failed_hosts',
    );
    expect(openCount(r.text)).toBe(openCount(EDGE));
    // Settings the step has already stay.
    const set = apply(EDGE, {
      kind: 'updateNode',
      id: id(EDGE, 'validate'),
      patch: { settings: { retries: 5 } },
    }).text;
    const again = apply(set, {
      kind: 'applyPattern',
      pattern: 'retry',
      from: { node: id(set, 'validate'), port: 'failed_hosts' },
    });
    expect(docOf(again.text).nodes.find((n) => n.key === 'validate')?.settings).toMatchObject({
      retries: 5,
      delay: 10,
    });
  });

  it('retry fits module steps only: not a role, a subflow, or unreachable hosts', () => {
    expect(patternFits('retry', { type: 'task' }, 'failed_hosts')).toBe(true);
    expect(
      patternFits('retry', { type: 'task', impl: { kind: 'module', ref: 'x.y.z' } }, 'timeout'),
    ).toBe(true);
    expect(
      patternFits('retry', { type: 'task', impl: { kind: 'role', ref: 'r' } }, 'failed_hosts'),
    ).toBe(false);
    expect(patternFits('retry', { type: 'subflow' }, 'failed_hosts')).toBe(false);
    expect(patternFits('retry', { type: 'task' }, 'unreachable')).toBe(false);
  });

  it('exclude reuses an `excluded` end only, never another failed end', () => {
    const os = apply(OS, {
      kind: 'applyPattern',
      pattern: 'exclude',
      from: { node: id(OS, 'restore-traffic'), port: 'failed_hosts' },
    });
    expect(docOf(os.text).nodes).toHaveLength(docOf(OS).nodes.length + 1);
    const edge = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'exclude',
      from: { node: id(EDGE, 'precheck'), port: 'failed_hosts' },
    });
    expect(node(edge.text, 'excluded')).toMatchObject({ type: 'end', outcome: 'failed' });
  });

  it('enables an optional port it attaches to', () => {
    const r = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'notify-stop',
      from: { node: id(EDGE, 'precheck'), port: 'unreachable' },
    });
    expect(node(r.text, 'precheck')?.ports).toEqual(['unreachable']);
  });

  it('wiring a port with an open-on-purpose decision removes the decision in the same edit', () => {
    const r = apply(EDGE, {
      kind: 'applyPattern',
      pattern: 'stop',
      from: { node: id(EDGE, 'backup-config'), port: 'failed_hosts' },
    });
    expect(docOf(r.text).decisions).toBeUndefined();
    expect(r.text).not.toMatch(/^decisions:/m);
  });

  it('approval escalation, decision skip lane, run report', () => {
    let text = apply(EDGE, {
      kind: 'addNode',
      type: 'approval',
      title: 'Change approval',
      insertOn: edgesFrom(EDGE, 'precheck')[0]?.id,
    }).text;
    const approval = id(text, 'change-approval');
    const esc = apply(text, {
      kind: 'applyPattern',
      pattern: 'escalate',
      from: { node: approval, port: 'rejected' },
    });
    const out = docOf(esc.text).edges.filter((e) => e.from.node === esc.created);
    expect(out.map((e) => [e.from.port, keyOf(esc.text, e.to.node)])).toEqual([
      ['rejected', 'failed'],
      ['approved', 'backup-config'],
    ]);
    text = apply(text, { kind: 'addNode', type: 'decision', title: 'Needed?' }).text;
    const skip = apply(text, {
      kind: 'applyPattern',
      pattern: 'done',
      from: { node: id(text, 'needed'), port: 'false' },
    });
    expect(edgesFrom(skip.text, 'needed').map((e) => keyOf(skip.text, e.to.node))).toEqual([
      'done',
    ]);
    refuse(
      text,
      {
        kind: 'applyPattern',
        pattern: 'escalate',
        from: { node: id(text, 'validate'), port: 'failed_hosts' },
      },
      'pattern-port',
    );
  });

  it('every pattern on every fitting open port keeps IDs and validates', () => {
    for (const { text } of exampleFlows()) {
      const before = docOf(text);
      const model = buildModel(before);
      for (const n of before.nodes) {
        for (const p of PATTERN_IDS) {
          const port = patternTarget(model, n.id, p);
          if (!port) continue;
          const r = apply(text, { kind: 'applyPattern', pattern: p, from: { node: n.id, port } });
          const next = docOf(r.text);
          const ids = new Set(next.nodes.map((x) => x.id));
          for (const old of before.nodes) expect(ids.has(old.id)).toBe(true);
          for (const e of before.edges) expect(next.edges).toContainEqual(e);
          const errors = validateFlow(next).findings.filter((f) => f.severity === 'error');
          expect(errors, `${n.key} ${p} ${port}`).toEqual([]);
        }
      }
    }
  }, 60_000);
});

describe('open on purpose (decision 13)', () => {
  const precheck = { node: id(EDGE, 'precheck'), port: 'failed_hosts' };

  it('records reason and by; the banner count drops; clearing restores the bytes', () => {
    const r = apply(EDGE, {
      kind: 'setDecision',
      ...precheck,
      reason: 'Read-only step',
      by: 'alice',
    });
    expect(docOf(r.text).decisions?.at(-1)).toEqual({
      ...precheck,
      kind: 'open_on_purpose',
      reason: 'Read-only step',
      by: 'alice',
    });
    expect(openCount(r.text)).toBe(openCount(EDGE) - 1);
    expect(apply(r.text, { kind: 'clearDecision', ...precheck }).text).toBe(EDGE);
  });

  it('editing the reason changes one line', () => {
    const backup = { node: id(EDGE, 'backup-config'), port: 'failed_hosts' };
    const r = apply(EDGE, {
      kind: 'setDecision',
      ...backup,
      reason: 'Nothing changed yet',
      by: '[USER]',
    });
    expect(r.edits).toHaveLength(1);
    expect(r.edits[0]?.newText).toBe('Nothing changed yet');
  });

  it('refuses a missing reason, a wired port and a non-fail port', () => {
    refuse(EDGE, { kind: 'setDecision', ...precheck, reason: '  ' }, 'no-reason');
    refuse(
      EDGE,
      { kind: 'setDecision', node: id(EDGE, 'push-baseline'), port: 'failed_hosts', reason: 'x' },
      'port-connected',
    );
    refuse(
      EDGE,
      { kind: 'setDecision', node: id(EDGE, 'precheck'), port: 'ok_hosts', reason: 'x' },
      'bad-port',
    );
  });

  it('creates the decisions block when the flow has none', () => {
    const none = apply(EDGE, {
      kind: 'clearDecision',
      node: id(EDGE, 'backup-config'),
      port: 'failed_hosts',
    }).text;
    expect(docOf(none).decisions).toBeUndefined();
    const r = apply(none, { kind: 'setDecision', ...precheck, reason: 'Safe' });
    expect(docOf(r.text).decisions).toEqual([
      { ...precheck, kind: 'open_on_purpose', reason: 'Safe' },
    ]);
  });
});

describe('rewire and insert keep edge IDs (04 §3)', () => {
  it('rewire changes only the target of the edge', () => {
    const edge = edgesFrom(EDGE, 'validate')[0];
    const r = apply(EDGE, {
      kind: 'rewire',
      edge: edge?.id as string,
      to: { node: id(EDGE, 'failed'), port: 'in' },
    });
    const moved = docOf(r.text).edges.find((e) => e.id === edge?.id);
    expect(moved?.from).toEqual(edge?.from);
    expect(keyOf(r.text, moved?.to.node as string)).toBe('failed');
    expect(r.edits).toHaveLength(1);
  });

  it('rewire refuses cycles and non-inputs', () => {
    const edge = edgesFrom(EDGE, 'push-baseline').find((e) => e.from.port === 'ok_hosts');
    refuse(
      EDGE,
      { kind: 'rewire', edge: edge?.id as string, to: { node: id(EDGE, 'precheck'), port: 'in' } },
      'cycle',
    );
    refuse(
      EDGE,
      { kind: 'rewire', edge: edge?.id as string, to: { node: id(EDGE, 'start'), port: 'in' } },
      'bad-port',
    );
  });

  it('insert on a wire: the edge ends at the new node, which continues to the old target', () => {
    const edge = edgesFrom(EDGE, 'precheck')[0];
    const r = apply(EDGE, { kind: 'addNode', type: 'task', title: 'Snapshot', insertOn: edge?.id });
    const doc = docOf(r.text);
    expect(doc.edges.find((e) => e.id === edge?.id)).toEqual({
      ...edge,
      to: { node: r.created, port: 'in' },
    });
    const next = doc.edges.find((e) => e.from.node === r.created);
    expect(next?.to).toEqual(edge?.to);
    refuse(EDGE, { kind: 'addNode', type: 'end', title: 'X', insertOn: edge?.id }, 'bad-type');
  });

  it('freeze writes the positions of auto-laid-out nodes in the same edit', () => {
    const freeze = Object.fromEntries(docOf(OS).nodes.map((n, i) => [n.id, { x: i * 10, y: 0 }]));
    const r = apply(OS, {
      kind: 'addNode',
      type: 'task',
      title: 'Extra',
      position: { x: 1, y: 2 },
      freeze,
    });
    const layout = docOf(r.text).layout ?? {};
    expect(Object.keys(layout)).toHaveLength(docOf(OS).nodes.length + 1);
    expect(semanticKey(docOf(apply(OS, { kind: 'moveNodes', positions: freeze }).text))).toBe(
      semanticKey(docOf(OS)),
    );
  });
});

describe('port menu (04 §3, mockup 07)', () => {
  const menu = (text: string, key: string, port: string) =>
    portMenu(buildModel(docOf(text)), { node: id(text, key), port });
  const labels = (text: string, key: string, port: string) =>
    menu(text, key, port)?.items.map((i) => i.label);

  it('open failed_hosts: existing Rollback first, then the patterns, then open on purpose', () => {
    expect(labels(EDGE, 'precheck', 'failed_hosts')).toEqual([
      'Rollback (existing)',
      'Notify On-Call and Stop',
      'Exclude and Report',
      'Retry',
      'Stop Flow',
      'Connect to Another Node…',
      'Accept with Reason…',
    ]);
  });

  it('unreachable never suggests Rollback (check 3), and offers Enable when not enabled', () => {
    for (const { text } of exampleFlows()) {
      const model = buildModel(docOf(text));
      for (const n of docOf(text).nodes) {
        const m = portMenu(model, { node: n.id, port: 'unreachable' });
        if (!m) continue;
        expect(m.items.some((i) => i.kind === 'pattern' && i.pattern === 'rollback')).toBe(false);
      }
    }
    expect(labels(EDGE, 'precheck', 'unreachable')?.[0]).toBe('Enable Port');
  });

  it('connected output: insert, rewire, disconnect', () => {
    expect(labels(EDGE, 'push-baseline', 'failed_hosts')).toEqual([
      'Insert Node on This Wire',
      'Rewire to Another Node…',
      'Disconnect',
    ]);
  });

  it('decided port: edit reason or reopen; inputs list their wires', () => {
    expect(labels(EDGE, 'backup-config', 'failed_hosts')?.slice(-2)).toEqual([
      'Edit Reason…',
      'Reopen',
    ]);
    expect(labels(EDGE, 'failed', 'in')).toEqual([
      'Connect from Another Node…',
      'Disconnect from Rollback · ok_hosts',
    ]);
    expect(labels(OS, 'backup-config', 'undo')).toEqual(['Remove Port']);
  });

  it('a dropped pattern targets the first open port it fits', () => {
    const model = buildModel(docOf(EDGE));
    expect(patternTarget(model, id(EDGE, 'precheck'), 'rollback')).toBe('failed_hosts');
    expect(patternTarget(model, id(EDGE, 'push-baseline'), 'rollback')).toBeUndefined();
    expect(patternTarget(model, id(EDGE, 'push-baseline'), 'notify-stop')).toBe('unreachable');
  });
});

describe('validator (M2 additions)', () => {
  it('warns when unreachable goes to a rollback (D-09)', () => {
    const r = apply(EDGE, {
      kind: 'connect',
      from: { node: id(EDGE, 'precheck'), port: 'unreachable' },
      to: { node: id(EDGE, 'rollback'), port: 'in' },
    });
    const codes = validateFlow(docOf(r.text)).findings.map((f) => f.code);
    expect(codes).toContain('rollback-unreachable');
  });

  it('flags duplicate decisions and decisions on non-fail ports', () => {
    const doc = docOf(EDGE);
    const d = doc.decisions?.[0] as Extract<Decision, { kind: 'open_on_purpose' }>;
    doc.decisions = [d, { ...d }, { ...d, port: 'ok_hosts' }];
    const codes = validateFlow(doc).findings.map((f) => f.code);
    expect(codes).toContain('duplicate-decision');
    expect(codes).toContain('decision-not-fail');
  });
});

describe('Add Next Node (AFD-71)', () => {
  const doc = (nodes: string, edges: string) =>
    buildModel(
      docOf(
        [
          'schema_version: 2',
          'flow: { id: 01JDGKS0000000000000000001, key: f, name: F, version: 1 }',
          `nodes: ${nodes}`,
          `edges: ${edges}`,
        ].join('\n'),
      ),
    );
  const A = '01JDGKS00000000000000000A0';
  const B = '01JDGKS00000000000000000B0';
  const W = '01JDGKS00000000000000000W0';
  const node = (type: string, extra = '') =>
    `{ id: ${A}, key: a, type: ${type}, title: A${extra} }`;
  const end = `{ id: ${B}, key: b, type: end, title: B }`;
  const wire = (port: string) =>
    `[{ id: ${W}, from: { node: ${A}, port: '${port}' }, to: { node: ${B}, port: in } }]`;

  it.each([
    ['task', '', 'ok_hosts', 'ok_hosts', W],
    ['task, ports: [always]', '', 'always', 'ok_hosts', undefined],
    ['decision', '', 'true', 'false', undefined],
    ['approval', '', 'approved', 'approved', W],
    ['parallel', ', branches: 3', 'branch_1', 'branch_2', undefined],
    ['start', '', 'ok_hosts', 'ok_hosts', W],
  ])('%s with %s', (type, extra, wired, port, insertOn) => {
    const [t, ports] = type.split(', ');
    const m = doc(
      `[${node(t as string, `${extra}${ports ? `, ${ports}` : ''}`)}, ${end}]`,
      wire(wired),
    );
    expect(nextFrom(m, A)).toEqual(insertOn ? { port, insertOn } : { port });
  });

  it('an unwired task continues on ok_hosts; an end node has nowhere to go', () => {
    expect(nextFrom(doc(`[${node('task')}, ${end}]`, '[]'), A)).toEqual({ port: 'ok_hosts' });
    expect(nextFrom(doc(`[${node('task')}, ${end}]`, '[]'), B)).toBeUndefined();
  });
});

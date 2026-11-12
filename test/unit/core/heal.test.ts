// AFD-233..235: a wire's source end moves, a free node goes into a wire, and the path closes
// behind deleted or detached nodes (core/flow/heal).
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { healPlan, spliceProblem } from '../../../src/core/flow/heal';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { applyEdits } from '../../../src/core/yaml';
import { readExample } from './helpers';

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
const model = (text: string) => buildModel(docOf(text));
const all = (text: string): FlowNode[] => [...model(text).nodes.values()].map((e) => e.node);
const id = (text: string, key: string) => all(text).find((n) => n.key === key)?.id as string;
/** Every wire of every level as `from.port -> to.port`, by key. */
const wires = (text: string): string[] => {
  const m = model(text);
  const key = (n: string) => m.nodes.get(n)?.node.key;
  return [...m.edges.values()]
    .map(({ edge: e }) => `${key(e.from.node)}.${e.from.port} -> ${key(e.to.node)}.${e.to.port}`)
    .sort();
};
const edgeId = (text: string, wire: string) => {
  const m = model(text);
  const key = (n: string) => m.nodes.get(n)?.node.key;
  for (const { edge: e } of m.edges.values())
    if (`${key(e.from.node)}.${e.from.port} -> ${key(e.to.node)}.${e.to.port}` === wire)
      return e.id;
  throw new Error(`no wire ${wire}`);
};
const boundary = (text: string, key: string) => {
  const m = model(text);
  const k = (n?: string) => (n ? m.nodes.get(n)?.node.key : undefined);
  const b = all(text).find((n) => n.key === key)?.subflow?.boundary;
  return {
    in: k(b?.in),
    outputs: Object.fromEntries(
      Object.entries(b?.outputs ?? {}).map(([p, refs]) => [
        p,
        (refs ?? []).map((r) => `${k(r.node)}.${r.port}`),
      ]),
    ),
  };
};

describe('Delete heals the path (AFD-235)', () => {
  it('the wire into a deleted step goes on to the step after it', () => {
    const r = apply(EDGE, { kind: 'deleteNodes', ids: [id(EDGE, 'backup-config')], heal: true });
    expect(wires(r.text)).toContain('precheck.ok_hosts -> push-baseline.in');
    expect(wires(r.text).some((w) => w.includes('backup-config'))).toBe(false);
    expect(r.notes?.[0]).toBe('Reconnected 1 wire across the gap');
  });

  it('without heal the gap stays, as before', () => {
    const r = apply(EDGE, { kind: 'deleteNodes', ids: [id(EDGE, 'backup-config')] });
    expect(wires(r.text).some((w) => w.startsWith('precheck.ok_hosts'))).toBe(false);
    expect((r.notes ?? []).some((n) => n.startsWith('Reconnected'))).toBe(false);
  });

  it('a run of deleted steps heals as one', () => {
    const ids = ['precheck', 'backup-config'].map((k) => id(EDGE, k));
    const r = apply(EDGE, { kind: 'deleteNodes', ids, heal: true });
    expect(wires(r.text)).toContain('start.ok_hosts -> push-baseline.in');
  });

  it('the fail wires of a deleted step go; its handler stays', () => {
    const r = apply(EDGE, { kind: 'deleteNodes', ids: [id(EDGE, 'push-baseline')], heal: true });
    expect(wires(r.text)).toEqual([
      'backup-config.ok_hosts -> validate.in',
      'precheck.ok_hosts -> backup-config.in',
      'rollback.ok_hosts -> failed.in',
      'start.ok_hosts -> precheck.in',
      'validate.ok_hosts -> done.in',
    ]);
  });

  it('a decision with both branches wired has no one way on: nothing is reconnected', () => {
    const r = apply(OS, { kind: 'deleteNodes', ids: [id(OS, 'upgrade-needed')], heal: true });
    expect(wires(r.text).some((w) => w.startsWith('pre-checks.ok_hosts'))).toBe(false);
    expect(r.notes).toBeUndefined();
  });

  it('a wire deleted with the node is not brought back', () => {
    const wire = edgeId(EDGE, 'precheck.ok_hosts -> backup-config.in');
    const r = apply(EDGE, {
      kind: 'deleteNodes',
      ids: [id(EDGE, 'backup-config')],
      edges: [wire],
      heal: true,
    });
    expect(wires(r.text).some((w) => w.startsWith('precheck.ok_hosts'))).toBe(false);
  });

  it('inside a subflow the entry moves on, and the last step hands its exit back', () => {
    const first = apply(OS, { kind: 'deleteNodes', ids: [id(OS, 'stage-image')], heal: true });
    expect(boundary(first.text, 'upgrade-os').in).toBe('verify-checksum');
    const last = apply(OS, { kind: 'deleteNodes', ids: [id(OS, 'verify-version')], heal: true });
    expect(boundary(last.text, 'upgrade-os').outputs.ok_hosts).toEqual(['wait-for-ssh.ok_hosts']);
    expect(wires(last.text).some((w) => w.includes('verify-version'))).toBe(false);
  });

  it('one undo step: one edit set gives the healed text', () => {
    const before = wires(EDGE).length;
    const r = apply(EDGE, { kind: 'deleteNodes', ids: [id(EDGE, 'validate')], heal: true });
    expect(wires(r.text).length).toBe(before - 1);
    expect(wires(r.text)).toContain('push-baseline.ok_hosts -> done.in');
  });
});

describe('Detach (AFD-235)', () => {
  it('the node stays, free of wires, and the path closes behind it', () => {
    const r = apply(EDGE, { kind: 'detachNodes', ids: [id(EDGE, 'backup-config')] });
    expect(id(r.text, 'backup-config')).toBeTruthy();
    expect(wires(r.text)).toContain('precheck.ok_hosts -> push-baseline.in');
    expect(wires(r.text).some((w) => w.includes('backup-config'))).toBe(false);
  });

  it('detached together, nodes keep the wires between them', () => {
    const ids = ['precheck', 'backup-config'].map((k) => id(EDGE, k));
    const r = apply(EDGE, { kind: 'detachNodes', ids });
    expect(wires(r.text)).toContain('precheck.ok_hosts -> backup-config.in');
    expect(wires(r.text)).toContain('start.ok_hosts -> push-baseline.in');
  });

  it('a detached entry step no longer starts the subflow', () => {
    const r = apply(OS, { kind: 'detachNodes', ids: [id(OS, 'stage-image')] });
    expect(boundary(r.text, 'upgrade-os').in).toBe('verify-checksum');
    expect(wires(r.text).some((w) => w.includes('stage-image'))).toBe(false);
  });
});

describe('Splice a node into a wire (AFD-234)', () => {
  const detached = apply(EDGE, { kind: 'detachNodes', ids: [id(EDGE, 'backup-config')] }).text;

  it('a free node goes between the ends of the wire, at the given place', () => {
    const node = id(detached, 'backup-config');
    const edge = edgeId(detached, 'validate.ok_hosts -> done.in');
    const r = apply(detached, {
      kind: 'spliceNode',
      node,
      edge,
      positions: { [node]: { x: 40, y: 400 } },
    });
    expect(wires(r.text)).toContain('validate.ok_hosts -> backup-config.in');
    expect(wires(r.text)).toContain('backup-config.ok_hosts -> done.in');
    expect(docOf(r.text).layout?.[node]).toEqual({ x: 40, y: 400 });
  });

  it('a node already in a path, or an end of the wire, is refused', () => {
    const edge = edgeId(EDGE, 'validate.ok_hosts -> done.in');
    refuse(EDGE, { kind: 'spliceNode', node: id(EDGE, 'precheck'), edge }, 'bad-command');
    refuse(EDGE, { kind: 'spliceNode', node: id(EDGE, 'done'), edge }, 'bad-command');
    expect(spliceProblem(model(EDGE), id(EDGE, 'precheck'))).toMatch(/already wired/);
    expect(spliceProblem(model(detached), id(detached, 'backup-config'))).toBeUndefined();
  });
});

describe("Move a wire's source end (AFD-233)", () => {
  it('to an open output of another node', () => {
    const cut = apply(EDGE, {
      kind: 'disconnect',
      edge: edgeId(EDGE, 'precheck.ok_hosts -> backup-config.in'),
    }).text;
    const r = apply(cut, {
      kind: 'rewireFrom',
      edge: edgeId(cut, 'backup-config.ok_hosts -> push-baseline.in'),
      from: { node: id(cut, 'precheck'), port: 'ok_hosts' },
    });
    expect(wires(r.text)).toContain('precheck.ok_hosts -> push-baseline.in');
    expect(wires(r.text).some((w) => w.startsWith('backup-config.ok_hosts'))).toBe(false);
  });

  it('to another port of the same node, which is enabled for it', () => {
    const edge = edgeId(EDGE, 'validate.ok_hosts -> done.in');
    const r = apply(EDGE, {
      kind: 'rewireFrom',
      edge,
      from: { node: id(EDGE, 'validate'), port: 'failed_hosts' },
    });
    expect(wires(r.text)).toContain('validate.failed_hosts -> done.in');
  });

  it('a wired output and a loop are refused', () => {
    const edge = edgeId(EDGE, 'validate.ok_hosts -> done.in');
    refuse(
      EDGE,
      { kind: 'rewireFrom', edge, from: { node: id(EDGE, 'precheck'), port: 'ok_hosts' } },
      'port-in-use',
    );
    const back = edgeId(EDGE, 'precheck.ok_hosts -> backup-config.in');
    refuse(
      EDGE,
      { kind: 'rewireFrom', edge: back, from: { node: id(EDGE, 'validate'), port: 'unchanged' } },
      'cycle',
    );
  });
});

describe('healPlan', () => {
  it('names the wires it would re-point, without touching the flow', () => {
    const plan = healPlan(model(EDGE), [id(EDGE, 'backup-config')]);
    expect(plan.wires).toEqual([
      {
        edge: edgeId(EDGE, 'precheck.ok_hosts -> backup-config.in'),
        to: { node: id(EDGE, 'push-baseline'), port: 'in' },
      },
    ]);
    expect(plan.exits).toEqual([]);
    expect(plan.entries).toEqual([]);
  });
});

describe('Dissolve from the canvas places the steps (AFD-241)', () => {
  const sub = id(OS, 'upgrade-os');
  const steps = ['stage-image', 'verify-checksum', 'reload'].map((k) => id(OS, k));

  it('with stored positions: the steps keep their arrangement, where the subflow stood', () => {
    const placedText = apply(OS, {
      kind: 'moveNodes',
      positions: {
        [sub]: { x: 500, y: 300 },
        ...Object.fromEntries(
          all(OS)
            .filter((n) => model(OS).nodes.get(n.id)?.level === sub)
            .map((n, i) => [n.id, { x: 40 + 10 * i, y: 20 + 100 * i }]),
        ),
      },
    }).text;
    const r = apply(placedText, { kind: 'dissolveSubflow', id: sub, place: true });
    const layout = docOf(r.text).layout ?? {};
    expect(layout[sub]).toBeUndefined();
    expect(layout[steps[0] as string]).toEqual({ x: 500, y: 300 });
    expect(layout[steps[1] as string]).toEqual({ x: 510, y: 400 });
  });

  it('without them: left to automatic placement; without place: as before', () => {
    const inner = Object.fromEntries(steps.map((s, i) => [s, { x: 0, y: 100 * i }]));
    const some = apply(OS, { kind: 'moveNodes', positions: inner }).text;
    const r = apply(some, { kind: 'dissolveSubflow', id: sub, place: true });
    for (const s of steps) expect(docOf(r.text).layout?.[s]).toBeUndefined();
    const plain = apply(some, { kind: 'dissolveSubflow', id: sub });
    expect(docOf(plain.text).layout?.[steps[1] as string]).toEqual({ x: 0, y: 100 });
  });
});

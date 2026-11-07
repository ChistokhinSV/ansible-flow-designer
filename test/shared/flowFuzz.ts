// Seeded random flows and scenarios (AFD-114): the scenario simulator is held to Ansible on flows
// nobody drew. A flow is a DAG on each level, from start through tasks, decisions, approvals,
// parallels with joins and subflows (some rolling) to success and failed ends, with optional ports,
// max_fail_percentage and fail ports left open. A scenario forces outcomes on random hosts, at
// random, ports the step does not have included. Same seed, same flow.

import { portsFor } from '../../src/core/flow/ports';
import type { FlowDocument, FlowNode } from '../../src/core/flow/types';
import type { Scenario } from '../../src/core/scenario/scenarios';

type Edge = NonNullable<FlowDocument['edges']>[number];

/** mulberry32: small and seedable. */
export function random(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T;
  const chance = (p: number) => next() < p;
  const some = <T>(list: readonly T[], p: number) => list.filter(() => chance(p));
  return { next, int, pick, chance, some };
}

type Rng = ReturnType<typeof random>;

const OK_PORTS = new Set(['ok_hosts', 'true', 'approved', 'always', 'unchanged']);

/** ULID-shaped, from a counter: the generator does not care, readers can tell them apart. */
function ids(seed: number) {
  let n = 0;
  const prefix = `01JF${String(seed % 1000).padStart(3, '0')}`;
  return () => `${prefix}${String(++n).padStart(26 - prefix.length, '0')}`;
}

interface Level {
  nodes: FlowNode[];
  edges: Edge[];
}

function task(rng: Rng, id: string, key: string): FlowNode {
  const ports = rng.some(['unreachable', 'unchanged', 'timeout', 'always'], 0.3);
  const node: FlowNode = { id, key, type: 'task', title: `Task ${key}` } as FlowNode;
  if (ports.length) node.ports = ports;
  const settings: Record<string, unknown> = {};
  if (ports.includes('timeout')) settings.timeout = 30;
  if (rng.chance(0.15)) settings.max_fail_percentage = rng.pick([0, 34, 50]);
  if (Object.keys(settings).length) node.settings = settings as FlowNode['settings'];
  return node;
}

/**
 * One level's nodes in order, then wires: each node gets a wire in from an earlier free port, the
 * rest of the ports go forward (normal outcomes always, fail ports often) or stay open.
 */
function level(
  rng: Rng,
  newId: () => string,
  prefix: string,
  size: number,
  depth: number,
  entry: FlowNode | undefined,
  ends: FlowNode[],
): Level {
  const nodes: FlowNode[] = [];
  const edges: Edge[] = [];
  const add = (n: FlowNode) => nodes.push(n);
  let k = 0;
  const key = (kind: string) => `${prefix}${kind}${++k}`;
  for (let i = 0; i < size; i++) {
    const roll = rng.next();
    if (roll < 0.55) add(task(rng, newId(), key('t')));
    else if (roll < 0.67)
      add({ id: newId(), key: key('d'), type: 'decision', title: 'Decide' } as FlowNode);
    else if (roll < 0.74) {
      const n = { id: newId(), key: key('a'), type: 'approval', title: 'Approve' } as FlowNode;
      if (rng.chance(0.5)) n.ports = ['timeout'];
      add(n);
    } else if (roll < 0.84 && i < size - 2) {
      add({ id: newId(), key: key('p'), type: 'parallel', title: 'Fan out' } as FlowNode);
      add(task(rng, newId(), key('t')));
      add(task(rng, newId(), key('t')));
      const join = { id: newId(), key: key('j'), type: 'join', title: 'Join' } as FlowNode;
      join.join_mode = rng.chance(0.7) ? 'all' : 'any';
      if (rng.chance(0.6)) join.ports = ['failed_hosts'];
      add(join);
      i += 3;
    } else if (depth < 2) {
      const sub = {
        id: newId(),
        key: key('s'),
        type: 'subflow',
        title: 'Stage',
      } as FlowNode;
      if (rng.chance(0.3)) sub.ports = ['unreachable'];
      if (depth === 0 && rng.chance(0.3)) sub.settings = { rolling: rng.pick([1, 2]) };
      const inner = level(rng, newId, `${sub.key}i`, rng.int(1, 4), depth + 1, undefined, []);
      const first = inner.nodes[0];
      // The last node's normal outcome leaves through the subflow's ok_hosts; fail ports bubble.
      const last = inner.nodes.at(-1);
      const lastOk =
        last && portsFor(last).find((p) => OK_PORTS.has(p.name) && p.direction === 'out');
      const outputs: Record<string, { node: string; port: string }[]> = {};
      if (last && lastOk) outputs.ok_hosts = [{ node: last.id, port: lastOk.name }];
      sub.subflow = {
        nodes: inner.nodes,
        edges: inner.edges.filter(
          (e) => !(e.from.node === last?.id && e.from.port === lastOk?.name),
        ),
        boundary: { in: first?.id, outputs },
      } as FlowNode['subflow'];
      add(sub);
    } else add(task(rng, newId(), key('t')));
  }

  const used = new Set<string>();
  const free = (n: FlowNode) =>
    portsFor(n).filter((p) => p.direction === 'out' && !used.has(`${n.id}|${p.name}`));
  const wire = (from: FlowNode, port: string, to: FlowNode) => {
    used.add(`${from.id}|${port}`);
    edges.push({
      id: newId(),
      from: { node: from.id, port },
      to: { node: to.id, port: 'in' },
    } as Edge);
  };
  const all = entry ? [entry, ...nodes] : nodes;
  // A wire into each node from an earlier one with a free port (the first inner node has none).
  for (let i = entry ? 1 : 1; i < all.length; i++) {
    const to = all[i] as FlowNode;
    const earlier = all.slice(0, i).filter((n) => free(n).length > 0);
    if (earlier.length === 0) continue;
    // A join is fed by the two branch tasks before it, as one is drawn.
    if (to.type === 'join' && i >= 2) {
      for (const b of all.slice(i - 2, i)) {
        const ok = free(b).find((p) => p.name === 'ok_hosts');
        if (ok) wire(b, ok.name, to);
      }
      continue;
    }
    const prev = all[i - 1] as FlowNode;
    const fromPrev = prev.type === 'parallel' ? free(prev)[0] : undefined;
    if (fromPrev) {
      wire(prev, fromPrev.name, to);
      continue;
    }
    const from = rng.chance(0.6) && free(prev).length ? prev : rng.pick(earlier);
    const okFirst = free(from).find((p) => OK_PORTS.has(p.name)) ?? rng.pick(free(from));
    wire(from, okFirst.name, to);
  }
  // The rest go forward, to a later node or an end, or stay open (fail ports).
  for (const [i, from] of all.entries()) {
    for (const p of free(from)) {
      const later = all.slice(i + 1).filter((n) => n.type !== 'join');
      const isOk = OK_PORTS.has(p.name);
      if (!isOk && rng.chance(0.45)) continue;
      // Inside a subflow an ok port with nowhere to go stays open: the host stops there.
      const success = ends.find((e) => e.outcome === 'success');
      const failed = ends.find((e) => e.outcome === 'failed');
      const end = isOk ? success : failed;
      const choices = [...later, ...(end ? [end] : [])];
      if (choices.length === 0) continue;
      const to = later.length && rng.chance(0.5) ? rng.pick(later) : (end ?? rng.pick(choices));
      wire(from, p.name, to);
    }
  }
  return { nodes, edges };
}

/** A random flow; `size` nodes on the top level, before parallels and subflows add theirs. */
export function fuzzFlow(seed: number, size = 6): FlowDocument {
  const rng = random(seed);
  const newId = ids(seed);
  const start = { id: newId(), key: 'start', type: 'start', title: 'Start' } as FlowNode;
  const done = {
    id: newId(),
    key: 'done',
    type: 'end',
    title: 'Done',
    outcome: 'success',
  } as FlowNode;
  const failed = {
    id: newId(),
    key: 'failed',
    type: 'end',
    title: 'Failed',
    outcome: 'failed',
  } as FlowNode;
  const top = level(rng, newId, '', size, 0, start, [done, failed]);
  return {
    schema_version: 1,
    flow: {
      id: newId(),
      key: `fuzz-${seed}`,
      name: `Fuzz ${seed}`,
      version: 1,
      owner: 'netops',
      inputs: { devices: { type: 'host_list', required: true, targets: true } },
    },
    nodes: [start, ...top.nodes, done, failed],
    edges: top.edges,
  } as FlowDocument;
}

/** Every step a scenario can force, by key path, with its type. */
function steps(nodes: FlowNode[] = [], path: string[] = []): [string, FlowNode][] {
  return nodes.flatMap((n) => {
    const key = [...path, n.key].join('/');
    if (n.type === 'subflow') return steps(n.subflow?.nodes, [...path, n.key]);
    return ['task', 'decision', 'approval'].includes(n.type)
      ? [[key, n] as [string, FlowNode]]
      : [];
  });
}

/** A random scenario for a flow: hosts, forced outcomes and approval choices (no expectations). */
export function fuzzScenario(doc: FlowDocument, seed: number): Omit<Scenario, 'expect'> {
  const rng = random(seed * 7919 + 1);
  const hosts = Array.from(
    { length: rng.int(2, 6) },
    (_, i) => `h${String(i + 1).padStart(2, '0')}`,
  );
  const force: NonNullable<Scenario['force']> = {};
  const approvals: NonNullable<Scenario['approvals']> = {};
  for (const [key, n] of steps(doc.nodes)) {
    if (n.type === 'approval') {
      // Mostly an outcome the approval has; now and then one it lacks, which stops the run.
      const outcomes = portsFor(n)
        .filter((p) => p.direction === 'out')
        .map((p) => p.name as 'approved' | 'rejected' | 'timeout');
      if (rng.chance(0.4))
        approvals[key] = rng.chance(0.9) ? rng.pick(outcomes) : rng.pick(['rejected', 'timeout']);
      continue;
    }
    const outcomes =
      n.type === 'decision'
        ? (['false'] as const)
        : (['failed', 'unreachable', 'unchanged', 'timeout'] as const);
    const forced: Record<string, string[]> = {};
    for (const o of outcomes) {
      // Sometimes a port the step does not have: the generated code ignores it.
      const list = rng.some(hosts, 0.25);
      if (list.length && rng.chance(0.5)) forced[o] = list;
    }
    if (Object.keys(forced).length) force[key] = forced;
  }
  return {
    name: `fuzz ${seed}`,
    inputs: { devices: hosts },
    ...(Object.keys(force).length ? { force } : {}),
    ...(Object.keys(approvals).length ? { approvals } : {}),
  };
}

// Approval segments for AWX workflows (AFD-11, ADR-0016). AWX approvals decide for a whole job,
// so a flow with top-level approvals runs in AWX as playbook segments with approval nodes between
// them. The first segment holds everything reachable from start without passing an approval; an
// approval that ends a segment (its gate) continues in `<key>-approved` (what its approved port
// reaches) and `<key>-rejected` (rejected and timeout, which AWX cannot tell apart). A node that
// is reachable on both sides of an approval is in both segments: every producer and consumer of a
// routing group sits in one segment, so only the hosts waiting at the gate and the hosts bound for
// the outcome cross segments. `finish` runs the outcome when no host reached a gate.
import { type FlowModel, ROOT } from '../flow/model';
import type { Edge, FlowNode, Ulid } from '../flow/types';

export interface Segment {
  /** File and AWX name part: `start`, `<approval>-approved`, `<approval>-rejected`, `finish`. */
  name: string;
  /** Top-level nodes whose plays this segment runs (its gate included). */
  nodes: Set<Ulid>;
  /** How it starts: from start (undefined), or from an approval's outcome. */
  entry?: { approval: Ulid; outcome: 'approved' | 'rejected' };
  /** The approval that ends it; its hosts wait there for AWX. */
  gate?: Ulid;
  parent?: string;
  /** The segment that only runs the outcome, after an empty gate. */
  finish?: boolean;
}

export interface SegmentProblem {
  node?: Ulid;
  message: string;
}

export interface SegmentPlan {
  segments: Segment[];
  problems: SegmentProblem[];
}

/** More segments than this is not a workflow anyone reviews. */
export const MAX_SEGMENTS = 32;

/** Undefined when the flow has no approvals; problems when AWX cannot run it as a workflow. */
export function planSegments(model: FlowModel): SegmentPlan | undefined {
  const root = model.levels.get(ROOT);
  if (!root) return undefined;
  const nodes = root.nodes.filter((n): n is FlowNode => !!n && typeof n === 'object');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const problems: SegmentProblem[] = [];
  for (const { node, level } of model.nodes.values())
    if (node.type === 'approval' && level !== ROOT)
      problems.push({
        node: node.id,
        message: `"${node.title}" is inside a subflow: AWX workflows split at top-level approvals only`,
      });
  const gates = nodes.filter((n) => n.type === 'approval');
  if (gates.length === 0 && problems.length === 0) return undefined;
  if (gates.length === 0) return { segments: [], problems };

  const out = new Map<Ulid, Edge[]>();
  for (const e of root.edges)
    if (e?.from?.node && byId.has(e.to?.node))
      out.set(e.from.node, [...(out.get(e.from.node) ?? []), e]);
  /** Nodes reached from these ports, stopping at approvals (which are included). */
  const reach = (ports: { node: Ulid; port: string }[]): Set<Ulid> => {
    const set = new Set<Ulid>();
    const stack = ports.flatMap((p) =>
      (out.get(p.node) ?? []).filter((e) => e.from.port === p.port).map((e) => e.to.node),
    );
    while (stack.length > 0) {
      const id = stack.pop() as Ulid;
      if (set.has(id)) continue;
      set.add(id);
      if (byId.get(id)?.type === 'approval') continue;
      for (const e of out.get(id) ?? []) stack.push(e.to.node);
    }
    return set;
  };

  const segments: Segment[] = [];
  const visit = (name: string, members: Set<Ulid>, entry?: Segment['entry'], parent?: string) => {
    if (segments.length >= MAX_SEGMENTS) return;
    // In document order, so plans and messages are stable.
    const waiting = nodes
      .filter((n) => n.type === 'approval' && members.has(n.id))
      .map((n) => n.id);
    if (waiting.length > 1)
      problems.push({
        node: waiting[0],
        message: `${waiting.map((id) => `"${byId.get(id)?.title}"`).join(' and ')} can wait for approval at the same time: an AWX workflow runs one approval at a time`,
      });
    const seg: Segment = { name, nodes: members, entry, parent, gate: waiting[0] };
    segments.push(seg);
    const gate = waiting.length === 1 ? byId.get(waiting[0] as Ulid) : undefined;
    if (!gate) return;
    const base = name === 'start' ? '' : `${name}_`;
    visit(
      `${base}${gate.key}-approved`,
      reach([{ node: gate.id, port: 'approved' }]),
      {
        approval: gate.id,
        outcome: 'approved',
      },
      name,
    );
    visit(
      `${base}${gate.key}-rejected`,
      reach([
        { node: gate.id, port: 'rejected' },
        { node: gate.id, port: 'timeout' },
      ]),
      { approval: gate.id, outcome: 'rejected' },
      name,
    );
  };
  const start = nodes.find((n) => n.type === 'start');
  visit('start', start ? reach([{ node: start.id, port: 'ok_hosts' }]) : new Set());
  if (segments.length >= MAX_SEGMENTS)
    problems.push({
      message: `The approvals split the flow into more than ${MAX_SEGMENTS} segments`,
    });
  segments.push({ name: 'finish', nodes: new Set(), finish: true });
  return { segments, problems };
}

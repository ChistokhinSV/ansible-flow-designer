// AFD-235: what takes the place of nodes leaving a path (Delete, Detach). A wire into a leaving
// node is re-pointed to where that node went on, when there is one answer: the node continues on
// exactly one main output. A decision with both branches wired, or a step that ends the path, has
// no one answer, and its wires simply go. Pure, so the command and the canvas agree on it.
// AFD-234: whether a node can be spliced into a wire.
import type { FlowModel, Level } from './model';
import { mainOutputs } from './ports';
import type { Edge, FlowNode, NodeType, PortRef, Ulid } from './types';

/** The output a node of this type continues on when it sits on a wire. */
export const CONTINUES_ON: Partial<Record<NodeType, string>> = {
  task: 'ok_hosts',
  subflow: 'ok_hosts',
  join: 'ok_hosts',
  decision: 'true',
  approval: 'approved',
  parallel: 'branch_1',
};

export interface HealPlan {
  /** Wires into the leaving nodes, and the port each now ends at. */
  wires: { edge: Ulid; to: PortRef }[];
  /** Wires whose path left the subflow through a leaving node: their source takes that exit. */
  exits: { edge: Ulid; subflow: Ulid; port: string; from: PortRef; reason?: string }[];
  /** Subflows whose entry step leaves: the step it went on to is the entry now. */
  entries: { subflow: Ulid; node: Ulid }[];
}

type Onward =
  | { kind: 'wire'; to: PortRef }
  | { kind: 'exit'; subflow: Ulid; port: string; reason?: string };

export function healPlan(
  model: FlowModel,
  ids: readonly Ulid[],
  goneEdges: readonly Ulid[] = [],
): HealPlan {
  const plan: HealPlan = { wires: [], exits: [], entries: [] };
  const leaving = new Set(ids.filter((id) => model.nodes.has(id)));
  const cut = new Set(goneEdges);
  const levels = new Set([...leaving].map((id) => model.nodes.get(id)?.level as string));
  for (const levelId of levels) {
    const level = model.levels.get(levelId);
    // A level inside a leaving subflow goes with it.
    if (!level || (level.parent && insideLeaving(model, level.parent, leaving))) continue;
    const parent = level.parent ? model.nodes.get(level.parent)?.node : undefined;
    const onward = (node: FlowNode) => onwardOf(level, parent, node, cut);
    const resolve = (start: Ulid): Onward | undefined => {
      const seen = new Set<Ulid>();
      for (let at = start; ; ) {
        if (seen.has(at)) return undefined;
        seen.add(at);
        const node = model.nodes.get(at)?.node;
        const next = node ? onward(node) : undefined;
        if (!next) return undefined;
        if (next.kind === 'exit' || !leaving.has(next.to.node)) return next;
        at = next.to.node;
      }
    };
    for (const e of level.edges) {
      if (!e?.from?.node || !e.to?.node || cut.has(e.id)) continue;
      if (leaving.has(e.from.node) || !leaving.has(e.to.node)) continue;
      const next = resolve(e.to.node);
      if (next?.kind === 'wire') plan.wires.push({ edge: e.id, to: next.to });
      else if (next?.kind === 'exit')
        plan.exits.push({
          edge: e.id,
          subflow: next.subflow,
          port: next.port,
          from: { node: e.from.node, port: e.from.port },
          ...(next.reason ? { reason: next.reason } : {}),
        });
    }
    const entry = parent?.subflow?.boundary?.in;
    if (parent && entry && leaving.has(entry)) {
      const next = resolve(entry);
      if (next?.kind === 'wire') plan.entries.push({ subflow: parent.id, node: next.to.node });
    }
  }
  return plan;
}

function insideLeaving(model: FlowModel, id: Ulid, leaving: ReadonlySet<Ulid>): boolean {
  for (let at: string | undefined = id; at; at = model.nodes.get(at)?.level) {
    if (leaving.has(at)) return true;
    if (!model.nodes.has(at)) return false;
  }
  return false;
}

/** Where a node goes on, when exactly one of its main outputs leads somewhere. */
function onwardOf(
  level: Level,
  parent: FlowNode | undefined,
  node: FlowNode,
  cut: ReadonlySet<Ulid>,
): Onward | undefined {
  const found: Onward[] = [];
  for (const port of mainOutputs(node)) {
    const wire = level.edges.find(
      (e: Edge) => e?.from?.node === node.id && e.from.port === port && !cut.has(e.id),
    );
    if (wire?.to?.node) {
      found.push({ kind: 'wire', to: { node: wire.to.node, port: wire.to.port } });
      continue;
    }
    for (const [exit, refs] of Object.entries(parent?.subflow?.boundary?.outputs ?? {})) {
      const ref = (refs ?? []).find((r) => r?.node === node.id && r.port === port);
      if (ref && parent)
        found.push({
          kind: 'exit',
          subflow: parent.id,
          port: exit,
          ...(ref.reason ? { reason: ref.reason } : {}),
        });
    }
  }
  return found.length === 1 ? found[0] : undefined;
}

/** What a heal did, for the message after it. */
export function healSummary(plan: HealPlan): string | undefined {
  const n = plan.wires.length + plan.exits.length;
  if (n === 0 && plan.entries.length === 0) return undefined;
  if (n === 0) return 'The subflow now starts at the next step';
  return `Reconnected ${n} wire${n === 1 ? '' : 's'} across the gap`;
}

/**
 * AFD-234: why a node cannot go into a wire, or undefined when it can: it must be of a type that
 * continues on an output, stand free of the path (nothing wired into it, its continuing output
 * open), and not be an end of that wire.
 */
export function spliceProblem(model: FlowModel, nodeId: Ulid, edgeId?: Ulid): string | undefined {
  const entry = model.nodes.get(nodeId);
  if (!entry) return 'No such node';
  const out = CONTINUES_ON[entry.node.type];
  if (!out) return `A ${entry.node.type} node cannot sit on a wire`;
  const level = model.levels.get(entry.level);
  const edges = level?.edges ?? [];
  if (edges.some((e) => e?.to?.node === nodeId)) return 'The node is already wired into a path';
  if (edges.some((e) => e?.from?.node === nodeId && e.from.port === out))
    return `The node's ${out} is already wired`;
  const parent = level?.parent ? model.nodes.get(level.parent)?.node : undefined;
  if (parent?.subflow?.boundary?.in === nodeId) return 'The node is the entry of the subflow';
  for (const refs of Object.values(parent?.subflow?.boundary?.outputs ?? {}))
    if ((refs ?? []).some((r) => r?.node === nodeId && r.port === out))
      return `The node's ${out} already leaves the subflow`;
  if (edgeId) {
    const wire = model.edges.get(edgeId);
    if (!wire) return 'No such wire';
    if (wire.level !== entry.level) return 'The node and the wire must be in the same level';
    if (wire.edge.from.node === nodeId || wire.edge.to.node === nodeId)
      return 'The wire already touches the node';
  }
  return undefined;
}

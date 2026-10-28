// Pure projection of a snapshot into what the canvas draws: nodes with positioned ports and their
// state (D-13), and edges with tone and problem styling (04 §2). No React here, so it is testable.
import { nodeSize } from '../core/flow/geometry';
import { buildModel, ROOT } from '../core/flow/model';
import type { OpenPort } from '../core/flow/openPorts';
import { legalPorts, type PortSpec, type PortTone, portSpec } from '../core/flow/ports';
import type { FlowDocument, FlowNode, NodeStatus, Position, Ulid } from '../core/flow/types';
import type { Snapshot } from '../core/protocol';

/**
 * D-13: filled = connected; amber outline = open fail; gray outline = open on purpose; colored
 * outline = open (enabled) or available (optional, not enabled yet).
 */
export type PortState = 'connected' | 'open-fail' | 'open-purpose' | 'open' | 'available';

export interface PortView extends PortSpec {
  state: PortState;
  /** D-14: shown at rest; the others appear on hover or selection. */
  rest: boolean;
  /** Offset along its side, 0..1; fixed by slot so ports never shift when others appear. */
  offset: number;
}

const REST: ReadonlySet<PortState> = new Set(['connected', 'open-fail', 'open-purpose']);

export interface NodeView {
  node: FlowNode;
  position: Position;
  width: number;
  height: number;
  ports: PortView[];
  openFail: number;
}

export interface EdgeView {
  id: Ulid;
  source: Ulid;
  sourcePort: string;
  target: Ulid;
  targetPort: string;
  tone: PortTone;
  /** Problem ports draw dashed wires (04 §2). */
  problem: boolean;
}

export interface LevelView {
  nodes: NodeView[];
  edges: EdgeView[];
}

export function levelView(
  snapshot: Snapshot,
  optimistic: Record<Ulid, Position> = {},
  levelId: string = ROOT,
): LevelView {
  const doc = snapshot.doc;
  if (!doc) return { nodes: [], edges: [] };
  const level = buildModel(doc).levels.get(levelId);
  if (!level) return { nodes: [], edges: [] };
  const edgeEnds = new Set<string>();
  for (const e of level.edges) {
    if (!e?.from || !e.to) continue;
    edgeEnds.add(`${e.from.node}|${e.from.port}`);
    edgeEnds.add(`${e.to.node}|${e.to.port}`);
  }
  const openFail = new Set(snapshot.openPorts.map((o) => `${o.node}|${o.port}`));
  const decided = new Set((doc.decisions ?? []).map((d) => `${d?.node}|${d?.port}`));
  const layout = doc.layout ?? {};

  const nodes = level.nodes
    .filter((n): n is FlowNode => !!n?.id)
    .map((node) => {
      const position = optimistic[node.id] ??
        layout[node.id] ??
        snapshot.autoPositions[node.id] ?? { x: 0, y: 0 };
      const ports = withOffsets(
        legalPorts(node).map(({ enabled, ...p }) => {
          const id = `${node.id}|${p.name}`;
          let state: PortState = enabled ? 'open' : 'available';
          if (edgeEnds.has(id)) state = 'connected';
          else if (!enabled) state = 'available';
          else if (openFail.has(id)) state = 'open-fail';
          else if (p.fail && decided.has(id)) state = 'open-purpose';
          return { ...p, state, rest: REST.has(state), offset: 0.5 };
        }),
      );
      return {
        node,
        position,
        ...nodeSize(node.type),
        ports,
        openFail: ports.filter((p) => p.state === 'open-fail').length,
      };
    });

  const ids = new Set(nodes.map((n) => n.node.id));
  const edges: EdgeView[] = level.edges
    .filter((e) => e?.from && e.to && ids.has(e.from.node) && ids.has(e.to.node))
    .map((e) => {
      const spec = portSpec(e.from.port);
      return {
        id: e.id,
        source: e.from.node,
        sourcePort: e.from.port,
        target: e.to.node,
        targetPort: e.to.port,
        tone: spec.tone,
        problem: spec.side === 'right',
      };
    });
  return { nodes, edges };
}

/** Positions of nodes shown at in-memory auto positions: written with the next edit so they stay put. */
export function unplacedPositions(
  view: LevelView,
  layout: FlowDocument['layout'],
): Record<Ulid, Position> {
  const out: Record<Ulid, Position> = {};
  for (const n of view.nodes) {
    if (!layout?.[n.node.id])
      out[n.node.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  }
  return out;
}

const GAP = 24;

/** First spot at or below `at` where a box of `size` overlaps no node (with a gap). */
export function freeSpot(
  view: LevelView,
  at: Position,
  size: { width: number; height: number },
): Position {
  const hits = (p: Position) =>
    view.nodes.some(
      (n) =>
        p.x < n.position.x + n.width + GAP &&
        p.x + size.width + GAP > n.position.x &&
        p.y < n.position.y + n.height + GAP &&
        p.y + size.height + GAP > n.position.y,
    );
  const spot = { x: Math.round(at.x), y: Math.round(at.y) };
  for (let i = 0; i < 40 && hits(spot); i++) spot.y += 40;
  return spot;
}

/** Where a node attached to a port goes: right of problem ports, below the others (D-12). */
export function besidePort(view: LevelView, node: Ulid, port: string): Position | undefined {
  const source = view.nodes.find((n) => n.node.id === node);
  if (!source) return undefined;
  const side = source.ports.find((p) => p.name === port)?.side ?? 'bottom';
  const size = nodeSize('task');
  const at =
    side === 'right'
      ? { x: source.position.x + source.width + 90, y: source.position.y }
      : { x: source.position.x, y: source.position.y + source.height + 70 };
  return freeSpot(view, at, size);
}

function withOffsets(ports: PortView[]): PortView[] {
  const bySide = new Map<string, PortView[]>();
  for (const p of ports) bySide.set(p.side, [...(bySide.get(p.side) ?? []), p]);
  for (const list of bySide.values()) {
    list.forEach((p, i) => {
      p.offset = (i + 1) / (list.length + 1);
    });
  }
  return ports;
}

export interface Readiness {
  counts: Record<NodeStatus, number>;
  total: number;
}

/** Status counters over every designable node (start/end excluded), all levels. */
export function readiness(doc: FlowDocument | null): Readiness {
  const counts: Record<NodeStatus, number> = { draft: 0, specified: 0, implemented: 0, tested: 0 };
  let total = 0;
  if (!doc) return { counts, total };
  for (const { node } of buildModel(doc).nodes.values()) {
    if (node.type === 'start' || node.type === 'end') continue;
    counts[node.status ?? 'draft']++;
    total++;
  }
  return { counts, total };
}

/** Top-level banner count: every open fail port that is not open on purpose (bubbling applied). */
export function bannerCount(openPorts: readonly OpenPort[]): number {
  return openPorts.length;
}

export const STATUS_ORDER: readonly NodeStatus[] = ['draft', 'specified', 'implemented', 'tested'];

/** What a node lacks for its next lifecycle stage (mockup 03), or undefined at the last one. */
export function nextRequirement(node: FlowNode): string | undefined {
  switch (node.status ?? 'draft') {
    case 'draft':
      return 'Define at least one input or output to make it specified';
    case 'specified':
      return 'Bind a module, role or playbook to make it implemented (M5)';
    case 'implemented':
      return 'Record a passing run of this flow version to make it tested (M7)';
    default:
      return undefined;
  }
}

/** The walking-skeleton task a draft node compiles to (05, D-03). */
export function skeletonStub(node: FlowNode): string {
  const msg = `TODO: ${node.intent ?? node.title}`.replaceAll('"', '\\"');
  return `- name: "[${node.key}] TODO"\n  ansible.builtin.debug:\n    msg: "${msg}"`;
}

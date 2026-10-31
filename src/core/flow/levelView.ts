// Pure projection of a flow level into what the canvas draws: nodes with positioned ports and their
// state (D-13), edges with tone and problem styling (04 §2), and a subflow's boundary frame (D-23).
// Shared by the webview canvas and the exports (AFD-25), so a picture matches the canvas.
import type { Snapshot } from '../protocol';
import { nodeSize } from './geometry';
import { modelOf, ROOT } from './model';
import { legalPorts, type PortSpec, type PortTone, portSpec } from './ports';
import type { FlowNode, Position, Ulid } from './types';

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
  const model = modelOf(doc);
  const level = model.levels.get(levelId);
  if (!level) return { nodes: [], edges: [] };
  const edgeEnds = new Set<string>();
  for (const e of level.edges) {
    if (!e?.from || !e.to) continue;
    edgeEnds.add(`${e.from.node}|${e.from.port}`);
    edgeEnds.add(`${e.to.node}|${e.to.port}`);
  }
  // Inside a subflow the entry and the exits are wires too (D-23).
  const boundary = level.parent ? model.nodes.get(level.parent)?.node.subflow?.boundary : undefined;
  if (boundary?.in) edgeEnds.add(`${boundary.in}|in`);
  for (const refs of Object.values(boundary?.outputs ?? {}))
    for (const r of refs ?? []) edgeEnds.add(`${r?.node}|${r?.port}`);
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

// ---- subflow levels (M4, D-23) -------------------------------------------------------------------

export const FRAME_PREFIX = 'boundary:';
const FRAME_PAD = { x: 64, top: 72, bottom: 72 };
const EMPTY_FRAME = { width: 420, height: 280 };

export type FramePortState = 'connected' | 'bubbled' | 'unfed' | 'available';

export interface FramePortView {
  name: string;
  side: 'top' | 'bottom' | 'right';
  tone: PortTone;
  fail: boolean;
  state: FramePortState;
  offset: number;
}

export interface BoundaryEdgeView {
  id: string;
  kind: 'entry' | 'exit';
  source: string;
  sourcePort: string;
  target: string;
  targetPort: string;
  tone: PortTone;
  problem: boolean;
  label: string;
  /** Exits: the inner port and the parent port it leaves through. */
  exit?: { from: { node: Ulid; port: string }; port: string; reason?: string };
}

export interface BoundaryView {
  subflow: FlowNode;
  id: string;
  frame: { x: number; y: number; width: number; height: number };
  ports: FramePortView[];
  edges: BoundaryEdgeView[];
}

/**
 * The dashed frame around a subflow's inner level: the parent's ports on its edges (`in` on top,
 * outcomes below, problems right), the entry wire and one wire per exit (D-23, mockup 10).
 */
export function boundaryView(
  snapshot: Snapshot,
  view: LevelView,
  levelId: string,
): BoundaryView | undefined {
  const doc = snapshot.doc;
  if (!doc || levelId === ROOT) return undefined;
  const subflow = modelOf(doc).nodes.get(levelId)?.node;
  if (!subflow) return undefined;
  const boundary = subflow.subflow?.boundary;
  const id = `${FRAME_PREFIX}${subflow.id}`;

  let frame = { x: 0, y: 0, ...EMPTY_FRAME };
  if (view.nodes.length > 0) {
    const xs = view.nodes.flatMap((n) => [n.position.x, n.position.x + n.width]);
    const ys = view.nodes.flatMap((n) => [n.position.y, n.position.y + n.height]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    frame = {
      x: x0 - FRAME_PAD.x,
      y: y0 - FRAME_PAD.top,
      width: Math.max(EMPTY_FRAME.width, x1 - x0 + 2 * FRAME_PAD.x),
      height: Math.max(EMPTY_FRAME.height, y1 - y0 + FRAME_PAD.top + FRAME_PAD.bottom),
    };
  }

  const inner = view.nodes.map((n) => n.node);
  const wired = new Set(view.edges.map((e) => `${e.source}|${e.sourcePort}`));
  const exited = new Set(
    Object.values(boundary?.outputs ?? {}).flatMap((refs) =>
      (refs ?? []).map((r) => `${r?.node}|${r?.port}`),
    ),
  );
  const ports: FramePortView[] = [];
  for (const p of legalPorts(subflow)) {
    if (p.name === 'undo' || p.name === 'cancelled') continue;
    if (p.direction === 'in') {
      ports.push({
        name: p.name,
        side: 'top',
        tone: p.tone,
        fail: false,
        state: boundary?.in ? 'connected' : 'unfed',
        offset: 0.5,
      });
      continue;
    }
    let state: FramePortState = p.enabled ? 'unfed' : 'available';
    if ((boundary?.outputs?.[p.name] ?? []).length > 0) state = 'connected';
    else if (
      p.enabled &&
      p.fail &&
      inner.some(
        (n) =>
          portSpecsOf(n).has(p.name) &&
          !wired.has(`${n.id}|${p.name}`) &&
          !exited.has(`${n.id}|${p.name}`),
      )
    )
      state = 'bubbled';
    ports.push({
      name: p.name,
      side: p.side === 'right' ? 'right' : 'bottom',
      tone: p.tone,
      fail: p.fail,
      state,
      offset: 0,
    });
  }
  for (const side of ['bottom', 'right'] as const) {
    const list = ports.filter((p) => p.side === side);
    list.forEach((p, i) => {
      p.offset = (i + 1) / (list.length + 1);
    });
  }

  const edges: BoundaryEdgeView[] = [];
  const ids = new Set(inner.map((n) => n.id));
  if (boundary?.in && ids.has(boundary.in)) {
    edges.push({
      id: `entry:${subflow.id}`,
      kind: 'entry',
      source: id,
      sourcePort: 'in',
      target: boundary.in,
      targetPort: 'in',
      tone: 'neutral',
      problem: false,
      label: 'in',
    });
  }
  for (const [port, refs] of Object.entries(boundary?.outputs ?? {})) {
    for (const r of refs ?? []) {
      if (!r?.node || !ids.has(r.node)) continue;
      const spec = portSpec(port);
      edges.push({
        id: `exit:${subflow.id}|${r.node}|${r.port}|${port}`,
        kind: 'exit',
        source: r.node,
        sourcePort: r.port,
        target: id,
        targetPort: port,
        tone: portSpec(r.port).tone,
        problem: spec.side === 'right',
        label: r.reason ?? port,
        exit: { from: { node: r.node, port: r.port }, port, reason: r.reason },
      });
    }
  }
  return { subflow, id, frame, ports, edges };
}

function portSpecsOf(node: FlowNode): Set<string> {
  return new Set(
    legalPorts(node)
      .filter((p) => p.enabled)
      .map((p) => p.name),
  );
}

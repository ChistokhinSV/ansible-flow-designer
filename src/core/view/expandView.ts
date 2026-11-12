// AFD-243: a subflow expanded in place. Its node grows into a frame on its own
// level and its inner steps and wires are drawn inside, so a level and what its subflows hold are
// read together without opening each one. A view only: nothing here is stored, and the steps
// around the frame are pushed aside on screen, never in the file (`shift` says by how much, so a
// drag saves the place a step would have with the frame closed).
import type { EdgeView, LevelView, NodeView } from '../flow/levelView';
import type { Position, Ulid } from '../flow/types';

/** Room round the inner steps: the frame's title above, a margin on the other sides. */
const HEAD = 44;
const PAD = 28;

export interface Expansion {
  view: LevelView;
  /** How far each node of the level is drawn from where it is stored. */
  shift: Record<Ulid, Position>;
  /** Inner steps drawn on this level, each with the subflow that holds it. */
  inner: Record<Ulid, Ulid>;
  /** The subflows drawn as frames. */
  frames: ReadonlySet<Ulid>;
}

const NONE: Expansion = {
  view: { nodes: [], edges: [], annotations: [] },
  shift: {},
  inner: {},
  frames: new Set(),
};

export function expandLevel(
  view: LevelView,
  innerOf: (subflow: Ulid) => LevelView,
  expanded: readonly Ulid[],
): Expansion {
  const open = view.nodes.filter((n) => n.node.type === 'subflow' && expanded.includes(n.node.id));
  if (open.length === 0) return { ...NONE, view };
  // Top to bottom, so a frame pushes what is under it before that is expanded itself.
  const order = [...open].sort((a, b) => a.position.y - b.position.y).map((n) => n.node.id);
  const at = new Map<Ulid, NodeView>(view.nodes.map((n) => [n.node.id, { ...n }]));
  const shift: Record<Ulid, Position> = {};
  const move = (id: Ulid, dx: number, dy: number) => {
    const n = at.get(id);
    if (!n || (dx === 0 && dy === 0)) return;
    n.position = { x: n.position.x + dx, y: n.position.y + dy };
    const was = shift[id] ?? { x: 0, y: 0 };
    shift[id] = { x: was.x + dx, y: was.y + dy };
  };
  const inner: Record<Ulid, Ulid> = {};
  const frames = new Set<Ulid>();
  // Inner steps by their place in their frame: a frame may still be pushed by a later one.
  const extraNodes: { node: NodeView; frame: Ulid; rel: Position }[] = [];
  const extraEdges: EdgeView[] = [];
  for (const id of order) {
    const sub = at.get(id);
    const inside = innerOf(id);
    if (!sub || inside.nodes.length === 0) continue;
    const left = Math.min(...inside.nodes.map((n) => n.position.x));
    const top = Math.min(...inside.nodes.map((n) => n.position.y));
    const right = Math.max(...inside.nodes.map((n) => n.position.x + n.width));
    const bottom = Math.max(...inside.nodes.map((n) => n.position.y + n.height));
    const width = Math.max(sub.width, right - left + 2 * PAD);
    const height = bottom - top + HEAD + PAD;
    const dw = width - sub.width;
    const dh = height - sub.height;
    const was = { ...sub.position, width: sub.width, height: sub.height };
    const middle = was.x + was.width / 2;
    // The frame grows about its own middle, so its ports stay on the line of the flow.
    for (const other of at.values()) {
      if (other.node.id === id) continue;
      const below = other.position.y >= was.y + was.height;
      const beside =
        !below && other.position.y + other.height > was.y && other.position.y < was.y + height;
      if (below) move(other.node.id, 0, dh);
      else if (beside)
        move(other.node.id, other.position.x + other.width / 2 >= middle ? dw / 2 : -dw / 2, 0);
    }
    move(id, -dw / 2, 0);
    sub.width = width;
    sub.height = height;
    frames.add(id);
    const origin = { x: (width - (right - left)) / 2 - left, y: HEAD - top };
    for (const n of inside.nodes) {
      inner[n.node.id] = id;
      extraNodes.push({
        node: n,
        frame: id,
        rel: { x: n.position.x + origin.x, y: n.position.y + origin.y },
      });
    }
    for (const e of inside.edges) extraEdges.push({ ...e, inner: true });
  }
  if (frames.size === 0) return { ...NONE, view };
  const placed = extraNodes.map(({ node, frame, rel }) => {
    const origin = (at.get(frame) as NodeView).position;
    return { ...node, position: { x: origin.x + rel.x, y: origin.y + rel.y } };
  });
  return {
    view: {
      nodes: [...view.nodes.map((n) => at.get(n.node.id) as NodeView), ...placed],
      edges: [...view.edges, ...extraEdges],
      annotations: view.annotations,
    },
    shift,
    inner,
    frames,
  };
}

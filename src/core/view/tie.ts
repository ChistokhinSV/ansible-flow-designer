// The dashed tie between a Note and its node (AFD-65): from border to border on the line between
// their centres, so it never runs under either box. Shared by the canvas and the exports.
// AFD-350: that line reaches the node in the middle of a side, where its ports are (the ok port
// under a node, the fail ports beside it), and ran across the port, its wire and the wire's label.
// Given the node's ports, the tie reaches the node elsewhere on its border: the shortest tie that
// keeps clear of every port and the stub its wire leaves by.
import type { PortSide } from '../flow/ports';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Point {
  x: number;
  y: number;
}

/** A port of the node, as the canvas places it: a side and how far along it (0..1). */
export interface TiePort {
  side: PortSide;
  offset: number;
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Where the line from the box's centre toward `to` leaves the box. */
function border(b: Box, to: Point) {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : b.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : b.height / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** A port's centre on the box, and the way its wire leaves. */
function portAt(b: Box, p: TiePort): { at: Point; out: Point } {
  if (p.side === 'top')
    return { at: { x: b.x + b.width * p.offset, y: b.y }, out: { x: 0, y: -1 } };
  if (p.side === 'bottom')
    return { at: { x: b.x + b.width * p.offset, y: b.y + b.height }, out: { x: 0, y: 1 } };
  if (p.side === 'left')
    return { at: { x: b.x, y: b.y + b.height * p.offset }, out: { x: -1, y: 0 } };
  return { at: { x: b.x + b.width, y: b.y + b.height * p.offset }, out: { x: 1, y: 0 } };
}

/** Distance between segments a–b and c–d (0 when they cross). */
function apart(a: Point, b: Point, c: Point, d: Point): number {
  const cross = (o: Point, p: Point, q: Point) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const d1 = cross(c, d, a);
  const d2 = cross(c, d, b);
  const d3 = cross(a, b, c);
  const d4 = cross(a, b, d);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0)))
    return 0;
  const toSeg = (p: Point, s: Point, t: Point) => {
    const vx = t.x - s.x;
    const vy = t.y - s.y;
    const len = vx * vx + vy * vy;
    const k = len ? Math.max(0, Math.min(1, ((p.x - s.x) * vx + (p.y - s.y) * vy) / len)) : 0;
    return Math.hypot(p.x - (s.x + k * vx), p.y - (s.y + k * vy));
  };
  return Math.min(toSeg(a, c, d), toSeg(b, c, d), toSeg(c, a, b), toSeg(d, a, b));
}

/** How far a wire runs straight out of its port (the router's stub 20, and its label's room). */
const STUB = 30;
/** How far a tie keeps from a port and its stub. */
const CLEAR = 12;
/** Points tried on each side of the node, as fractions along it (not the corners). */
const ALONG = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/**
 * The tie from a Note to its node, or undefined when the boxes overlap (nothing to draw). With the
 * node's ports, it keeps clear of them and of their wires' stubs where the node's border allows.
 */
export function tieLine(
  note: Box,
  node: Box,
  ports: readonly TiePort[] = [],
): { from: Point; to: Point } | undefined {
  if (overlap(note, node)) return undefined;
  const straight = { from: border(note, centre(node)), to: border(node, centre(note)) };
  if (!ports.length) return straight;
  const stubs = ports.map((p) => {
    const { at, out } = portAt(node, p);
    return [at, { x: at.x + out.x * STUB, y: at.y + out.y * STUB }] as const;
  });
  const clear = (from: Point, to: Point) =>
    stubs.every(([s, t]) => apart(from, to, s, t) >= CLEAR) &&
    // Not back across the node: the tie reaches the side that faces the note.
    !crossesNode(from, to, node);
  if (clear(straight.from, straight.to)) return straight;
  let best: { from: Point; to: Point; length: number } | undefined;
  for (const side of ['top', 'right', 'bottom', 'left'] as const)
    for (const offset of ALONG) {
      const to = portAt(node, { side, offset }).at;
      const from = border(note, to);
      if (!clear(from, to)) continue;
      const length = Math.hypot(to.x - from.x, to.y - from.y);
      if (!best || length < best.length) best = { from, to, length };
    }
  return best ? { from: best.from, to: best.to } : straight;
}

/** Whether the segment runs through the node's inside (a point on its border is not inside). */
function crossesNode(a: Point, b: Point, n: Box): boolean {
  for (let i = 1; i < 8; i++) {
    const k = i / 8;
    const x = a.x + (b.x - a.x) * k;
    const y = a.y + (b.y - a.y) * k;
    if (x > n.x + 1 && x < n.x + n.width - 1 && y > n.y + 1 && y < n.y + n.height - 1) return true;
  }
  return false;
}

// Wires that step round nodes (AFD-70). A wire is React Flow's smooth step from port to port, as
// before, wherever that clears every node box. Where it would run through one (a wire that skips a
// step, or one back up the flow), it takes an orthogonal route round the boxes instead: short, few
// turns, clear of the boxes, drawn with the same stubs and rounded corners. The canvas edge, the
// export scenes and the layout check all route here, so every picture of a level shows the same
// wires.
import { getSmoothStepPath, Position as Side } from '@xyflow/system';
import type { Position } from '../flow/types';

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Route {
  /** SVG path in canvas pixels. */
  path: string;
  /** Where the wire's label sits. */
  label: Position;
  /** A route round boxes: its corners between the two ends (draw.io waypoints). */
  bends?: Position[];
}

/** getSmoothStepPath's defaults: the stub out of a port and the corner radius. */
const OFFSET = 20;
const RADIUS = 5;
/** A wire that only grazes a box edge is not through it: boxes shrink by this much first. */
export const INSET = 2;
/** Routes keep as far from a box as a stub keeps from its node (handle face 5 + stub 20)... */
const CLEAR = 25;
/** ...and, in a narrow gap, never come closer than this. */
const GAP = 8;
/** A bend costs as much as this much more wire... */
const BEND = 40;
/** ...and wire closer to a box than CLEAR costs this much more again... */
const NEAR = 1;
/**
 * ...and wire off the two lines through its stub ends a little more, so of equal routes it takes
 * the one that turns onto its stubs: wires into one port then share their last stretch.
 */
const DRIFT = 0.01;

/** Directions of travel, clockwise from up; a port's side is the way its stub leaves. */
const DIRS: Position[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];
const DIR_OF: Record<Side, number> = {
  [Side.Top]: 0,
  [Side.Right]: 1,
  [Side.Bottom]: 2,
  [Side.Left]: 3,
};

// ---- geometry shared with the layout check ------------------------------------------------------

/** The corners a stepped path passes: its M, L and Q points in order (Q's control is a corner). */
export function pointsOf(path: string): Position[] {
  const n = path.match(/-?\d+(\.\d+)?(e-?\d+)?/g)?.map(Number) ?? [];
  const out: Position[] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push({ x: n[i] as number, y: n[i + 1] as number });
  return out;
}

export const overlaps = (a: Box, b: Box) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** The box shrunk by `by` on every side (grown when negative). */
export const inset = (b: Box, by: number): Box => ({
  x: b.x + by,
  y: b.y + by,
  width: Math.max(0, b.width - 2 * by),
  height: Math.max(0, b.height - 2 * by),
});

/** Whether segment a–b passes through the box (Liang–Barsky clipping). */
export function segmentHits(a: Position, b: Position, r: Box): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const edges: [number, number][] = [
    [-dx, a.x - r.x],
    [dx, r.x + r.width - a.x],
    [-dy, a.y - r.y],
    [dy, r.y + r.height - a.y],
  ];
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false;
      continue;
    }
    const t = q / p;
    if (p < 0) t0 = Math.max(t0, t);
    else t1 = Math.min(t1, t);
    if (t0 > t1) return false;
  }
  return true;
}

/** Whether a polyline runs through any of the boxes. */
export function runsThrough(points: Position[], boxes: readonly Box[]): boolean {
  for (const box of boxes) {
    const r = inset(box, INSET);
    for (let i = 0; i + 1 < points.length; i++)
      if (segmentHits(points[i] as Position, points[i + 1] as Position, r)) return true;
  }
  return false;
}

/** A wire label as the canvas draws it: 10 px mono text (6 px a character) on a padded background. */
export function labelBox(text: string, at: Position): Box {
  const w = [...text].length * 6 + 8;
  return { x: at.x - w / 2, y: at.y - 8, width: w, height: 16 };
}

// ---- routing ------------------------------------------------------------------------------------

/**
 * The wire from `a` (leaving by side `from`) to `b` (entered by side `to`) among the node boxes of
 * its level, its own two included. `label` is the text it shows, kept off the boxes on a route.
 */
export function routeWire(
  a: Position,
  from: Side,
  b: Position,
  to: Side,
  boxes: readonly Box[],
  label?: string,
): Route {
  const [path, x, y] = getSmoothStepPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: from,
    targetX: b.x,
    targetY: b.y,
    targetPosition: to,
  });
  const step = { path, label: { x, y } };
  if (!runsThrough(pointsOf(path), boxes)) return step;
  // Boxed in (a node on a port, or no gap wide enough): the smooth step, as before.
  const points = roundBoxes(a, DIR_OF[from], b, DIR_OF[to], boxes);
  if (!points) return step;
  return { path: pathOf(points), label: labelOn(points, boxes, label), bends: points.slice(1, -1) };
}

/** Grid lines: the stub ends, the lines CLEAR off each box edge, and the middle of a gap too narrow for those. */
function lines(s: number, t: number, edges: [number, number][]): number[] {
  const all = edges.flat().sort((p, q) => p - q);
  const out = [s, t];
  for (const [lo, hi] of edges) out.push(lo - CLEAR, hi + CLEAR);
  for (let i = 0; i + 1 < all.length; i++) {
    const gap = (all[i + 1] as number) - (all[i] as number);
    if (gap > 2 * GAP && gap < 2 * CLEAR)
      out.push(((all[i] as number) + (all[i + 1] as number)) / 2);
  }
  return [...new Set(out)].sort((p, q) => p - q);
}

/**
 * The route's corners, from `a` to `b`, keeping the smooth step's stubs: it leaves the source stub
 * heading out and enters the target stub heading in. Nodes far off the two ends are left out of
 * the search; when that finds nothing, it runs again with every node.
 */
function roundBoxes(
  a: Position,
  from: number,
  b: Position,
  to: number,
  boxes: readonly Box[],
): Position[] | undefined {
  const out = DIRS[from] as Position;
  const back = DIRS[to] as Position;
  const s = { x: a.x + out.x * OFFSET, y: a.y + out.y * OFFSET };
  const t = { x: b.x + back.x * OFFSET, y: b.y + back.y * OFFSET };
  if (runsThrough([a, s], boxes) || runsThrough([t, b], boxes)) return undefined;
  for (const reach of [REACH, Number.POSITIVE_INFINITY]) {
    const near = nearby(s, t, boxes, reach);
    const found = search(s, from, t, (to + 2) % 4, near);
    if (found) return corners([a, ...found, b]);
    if (near.length === boxes.length) break;
  }
  return undefined;
}

/** How far round the two ends a first search looks: about two node widths. */
const REACH = 400;

/**
 * The boxes within `reach` of the box spanning s and t, and then every box the search grid they
 * make would reach, so a grid segment can never jump a box it does not know.
 */
function nearby(s: Position, t: Position, boxes: readonly Box[], reach: number): readonly Box[] {
  if (!Number.isFinite(reach)) return boxes;
  const span = (pts: Position[], pad: number): Box => {
    const xs = pts.map((p) => p.x);
    const ys = pts.map((p) => p.y);
    const [x, y] = [Math.min(...xs) - pad, Math.min(...ys) - pad];
    return { x, y, width: Math.max(...xs) + pad - x, height: Math.max(...ys) + pad - y };
  };
  let near = boxes.filter((r) => overlaps(r, span([s, t], reach)));
  for (;;) {
    const grid = span(
      [s, t, ...near.flatMap((r) => [r, { x: r.x + r.width, y: r.y + r.height }])],
      CLEAR + GAP,
    );
    const more = boxes.filter((r) => near.includes(r) || overlaps(r, grid));
    if (more.length === near.length) return near;
    near = more;
  }
}

/**
 * A* over a grid of lines in (point, direction) states: cost is length (more near a box) plus
 * BEND a turn, and no U-turns. A stretch into a box is not taken. From s heading `from` to t heading `into`; the grid points passed.
 */
function search(
  s: Position,
  from: number,
  t: Position,
  into: number,
  boxes: readonly Box[],
): Position[] | undefined {
  const xs = lines(
    s.x,
    t.x,
    boxes.map((r) => [r.x, r.x + r.width]),
  );
  const ys = lines(
    s.y,
    t.y,
    boxes.map((r) => [r.y, r.y + r.height]),
  );
  const nx = xs.length;
  const ny = ys.length;
  // Per stretch between neighbouring grid points, across (i,j)-(i+1,j) and down (i,j)-(i,j+1):
  // -1 when it enters a box grown by GAP, else how much of it runs closer to a box than CLEAR.
  const across = new Float32Array(nx * ny);
  const down = new Float32Array(nx * ny);
  const mark = (
    to: Float32Array,
    k: number,
    lo: number,
    hi: number,
    g0: number,
    g1: number,
    c0: number,
    c1: number,
    inside: boolean,
  ) => {
    if (hi <= c0 || lo >= c1 || (to[k] as number) < 0) return;
    if (inside && hi > g0 && lo < g1) to[k] = -1;
    else to[k] = Math.max(to[k] as number, Math.min(hi, c1) - Math.max(lo, c0));
  };
  for (const r of boxes) {
    const [gx0, gx1, gy0, gy1] = [r.x - GAP, r.x + r.width + GAP, r.y - GAP, r.y + r.height + GAP];
    const [cx0, cx1, cy0, cy1] = [
      r.x - CLEAR,
      r.x + r.width + CLEAR,
      r.y - CLEAR,
      r.y + r.height + CLEAR,
    ];
    for (let j = 0; j < ny; j++) {
      const y = ys[j] as number;
      if (y <= cy0 || y >= cy1) continue;
      for (let i = 0; i + 1 < nx; i++)
        mark(
          across,
          i * ny + j,
          xs[i] as number,
          xs[i + 1] as number,
          gx0,
          gx1,
          cx0,
          cx1,
          y > gy0 && y < gy1,
        );
    }
    for (let i = 0; i < nx; i++) {
      const x = xs[i] as number;
      if (x <= cx0 || x >= cx1) continue;
      for (let j = 0; j + 1 < ny; j++)
        mark(
          down,
          i * ny + j,
          ys[j] as number,
          ys[j + 1] as number,
          gy0,
          gy1,
          cy0,
          cy1,
          x > gx0 && x < gx1,
        );
    }
  }
  const inBox = (p: Position) =>
    boxes.some(
      (r) =>
        p.x > r.x - GAP &&
        p.x < r.x + r.width + GAP &&
        p.y > r.y - GAP &&
        p.y < r.y + r.height + GAP,
    );
  if (inBox(s) || inBox(t)) return undefined;
  const si = xs.indexOf(s.x);
  const sj = ys.indexOf(s.y);
  const ti = xs.indexOf(t.x);
  const tj = ys.indexOf(t.y);
  const states = nx * ny * 4;
  const cost = new Float64Array(states).fill(Number.POSITIVE_INFINITY);
  const prev = new Int32Array(states).fill(-1);
  // Distance left, plus the turns any route from here must still make (a lower bound, so A*
  // stays exact): none straight ahead in the right heading, one from a heading across it, else two.
  // At t itself none: the step onto t paid for its last turn.
  const h = (i: number, j: number, d: number) => {
    const dx = t.x - (xs[i] as number);
    const dy = t.y - (ys[j] as number);
    if (dx === 0 && dy === 0) return 0;
    const step = DIRS[d] as Position;
    const turns =
      d === into
        ? dx * step.y === dy * step.x && dx * step.x + dy * step.y >= 0
          ? 0
          : 2
        : d === (into + 2) % 4
          ? 2
          : 1;
    return Math.abs(dx) + Math.abs(dy) + turns * BEND;
  };
  const heap = new Heap();
  const start = (si * ny + sj) * 4 + from;
  cost[start] = 0;
  heap.push(h(si, sj, from), 0, start);
  let goal = -1;
  while (heap.size > 0) {
    const { key: f, value: k } = heap.pop();
    const d = k % 4;
    const p = (k - d) / 4;
    const i = Math.floor(p / ny);
    const j = p % ny;
    if (f > (cost[k] as number) + h(i, j, d)) continue;
    if (i === ti && j === tj) {
      goal = k;
      break;
    }
    for (let nd = 0; nd < 4; nd++) {
      if (nd === (d + 2) % 4) continue;
      const step = DIRS[nd] as Position;
      const ni = i + step.x;
      const nj = j + step.y;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const flat = nd % 2 === 1;
      const near = flat
        ? (across[Math.min(i, ni) * ny + j] as number)
        : (down[i * ny + Math.min(j, nj)] as number);
      if (near < 0) continue;
      const x = xs[i] as number;
      const y = ys[j] as number;
      const len = flat ? Math.abs((xs[ni] as number) - x) : Math.abs((ys[nj] as number) - y);
      const stub = flat ? y === s.y || y === t.y : x === s.x || x === t.x;
      let c =
        (cost[k] as number) + len * (stub ? 1 : 1 + DRIFT) + near * NEAR + (nd === d ? 0 : BEND);
      const nk = (ni * ny + nj) * 4 + nd;
      if (ni === ti && nj === tj) {
        if (nd === (into + 2) % 4) continue;
        if (nd !== into) c += BEND;
      }
      if (c < (cost[nk] as number)) {
        cost[nk] = c;
        prev[nk] = k;
        heap.push(c + h(ni, nj, nd), c, nk);
      }
    }
  }
  if (goal < 0) return undefined;
  const path: Position[] = [];
  for (let k = goal; k >= 0; k = prev[k] as number) {
    const p = (k - (k % 4)) / 4;
    path.push({ x: xs[Math.floor(p / ny)] as number, y: ys[p % ny] as number });
  }
  return path.reverse();
}

/** The points where the route turns, with its two ends. */
function corners(points: Position[]): Position[] {
  const out: Position[] = [];
  for (const p of points) {
    const q = out.at(-1);
    if (q && q.x === p.x && q.y === p.y) continue;
    const o = out.at(-2);
    if (o && q && ((o.x === q.x && q.x === p.x) || (o.y === q.y && q.y === p.y))) out.pop();
    out.push(p);
  }
  return out;
}

/** The route as getSmoothStepPath draws its own points: rounded corners of radius RADIUS. */
function pathOf(points: Position[]): string {
  const first = points[0] as Position;
  const last = points.at(-1) as Position;
  let path = `M${first.x} ${first.y}`;
  for (let i = 1; i < points.length - 1; i++)
    path += bendAt(points[i - 1] as Position, points[i] as Position, points[i + 1] as Position);
  return `${path}L${last.x} ${last.y}`;
}

/** @xyflow/system's getBend (not exported), so a route's corners match a smooth step's. */
function bendAt(a: Position, b: Position, c: Position): string {
  const size = Math.min(
    Math.hypot(a.x - b.x, a.y - b.y) / 2,
    Math.hypot(b.x - c.x, b.y - c.y) / 2,
    RADIUS,
  );
  const { x, y } = b;
  if ((a.x === x && x === c.x) || (a.y === y && y === c.y)) return `L${x} ${y}`;
  if (a.y === y) {
    const xDir = a.x < c.x ? -1 : 1;
    const yDir = a.y < c.y ? 1 : -1;
    return `L ${x + size * xDir},${y}Q ${x},${y} ${x},${y + size * yDir}`;
  }
  const xDir = a.x < c.x ? 1 : -1;
  const yDir = a.y < c.y ? -1 : 1;
  return `L ${x},${y + size * yDir}Q ${x},${y} ${x + size * xDir},${y}`;
}

/** Length of a straight stretch. */
const length = (p: Position, q: Position) => Math.abs(q.x - p.x) + Math.abs(q.y - p.y);

/**
 * Where a route's label goes: on the first stretch from the source that holds it clear of every
 * box, as near that stretch's middle as it can, so a label names the port its wire leaves by.
 * Without a clear spot, half way along.
 */
function labelOn(points: Position[], boxes: readonly Box[], text: string | undefined): Position {
  for (let i = 0; text && i + 1 < points.length; i++) {
    const p = points[i] as Position;
    const q = points[i + 1] as Position;
    const len = length(p, q);
    const along = p.y === q.y ? labelBox(text, p).width : 16;
    const room = (len - along - 8) / 2;
    const ux = Math.sign(q.x - p.x);
    const uy = Math.sign(q.y - p.y);
    for (let k = 0; k <= room; k += 8)
      for (const sign of k ? [-1, 1] : [1]) {
        const o = len / 2 + sign * k;
        const at = { x: p.x + ux * o, y: p.y + uy * o };
        const box = labelBox(text, at);
        if (!boxes.some((r) => overlaps(box, r))) return at;
      }
  }
  const legs = points.slice(1).map((q, i) => length(points[i] as Position, q));
  let rest = legs.reduce((sum, len) => sum + len, 0) / 2;
  for (let i = 0; i + 1 < points.length; i++) {
    const p = points[i] as Position;
    const q = points[i + 1] as Position;
    const len = legs[i] as number;
    if (rest <= len)
      return { x: p.x + Math.sign(q.x - p.x) * rest, y: p.y + Math.sign(q.y - p.y) * rest };
    rest -= len;
  }
  return points[0] as Position;
}

/**
 * A binary min-heap of states by priority. Of equal priorities the one furthest along goes first
 * (else A* widens over every equally short path on a grid), then the first pushed, so a route is
 * the same wherever it is drawn. The heap holds entry numbers; an entry's fields are stored once.
 */
class Heap {
  private heap: number[] = [];
  private keys: number[] = [];
  private depths: number[] = [];
  private values: number[] = [];

  get size(): number {
    return this.heap.length;
  }

  push(key: number, depth: number, value: number): void {
    const e = this.keys.length;
    this.keys.push(key);
    this.depths.push(depth);
    this.values.push(value);
    const h = this.heap;
    let i = h.length;
    h.push(e);
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (!this.before(e, h[up] as number)) break;
      h[i] = h[up] as number;
      i = up;
    }
    h[i] = e;
  }

  /** Takes the first entry off: its priority and value. */
  pop(): { key: number; value: number } {
    const h = this.heap;
    const top = h[0] as number;
    const last = h.pop() as number;
    if (h.length > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        if (l >= h.length) break;
        const r = l + 1;
        const c = r < h.length && this.before(h[r] as number, h[l] as number) ? r : l;
        if (!this.before(h[c] as number, last)) break;
        h[i] = h[c] as number;
        i = c;
      }
      h[i] = last;
    }
    return { key: this.keys[top] as number, value: this.values[top] as number };
  }

  private before(a: number, b: number): boolean {
    const ka = this.keys[a] as number;
    const kb = this.keys[b] as number;
    if (ka !== kb) return ka < kb;
    const da = this.depths[a] as number;
    const db = this.depths[b] as number;
    return da !== db ? da > db : a < b;
  }
}

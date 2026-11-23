// Wires side by side (AFD-345). Each wire is routed on its own (routeWire), so two different wires
// can take the same line for a stretch: an `ok` wire along a dashed `failed_hosts` one, through its
// label, and nobody can tell which goes where. This pass looks at every wire of a level at once:
// stretches of different wires on one line move into lanes LANE px apart, each wire keeping its
// own turns and its stubs, and a label that sits on another wire moves along its own wire to a
// clear spot. Wires into one target port still share their last stretch (DRIFT in route.ts makes
// them do so on purpose). The canvas, the export scenes and the layout check all run it, so every
// picture of a level shows the same wires.
import type { Position } from '../flow/types';
import {
  type Box,
  bezierPoints,
  CURVE_RADIUS,
  labelBox,
  overlaps,
  pathOf,
  pointsOf,
  RADIUS,
  type Route,
  runsThrough,
  segmentHits,
  type WireStyle,
} from './route';

/** One wire of a level as routeWire drew it, with the ports it joins. */
export interface LaneWire {
  id: string;
  /** Its two ends, as passed to routeWire. */
  a: Position;
  b: Position;
  /** The ports it leaves and enters, as `node.port`: wires into one port may share a stretch. */
  from: string;
  to: string;
  route: Route;
  /** The text its label shows, if it shows one. */
  label?: string;
  style?: WireStyle;
}

/** How far apart wires that share a line run. */
export const LANE = 6;
/** Stretches on lines this close are on one line. */
const SAME = 1;
/** ...and share it where they overlap by more than this. */
const SHARE = 2;
const LANES = [1, -1, 2, -2, 3, -3];
/** Label spots are tried this far apart along the wire. */
const STEP = 4;

interface Seg {
  wire: number;
  k: number;
  horiz: boolean;
  at: number;
  lo: number;
  hi: number;
  /** Not a wire's first or last stretch: those hold its stubs on the ports. */
  movable: boolean;
}

const near = (p: number, q: number) => Math.abs(p - q) < 0.01;

/**
 * A stepped wire's corners, ends included, or undefined for a curve (a bezier has no straight
 * stretches to share).
 */
export function cornersOf(w: Pick<LaneWire, 'a' | 'b' | 'route'>): Position[] | undefined {
  const raw = w.route.bends
    ? [w.a, ...w.route.bends, w.b]
    : /C/.test(w.route.path)
      ? undefined
      : pointsOf(w.route.path);
  if (!raw) return undefined;
  const out: Position[] = [];
  for (const p of raw) {
    const q = out.at(-1);
    if (q && near(q.x, p.x) && near(q.y, p.y)) continue;
    const o = out.at(-2);
    if (o && q && ((near(o.x, q.x) && near(q.x, p.x)) || (near(o.y, q.y) && near(q.y, p.y))))
      out.pop();
    out.push(p);
  }
  for (let i = 0; i + 1 < out.length; i++) {
    const [p, q] = [out[i] as Position, out[i + 1] as Position];
    if (!near(p.x, q.x) && !near(p.y, q.y)) return undefined;
  }
  return out;
}

/** The wire as straight pieces: its corners, or points along its curve. */
function polyline(w: LaneWire): Position[] {
  return cornersOf(w) ?? bezierPoints(w.route.path);
}

/** The corners with stretch k moved `off[k]` px across (down or right when positive). */
function shifted(pts: readonly Position[], off: readonly number[]): Position[] {
  const out = pts.map((p) => ({ ...p }));
  for (let j = 1; j < pts.length - 1; j++) {
    const before = pts[j - 1] as Position;
    const at = pts[j] as Position;
    // Corner j joins stretch j-1 and stretch j; one is flat, the other upright.
    const [flat, upright] = near(before.y, at.y) ? [j - 1, j] : [j, j - 1];
    out[j] = {
      x: at.x + (off[upright] ?? 0),
      y: at.y + (off[flat] ?? 0),
    };
  }
  return out;
}

/** Each stretch still runs the way it did, and no shorter than a pixel. */
function keepsShape(before: readonly Position[], after: readonly Position[]): boolean {
  for (let i = 0; i + 1 < before.length; i++) {
    const [p, q, r, s] = [
      before[i] as Position,
      before[i + 1] as Position,
      after[i] as Position,
      after[i + 1] as Position,
    ];
    const was = q.x - p.x + q.y - p.y;
    const now = s.x - r.x + s.y - r.y;
    if (Math.sign(was) !== Math.sign(now) || Math.abs(now) < 1) return false;
  }
  return true;
}

/** How many times two stepped wires cross at a right angle. */
function crossings(a: readonly Position[], b: readonly Position[]): number {
  let n = 0;
  const inside = (v: number, p: number, q: number) =>
    v > Math.min(p, q) + 0.5 && v < Math.max(p, q) - 0.5;
  for (let i = 0; i + 1 < a.length; i++)
    for (let j = 0; j + 1 < b.length; j++) {
      const [p, q, r, s] = [
        a[i] as Position,
        a[i + 1] as Position,
        b[j] as Position,
        b[j + 1] as Position,
      ];
      if (near(p.y, q.y) && near(r.x, s.x)) {
        if (inside(r.x, p.x, q.x) && inside(p.y, r.y, s.y)) n++;
      } else if (near(p.x, q.x) && near(r.y, s.y)) {
        if (inside(p.x, r.x, s.x) && inside(r.y, p.y, q.y)) n++;
      }
    }
  return n;
}

/** Where along a polyline (its length from the start) lies nearest to `at`. */
function arcOf(pts: readonly Position[], at: Position): number {
  let best = Number.POSITIVE_INFINITY;
  let arc = 0;
  let run = 0;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i] as Position, pts[i + 1] as Position];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const t =
      len === 0
        ? 0
        : Math.max(
            0,
            Math.min(1, ((at.x - p.x) * (q.x - p.x) + (at.y - p.y) * (q.y - p.y)) / len ** 2),
          );
    const d = Math.hypot(p.x + t * (q.x - p.x) - at.x, p.y + t * (q.y - p.y) - at.y);
    if (d < best) {
      best = d;
      arc = run + t * len;
    }
    run += len;
  }
  return arc;
}

/** The point `arc` along a polyline. */
function pointAt(pts: readonly Position[], arc: number): Position {
  let rest = arc;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [p, q] = [pts[i] as Position, pts[i + 1] as Position];
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    if (rest <= len && len > 0)
      return { x: p.x + ((q.x - p.x) * rest) / len, y: p.y + ((q.y - p.y) * rest) / len };
    rest -= len;
  }
  return { ...(pts.at(-1) as Position) };
}

const lengthOf = (pts: readonly Position[]) =>
  pts.slice(1).reduce((sum, q, i) => {
    const p = pts[i] as Position;
    return sum + Math.hypot(q.x - p.x, q.y - p.y);
  }, 0);

/** Whether a polyline runs through the box. */
const hits = (pts: readonly Position[], box: Box) =>
  pts.some((p, i) => {
    const q = pts[i + 1];
    return q !== undefined && segmentHits(p, q, box);
  });

/** The label's box a pixel smaller: a wire along its edge is not on it. */
const labelArea = (text: string, at: Position): Box => {
  const b = labelBox(text, at);
  return { x: b.x + 1, y: b.y + 1, width: b.width - 2, height: b.height - 2 };
};

/** Whether a label of `text` at `at` sits on one of the other wires. */
export function labelOnWire(
  text: string,
  at: Position,
  others: readonly (readonly Position[])[],
): boolean {
  const box = labelArea(text, at);
  return others.some((pts) => hits(pts, box));
}

/**
 * Every wire of a level, those that shared a line with another wire moved into lanes beside it
 * and labels moved off other wires. A wire left as it was keeps its own Route object.
 */
export function spreadWires(level: readonly LaneWire[], boxes: readonly Box[]): Map<string, Route> {
  // By ID, so the canvas (wires in the order they render) and the exports agree.
  const wires = [...level].sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
  const corners = wires.map((w) => cornersOf(w));
  const segs: Seg[] = [];
  corners.forEach((pts, wire) => {
    if (!pts) return;
    for (let k = 0; k + 1 < pts.length; k++) {
      const [p, q] = [pts[k] as Position, pts[k + 1] as Position];
      const horiz = near(p.y, q.y);
      segs.push({
        wire,
        k,
        horiz,
        at: horiz ? p.y : p.x,
        lo: horiz ? Math.min(p.x, q.x) : Math.min(p.y, q.y),
        hi: horiz ? Math.max(p.x, q.x) : Math.max(p.y, q.y),
        movable: k > 0 && k < pts.length - 2,
      });
    }
  });
  const share = (s: Seg, t: Seg) => {
    const [ws, wt] = [wires[s.wire] as LaneWire, wires[t.wire] as LaneWire];
    return (
      s.wire !== t.wire &&
      ws.from !== wt.from &&
      ws.to !== wt.to &&
      Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > SHARE
    );
  };
  // Stretches on one line, flat ones then upright ones, each by where the line is.
  const sorted = [...segs].sort((s, t) =>
    s.horiz !== t.horiz ? (s.horiz ? -1 : 1) : s.at - t.at || s.wire - t.wire || s.k - t.k,
  );
  const offsets = corners.map((pts) => (pts ? pts.map(() => 0) : []));
  const lane = new Map<Seg, number>();
  const moved = new Set<number>();
  for (let i = 0; i < sorted.length; ) {
    let j = i + 1;
    const first = sorted[i] as Seg;
    while (
      j < sorted.length &&
      (sorted[j] as Seg).horiz === first.horiz &&
      (sorted[j] as Seg).at - first.at <= SAME
    )
      j++;
    const line = sorted.slice(i, j);
    i = j;
    if (line.length < 2) continue;
    // Stubs hold their line; the rest move off it in turn, the first by ID staying put.
    const byWire = (s: Seg, t: Seg) => s.wire - t.wire || s.k - t.k;
    const order = [
      ...line.filter((s) => !s.movable).sort(byWire),
      ...line.filter((s) => s.movable).sort(byWire),
    ];
    const rivalsOf = (s: Seg) => line.filter((t) => lane.has(t) && share(s, t));
    // Wires into one port that share this stretch keep to one lane, so they still run as one.
    const mateLane = (s: Seg) =>
      line
        .filter(
          (t) =>
            t.wire !== s.wire &&
            (wires[t.wire] as LaneWire).to === (wires[s.wire] as LaneWire).to &&
            Math.min(s.hi, t.hi) - Math.max(s.lo, t.lo) > SHARE,
        )
        .map((t) => lane.get(t) ?? 0)
        .find((n) => n !== 0);
    /** The wire's corners with stretch s in lane n, if that keeps its shape and its clearance. */
    const fits = (s: Seg, n: number): Position[] | undefined => {
      const pts = corners[s.wire] as Position[];
      const off = offsets[s.wire] as number[];
      const trial = [...off];
      trial[s.k] = n * LANE;
      const at = shifted(pts, trial);
      if (!keepsShape(pts, at)) return undefined;
      if (runsThrough(at, boxes) && !runsThrough(shifted(pts, off), boxes)) return undefined;
      return at;
    };
    const take = (s: Seg, n: number) => {
      lane.set(s, n);
      (offsets[s.wire] as number[])[s.k] = n * LANE;
      if (n !== 0) moved.add(s.wire);
    };
    for (const s of order) {
      const rivals = rivalsOf(s);
      const taken = new Set(rivals.map((t) => lane.get(t)));
      const mate = s.movable ? mateLane(s) : undefined;
      if (mate !== undefined && !taken.has(mate) && fits(s, mate)) {
        take(s, mate);
        continue;
      }
      if (!s.movable || !taken.has(0)) {
        lane.set(s, 0);
        continue;
      }
      let best: { n: number; crosses: number } | undefined;
      for (const n of LANES) {
        if (taken.has(n)) continue;
        if (best && Math.abs(n) > Math.abs(best.n)) break;
        const at = fits(s, n);
        if (!at) continue;
        const crosses = rivals.reduce((sum, t) => {
          const other = corners[t.wire] as Position[];
          return sum + crossings(at, shifted(other, offsets[t.wire] as number[]));
        }, 0);
        if (!best || crosses < best.crosses) best = { n, crosses };
      }
      take(s, best ? best.n : 0);
    }
    // A stretch left on the line while a wire into its port moved off it follows that wire.
    for (const s of order) {
      if (!s.movable || lane.get(s) !== 0) continue;
      const mate = mateLane(s);
      if (mate === undefined) continue;
      const taken = new Set(rivalsOf(s).map((t) => lane.get(t)));
      if (!taken.has(mate) && fits(s, mate)) take(s, mate);
    }
  }

  const out = new Map<string, Route>();
  const lines: Position[][] = [];
  wires.forEach((w, n) => {
    const pts = corners[n];
    if (!pts || !moved.has(n)) {
      out.set(w.id, w.route);
      lines.push(polyline(w));
      return;
    }
    const now = shifted(pts, offsets[n] as number[]);
    const radius = w.style === 'curved' ? CURVE_RADIUS : RADIUS;
    out.set(w.id, {
      path: pathOf(now, radius),
      label: pointAt(now, arcOf(now, w.route.label)),
      bends: now.slice(1, -1),
    });
    lines.push(now);
  });

  // Labels off other wires: along its own wire, nearest where it was, clear of the boxes, the
  // other wires and the labels already placed.
  const placed: Box[] = [];
  wires.forEach((w, n) => {
    const text = w.label;
    const route = out.get(w.id) as Route;
    if (!text) return;
    // Wires into the same port run together on purpose: a label on that bundle names its own wire.
    const others = lines.filter((_, m) => m !== n && (wires[m] as LaneWire).to !== w.to);
    // AFD-351: but their labels do not stack on the shared stretch, where nobody could count the
    // wires: a label on another label moves along its own wire, off the bundle where it can.
    const mates = lines.filter((_, m) => m !== n && (wires[m] as LaneWire).to === w.to);
    const onLabel = (at: Position) => {
      const box = labelBox(text, at);
      return placed.some((r) => overlaps(box, r));
    };
    // AFD-360: nor on a node: a label beside a node's edge was cut by it ("iled_hosts").
    const onNode = boxes.some((r) => overlaps(labelArea(text, route.label), r));
    if (!labelOnWire(text, route.label, others) && !onLabel(route.label) && !onNode) {
      placed.push(labelBox(text, route.label));
      return;
    }
    const own = lines[n] as Position[];
    const total = lengthOf(own);
    const from = arcOf(own, route.label);
    const free = (at: Position, offBundle: boolean) =>
      !labelOnWire(text, at, others) &&
      !(offBundle && labelOnWire(text, at, mates)) &&
      !boxes.some((r) => overlaps(labelBox(text, at), r)) &&
      !onLabel(at);
    for (const offBundle of mates.length ? [true, false] : [false])
      for (let k = STEP; k <= total; k += STEP)
        for (const arc of [from - k, from + k]) {
          if (arc < 0 || arc > total) continue;
          const at = pointAt(own, arc);
          if (!free(at, offBundle)) continue;
          const label = { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100 };
          out.set(w.id, { ...route, label });
          placed.push(labelBox(text, label));
          return;
        }
    placed.push(labelBox(text, route.label));
  });
  return out;
}

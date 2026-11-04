// Align and distribute (AFD-88, wave 8 group G): line selected steps up on an edge or their
// centres, or space three or more evenly, as one move. Round 1's participant dragged three steps
// one at a time by eye (T10, gaps of 134 and 136 px; W15). Tidy Up was no answer: it moves the whole
// level. Guide lines while dragging (`guides`) show when a step lines up with another or the gaps
// are even. Pure: positions are top-left corners, as in `layout:`.
import type { Position, Ulid } from './types';

export interface Box {
  id: Ulid;
  x: number;
  y: number;
  width: number;
  height: number;
}

export type AlignHow = 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom';
export type DistributeHow = 'horizontal' | 'vertical';

export const ALIGN_LABEL: Record<AlignHow, string> = {
  left: 'Align Left Edges',
  center: 'Align Centers (Flow Line)',
  right: 'Align Right Edges',
  top: 'Align Top Edges',
  middle: 'Align Middles',
  bottom: 'Align Bottom Edges',
};

export const DISTRIBUTE_LABEL: Record<DistributeHow, string> = {
  vertical: 'Distribute Vertically',
  horizontal: 'Distribute Horizontally',
};

const round = (n: number) => Math.round(n);

/** Only the boxes that move, at their new corner. */
function moved(boxes: readonly Box[], next: (b: Box) => Position): Record<Ulid, Position> {
  const out: Record<Ulid, Position> = {};
  for (const b of boxes) {
    const p = next(b);
    const at = { x: round(p.x), y: round(p.y) };
    if (at.x !== b.x || at.y !== b.y) out[b.id] = at;
  }
  return out;
}

/** Two or more boxes on one line of the selection's bounds. Centres align on their mean. */
export function align(boxes: readonly Box[], how: AlignHow): Record<Ulid, Position> {
  if (boxes.length < 2) return {};
  const left = Math.min(...boxes.map((b) => b.x));
  const right = Math.max(...boxes.map((b) => b.x + b.width));
  const top = Math.min(...boxes.map((b) => b.y));
  const bottom = Math.max(...boxes.map((b) => b.y + b.height));
  const mean = (f: (b: Box) => number) => boxes.reduce((s, b) => s + f(b), 0) / boxes.length;
  const cx = mean((b) => b.x + b.width / 2);
  const cy = mean((b) => b.y + b.height / 2);
  return moved(boxes, (b) => {
    switch (how) {
      case 'left':
        return { x: left, y: b.y };
      case 'right':
        return { x: right - b.width, y: b.y };
      case 'center':
        return { x: cx - b.width / 2, y: b.y };
      case 'top':
        return { x: b.x, y: top };
      case 'bottom':
        return { x: b.x, y: bottom - b.height };
      case 'middle':
        return { x: b.x, y: cy - b.height / 2 };
    }
  });
}

/**
 * Three or more boxes with equal gaps between them, in their order along the axis. The first and
 * last stay where they are. Gaps can come out negative when the boxes overlap: they then overlap
 * evenly, which is still what was asked.
 */
export function distribute(boxes: readonly Box[], how: DistributeHow): Record<Ulid, Position> {
  if (boxes.length < 3) return {};
  const v = how === 'vertical';
  const start = (b: Box) => (v ? b.y : b.x);
  const size = (b: Box) => (v ? b.height : b.width);
  const sorted = [...boxes].sort((a, b) => start(a) - start(b) || a.id.localeCompare(b.id));
  const first = sorted[0] as Box;
  const last = sorted.at(-1) as Box;
  const span = start(last) + size(last) - start(first);
  const gap = (span - sorted.reduce((s, b) => s + size(b), 0)) / (sorted.length - 1);
  const at = new Map<Ulid, number>();
  let cursor = start(first);
  for (const b of sorted) {
    at.set(b.id, cursor);
    cursor += size(b) + gap;
  }
  return moved(boxes, (b) =>
    v ? { x: b.x, y: at.get(b.id) ?? b.y } : { x: at.get(b.id) ?? b.x, y: b.y },
  );
}

export interface Guides {
  /** x of vertical guide lines (an edge or centre shared with another box). */
  xs: number[];
  /** y of horizontal guide lines. */
  ys: number[];
  /** The dragged box's corner moved onto the nearest guide, when one is within reach. */
  snap: Position;
  /** The dragged box sits at an even gap between two neighbours on this axis. */
  even?: DistributeHow;
}

/**
 * Guide lines for a box being dragged among `others` (the rest of the level): a shared left edge,
 * centre or right edge (vertical lines), top, middle or bottom (horizontal lines), within `reach`
 * pixels; the box snaps onto the nearest. `even` says the gap to the box before equals the gap to
 * the box after, on the axis where they are in a row.
 */
export function guides(box: Box, others: readonly Box[], reach = 6): Guides {
  const lines = (f: (b: Box) => number[]) => others.flatMap(f);
  const vx = lines((b) => [b.x, b.x + b.width / 2, b.x + b.width]);
  const hy = lines((b) => [b.y, b.y + b.height / 2, b.y + b.height]);
  const nearest = (mine: number[], theirs: number[]) => {
    let best: { delta: number; line: number } | undefined;
    for (const m of mine)
      for (const t of theirs) {
        const delta = t - m;
        if (Math.abs(delta) <= reach && (!best || Math.abs(delta) < Math.abs(best.delta)))
          best = { delta, line: t };
      }
    return best;
  };
  const sx = nearest([box.x, box.x + box.width / 2, box.x + box.width], vx);
  const sy = nearest([box.y, box.y + box.height / 2, box.y + box.height], hy);
  const snapped: Box = { ...box, x: box.x + (sx?.delta ?? 0), y: box.y + (sy?.delta ?? 0) };
  const on = (mine: number[], theirs: number[]) =>
    [...new Set(theirs.filter((t) => mine.some((m) => Math.abs(m - t) < 0.5)))].sort(
      (a, b) => a - b,
    );
  const xs = on([snapped.x, snapped.x + snapped.width / 2, snapped.x + snapped.width], vx);
  const ys = on([snapped.y, snapped.y + snapped.height / 2, snapped.y + snapped.height], hy);
  return {
    xs,
    ys,
    snap: { x: round(snapped.x), y: round(snapped.y) },
    ...evenGap(snapped, others, reach),
  };
}

function evenGap(box: Box, others: readonly Box[], reach: number): { even?: DistributeHow } {
  for (const how of ['vertical', 'horizontal'] as const) {
    const v = how === 'vertical';
    // Neighbours in the same column (vertical) or row (horizontal): they overlap the box across.
    const across = (b: Box) =>
      v
        ? b.x < box.x + box.width && box.x < b.x + b.width
        : b.y < box.y + box.height && box.y < b.y + b.height;
    const start = (b: Box) => (v ? b.y : b.x);
    const end = (b: Box) => (v ? b.y + b.height : b.x + b.width);
    const row = others.filter(across);
    const before = row.filter((b) => end(b) <= start(box)).sort((a, b) => end(b) - end(a))[0];
    const after = row.filter((b) => start(b) >= end(box)).sort((a, b) => start(a) - start(b))[0];
    if (before && after) {
      const g1 = start(box) - end(before);
      const g2 = start(after) - end(box);
      if (Math.abs(g1 - g2) <= reach) return { even: how };
    }
  }
  return {};
}

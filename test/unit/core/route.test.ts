// AFD-70: wires step round the nodes in their way, and look as before everywhere else.
import { getSmoothStepPath, Position as Side } from '@xyflow/system';
import { describe, expect, it } from 'vitest';
import type { Position } from '../../../src/core/flow/types';
import {
  type Box,
  labelBox,
  overlaps,
  pointsOf,
  routeWire,
  runsThrough,
} from '../../../src/core/view/route';

const W = 208;
const H = 76;
const box = (x: number, y: number): Box => ({ x, y, width: W, height: H });
/** A task's ok_hosts (bottom) and in (top) wire ends, 5 px off the box as React Flow draws them. */
const okOf = (b: Box): Position => ({ x: b.x + W / 2, y: b.y + H + 5 });
const inOf = (b: Box): Position => ({ x: b.x + W / 2, y: b.y - 5 });
const step = (a: Position, from: Side, b: Position, to: Side) =>
  getSmoothStepPath({
    sourceX: a.x,
    sourceY: a.y,
    sourcePosition: from,
    targetX: b.x,
    targetY: b.y,
    targetPosition: to,
  });

describe('wire routes (AFD-70)', () => {
  it('a smooth step that clears every box is kept as React Flow draws it', () => {
    const [a, b, aside] = [box(0, 0), box(40, 132), box(400, 60)];
    const r = routeWire(okOf(a), Side.Bottom, inOf(b), Side.Top, [a, b, aside], 'ok_hosts');
    const [path, x, y] = step(okOf(a), Side.Bottom, inOf(b), Side.Top);
    expect(r).toEqual({ path, label: { x, y } });
  });

  it('a wire that skips a step goes round it, keeping its stubs and corners', () => {
    const [a, mid, c] = [box(0, 0), box(30, 132), box(0, 264)];
    const boxes = [a, mid, c];
    expect(runsThrough(pointsOf(step(okOf(a), Side.Bottom, inOf(c), Side.Top)[0]), boxes)).toBe(
      true,
    );
    const r = routeWire(okOf(a), Side.Bottom, inOf(c), Side.Top, boxes, 'unchanged');
    const points = pointsOf(r.path);
    expect(runsThrough(points, boxes)).toBe(false);
    expect(r.bends?.length).toBeGreaterThan(1);
    // Straight down out of the port and straight down into the next, at least a stub long.
    const [p0, q0] = [points[0] as Position, points.at(-1) as Position];
    const [p1, q1] = [r.bends?.[0] as Position, r.bends?.at(-1) as Position];
    expect(p0).toEqual(okOf(a));
    expect(p1.x === p0.x && p1.y - p0.y >= 20).toBe(true);
    expect(q0).toEqual(inOf(c));
    expect(q1.x === q0.x && q0.y - q1.y >= 20).toBe(true);
    // Every stretch runs straight across or straight down.
    const corners = [p0, ...(r.bends ?? []), q0];
    for (let i = 0; i + 1 < corners.length; i++) {
      const [u, v] = [corners[i] as Position, corners[i + 1] as Position];
      expect(u.x === v.x || u.y === v.y).toBe(true);
    }
    // Rounded corners of 5 px, as a smooth step draws them.
    expect(r.path).toMatch(/^M[^Q]+Q/);
    // Its label sits on the route, on no box.
    expect(boxes.some((b) => overlaps(labelBox('unchanged', r.label), b))).toBe(false);
  });

  it('fail wires into one step share their last stretch', () => {
    // Render, Write, Refuse staggered as ELK lays them out; Rollback below, fed by all three.
    const [render, write, refuse, rollback] = [
      box(58, 108),
      box(92, 240),
      box(127, 372),
      box(12, 504),
    ];
    const boxes = [render, write, refuse, rollback];
    const fail = (b: Box): Position => ({ x: b.x + W + 5, y: b.y + H / 4 });
    const routes = [render, write, refuse].map((b) =>
      routeWire(fail(b), Side.Right, inOf(rollback), Side.Top, boxes, 'failed_hosts'),
    );
    for (const r of routes) expect(runsThrough(pointsOf(r.path), boxes)).toBe(false);
    // Render's and Write's go round Refuse and join Refuse's own (a smooth step) for the last turn.
    expect(routes.map((r) => !!r.bends)).toEqual([true, true, false]);
    const last = routes.map((r) => JSON.stringify(pointsOf(r.path).slice(-4)));
    expect(new Set(last).size).toBe(1);
  });

  it('boxed in, a wire keeps its smooth step', () => {
    // A node 10 px under the port: no stub fits, so nothing is gained by steering.
    const [a, under, c] = [box(0, 0), box(0, 86), box(0, 300)];
    const r = routeWire(okOf(a), Side.Bottom, inOf(c), Side.Top, [a, under, c]);
    expect(r.path).toBe(step(okOf(a), Side.Bottom, inOf(c), Side.Top)[0]);
    expect(r.bends).toBeUndefined();
  });

  it('a wire back up the flow goes round both its ends', () => {
    const [up, down] = [box(0, 0), box(0, 200)];
    const r = routeWire(okOf(down), Side.Bottom, inOf(up), Side.Top, [up, down]);
    expect(runsThrough(pointsOf(r.path), [up, down])).toBe(false);
  });
});

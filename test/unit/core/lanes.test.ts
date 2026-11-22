// AFD-345: wires that would lie on one line run side by side; labels stay off other wires.
import { readFileSync } from 'node:fs';
import { Position as Side } from '@xyflow/system';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { flowLayoutProblems, type Line, wiresOnWires } from '../../../src/core/export/layoutCheck';
import { scenesOf, type Wire } from '../../../src/core/export/scene';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, Position } from '../../../src/core/flow/types';
import {
  cornersOf,
  LANE,
  type LaneWire,
  labelOnWire,
  spreadWires,
} from '../../../src/core/view/lanes';
import { type Box, labelBox, overlaps, pointsOf, routeWire } from '../../../src/core/view/route';
import { shownPositions } from '../../../src/node/autoLayout';
import { WireLaneStore } from '../../../src/webview/canvas/wireLanes';

/** A stepped wire from a bottom port down to a top port, routed alone. */
const wire = (id: string, a: Position, b: Position, to: string, label?: string): LaneWire => ({
  id,
  a,
  b,
  from: `${id}.port`,
  to,
  route: routeWire(a, Side.Bottom, b, Side.Top, [], label),
  ...(label ? { label } : {}),
});

/** The flat middle stretch of a bottom-to-top step: its y and its x span. */
const middle = (w: LaneWire, route = w.route) => {
  const pts = cornersOf({ ...w, route }) as Position[];
  expect(pts).toHaveLength(4);
  const [p, q] = [pts[1] as Position, pts[2] as Position];
  expect(p.y).toBe(q.y);
  return { y: p.y, lo: Math.min(p.x, q.x), hi: Math.max(p.x, q.x) };
};

describe('wire lanes (AFD-345)', () => {
  // Both steps turn at y 100 and overlap from x 40 to 200.
  const a = wire('a', { x: 0, y: 0 }, { x: 200, y: 200 }, 'p.in');
  const b = wire('b', { x: 40, y: 0 }, { x: 240, y: 200 }, 'q.in');

  it('two wires on one line become two lines LANE apart, keeping their ends and turns', () => {
    expect(middle(a).y).toBe(middle(b).y);
    const out = spreadWires([b, a], []);
    // The first by ID stays as it was.
    expect(out.get('a')).toBe(a.route);
    const moved = out.get('b') as LaneWire['route'];
    expect(Math.abs(middle(b, moved).y - middle(a).y)).toBe(LANE);
    const pts = cornersOf({ ...b, route: moved }) as Position[];
    expect(pts[0]).toEqual(b.a);
    expect(pts.at(-1)).toEqual(b.b);
    // draw.io gets the corners as waypoints.
    expect(moved.bends).toEqual(pts.slice(1, -1));
  });

  it('wires into one port still share their stretch', () => {
    const c = wire('c', { x: 40, y: 0 }, { x: 200, y: 200 }, 'p.in');
    const out = spreadWires([a, c], []);
    expect(out.get('a')).toBe(a.route);
    expect(out.get('c')).toBe(c.route);
  });

  it('a lane that would run into a box is not taken', () => {
    // A box just below the shared stretch: b goes up a lane instead.
    const below: Box = { x: 60, y: 103, width: 100, height: 40 };
    const out = spreadWires([a, b], [below]);
    expect(middle(b, out.get('b')).y).toBe(middle(a).y - LANE);
  });

  it('a label on another wire moves along its own wire to a clear spot', () => {
    const l = wire('a', { x: 0, y: 0 }, { x: 200, y: 200 }, 'p.in', 'failed_hosts');
    // A straight wire down through the label in the middle of a's turn.
    const across = wire('z', { x: 100, y: -50 }, { x: 100, y: 300 }, 'r.in');
    expect(labelOnWire('failed_hosts', l.route.label, [cornersOf(across) as Position[]])).toBe(
      true,
    );
    const out = spreadWires([l, across], []);
    const label = out.get('a')?.label as Position;
    expect(label).not.toEqual(l.route.label);
    expect(labelOnWire('failed_hosts', label, [cornersOf(across) as Position[]])).toBe(false);
    // Still on its own wire.
    expect(labelOnWire('x', label, [cornersOf(l) as Position[]])).toBe(true);
  });

  it('labels of wires into one port do not stack on their shared stretch (AFD-351)', () => {
    const ws = [0, 1, 2].map((i) =>
      wire(`f${i}`, { x: 0, y: i * 10 }, { x: 0, y: 400 }, 'stop.in', 'failed_hosts'),
    );
    const out = spreadWires(ws, []);
    const boxes = ws.map((w) => labelBox('failed_hosts', out.get(w.id)?.label as Position));
    const stacked = boxes.flatMap((b, i) => boxes.slice(i + 1).filter((c) => overlaps(b, c)));
    expect(stacked).toEqual([]);
  });

  it('the canvas store spreads the wires its edges put, as the exports do', () => {
    const store = new WireLaneStore();
    let told = 0;
    store.subscribe('b', () => told++);
    store.put(a);
    store.put(b);
    store.run();
    expect(store.get('b')?.route).toEqual(spreadWires([a, b], []).get('b'));
    expect(told).toBe(1);
    // Nothing moved: nobody is told again.
    store.run();
    expect(told).toBe(1);
  });
});

describe('layout check: wires on wires (AFD-345)', () => {
  const line = (name: string, to: string, points: Position[], label?: string): Line => ({
    name,
    from: `${name}.out`,
    to,
    points,
    ...(label
      ? {
          label: {
            text: label,
            box: {
              x: (points[0] as Position).x - 20,
              y: (points[0] as Position).y - 8,
              width: 40,
              height: 16,
            },
          },
        }
      : {}),
  });

  it('reports two wires on top of each other, but not wires into one port', () => {
    const x = line('x', 't.in', [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ]);
    const y = line('y', 'u.in', [
      { x: 50, y: 0.5 },
      { x: 200, y: 0.5 },
    ]);
    const z = line('z', 't.in', [
      { x: 20, y: 0 },
      { x: 90, y: 0 },
    ]);
    expect(wiresOnWires([x, y, z])).toEqual([
      { kind: 'stacked', text: 'wires x and y run on top of each other' },
      { kind: 'stacked', text: 'wires y and z run on top of each other' },
    ]);
    // Six px apart is side by side.
    const beside = line('y', 'u.in', [
      { x: 50, y: 6 },
      { x: 200, y: 6 },
    ]);
    expect(wiresOnWires([x, beside])).toEqual([]);
  });

  it('reports a label on another wire', () => {
    const x = line(
      'x',
      't.in',
      [
        { x: 100, y: 50 },
        { x: 100, y: 200 },
      ],
      'failed_hosts',
    );
    const y = line('y', 'u.in', [
      { x: 0, y: 52 },
      { x: 300, y: 52 },
    ]);
    expect(wiresOnWires([x, y])).toEqual([
      { kind: 'label-wire', text: 'label "failed_hosts" of wire x lies on wire y' },
    ]);
  });
});

describe('wire lanes in a flow (AFD-345)', () => {
  it('the ok wire that skips a step runs beside the dashed fail wires, in the exports and the check', async () => {
    const doc = parse(
      readFileSync('test/fixtures/flows/wire-lanes.flow.yaml', 'utf8'),
    ) as FlowDocument;
    const model = buildModel(doc);
    const shown = await shownPositions(model);
    const scene = scenesOf({ doc, shown, findings: [], openPorts: openFailPorts(model) })[0];
    const okWire = scene?.wires.get('01JDXAN0000000000000000011') as Wire;
    const failWire = scene?.wires.get('01JDXAN0000000000000000012') as Wire;
    // The channel right of the column both wires go down.
    const upright = (w: Wire) => Math.max(...pointsOf(w.path).map((p) => p.x));
    expect(Math.abs(upright(okWire) - upright(failWire))).toBe(LANE);
    // The fail wires into Roll back still run as one, in the lane they moved to.
    for (const id of ['01JDXAN0000000000000000014', '01JDXAN0000000000000000016'])
      expect(upright(scene?.wires.get(id) as Wire)).toBe(upright(failWire));
    const problems = flowLayoutProblems(model, shown).get(ROOT) ?? [];
    expect(problems.filter((p) => p.kind === 'stacked' || p.kind === 'label-wire')).toEqual([]);
  });

  it('a 60-step level spreads in a few milliseconds (dragging stays smooth)', () => {
    const W = 208;
    const boxes: Box[] = [];
    const wires: LaneWire[] = [];
    for (let i = 0; i < 60; i++) boxes.push({ x: 100, y: i * 150, width: W, height: 76 });
    const rollback: Box = { x: 500, y: 60 * 150, width: W, height: 76 };
    boxes.push(rollback);
    const rIn = { x: 604, y: rollback.y - 5 };
    for (let i = 0; i < 60; i++) {
      const box = boxes[i] as Box;
      const ok = { x: 204, y: box.y + 81 };
      // Every other ok wire skips a step and goes round it.
      const next = boxes[Math.min(i + (i % 2 ? 2 : 1), 59)] as Box;
      const into = { x: 204, y: next.y - 5 };
      wires.push({
        id: `ok${String(i).padStart(2, '0')}`,
        a: ok,
        b: into,
        from: `${i}.ok`,
        to: `${next.y}.in`,
        route: routeWire(ok, Side.Bottom, into, Side.Top, boxes, 'ok_hosts'),
      });
      const fail = { x: 313, y: box.y + 40 };
      wires.push({
        id: `f${String(i).padStart(2, '0')}`,
        a: fail,
        b: rIn,
        from: `${i}.failed`,
        to: 'rollback.in',
        label: 'failed_hosts',
        route: routeWire(fail, Side.Right, rIn, Side.Top, boxes, 'failed_hosts'),
      });
    }
    spreadWires(wires, boxes);
    const t0 = performance.now();
    for (let k = 0; k < 10; k++) spreadWires(wires, boxes);
    expect((performance.now() - t0) / 10).toBeLessThan(16);
  });
});

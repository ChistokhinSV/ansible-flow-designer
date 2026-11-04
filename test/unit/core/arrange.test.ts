// AFD-88 (wave 8 group G): align, distribute and the guide lines while dragging (round 1: T10, W15).
import { describe, expect, it } from 'vitest';
import { align, type Box, distribute, guides } from '../../../src/core/flow/arrange';

const box = (id: string, x: number, y: number, width = 208, height = 76): Box => ({
  id,
  x,
  y,
  width,
  height,
});

describe('align', () => {
  // Round 1's three steps: dragged by eye to about x 320, a pill among them.
  const three = [box('a', 318, 100), box('b', 323, 210), box('c', 356, 350, 136, 40)];

  it('centres line up on their mean, so a pill and a step share the flow line', () => {
    const moved = align(three, 'center');
    const centre = (id: string) => {
      const b = three.find((x) => x.id === id) as Box;
      return (moved[id]?.x ?? b.x) + b.width / 2;
    };
    expect(new Set(['a', 'b', 'c'].map(centre)).size).toBe(1);
    expect(Object.values(moved).every((p) => Number.isInteger(p.x) && Number.isInteger(p.y))).toBe(
      true,
    );
  });

  it('edges line up on the selection bounds and only the boxes that move are returned', () => {
    expect(align(three, 'left')).toEqual({ b: { x: 318, y: 210 }, c: { x: 318, y: 350 } });
    expect(align(three, 'right')).toEqual({ a: { x: 323, y: 100 }, c: { x: 395, y: 350 } });
    expect(align(three, 'top')).toEqual({ b: { x: 323, y: 100 }, c: { x: 356, y: 100 } });
    expect(align([box('a', 0, 0)], 'left')).toEqual({});
  });
});

describe('distribute', () => {
  it('equal gaps between three or more, the first and last staying where they are', () => {
    const moved = distribute(
      [box('a', 320, 100), box('c', 320, 446), box('b', 320, 300)],
      'vertical',
    );
    // span 100..522 = 422, boxes 3 × 76 = 228, so two gaps of 97.
    expect(moved).toEqual({ b: { x: 320, y: 273 } });
    expect(distribute([box('a', 0, 0), box('b', 0, 200)], 'vertical')).toEqual({});
  });

  it('works across for a row', () => {
    const moved = distribute(
      [box('a', 0, 0, 100), box('b', 150, 0, 100), box('c', 400, 0, 100)],
      'horizontal',
    );
    expect(moved).toEqual({ b: { x: 200, y: 0 } });
  });
});

describe('guides', () => {
  const others = [box('a', 320, 100), box('c', 320, 400)];

  it('a dragged box near a shared centre snaps onto it and shows the line', () => {
    const g = guides(box('d', 324, 250), others);
    expect(g.snap.x).toBe(320);
    expect(g.xs).toEqual([320, 424, 528]);
  });

  it('an even gap between two neighbours in a column is reported', () => {
    // a ends at 176, c starts at 400: a box of 76 at 250 leaves 74 above and 74 below.
    expect(guides(box('d', 320, 250), others).even).toBe('vertical');
    expect(guides(box('d', 320, 300), others).even).toBeUndefined();
  });

  it('nothing within reach: no line, no snap', () => {
    const g = guides(box('d', 600, 250), others);
    expect(g).toEqual({ xs: [], ys: [], snap: { x: 600, y: 250 } });
  });
});

// AFD-68: where a new annotation goes: free space near a rough spot (never under a node, where a
// Section's title bar could not be grabbed), and a Section drawn round picked boxes.
import { describe, expect, it } from 'vitest';
import { freeSpot, sectionAround } from '../../../src/core/flow/annotations';
import { SECTION_TITLE_HEIGHT } from '../../../src/core/flow/geometry';

const box = (x: number, y: number, width = 136, height = 40) => ({
  position: { x, y },
  width,
  height,
});
const hits = (a: ReturnType<typeof box>, b: ReturnType<typeof box>) =>
  a.position.x < b.position.x + b.width &&
  b.position.x < a.position.x + a.width &&
  a.position.y < b.position.y + b.height &&
  b.position.y < a.position.y + a.height;

describe('placing a new annotation (AFD-68)', () => {
  it('centres it on the spot when that is free, else takes the nearest free place', () => {
    const size = { width: 480, height: 320 };
    expect(freeSpot([], size, { x: 500, y: 400 })).toEqual({ x: 260, y: 240 });
    const nodes = [box(400, 300), box(400, 380), box(600, 500)];
    const at = freeSpot(nodes, size, { x: 500, y: 400 });
    expect(nodes.some((n) => hits({ position: at, ...size }, n))).toBe(false);
    // Nearer than the far edge of the search.
    expect(Math.hypot(at.x - 260, at.y - 240)).toBeLessThan(500);
  });

  it('a Section round boxes holds them wholly, with room for its title bar', () => {
    const picked = [box(100, 200), box(300, 260, 200, 120)];
    const s = sectionAround(picked, 24);
    expect(s).toEqual({
      position: { x: 76, y: 200 - 24 - SECTION_TITLE_HEIGHT },
      width: 500 - 100 + 48,
      height: 380 - 200 + 48 + SECTION_TITLE_HEIGHT,
    });
    expect(sectionAround([])).toBeUndefined();
  });
});

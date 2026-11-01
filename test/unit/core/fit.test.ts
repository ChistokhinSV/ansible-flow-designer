// AFD-42: a level opens readable. Small levels fit whole at up to 100%; large ones fit their width
// at the top, never below the zoom where titles are 11 px.
import { describe, expect, it } from 'vitest';
import {
  FIT_MARGIN,
  READABLE_PX,
  READABLE_ZOOM,
  readableViewport,
  TITLE_PX,
} from '../../../src/core/view/fit';

const PANE = { width: 800, height: 700 };

describe('readableViewport (AFD-42)', () => {
  it('the readable zoom gives titles of at least 11 px', () => {
    expect(TITLE_PX * READABLE_ZOOM).toBeGreaterThanOrEqual(READABLE_PX);
  });

  it('a small level opens whole, centred, at 100% at most', () => {
    const v = readableViewport({ x: 0, y: 0, width: 300, height: 200 }, PANE);
    expect(v.zoom).toBe(1);
    expect(v.x).toBe(250);
    expect(v.y).toBe(250);
  });

  it('a level that fits at a readable zoom opens whole', () => {
    const v = readableViewport({ x: 100, y: 50, width: 880, height: 700 }, PANE);
    expect(v.zoom).toBeCloseTo((800 - 2 * FIT_MARGIN) / 880);
    expect(v.zoom).toBeGreaterThanOrEqual(READABLE_ZOOM);
    expect(v.zoom).toBeLessThan(1);
  });

  it('a tall level fits its width at the top instead of shrinking', () => {
    const v = readableViewport({ x: 0, y: 40, width: 600, height: 2000 }, PANE);
    expect(v.zoom).toBe(1);
    expect(v.y).toBe(FIT_MARGIN - 40);
    expect(v.x).toBe(100);
  });

  it('a wide level keeps the readable zoom and centres the top node, without empty space', () => {
    const bounds = { x: 0, y: 0, width: 2400, height: 900 };
    const v = readableViewport(bounds, PANE, 1200);
    expect(v.zoom).toBe(READABLE_ZOOM);
    expect(v.x).toBe(400 - 1200 * READABLE_ZOOM);
    // The top node far left: the view starts at the level's left edge, not past it.
    expect(readableViewport(bounds, PANE, 0).x).toBe(FIT_MARGIN);
  });
});

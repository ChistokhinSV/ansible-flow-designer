// AFD-42: a level opens readable. Small levels fit whole at up to 100%; large ones fit their width
// at the top, never below the zoom where titles are 11 px.
import { describe, expect, it } from 'vitest';
import {
  CONTROLS_ROOM,
  FIT_MARGIN,
  minimapCorner,
  PAGE_FIT_ZOOM,
  panInto,
  READABLE_PX,
  READABLE_ZOOM,
  readableViewport,
  TITLE_PX,
  WHOLE_MARGIN,
  wholeViewport,
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

  it('in a web page a level opens whole down to the page zoom (AFS-148 a9.16)', () => {
    // A laptop's canvas: the flow fits at about 0.5, below the readable zoom.
    const bounds = { x: 0, y: 0, width: 1400, height: 1000 };
    const page = readableViewport(bounds, PANE, 700, PAGE_FIT_ZOOM);
    expect(page.zoom).toBeCloseTo((800 - 2 * FIT_MARGIN) / 1400);
    expect(page.zoom).toBeLessThan(READABLE_ZOOM);
    // All of it inside the pane.
    expect(page.x).toBeGreaterThanOrEqual(0);
    expect(page.x + bounds.width * page.zoom).toBeLessThanOrEqual(PANE.width);
    expect(page.y + bounds.height * page.zoom).toBeLessThanOrEqual(PANE.height);
    // VS Code keeps the readable view; and a level too large even for the page zoom too.
    expect(readableViewport(bounds, PANE, 700).zoom).toBe(READABLE_ZOOM);
    expect(
      readableViewport({ x: 0, y: 0, width: 6000, height: 4000 }, PANE, 0, PAGE_FIT_ZOOM).zoom,
    ).toBe(READABLE_ZOOM);
  });
});

describe('minimap corner (AFD-72)', () => {
  const pane = { width: 800, height: 600 };
  it('bottom left when free, else top left, else nowhere', () => {
    expect(minimapCorner([], pane)).toBe('bottom-left');
    const low = { x: 40, y: 520, width: 120, height: 60 };
    expect(minimapCorner([low], pane)).toBe('top-left');
    const high = { x: 40, y: 20, width: 120, height: 60 };
    expect(minimapCorner([low, high], pane)).toBeNull();
    // A node right of the minimap's box is no obstacle.
    expect(minimapCorner([{ x: 200, y: 520, width: 120, height: 60 }], pane)).toBe('bottom-left');
    // The first-flow checklist holds the bottom left (AFD-73).
    expect(minimapCorner([], pane, true)).toBe('top-left');
  });
});

describe('panInto (AFD-328)', () => {
  const vp = { x: 0, y: 0, zoom: 1 };
  it('leaves a node in view where it is', () => {
    expect(panInto({ x: 100, y: 100, width: 136, height: 60 }, vp, PANE)).toBeUndefined();
  });

  it('moves the least it can to bring a node off the right or bottom into view', () => {
    const to = panInto({ x: 760, y: 680, width: 136, height: 60 }, vp, PANE);
    expect(to).toEqual({ x: 800 - FIT_MARGIN - 896, y: 700 - FIT_MARGIN - 740, zoom: 1 });
  });

  it('brings a node off the left or top in, at the zoom it is at', () => {
    const to = panInto({ x: -50, y: -20, width: 100, height: 40 }, { x: 0, y: 0, zoom: 0.5 }, PANE);
    expect(to).toEqual({ x: FIT_MARGIN + 25, y: FIT_MARGIN + 10, zoom: 0.5 });
  });
});

describe('wholeViewport (AFD-351)', () => {
  it('a wide level in a narrow, tall pane fills the width and starts at the top', () => {
    const pane = { width: 358, height: 550 };
    const v = wholeViewport({ x: 0, y: 0, width: 736, height: 615 }, pane);
    // React Flow's fit (7% round, the controls' column kept clear) gave 0.365 here.
    expect(v.zoom).toBeGreaterThan(0.43);
    expect(v.y).toBe(WHOLE_MARGIN);
    expect(Math.round(v.x + (736 * v.zoom) / 2)).toBe(Math.round(pane.width / 2));
  });

  it('keeps the bottom right clear for the zoom controls when the level would reach them', () => {
    const pane = { width: 800, height: 400 };
    const v = wholeViewport({ x: 0, y: 0, width: 800, height: 400 }, pane);
    const right = 800 * v.zoom + v.x;
    expect(right).toBeLessThanOrEqual(pane.width - CONTROLS_ROOM);
  });

  it('never zooms past 100%', () => {
    expect(
      wholeViewport({ x: 0, y: 0, width: 100, height: 100 }, { width: 800, height: 600 }).zoom,
    ).toBe(1);
  });
});

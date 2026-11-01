// The view a level opens with (AFD-42). A full fit shrinks a large level until its titles are a few
// pixels tall; below a readable zoom the level fits its width instead, aligned to the top, and
// never goes below that zoom: the first steps are readable and the rest is a scroll away.

/** Node title size on the canvas, in px at zoom 1 (`--afd-font-node-title`). */
export const TITLE_PX = 14;
/** Smallest on-screen title size we call readable (WCAG-ish 11 px; AFD-33 metrics). */
export const READABLE_PX = 11;
/** The zoom at which titles reach READABLE_PX, rounded up. */
export const READABLE_ZOOM = 0.8;
/** A fit never zooms in past 100%: small levels open at their real size. */
export const MAX_FIT_ZOOM = 1;
/** Room around the level, in screen px. */
export const FIT_MARGIN = 32;
/** Fit View, the zoom controls' fit, and the first view where the pane has no size yet. */
export const FULL_FIT = { padding: 0.15, maxZoom: MAX_FIT_ZOOM };

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Viewport {
  x: number;
  y: number;
  zoom: number;
}

/**
 * The opening viewport of a level with these bounds in a pane of this size. `anchorX` is the
 * flow x the view centres on when the level is wider than the pane (the top node's centre).
 */
export function readableViewport(
  bounds: Rect,
  pane: { width: number; height: number },
  anchorX = bounds.x + bounds.width / 2,
): Viewport {
  const room = {
    width: Math.max(1, pane.width - 2 * FIT_MARGIN),
    height: Math.max(1, pane.height - 2 * FIT_MARGIN),
  };
  const w = Math.max(1, bounds.width);
  const h = Math.max(1, bounds.height);
  const full = Math.min(room.width / w, room.height / h, MAX_FIT_ZOOM);
  if (full >= READABLE_ZOOM) {
    return {
      zoom: full,
      x: (pane.width - w * full) / 2 - bounds.x * full,
      y: (pane.height - h * full) / 2 - bounds.y * full,
    };
  }
  const zoom = Math.max(READABLE_ZOOM, Math.min(room.width / w, MAX_FIT_ZOOM));
  const y = FIT_MARGIN - bounds.y * zoom;
  if (w * zoom <= room.width) return { zoom, x: (pane.width - w * zoom) / 2 - bounds.x * zoom, y };
  // Wider than the pane even so: centre the top node, without showing empty space past an edge.
  const centred = pane.width / 2 - anchorX * zoom;
  const leftmost = FIT_MARGIN - bounds.x * zoom;
  const rightmost = pane.width - FIT_MARGIN - (bounds.x + w) * zoom;
  return { zoom, x: Math.min(leftmost, Math.max(rightmost, centred)), y };
}

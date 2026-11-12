// Where a completion list goes (AFD-226): under the caret's line, inside the window (a field in a
// narrow panel may be narrower than the list), and above the line when there is no room below.
// Pure, so it is tested without layout.

export interface Box {
  left: number;
  top: number;
  bottom: number;
}

const MARGIN = 4;

/**
 * The list's offset from its positioned field (`field`, on screen), for a caret box on screen and a
 * list of `menu` size in a window of `viewport` size.
 */
export function placeMenu(
  caret: Box,
  field: { left: number; top: number },
  menu: { width: number; height: number },
  viewport: { width: number; height: number },
): { left: number; top: number; above: boolean } {
  // Left under the caret, moved left to stay in the window, never past its left edge.
  const screenLeft = Math.max(MARGIN, Math.min(caret.left, viewport.width - MARGIN - menu.width));
  const below = caret.bottom + 2 + menu.height <= viewport.height;
  const above = !below && caret.top - 2 - menu.height >= 0;
  return {
    left: screenLeft - field.left,
    top: above ? caret.top - field.top - 2 - menu.height : caret.bottom - field.top + 2,
    above,
  };
}

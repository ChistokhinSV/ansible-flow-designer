// The dashed tie between a Note and its node (AFD-65): from border to border on the line between
// their centres, so it never runs under either box. Shared by the canvas and the exports.

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

const centre = (b: Box) => ({ x: b.x + b.width / 2, y: b.y + b.height / 2 });

/** Where the line from the box's centre toward `to` leaves the box. */
function border(b: Box, to: { x: number; y: number }) {
  const c = centre(b);
  const dx = to.x - c.x;
  const dy = to.y - c.y;
  if (dx === 0 && dy === 0) return c;
  const scale = Math.min(
    dx === 0 ? Number.POSITIVE_INFINITY : b.width / 2 / Math.abs(dx),
    dy === 0 ? Number.POSITIVE_INFINITY : b.height / 2 / Math.abs(dy),
  );
  return { x: c.x + dx * scale, y: c.y + dy * scale };
}

const overlap = (a: Box, b: Box) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/** The tie from a Note to its node, or undefined when the boxes overlap (nothing to draw). */
export function tieLine(
  note: Box,
  node: Box,
): { from: { x: number; y: number }; to: { x: number; y: number } } | undefined {
  if (overlap(note, node)) return undefined;
  return { from: border(note, centre(node)), to: border(node, centre(note)) };
}

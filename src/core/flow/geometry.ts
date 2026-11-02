// Node box sizes shared by the canvas (explicit React Flow sizes) and host auto-layout (ELK).
import type { Annotation, NodeType } from './types';

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;
/** start/end are drawn as pills. */
export const PILL_WIDTH = 136;
export const PILL_HEIGHT = 40;
/** parallel/join are fork and merge bars (AFD-42). */
export const BAR_HEIGHT = 36;

export function nodeSize(type: NodeType): { width: number; height: number } {
  if (type === 'start' || type === 'end') return { width: PILL_WIDTH, height: PILL_HEIGHT };
  if (type === 'parallel' || type === 'join') return { width: NODE_WIDTH, height: BAR_HEIGHT };
  return { width: NODE_WIDTH, height: NODE_HEIGHT };
}

// ---- annotations (AFD-64) ------------------------------------------------------------------------

export const NOTE_SIZE = { width: 200, height: 120 };
export const SECTION_SIZE = { width: 480, height: 320 };
/** A Section's title bar: where it is dragged from. */
export const SECTION_TITLE_HEIGHT = 32;
/** Text: font size by `size`, and a box that fits its words when no size is stored. */
export const TEXT_FONT = { s: 13, m: 18, l: 26 } as const;

export function annotationSize(
  a: Pick<Annotation, 'kind' | 'width' | 'height' | 'size' | 'text'>,
): {
  width: number;
  height: number;
} {
  const kind = a.kind ?? 'note';
  if (kind === 'note')
    return { width: a.width ?? NOTE_SIZE.width, height: a.height ?? NOTE_SIZE.height };
  if (kind === 'section')
    return { width: a.width ?? SECTION_SIZE.width, height: a.height ?? SECTION_SIZE.height };
  const font = TEXT_FONT[a.size ?? 'm'];
  const rows = String(a.text ?? '').split('\n');
  const longest = Math.max(1, ...rows.map((r) => r.length));
  return {
    width: a.width ?? Math.max(40, Math.round(longest * font * 0.58) + 8),
    height: a.height ?? Math.max(24, Math.round(rows.length * font * 1.35) + 8),
  };
}

// Node box sizes shared by the canvas (explicit React Flow sizes) and host auto-layout (ELK).
import type { NodeType } from './types';

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

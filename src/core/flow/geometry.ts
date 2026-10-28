// Node box sizes shared by the canvas (explicit React Flow sizes) and host auto-layout (ELK).
import type { NodeType } from './types';

export const NODE_WIDTH = 208;
export const NODE_HEIGHT = 76;
/** start/end are drawn as pills. */
export const PILL_WIDTH = 136;
export const PILL_HEIGHT = 40;

export function nodeSize(type: NodeType): { width: number; height: number } {
  return type === 'start' || type === 'end'
    ? { width: PILL_WIDTH, height: PILL_HEIGHT }
    : { width: NODE_WIDTH, height: NODE_HEIGHT };
}

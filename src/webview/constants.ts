// Labels, drag types and small formatters several webview components share (AFD-34), so no
// component imports another one for a constant.
import { NODE_TYPE_LABEL } from '../core/export/details';
import type { NodeType } from '../core/flow/types';
import type { PortState } from './viewModel';

/** Node type names, shared with the exports (AFD-25). */
export const TYPE_LABEL: Record<NodeType, string> = NODE_TYPE_LABEL;

export const STATE_LABEL: Record<PortState, string> = {
  connected: 'connected',
  'open-fail': 'open: not handled',
  'open-purpose': 'open on purpose',
  open: 'open',
  available: 'optional, not enabled',
};

/** Drag data types: a node type or a failure pattern dragged from the palette onto the canvas. */
export const DRAG_MIME = 'application/x-afd-node-type';
export const PATTERN_MIME = 'application/x-afd-pattern';
/** AFD-65: a Note, Section or Text dragged from the palette. */
export const ANNOTATION_MIME = 'application/x-afd-annotation';

/** "5 min ago" for a time stamp, in the panels that show when something happened. */
export function ago(iso: string | undefined, now = Date.now()): string {
  if (!iso) return '';
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

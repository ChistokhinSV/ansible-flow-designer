// Which panel the right side shows (AFD-35): one pure rule, tested as a table, instead of a nested
// conditional in App. A selected node shows its Details in every mode (AFD-43; Code and Run add
// their tab); otherwise Code and Run modes show their own panels, and Design the selection, a
// boundary wire, the open subflow, or the flow. A lens has a tab of its own beside it (AFD-45).
import { ROOT } from '../core/flow/model';
import type { LensId } from '../core/lens/types';
import type { Mode, Selection } from './store';

export type RightPanel =
  | { kind: 'drift' }
  | { kind: 'wireRun'; edge: string }
  | { kind: 'run' }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'details'; id: string; context?: boolean }
  | { kind: 'boundary'; edge: string }
  | { kind: 'flow' };

const boundaryWire = (edge: string | undefined) => !!edge && /^(entry|exit):/.test(edge);

export function rightPanelFor(s: {
  lens: LensId | null;
  mode: Mode;
  selection: Selection;
  level: string;
}): RightPanel {
  const { node, edge, nodes } = s.selection;
  if (node) return { kind: 'details', id: node };
  if (s.mode === 'code') return { kind: 'drift' };
  if (s.mode === 'run') {
    if (edge && !boundaryWire(edge)) return { kind: 'wireRun', edge };
    return { kind: 'run' };
  }
  if (nodes?.length) return { kind: 'selection', ids: nodes };
  if (edge && boundaryWire(edge)) return { kind: 'boundary', edge };
  // Inside a subflow with nothing selected: that subflow, not the whole flow (AFD-30).
  if (s.level !== ROOT) return { kind: 'details', id: s.level, context: true };
  return { kind: 'flow' };
}

/** The accessible name of the right side for each panel. */
export function rightPanelLabel(panel: RightPanel): string {
  switch (panel.kind) {
    case 'drift':
      return 'Design vs code';
    case 'wireRun':
    case 'run':
      return 'Run results';
    case 'selection':
      return 'Selected nodes';
    case 'details':
      return panel.context ? 'Subflow details' : 'Details';
    case 'boundary':
      return 'Subflow boundary';
    case 'flow':
      return 'Flow description';
  }
}

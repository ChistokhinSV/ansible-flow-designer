// Which panel the right side shows (AFD-35): one pure rule, tested as a table, instead of a nested
// conditional in App. A lens with nothing selected shows its findings; Code and Run modes show
// their own panels; Design shows the selection, the inspector, a boundary wire, the subflow whose
// level is open, or the flow.
import { ROOT } from '../core/flow/model';
import type { LensId } from '../core/lens/types';
import type { Mode, Selection } from './store';

export type RightPanel =
  | { kind: 'lens' }
  | { kind: 'nodeCode'; id: string }
  | { kind: 'drift' }
  | { kind: 'nodeRun'; id: string }
  | { kind: 'wireRun'; edge: string }
  | { kind: 'run' }
  | { kind: 'selection'; ids: string[] }
  | { kind: 'inspector'; id: string; context?: boolean }
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
  if (s.lens && !node && !edge && !nodes) return { kind: 'lens' };
  if (s.mode === 'implementation') return node ? { kind: 'nodeCode', id: node } : { kind: 'drift' };
  if (s.mode === 'run') {
    if (node) return { kind: 'nodeRun', id: node };
    if (edge && !boundaryWire(edge)) return { kind: 'wireRun', edge };
    return { kind: 'run' };
  }
  if (nodes?.length) return { kind: 'selection', ids: nodes };
  if (node) return { kind: 'inspector', id: node };
  if (edge && boundaryWire(edge)) return { kind: 'boundary', edge };
  // Inside a subflow with nothing selected: that subflow, not the whole flow (AFD-30).
  if (s.level !== ROOT) return { kind: 'inspector', id: s.level, context: true };
  return { kind: 'flow' };
}

/** The accessible name of the right side for each panel. */
export function rightPanelLabel(panel: RightPanel): string {
  switch (panel.kind) {
    case 'lens':
      return 'Lens findings';
    case 'nodeCode':
    case 'drift':
      return 'Design vs code';
    case 'nodeRun':
    case 'wireRun':
    case 'run':
      return 'Run results';
    case 'selection':
      return 'Selected nodes';
    case 'inspector':
      return panel.context ? 'Subflow description' : 'Node inspector';
    case 'boundary':
      return 'Subflow boundary';
    case 'flow':
      return 'Flow description';
  }
}

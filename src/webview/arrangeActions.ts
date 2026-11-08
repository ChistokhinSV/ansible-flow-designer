// Align, Distribute and Reset Position on the canvas (AFD-88, wave 8 group G). Each is one
// moveNodes (or unplaceNodes) command, so one undo restores it. Steps still at their automatic
// place are written too, so lining up three steps does not move the rest (ADR-0002).
import {
  type AlignHow,
  align,
  type Box,
  type DistributeHow,
  distribute,
} from '../core/flow/arrange';
import { nodeSize } from '../core/flow/geometry';
import type { Ulid } from '../core/flow/types';
import { run } from './actions';
import { canEdit } from './editActions';
import { useUi } from './store';
import { levelView, unplacedPositions } from './viewModel';

/** The selected steps of the open level as boxes, where the canvas shows them. */
export function selectedBoxes(ids: readonly Ulid[]): Box[] {
  const ui = useUi.getState();
  if (!ui.snapshot) return [];
  const view = levelView(ui.snapshot, ui.optimistic, ui.level);
  return view.nodes
    .filter((n) => ids.includes(n.node.id))
    .map((n) => ({
      id: n.node.id,
      x: Math.round(n.position.x),
      y: Math.round(n.position.y),
      ...nodeSize(n.node.type),
    }));
}

async function move(positions: Record<Ulid, { x: number; y: number }>, done: string) {
  const ui = useUi.getState();
  if (!ui.snapshot?.doc) return;
  if (Object.keys(positions).length === 0) {
    ui.notify('info', done);
    return;
  }
  const freeze = unplacedPositions(
    levelView(ui.snapshot, ui.optimistic, ui.level),
    ui.snapshot.doc.layout,
  );
  const all = { ...freeze, ...positions };
  ui.setOptimistic(all);
  const ack = await run({ kind: 'moveNodes', positions: all });
  if (ack.ok) return;
  // AFD-156: back to where the file has them.
  useUi.getState().dropOptimistic(all);
  ui.setError(ack.error ?? 'The steps could not be moved');
}

export function alignSelection(how: AlignHow, ids = useUi.getState().selection.nodes ?? []) {
  if (!canEdit() || ids.length < 2) return;
  return move(align(selectedBoxes(ids), how), 'The steps are lined up already');
}

export function distributeSelection(
  how: DistributeHow,
  ids = useUi.getState().selection.nodes ?? [],
) {
  if (!canEdit() || ids.length < 3) return;
  return move(distribute(selectedBoxes(ids), how), 'The gaps are even already');
}

/** Placed steps go back to automatic placement (`unplaceNodes`, AFD-24). */
export async function resetPositions(ids: readonly Ulid[]) {
  const ui = useUi.getState();
  const placed = ids.filter((id) => ui.snapshot?.doc?.layout?.[id]);
  if (!canEdit() || placed.length === 0) return;
  const ack = await run({ kind: 'unplaceNodes', ids: placed });
  if (!ack.ok) ui.setError(ack.error ?? 'The positions could not be reset');
}

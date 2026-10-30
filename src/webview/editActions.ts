// Edits shared by the canvas, its context menu and the keyboard (AFD-18). Each one is a single
// command, so a single undo step: deleting a selection, cutting, duplicating.
import type { CanvasTarget } from '../core/flow/canvasMenu';
import { copyNodes } from '../core/flow/clipboard';
import { buildModel, ROOT } from '../core/flow/model';
import type { Ulid } from '../core/flow/types';
import { run } from './actions';
import type { Ack } from './bus';
import { copySelection } from './clipboard';
import { useUi } from './store';
import { levelView, unplacedPositions } from './viewModel';

/** The selected nodes, one or a group. */
export function selectedNodes(): Ulid[] {
  const { selection } = useUi.getState();
  return selection.nodes ?? (selection.node ? [selection.node] : []);
}

/** Edits are possible: not in Run mode, and the text parses. */
export function canEdit(): boolean {
  const { mode, snapshot } = useUi.getState();
  return mode !== 'run' && !!snapshot?.doc && !snapshot.stale;
}

/** The boundary wires of an open subflow (`entry:…`, `exit:…`, see viewModel) as menu targets. */
export function boundaryWire(
  id: string,
): Extract<CanvasTarget, { kind: 'entry' | 'exit' }> | undefined {
  if (id.startsWith('entry:')) return { kind: 'entry', subflow: id.slice('entry:'.length) };
  if (!id.startsWith('exit:')) return undefined;
  const [subflow, node, port, parent] = id.slice('exit:'.length).split('|');
  if (!subflow || !node || !port || !parent) return undefined;
  return { kind: 'exit', subflow, edge: id, from: { node, port }, port: parent };
}

/** Selects what a paste or a duplicate created. */
export function selectCreated(ack: Ack): Ulid[] {
  const created = ack.pasted ?? (ack.created ? [ack.created] : []);
  if (created.length > 1) useUi.getState().select({ nodes: created });
  else if (created[0]) useUi.getState().select({ node: created[0] });
  return created;
}

/**
 * Deletes nodes and wires in one edit. Boundary wires are boundary edits of their own (the entry
 * or the exit of the open subflow); those touching a deleted node go with the node.
 */
export async function deleteSelection(nodes: Ulid[], edges: string[] = []): Promise<void> {
  if (!canEdit()) return;
  const gone = new Set(nodes);
  const doc = useUi.getState().snapshot?.doc;
  const entryOf = (subflow: Ulid) =>
    doc ? buildModel(doc).nodes.get(subflow)?.node.subflow?.boundary?.in : undefined;
  const plain: string[] = [];
  for (const id of edges) {
    const b = boundaryWire(id);
    if (b?.kind === 'entry') {
      const entry = entryOf(b.subflow);
      if (!entry || !gone.has(entry))
        await run({ kind: 'setBoundaryIn', subflow: b.subflow, node: null });
    } else if (b?.kind === 'exit') {
      if (!gone.has(b.from.node))
        await run({ kind: 'disconnectBoundary', subflow: b.subflow, from: b.from, port: b.port });
    } else plain.push(id);
  }
  if (nodes.length === 0 && plain.length === 0) return;
  await run({ kind: 'deleteNodes', ids: nodes, edges: plain });
}

/** Cut from the menu: the text goes to the clipboard through the host, then one delete. */
export async function cutNodes(ids: Ulid[]): Promise<void> {
  if (ids.length === 0) return;
  copySelection(ids);
  await deleteSelection(ids);
}

/** A copy of the nodes next to them (+40, +40), without the clipboard: one paste command. */
export async function duplicate(ids: Ulid[]): Promise<void> {
  const ui = useUi.getState();
  if (!canEdit() || ids.length === 0 || !ui.snapshot?.doc) return;
  const text = copyNodes(ui.snapshot.doc, ids, ui.snapshot.autoPositions);
  if (!text) return;
  // Nodes still at auto-layout positions are written too, so the copy does not move them.
  const freeze = unplacedPositions(
    levelView(ui.snapshot, ui.optimistic, ui.level),
    ui.snapshot.doc.layout,
  );
  const ack = await run({
    kind: 'pasteNodes',
    text,
    level: ui.level,
    ...(Object.keys(freeze).length > 0 ? { freeze } : {}),
  });
  if (ack.ok) selectCreated(ack);
}

/** Every node of the open level. */
export function selectAll(): void {
  const ui = useUi.getState();
  if (!ui.snapshot) return;
  const ids = levelView(ui.snapshot, ui.optimistic, ui.level).nodes.map((n) => n.node.id);
  if (ids.length > 1) ui.select({ nodes: ids });
  else if (ids[0]) ui.select({ node: ids[0] });
}

/** The level that holds the open subflow. */
export function upLevel(): void {
  const ui = useUi.getState();
  if (ui.level === ROOT || !ui.snapshot?.doc) return;
  const parent = buildModel(ui.snapshot.doc).nodes.get(ui.level)?.level ?? ROOT;
  const left = ui.level;
  ui.setLevel(parent);
  // The subflow just left stays selected, so Enter goes back in.
  ui.select({ node: left });
}

/** F2: the node selected and its title field focused (Design mode's inspector). */
export function rename(node: Ulid): void {
  const ui = useUi.getState();
  if (ui.mode !== 'design') return;
  ui.select({ node });
  ui.requestFocus('title');
}

/** Extract into subflow: the group selected and the selection panel's title focused. */
export function startExtract(ids: Ulid[]): void {
  const ui = useUi.getState();
  ui.select({ nodes: ids });
  ui.requestFocus('extractTitle');
}

/** Edit reason of a boundary exit: the wire selected and the boundary panel's field focused. */
export function editExitReason(edge: string): void {
  const ui = useUi.getState();
  ui.select({ edge });
  ui.requestFocus('exitReason');
}

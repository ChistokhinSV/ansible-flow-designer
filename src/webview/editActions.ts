// Edits shared by the canvas, its context menu and the keyboard (AFD-18). Each one is a single
// command, so a single undo step: deleting a selection, cutting, duplicating.
import type { CanvasTarget } from '../core/flow/canvasMenu';
import { copyNodes } from '../core/flow/clipboard';
import { canDisable } from '../core/flow/disabled';
import { healPlan, healSummary } from '../core/flow/heal';
import { modelOf, ROOT } from '../core/flow/model';
import { mainOutputs } from '../core/flow/ports';
import { sharedAround } from '../core/flow/refs';
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

/** The selected Notes, Sections and Text (AFD-65). */
export function selectedAnnotations(): Ulid[] {
  return useUi.getState().selection.annotations ?? [];
}

/**
 * The graph can be edited: Design mode (Code and Run show it read-only, AFD-45), the text parses,
 * and no IDs are missing (AFD-19).
 */
export function canEdit(): boolean {
  const { mode, snapshot, level } = useUi.getState();
  return (
    mode === 'design' &&
    !!snapshot?.doc &&
    !snapshot.stale &&
    !snapshot.idGaps &&
    // AFD-60: a shared subflow is edited in its source flow.
    !sharedAround(snapshot.doc, level)
  );
}

/**
 * The flow text can take edits: it parses and no IDs are missing. Panels show their fields
 * read-only otherwise, instead of accepting input the host then refuses (AFD-30).
 */
export function useEditable(): boolean {
  return useUi(
    (s) =>
      !!s.snapshot?.doc &&
      !s.snapshot.stale &&
      !s.snapshot.idGaps &&
      !sharedAround(s.snapshot.doc, s.level),
  );
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
 * AFD-235: the path closes behind deleted nodes (`heal`; Shift+Delete leaves the gap), and a
 * message says so.
 */
export async function deleteSelection(
  nodes: Ulid[],
  edges: string[] = [],
  annotations: Ulid[] = [],
  heal = true,
): Promise<void> {
  if (!canEdit()) return;
  const gone = new Set(nodes);
  const doc = useUi.getState().snapshot?.doc;
  const entryOf = (subflow: Ulid) =>
    doc ? modelOf(doc).nodes.get(subflow)?.node.subflow?.boundary?.in : undefined;
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
  if (nodes.length === 0 && plain.length === 0 && annotations.length === 0) return;
  const healing = heal && nodes.length > 0;
  const said = healing && doc ? healSummary(healPlan(modelOf(doc), nodes, plain)) : undefined;
  const ack = await run({
    kind: 'deleteNodes',
    ids: nodes,
    edges: plain,
    ...(annotations.length ? { annotations } : {}),
    ...(healing ? { heal: true } : {}),
  });
  if (ack.ok && said) useUi.getState().notify('info', said);
}

/**
 * AFD-242 (D): switches the selected steps off, or back on once all of them are off. Start and
 * end nodes among them are left as they are.
 */
export async function toggleDisabled(ids: Ulid[]): Promise<void> {
  const doc = useUi.getState().snapshot?.doc;
  if (!canEdit() || !doc) return;
  const model = modelOf(doc);
  const steps = ids
    .map((id) => model.nodes.get(id)?.node)
    .filter((n): n is NonNullable<typeof n> => !!n && canDisable(n));
  if (steps.length === 0) return;
  const disabled = !steps.every((n) => n.disabled);
  await run({ kind: 'setDisabled', ids: steps.map((n) => n.id), disabled });
}

/** AFD-235: the nodes leave their path and stay on the canvas; the path closes behind them. */
export async function detachNodes(ids: Ulid[]): Promise<void> {
  const doc = useUi.getState().snapshot?.doc;
  if (!canEdit() || ids.length === 0 || !doc) return;
  const said = healSummary(healPlan(modelOf(doc), ids));
  const ack = await run({ kind: 'detachNodes', ids });
  if (ack.ok && said) useUi.getState().notify('info', said);
}

/** Cut from the menu: the text goes to the clipboard through the host, then one delete. */
export async function cutNodes(ids: Ulid[], annotations: Ulid[] = []): Promise<void> {
  if (ids.length === 0 && annotations.length === 0) return;
  copySelection(ids, annotations);
  await deleteSelection(ids, [], annotations);
}

/** A copy of the nodes next to them (+40, +40), without the clipboard: one paste command. */
export async function duplicate(ids: Ulid[], annotations: Ulid[] = []): Promise<void> {
  const ui = useUi.getState();
  if (!canEdit() || (ids.length === 0 && annotations.length === 0) || !ui.snapshot?.doc) return;
  const text = copyNodes(ui.snapshot.doc, ids, ui.snapshot.autoPositions, annotations);
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

/** Every node and annotation of the open level. */
export function selectAll(): void {
  const ui = useUi.getState();
  if (!ui.snapshot) return;
  const view = levelView(ui.snapshot, ui.optimistic, ui.level);
  const ids = view.nodes.map((n) => n.node.id);
  const notes = ui.annotationsHidden ? [] : view.annotations.map((a) => a.annotation.id);
  const also = notes.length ? { annotations: notes } : {};
  if (ids.length > 1) ui.select({ nodes: ids, ...also });
  else if (ids[0]) ui.select({ node: ids[0], ...also });
  else if (notes.length) ui.select(also);
}

/** The level that holds the open subflow. */
export function upLevel(): void {
  const ui = useUi.getState();
  if (ui.level === ROOT || !ui.snapshot?.doc) return;
  const parent = modelOf(ui.snapshot.doc).nodes.get(ui.level)?.level ?? ROOT;
  const left = ui.level;
  ui.setLevel(parent);
  // The subflow just left stays selected, so Enter goes back in.
  ui.select({ node: left });
}

/** F2, or a double-click on a title (AFD-237): the node selected and its title edited in place. */
export function rename(node: Ulid): void {
  const ui = useUi.getState();
  if (!canEdit()) return;
  ui.select({ node });
  ui.setRenaming(node);
}

/** The wires of the level a node is on. */
function wiresAround(node: Ulid) {
  const doc = useUi.getState().snapshot?.doc;
  if (!doc) return undefined;
  const model = modelOf(doc);
  const entry = model.nodes.get(node);
  const level = entry ? model.levels.get(entry.level) : undefined;
  return entry && level ? { node: entry.node, edges: level.edges.filter((e) => !!e) } : undefined;
}

/**
 * AFD-238: the node with every step upstream of it (the hosts came through them) or downstream
 * (they can go on to them), on its level.
 */
export function selectFlow(node: Ulid, dir: 'up' | 'down'): void {
  const around = wiresAround(node);
  if (!around) return;
  const seen = new Set<Ulid>([node]);
  for (const stack = [node]; stack.length > 0; ) {
    const at = stack.pop() as Ulid;
    for (const e of around.edges) {
      const [here, there] = dir === 'down' ? [e.from.node, e.to.node] : [e.to.node, e.from.node];
      if (here === at && !seen.has(there)) {
        seen.add(there);
        stack.push(there);
      }
    }
  }
  const ids = [...seen];
  useUi.getState().select(ids.length > 1 ? { nodes: ids } : { node });
}

/**
 * AFD-238: Ctrl+arrow moves the selection along a wire: down to the step the selected one goes on
 * to (its first wired main output, else any wire out), up to the step it came from. True when it
 * moved.
 */
export function followWire(dir: 'up' | 'down'): boolean {
  const ui = useUi.getState();
  const from = ui.selection.node;
  const around = from ? wiresAround(from) : undefined;
  if (!from || !around) return false;
  let next: Ulid | undefined;
  if (dir === 'up') next = around.edges.find((e) => e.to.node === from)?.from.node;
  else {
    const out = around.edges.filter((e) => e.from.node === from);
    const mains = mainOutputs(around.node);
    next = (out.find((e) => mains.includes(e.from.port)) ?? out[0])?.to.node;
  }
  if (!next) return false;
  ui.select({ node: next });
  // The focus goes with it, so the next key (Enter, arrows, F2) is this node's.
  document.querySelector<HTMLElement>(`.react-flow__node[data-id="${next}"]`)?.focus();
  return true;
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

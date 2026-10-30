// Copy and paste of nodes (AFD-17). The text goes through the system clipboard, so a copy pastes
// into another flow, another spot or level of this one, or a text file kept as a snippet. Keys go
// through the document's copy/paste events (VS Code's own Ctrl+C / Ctrl+V); buttons and the
// palette commands go through the host, which owns the clipboard there.
import { copyNodes } from '../core/flow/clipboard';
import type { Position, Ulid } from '../core/flow/types';
import { command, send } from './bus';
import { useUi } from './store';

/** The selected nodes as clipboard text; undefined when no node is selected. */
export function selectionText(): { text: string; count: number } | undefined {
  const { selection, snapshot } = useUi.getState();
  const ids = selection.nodes ?? (selection.node ? [selection.node] : []);
  if (!snapshot?.doc || ids.length === 0) return undefined;
  const text = copyNodes(snapshot.doc, ids, snapshot.autoPositions);
  return text ? { text, count: ids.length } : undefined;
}

/** Copy through the host (buttons, palette command). */
export function copySelection(): void {
  const copied = selectionText();
  if (copied) send({ type: 'copyText', ...copied });
  else useUi.getState().setError('Select the nodes to copy first');
}

let placeOf: () => Position | undefined = () => undefined;
let last: { at: Position; times: number } | undefined;

/** The canvas tells where a paste lands: the pointer, else the middle of the view. */
export function setPastePlace(place: () => Position | undefined): void {
  placeOf = place;
}

/** Pastes on the open level and selects what was pasted; a repeat at one spot steps aside. */
export async function pasteText(text: string): Promise<Ulid[]> {
  const ui = useUi.getState();
  if (!ui.snapshot?.doc) return [];
  if (ui.mode === 'run') {
    ui.setError('Run mode is read-only: switch to Design to paste');
    return [];
  }
  const at = placeOf();
  if (at && last && last.at.x === at.x && last.at.y === at.y) last.times += 1;
  else last = at ? { at, times: 0 } : undefined;
  const step = (last?.times ?? 0) * 32;
  const ack = await command({
    kind: 'pasteNodes',
    text,
    level: ui.level,
    ...(at ? { position: { x: at.x + step, y: at.y + step } } : {}),
  });
  if (!ack.ok) {
    useUi.getState().setError(ack.error ?? 'Nothing was pasted');
    return [];
  }
  const pasted = ack.pasted ?? [];
  if (pasted.length > 1) useUi.getState().select({ nodes: pasted });
  else if (pasted[0]) useUi.getState().select({ node: pasted[0] });
  return pasted;
}

/**
 * Typing in a field, or text selected in a panel, keeps the browser's own copy and paste. Text
 * selected on the canvas does not count: a right-click there can select a word of a node title.
 */
function ownedByText(): boolean {
  const active = document.activeElement as HTMLElement | null;
  if (active?.closest('input, textarea, select, [contenteditable="true"]')) return true;
  const selected = document.getSelection();
  if (!selected?.toString()) return false;
  const at = selected.anchorNode;
  const element = at instanceof Element ? at : at?.parentElement;
  return !element?.closest('.react-flow');
}

/** Document copy/paste listeners for the canvas; returns the cleanup. */
export function installClipboard(): () => void {
  const onCopy = (e: ClipboardEvent) => {
    if (ownedByText() || !e.clipboardData) return;
    const copied = selectionText();
    if (!copied) return;
    e.clipboardData.setData('text/plain', copied.text);
    e.preventDefault();
  };
  const onPaste = (e: ClipboardEvent) => {
    if (ownedByText()) return;
    const text = e.clipboardData?.getData('text/plain');
    if (!text?.trim()) return;
    e.preventDefault();
    void pasteText(text);
  };
  document.addEventListener('copy', onCopy);
  document.addEventListener('paste', onPaste);
  return () => {
    document.removeEventListener('copy', onCopy);
    document.removeEventListener('paste', onPaste);
  };
}

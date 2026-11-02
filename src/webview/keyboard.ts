// Keyboard shortcuts on the canvas (AFD-18), from one document listener. VS Code also receives
// every key a webview gets (from the window, after us), so keys handled here stop propagating;
// Ctrl/Cmd+C, X, V, Z and Y are never stopped, since VS Code turns them into copy, cut, paste and
// undo for the page. Typing in a field and keys inside menus and dialogs (`nokey`) are left alone.
import { chooseMode } from './actions';
import { addAnnotation, editAnnotation } from './annotationActions';
import { canvasPlace } from './clipboard';
import {
  canEdit,
  deleteSelection,
  duplicate,
  rename,
  selectAll,
  selectedAnnotations,
  selectedNodes,
  upLevel,
} from './editActions';
import { CLOSED, ESCAPE_ORDER, isOpen } from './overlays';
import { addNode } from './portActions';
import { IS_MAC } from './shortcuts';
import { type Mode, useUi } from './store';

const FIELD = 'input, textarea, select, [contenteditable="true"]';

/** Escape closes the innermost open thing, and only that; at the end it clears the selection. */
function closeInnermost(): boolean {
  const ui = useUi.getState();
  const open = ESCAPE_ORDER.find((o) => isOpen(ui, o));
  if (open) useUi.setState({ [open]: CLOSED[open] });
  else if (ui.leave) ui.resolveLeave('stay');
  else if (ui.preview) ui.setPreview(null);
  else if (
    ui.selection.node ||
    ui.selection.nodes ||
    ui.selection.edge ||
    ui.selection.annotations?.length
  )
    ui.select({});
  else return false;
  return true;
}

/** Shift+F10 or the Menu key with nothing focused: the menu for the selection, or the canvas. */
function keyboardMenu(): void {
  const ui = useUi.getState();
  const { selection } = ui;
  const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
  const pane = box('.react-flow');
  if (!pane) return;
  const middle = { x: pane.left + pane.width / 2, y: pane.top + pane.height / 3 };
  if (selection.nodes?.length) {
    const r = box(`.react-flow__node[data-id="${selection.nodes[0]}"]`);
    ui.openContextMenu({
      target: { kind: 'nodes', ids: selection.nodes },
      x: r ? r.left + 12 : middle.x,
      y: r ? r.bottom : middle.y,
    });
  } else if (selection.node) {
    const r = box(`.react-flow__node[data-id="${selection.node}"]`);
    ui.openContextMenu({
      target: { kind: 'node', id: selection.node },
      x: r ? r.left + 12 : middle.x,
      y: r ? r.bottom : middle.y,
    });
  } else if (selection.annotations?.length) {
    const [first] = selection.annotations;
    const r = box(`.react-flow__node[data-id="${first}"]`);
    ui.openContextMenu({
      target:
        selection.annotations.length > 1
          ? { kind: 'annotations', ids: selection.annotations }
          : { kind: 'annotation', id: first as string },
      x: r ? r.left + 12 : middle.x,
      y: r ? r.bottom : middle.y,
    });
  } else {
    ui.openContextMenu({ target: { kind: 'pane' }, x: middle.x, y: middle.y });
  }
}

const MODE_KEYS: Record<string, Mode> = { Digit1: 'design', Digit2: 'code', Digit3: 'run' };

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target as Element | null;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    // Find (AFD-48) from anywhere in the designer, a field included: VS Code's own Find has
    // nothing to search in the page.
    const modKey = IS_MAC ? e.metaKey : e.ctrlKey;
    if (modKey && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'f') {
      consume();
      useUi.getState().openFind(true);
      return;
    }
    if (target?.closest?.(FIELD)) return;
    if (e.key === 'Escape') {
      if (closeInnermost()) consume();
      return;
    }
    if (target?.closest?.('.nokey')) return;
    const ui = useUi.getState();
    const mod = IS_MAC ? e.metaKey : e.ctrlKey;
    if ((e.key === 'Delete' || e.key === 'Backspace') && !mod && !e.altKey) {
      // The whole selection in one command (React Flow's own delete key is off).
      const nodes = selectedNodes();
      const notes = selectedAnnotations();
      const edge = ui.selection.edge;
      if (canEdit() && (nodes.length > 0 || notes.length > 0 || edge)) {
        consume();
        void deleteSelection(nodes, edge ? [edge] : [], notes);
      }
    } else if (e.key === 'F2' && !mod && !e.altKey) {
      const ids = selectedNodes();
      const notes = selectedAnnotations();
      if (ids.length === 1 && ids[0] && ui.mode === 'design') {
        consume();
        rename(ids[0]);
      } else if (ids.length === 0 && notes.length === 1 && notes[0] && canEdit()) {
        consume();
        editAnnotation(notes[0]);
      }
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
      const ids = selectedNodes();
      const notes = selectedAnnotations();
      if (ids.length + notes.length > 0) {
        consume();
        void duplicate(ids, notes);
      }
    } else if (e.altKey && !mod && e.key === 'ArrowUp') {
      consume();
      upLevel();
    } else if (e.key === '?' && !mod && !e.altKey) {
      consume();
      ui.showCheatSheet(true);
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'a') {
      // Every node of the level when the canvas (or nothing) has the focus; text in a panel keeps
      // the browser's own Select All.
      if (target && target !== document.body && !target.closest?.('.react-flow')) return;
      consume();
      selectAll();
    } else if (e.key.toLowerCase() === 'n' && !mod && !e.altKey && e.shiftKey) {
      // AFD-65: a Note on the selected node, else where a paste would land.
      if (!canEdit()) return;
      consume();
      const one = ui.selection.node;
      void addAnnotation('note', one ? undefined : canvasPlace(), one);
    } else if (e.key.toLowerCase() === 'n' && !mod && !e.altKey && !e.shiftKey) {
      if (!canEdit()) return;
      consume();
      addNode();
    } else if (e.altKey && !mod && !e.shiftKey && MODE_KEYS[e.code]) {
      consume();
      chooseMode(MODE_KEYS[e.code] as Mode);
    }
  };
  // The Menu key or Shift+F10 with the focus on the page itself: our menu, not VS Code's. On a
  // focused node the canvas opens it; in a field the native menu stays.
  const onMenu = (e: MouseEvent) => {
    if (e.defaultPrevented) return;
    if (e.target !== document.body && e.target !== document.documentElement) return;
    e.preventDefault();
    keyboardMenu();
  };
  document.addEventListener('keydown', onKey);
  document.addEventListener('contextmenu', onMenu);
  return () => {
    document.removeEventListener('keydown', onKey);
    document.removeEventListener('contextmenu', onMenu);
  };
}

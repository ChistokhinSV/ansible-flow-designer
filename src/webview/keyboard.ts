// Keyboard shortcuts on the canvas (AFD-18), from one document listener. VS Code also receives
// every key a webview gets (from the window, after us), so keys handled here stop propagating;
// Ctrl/Cmd+C, X, V, Z and Y are never stopped, since VS Code turns them into copy, cut, paste and
// undo for the page. Typing in a field and keys inside menus and dialogs (`nokey`) are left alone.
import { canEdit, deleteSelection, duplicate, rename, selectedNodes, upLevel } from './editActions';
import { IS_MAC } from './shortcuts';
import { useUi } from './store';

const FIELD = 'input, textarea, select, [contenteditable="true"]';

/** Escape closes the innermost open thing, and only that; at the end it clears the selection. */
function closeInnermost(): boolean {
  const ui = useUi.getState();
  if (ui.contextMenu) ui.openContextMenu(null);
  else if (ui.portMenu) ui.openPortMenu(null);
  else if (ui.cheatSheet) ui.showCheatSheet(false);
  else if (ui.quickAdd) ui.openQuickAdd(null);
  else if (ui.decide) ui.setDecide(null);
  else if (ui.ignore) ui.setIgnore(null);
  else if (ui.accept) ui.setAccept(null);
  else if (ui.pick) ui.setPick(null);
  // The properties page closes itself (it may ask about unsaved changes).
  else if (ui.properties) return false;
  else if (ui.preview) ui.setPreview(null);
  else if (ui.selection.node || ui.selection.nodes || ui.selection.edge) ui.select({});
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
  } else {
    ui.openContextMenu({ target: { kind: 'pane' }, x: middle.x, y: middle.y });
  }
}

export function installKeyboard(): () => void {
  const onKey = (e: KeyboardEvent) => {
    if (e.defaultPrevented) return;
    const target = e.target as Element | null;
    if (target?.closest?.(FIELD)) return;
    const consume = () => {
      e.preventDefault();
      e.stopPropagation();
    };
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
      const edge = ui.selection.edge;
      if (canEdit() && (nodes.length > 0 || edge)) {
        consume();
        void deleteSelection(nodes, edge ? [edge] : []);
      }
    } else if (e.key === 'F2' && !mod && !e.altKey) {
      const ids = selectedNodes();
      if (ids.length === 1 && ids[0] && ui.mode === 'design') {
        consume();
        rename(ids[0]);
      }
    } else if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') {
      const ids = selectedNodes();
      if (ids.length > 0) {
        consume();
        void duplicate(ids);
      }
    } else if (e.altKey && !mod && e.key === 'ArrowUp') {
      consume();
      upLevel();
    } else if (e.key === '?' && !mod && !e.altKey) {
      consume();
      ui.showCheatSheet(true);
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

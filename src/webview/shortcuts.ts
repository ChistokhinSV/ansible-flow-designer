// The designer's keyboard shortcuts (AFD-18): one table for the menu hints and the `?` sheet, so
// they cannot disagree. Ctrl on Windows and Linux is ⌘ on macOS.
import type { ShortcutId } from '../core/flow/canvasMenu';

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const MOD = IS_MAC ? '⌘' : 'Ctrl+';

export interface Shortcut {
  id: ShortcutId | 'undo' | 'nudge' | 'select' | 'escape';
  keys: string;
  label: string;
  group: 'Edit' | 'Move around' | 'Canvas';
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'copy', keys: `${MOD}C`, label: 'Copy the selected nodes, as YAML text', group: 'Edit' },
  { id: 'cut', keys: `${MOD}X`, label: 'Cut the selected nodes', group: 'Edit' },
  { id: 'paste', keys: `${MOD}V`, label: 'Paste nodes at the pointer', group: 'Edit' },
  { id: 'duplicate', keys: `${MOD}D`, label: 'Duplicate the selected nodes', group: 'Edit' },
  { id: 'delete', keys: 'Delete', label: 'Delete the selection, in one undo step', group: 'Edit' },
  { id: 'rename', keys: 'F2', label: 'Rename the selected node', group: 'Edit' },
  { id: 'undo', keys: `${MOD}Z`, label: 'Undo (VS Code keeps one step per change)', group: 'Edit' },
  { id: 'open', keys: 'Enter', label: 'Open the selected subflow', group: 'Move around' },
  {
    id: 'up',
    keys: IS_MAC ? '⌥↑' : 'Alt+↑',
    label: 'Up to the parent level',
    group: 'Move around',
  },
  {
    id: 'menu',
    keys: 'Shift+F10',
    label: 'Menu for the selection, or the canvas',
    group: 'Move around',
  },
  {
    id: 'nudge',
    keys: 'Arrow keys',
    label: 'Nudge the focused node (Shift: further)',
    group: 'Canvas',
  },
  {
    id: 'select',
    keys: `${MOD}click, Shift+drag`,
    label: 'Select several nodes',
    group: 'Canvas',
  },
  {
    id: 'escape',
    keys: 'Esc',
    label: 'Close the menu or dialog; else clear the selection',
    group: 'Canvas',
  },
  { id: 'help', keys: '?', label: 'This list', group: 'Canvas' },
];

/** The keys shown next to a menu item. */
export function keysOf(id: ShortcutId | undefined): string | undefined {
  return id ? SHORTCUTS.find((s) => s.id === id)?.keys : undefined;
}

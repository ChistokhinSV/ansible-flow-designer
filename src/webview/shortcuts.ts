// The designer's keyboard shortcuts (AFD-18): one table for the menu hints and the `?` sheet, so
// they cannot disagree. Ctrl on Windows and Linux is ⌘ on macOS.
import type { ShortcutId } from '../core/flow/canvasMenu';

export const IS_MAC =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);

const MOD = IS_MAC ? '⌘' : 'Ctrl+';

/** Keys VS Code handles while the designer has focus (package.json `keybindings`, AFD-41). */
type FlowKey = 'runSkeleton' | 'stopRun' | 'generate' | 'tidyUp' | 'check';

export interface Shortcut {
  id:
    | ShortcutId
    | 'undo'
    | 'redo'
    | 'nudge'
    | 'select'
    | 'escape'
    | 'modes'
    | 'ports'
    | 'pick'
    | FlowKey;
  keys: string;
  label: string;
  group: 'Edit' | 'Move around' | 'Canvas' | 'Flow';
}

export const SHORTCUTS: readonly Shortcut[] = [
  { id: 'copy', keys: `${MOD}C`, label: 'Copy the selected nodes, as YAML text', group: 'Edit' },
  { id: 'cut', keys: `${MOD}X`, label: 'Cut the selected nodes', group: 'Edit' },
  { id: 'paste', keys: `${MOD}V`, label: 'Paste nodes at the pointer', group: 'Edit' },
  { id: 'duplicate', keys: `${MOD}D`, label: 'Duplicate the selected nodes', group: 'Edit' },
  { id: 'delete', keys: 'Delete', label: 'Delete the selection, in one undo step', group: 'Edit' },
  {
    id: 'rename',
    keys: 'F2',
    label: "Rename the selected node, or edit a note's text",
    group: 'Edit',
  },
  { id: 'undo', keys: `${MOD}Z`, label: 'Undo (VS Code keeps one step per change)', group: 'Edit' },
  { id: 'redo', keys: IS_MAC ? '⇧⌘Z' : 'Ctrl+Y', label: 'Redo', group: 'Edit' },
  {
    id: 'addNode',
    keys: 'N',
    label: 'Add a node: after the selected one, else at the pointer',
    group: 'Edit',
  },
  {
    id: 'addNote',
    keys: 'Shift+N',
    label: 'Add a note: on the selected node, else at the pointer',
    group: 'Edit',
  },
  {
    id: 'open',
    keys: 'Enter',
    label: "Open the selected subflow, or go to the node's Details",
    group: 'Move around',
  },
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
  { id: 'find', keys: `${MOD}F`, label: 'Find a node on any level', group: 'Move around' },
  {
    id: 'ports',
    keys: 'Tab, Enter',
    label: "The selected node's ports; Enter opens a port's menu",
    group: 'Move around',
  },
  {
    id: 'pick',
    keys: 'Tab or arrows, Enter',
    label: 'While connecting: show a node, then wire it',
    group: 'Move around',
  },
  {
    id: 'modes',
    keys: IS_MAC ? '⌥1, ⌥2, ⌥3' : 'Alt+1, Alt+2, Alt+3',
    label: 'Design, Code or Run mode',
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
  { id: 'selectAll', keys: `${MOD}A`, label: 'Select every node of the level', group: 'Canvas' },
  { id: 'fit', keys: 'Shift+1', label: 'Fit the whole level in view', group: 'Canvas' },
  {
    id: 'escape',
    keys: 'Esc',
    label: 'Close the menu or dialog; else clear the selection',
    group: 'Canvas',
  },
  { id: 'help', keys: '?', label: 'This list', group: 'Canvas' },
  { id: 'runSkeleton', keys: 'Ctrl+F5', label: 'Run as Skeleton', group: 'Flow' },
  { id: 'stopRun', keys: 'Shift+F5', label: 'Stop Run', group: 'Flow' },
  { id: 'generate', keys: IS_MAC ? '⇧⌘B' : 'Ctrl+Shift+B', label: 'Generate Code', group: 'Flow' },
  { id: 'tidyUp', keys: IS_MAC ? '⇧⌥F' : 'Shift+Alt+F', label: 'Tidy Up', group: 'Flow' },
  { id: 'check', keys: 'F7', label: 'Check Flow', group: 'Flow' },
];

/** The keys shown next to a menu item. */
export function keysOf(id: ShortcutId | undefined): string | undefined {
  return id ? SHORTCUTS.find((s) => s.id === id)?.keys : undefined;
}

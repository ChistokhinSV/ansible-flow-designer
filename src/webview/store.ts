import { create } from 'zustand';
import type { BindKind } from '../core/catalog/draft';
import { computeDrift } from '../core/drift/drift';
import type { CodeScan, DriftReport } from '../core/drift/types';
import type { CanvasMode, CanvasTarget } from '../core/flow/canvasMenu';
import { modelOf, ROOT } from '../core/flow/model';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import { lensView } from '../core/lens';
import type { LensFacts, LensId, LensView } from '../core/lens/types';
import type { CatalogStatus, RunView, Snapshot } from '../core/protocol';
import { type NodeRun, runStates } from '../core/run/view';
import { closing, HOLDS_POINTER, isOpen } from './overlays';

export interface QuickAddState {
  type: NodeType;
  position?: Position;
  connectFrom?: PortRef;
  /** Insert the new node on this edge (port menu "Insert node on this wire"). */
  insertOn?: Ulid;
  /** Prefilled title (port menu suggestions such as "Cleanup task"). */
  title?: string;
}

export interface Selection {
  node?: Ulid;
  edge?: Ulid;
  /** Several nodes (Ctrl/Cmd+click, Shift+drag): Extract into subflow (AFD-7). */
  nodes?: Ulid[];
}

/** Port menu (04 §3), anchored at a point in the window. */
export interface PortMenuState {
  ref: PortRef;
  x: number;
  y: number;
}

/**
 * Canvas context menu (AFD-18): what was right-clicked, where (window) and the same spot on the
 * canvas, so Paste and Add node land there.
 */
export interface ContextMenuState {
  target: CanvasTarget;
  x: number;
  y: number;
  at?: Position;
}

/** A field to focus (F2 Rename, Extract, Edit reason); the nonce repeats the request. */
export interface FocusRequest {
  field: 'title' | 'extractTitle' | 'exitReason';
  nonce: number;
}

/** Hover preview card (D-22), anchored right of the node (or left of it near the window edge). */
export interface PreviewState {
  node: Ulid;
  x: number;
  y: number;
  /** Left edge of the node, for opening the card on the other side. */
  left: number;
}

/** D-22: about 400 ms of pause on a node before its card opens. */
export const PREVIEW_DELAY = 400;
let openTimer: ReturnType<typeof setTimeout> | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;
let onCard = false;

/** Tabs of the Details panel (AFD-43); Code and Run modes add their own first. */
export type PropTab = 'general' | 'binding' | 'io' | 'ports' | 'execution' | 'code' | 'run';

/**
 * What the user asked for while a staged binding was not saved (AFD-43): it happens once they
 * choose to save or discard the binding, and not if they keep editing.
 */
export type Leave =
  | { kind: 'select'; selection: Selection }
  | { kind: 'level'; level: string }
  | { kind: 'mode'; mode: Mode }
  | { kind: 'reveal'; node: Ulid }
  | { kind: 'details'; node: Ulid; tab: PropTab; bindKind?: BindKind };

/** A message over the canvas (AFD-46): what happened, as info, success or error. */
export type ToastLevel = 'info' | 'success' | 'error';
export interface Toast {
  id: number;
  level: ToastLevel;
  text: string;
}
/** How long a toast stays, in ms: errors longer, so they can be read. */
export const TOAST_MS: Record<ToastLevel, number> = { info: 4000, success: 4000, error: 9000 };
let toastId = 0;

/** The side panel's width when not expanded, in px (AFD-43). */
export const PANEL_WIDTH = { min: 260, initial: 340, max: 720 };

/**
 * Design edits the graph; Implementation shows it against the code (M6, mockup 04); Run shows what
 * the last run did per node, wire and host (M7, 04 §10).
 */
export type Mode = CanvasMode;

export interface SyncState {
  state: 'idle' | 'syncing' | 'done' | 'error';
  scan?: CodeScan;
  error?: string;
}

/** A drift item whose Ignore reason is being entered. */
export interface IgnoreTarget {
  node: Ulid;
  item: string;
  title: string;
  label: string;
}

/** A lens finding whose "Accept with Reason…" reason is being entered (M8). */
export interface AcceptTarget {
  id: string;
  node?: Ulid;
  title: string;
}

/** Waiting for a node click to finish a port menu action ("Connect to another node…"). */
export interface PickState {
  mode: 'to' | 'from' | 'rewire';
  ref: PortRef;
  edge?: Ulid;
}

interface UiState {
  snapshot: Snapshot | null;
  testMode: boolean;
  selection: Selection;
  quickAdd: QuickAddState | null;
  portMenu: PortMenuState | null;
  contextMenu: ContextMenuState | null;
  focusRequest: FocusRequest | null;
  /** The keyboard shortcuts sheet (`?`). */
  cheatSheet: boolean;
  pick: PickState | null;
  /** Port whose open-on-purpose reason is being entered. */
  decide: PortRef | null;
  /** Banner hidden by the user for this count of open ports. */
  bannerDismissedAt: number | null;
  /** Positions dragged locally and not yet confirmed by a snapshot. */
  optimistic: Record<Ulid, Position>;
  /** Messages over the canvas, oldest first (AFD-46). */
  toasts: Toast[];
  /** Commands sent and not answered yet: the top bar says "Saving…" (AFD-46). */
  saving: boolean;
  /** Last skeleton or real run of this flow, from the host. */
  run: RunView | null;
  /** Run mode read-out per node for the current document and run (computed, never stored). */
  runNodes: Record<Ulid, NodeRun> | null;
  /** Level on the canvas: ROOT or the subflow node whose inner graph is open (D-23). */
  level: string;
  preview: PreviewState | null;
  /** The Details panel's tab, kept from node to node (AFD-43). */
  detailsTab: PropTab;
  /** A kind to bind first (drift "Bind role"), for one node. */
  bindKind: { node: Ulid; kind: BindKind } | null;
  /** The node whose staged binding is not saved: leaving it asks first. */
  pendingBinding: Ulid | null;
  leave: Leave | null;
  /** The side panel: its width, and expanded for the catalog docs. */
  panelWidth: number;
  expanded: boolean;
  /** The environment's module catalog (M5). */
  catalog: CatalogStatus;
  mode: Mode;
  sync: SyncState;
  /** Design vs code for the current document and the last scan (computed, never stored). */
  drift: DriftReport | null;
  ignore: IgnoreTarget | null;
  /** The lens across the canvas (D-18, M8), independent of mode. */
  lens: LensId | null;
  /** The right panel shows the lens's tab (its browser and findings) rather than the mode's panel. */
  lensTab: boolean;
  lensFacts: LensFacts;
  /** The active lens for the current document, facts and run (computed, never stored). */
  lensView: LensView | null;
  /** Nodes a hovered lens panel item matches; the rest dims (04 §7). */
  highlight: Ulid[] | null;
  accept: AcceptTarget | null;
  /** A node being marked tested by hand: its reason is being entered (AFD-44). */
  testedReason: Ulid | null;
  setSnapshot(s: Snapshot): void;
  setTestMode(on: boolean): void;
  select(s: Selection): void;
  openQuickAdd(q: QuickAddState | null): void;
  openPortMenu(m: PortMenuState | null): void;
  openContextMenu(m: ContextMenuState | null): void;
  requestFocus(field: FocusRequest['field']): void;
  showCheatSheet(on: boolean): void;
  setPick(p: PickState | null): void;
  setDecide(p: PortRef | null): void;
  dismissBanner(count: number | null): void;
  setOptimistic(p: Record<Ulid, Position>): void;
  /** An error toast (a refused change, a failed action); null does nothing. */
  setError(e: string | null): void;
  notify(level: ToastLevel, text: string): void;
  dismissToast(id: number): void;
  setRun(r: RunView | null): void;
  /** Opens a level; selection, menus and picks belong to the level being left. */
  setLevel(level: string): void;
  /** Shows a node: opens its level and selects it. */
  reveal(node: Ulid): void;
  setPreview(p: PreviewState | null): void;
  /** Pointer entered a node with a card (with its box) or left it (null). */
  hoverNode(node: Ulid | null, box?: { left: number; right: number; top: number }): void;
  /** Pointer on the card keeps it open. */
  holdPreview(on: boolean): void;
  /** Selects a node and shows a tab of its Details. */
  openDetails(node: Ulid, tab?: PropTab, bindKind?: BindKind): void;
  setDetailsTab(tab: PropTab): void;
  setPendingBinding(node: Ulid | null): void;
  /** `go` does what was asked (the binding was saved or discarded); `stay` keeps editing. */
  resolveLeave(choice: 'go' | 'stay'): void;
  setPanelWidth(width: number): void;
  setExpanded(on: boolean): void;
  setCatalog(status: CatalogStatus): void;
  setMode(mode: Mode): void;
  setSync(sync: SyncState): void;
  setIgnore(target: IgnoreTarget | null): void;
  setLens(lens: LensId | null): void;
  /** Which tab the right panel shows while a lens is on (AFD-45). */
  showLensTab(on: boolean): void;
  /** Merges facts from the host (each message carries the kinds it updates). */
  setLensFacts(facts: LensFacts): void;
  setHighlight(nodes: Ulid[] | null): void;
  setAccept(target: AcceptTarget | null): void;
  setTestedReason(node: Ulid | null): void;
}

function runOf(snapshot: Snapshot | null, run: RunView | null): Record<Ulid, NodeRun> | null {
  return snapshot?.doc && run?.summary ? runStates(snapshot.doc, run.summary) : null;
}

function lensOf(
  snapshot: Snapshot | null,
  lens: LensId | null,
  facts: LensFacts,
  run: RunView | null,
): LensView | null {
  return snapshot?.doc && lens ? lensView(lens, snapshot.doc, facts, run) : null;
}

function driftOf(snapshot: Snapshot | null, scan: CodeScan | undefined): DriftReport | null {
  return snapshot?.doc && scan ? computeDrift(snapshot.doc, scan) : null;
}

export const useUi = create<UiState>((set, get) => ({
  snapshot: null,
  testMode: false,
  selection: {},
  quickAdd: null,
  portMenu: null,
  contextMenu: null,
  focusRequest: null,
  cheatSheet: false,
  pick: null,
  decide: null,
  bannerDismissedAt: null,
  optimistic: {},
  toasts: [],
  saving: false,
  run: null,
  runNodes: null,
  level: ROOT,
  preview: null,
  detailsTab: 'general',
  bindKind: null,
  pendingBinding: null,
  leave: null,
  panelWidth: PANEL_WIDTH.initial,
  expanded: false,
  catalog: { state: 'idle' },
  mode: 'design',
  sync: { state: 'idle' },
  drift: null,
  ignore: null,
  lens: null,
  lensTab: false,
  lensFacts: {},
  lensView: null,
  highlight: null,
  accept: null,
  testedReason: null,
  setSnapshot(snapshot) {
    const current = get().snapshot;
    if (current && snapshot.docVersion < current.docVersion) return;
    // Drop optimistic positions the document now confirms (or any, once the version moved on).
    const layout = snapshot.doc?.layout ?? {};
    const optimistic = Object.fromEntries(
      Object.entries(get().optimistic).filter(([id, p]) => {
        const stored = layout[id];
        return !(stored && stored.x === Math.round(p.x) && stored.y === Math.round(p.y));
      }),
    );
    const model = snapshot.doc ? modelOf(snapshot.doc) : undefined;
    const ids = new Set(model ? model.nodes.keys() : []);
    // The open subflow may be gone (deleted, or the text was edited): fall back to the top level.
    // A subflow without inner steps has no level in the model yet, but it can be open.
    const open = get().level;
    const level =
      model?.levels.has(open) || model?.nodes.get(open)?.node.type === 'subflow' ? open : ROOT;
    const sel = get().selection;
    const selection =
      (sel.node && !ids.has(sel.node)) || sel.nodes?.some((id) => !ids.has(id)) ? {} : sel;
    const gone = (ref: PortRef | undefined) => ref !== undefined && !ids.has(ref.node);
    const target = get().contextMenu?.target;
    const lost =
      (target?.kind === 'node' && !ids.has(target.id)) ||
      (target?.kind === 'nodes' && target.ids.some((id) => !ids.has(id))) ||
      (target?.kind === 'edge' && !model?.edges.has(target.id));
    set({
      snapshot,
      optimistic,
      selection: level === get().level ? selection : {},
      level,
      ...(gone(get().portMenu?.ref) ? { portMenu: null } : {}),
      ...(lost ? { contextMenu: null } : {}),
      ...(gone(get().pick?.ref) ? { pick: null } : {}),
      ...(get().preview && !ids.has(get().preview?.node ?? '') ? { preview: null } : {}),
      drift: driftOf(snapshot, get().sync.scan),
      runNodes: runOf(snapshot, get().run),
      lensView: lensOf(snapshot, get().lens, get().lensFacts, get().run),
    });
  },
  setTestMode: (testMode) => set({ testMode }),
  select(selection) {
    const pending = get().pendingBinding;
    if (pending && selection.node !== pending)
      return void set({ leave: { kind: 'select', selection } });
    // Selecting shows what was selected: the mode's panel, not the lens's tab.
    const chosen = !!(selection.node || selection.nodes?.length || selection.edge);
    set({ selection, ...(chosen ? { lensTab: false } : {}) });
  },
  openQuickAdd: (quickAdd) => set({ quickAdd }),
  openPortMenu: (portMenu) => set({ portMenu, ...closing('portMenu') }),
  openContextMenu: (contextMenu) => {
    clearTimeout(openTimer);
    set({ contextMenu, ...closing('contextMenu') });
  },
  requestFocus: (field) => set({ focusRequest: { field, nonce: Date.now() } }),
  showCheatSheet: (cheatSheet) => set({ cheatSheet, ...closing('cheatSheet') }),
  setPick: (pick) => set({ pick, ...closing('pick') }),
  setDecide: (decide) => set({ decide, ...closing('decide') }),
  dismissBanner: (bannerDismissedAt) => set({ bannerDismissedAt }),
  setOptimistic: (p) => set({ optimistic: { ...get().optimistic, ...p } }),
  setError(error) {
    if (error) get().notify('error', error);
  },
  notify(level, text) {
    const id = ++toastId;
    // The same message again replaces the one shown; at most four stay.
    const others = get().toasts.filter((t) => t.text !== text);
    set({ toasts: [...others, { id, level, text }].slice(-4) });
    setTimeout(() => get().dismissToast(id), TOAST_MS[level]);
  },
  dismissToast: (id) => set({ toasts: get().toasts.filter((t) => t.id !== id) }),
  setRun: (run) =>
    set({
      run,
      runNodes: runOf(get().snapshot, run),
      lensView: lensOf(get().snapshot, get().lens, get().lensFacts, run),
    }),
  setLens(lens) {
    set({
      lens,
      // A lens opens on its tab; the mode's panel stays one click away (AFD-45).
      lensTab: lens !== null,
      highlight: null,
      lensView: lensOf(get().snapshot, lens, get().lensFacts, get().run),
    });
  },
  showLensTab: (lensTab) => set({ lensTab }),
  setLensFacts(facts) {
    const lensFacts = { ...get().lensFacts, ...facts };
    set({ lensFacts, lensView: lensOf(get().snapshot, get().lens, lensFacts, get().run) });
  },
  setHighlight: (highlight) => set({ highlight }),
  setAccept: (accept) => set({ accept }),
  setTestedReason: (testedReason) => set({ testedReason, ...closing('testedReason') }),
  setLevel(level) {
    if (level === get().level) return;
    if (get().pendingBinding) return void set({ leave: { kind: 'level', level } });
    clearTimeout(openTimer);
    set({ level, selection: {}, ...closing('level') });
  },
  setPreview(preview) {
    clearTimeout(openTimer);
    clearTimeout(closeTimer);
    onCard = false;
    set({ preview });
  },
  hoverNode(node, box) {
    clearTimeout(openTimer);
    if (!node || !box) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (!onCard) set({ preview: null });
      }, 200);
      return;
    }
    clearTimeout(closeTimer);
    if (get().preview?.node === node) return;
    openTimer = setTimeout(() => {
      const s = get();
      // Menus, picks and dialogs own the pointer; no card on top of them.
      if (HOLDS_POINTER.some((o) => isOpen(s, o))) return;
      set({ preview: { node, x: box.right + 12, y: box.top, left: box.left } });
    }, PREVIEW_DELAY);
  },
  holdPreview(on) {
    onCard = on;
    if (on) clearTimeout(closeTimer);
    else get().hoverNode(null);
  },
  openDetails(node, tab = 'general', bindKind) {
    clearTimeout(openTimer);
    const pending = get().pendingBinding;
    if (pending && pending !== node)
      return void set({ leave: { kind: 'details', node, tab, bindKind } });
    set({
      selection: { node },
      detailsTab: tab,
      bindKind: bindKind ? { node, kind: bindKind } : null,
      ...closing('details'),
    });
  },
  setDetailsTab: (detailsTab) => set({ detailsTab }),
  setPendingBinding: (pendingBinding) => set({ pendingBinding }),
  resolveLeave(choice) {
    const leave = get().leave;
    set({ leave: null });
    if (!leave || choice === 'stay') return;
    set({ pendingBinding: null });
    if (leave.kind === 'select') get().select(leave.selection);
    else if (leave.kind === 'level') get().setLevel(leave.level);
    else if (leave.kind === 'mode') get().setMode(leave.mode);
    else if (leave.kind === 'reveal') get().reveal(leave.node);
    else get().openDetails(leave.node, leave.tab, leave.bindKind);
  },
  setPanelWidth: (width) =>
    set({ panelWidth: Math.round(Math.min(PANEL_WIDTH.max, Math.max(PANEL_WIDTH.min, width))) }),
  setExpanded: (expanded) => set({ expanded }),
  setMode(mode) {
    if (mode === get().mode) return;
    if (get().pendingBinding) return void set({ leave: { kind: 'mode', mode } });
    // Code and Run modes open their own tab of the Details; Design leaves theirs.
    const tab = get().detailsTab;
    const detailsTab =
      mode === 'code'
        ? 'code'
        : mode === 'run'
          ? 'run'
          : tab === 'code' || tab === 'run'
            ? 'general'
            : tab;
    set({ mode, detailsTab, ...closing('mode') });
  },
  setSync(sync) {
    set({ sync, drift: driftOf(get().snapshot, sync.scan) });
  },
  setIgnore: (ignore) => set({ ignore }),
  setCatalog: (catalog) => set({ catalog }),
  reveal(node) {
    const pending = get().pendingBinding;
    if (pending && pending !== node) return void set({ leave: { kind: 'reveal', node } });
    const doc = get().snapshot?.doc;
    const entry = doc ? modelOf(doc).nodes.get(node) : undefined;
    if (!entry) return;
    get().setLevel(entry.level);
    set({ selection: { node } });
  },
}));

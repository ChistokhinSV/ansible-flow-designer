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

/** Tabs of the node properties page (mockup 11). */
export type PropTab = 'general' | 'binding' | 'io' | 'ports' | 'execution';

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
  error: string | null;
  /** Last skeleton or real run of this flow, from the host. */
  run: RunView | null;
  /** Run mode read-out per node for the current document and run (computed, never stored). */
  runNodes: Record<Ulid, NodeRun> | null;
  /** Level on the canvas: ROOT or the subflow node whose inner graph is open (D-23). */
  level: string;
  preview: PreviewState | null;
  /** The node properties page over the canvas (M5), with its open tab and a kind to bind. */
  properties: { node: Ulid; tab: PropTab; bindKind?: BindKind } | null;
  /** The environment's module catalog (M5). */
  catalog: CatalogStatus;
  mode: Mode;
  sync: SyncState;
  /** Design vs code for the current document and the last scan (computed, never stored). */
  drift: DriftReport | null;
  ignore: IgnoreTarget | null;
  /** The lens across the canvas (D-18, M8), independent of mode. */
  lens: LensId | null;
  lensFacts: LensFacts;
  /** The active lens for the current document, facts and run (computed, never stored). */
  lensView: LensView | null;
  /** Nodes a hovered lens panel item matches; the rest dims (04 §7). */
  highlight: Ulid[] | null;
  accept: AcceptTarget | null;
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
  setError(e: string | null): void;
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
  openProperties(node: Ulid, tab?: PropTab, bindKind?: BindKind): void;
  closeProperties(): void;
  setCatalog(status: CatalogStatus): void;
  setMode(mode: Mode): void;
  setSync(sync: SyncState): void;
  setIgnore(target: IgnoreTarget | null): void;
  setLens(lens: LensId | null): void;
  /** Merges facts from the host (each message carries the kinds it updates). */
  setLensFacts(facts: LensFacts): void;
  setHighlight(nodes: Ulid[] | null): void;
  setAccept(target: AcceptTarget | null): void;
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
  error: null,
  run: null,
  runNodes: null,
  level: ROOT,
  preview: null,
  properties: null,
  catalog: { state: 'idle' },
  mode: 'design',
  sync: { state: 'idle' },
  drift: null,
  ignore: null,
  lens: null,
  lensFacts: {},
  lensView: null,
  highlight: null,
  accept: null,
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
      ...(get().properties && !ids.has(get().properties?.node ?? '') ? { properties: null } : {}),
      drift: driftOf(snapshot, get().sync.scan),
      runNodes: runOf(snapshot, get().run),
      lensView: lensOf(snapshot, get().lens, get().lensFacts, get().run),
    });
  },
  setTestMode: (testMode) => set({ testMode }),
  select: (selection) => set({ selection }),
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
  setError: (error) => set({ error }),
  setRun: (run) =>
    set({
      run,
      runNodes: runOf(get().snapshot, run),
      lensView: lensOf(get().snapshot, get().lens, get().lensFacts, run),
    }),
  setLens(lens) {
    set({
      lens,
      highlight: null,
      lensView: lensOf(get().snapshot, lens, get().lensFacts, get().run),
    });
  },
  setLensFacts(facts) {
    const lensFacts = { ...get().lensFacts, ...facts };
    set({ lensFacts, lensView: lensOf(get().snapshot, get().lens, lensFacts, get().run) });
  },
  setHighlight: (highlight) => set({ highlight }),
  setAccept: (accept) => set({ accept }),
  setLevel(level) {
    if (level === get().level) return;
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
  openProperties(node, tab = 'general', bindKind) {
    clearTimeout(openTimer);
    set({ properties: { node, tab, bindKind }, ...closing('properties') });
  },
  setMode(mode) {
    set({ mode, ...closing('mode') });
  },
  setSync(sync) {
    set({ sync, drift: driftOf(get().snapshot, sync.scan) });
  },
  setIgnore: (ignore) => set({ ignore }),
  closeProperties: () => set({ properties: null }),
  setCatalog: (catalog) => set({ catalog }),
  reveal(node) {
    const doc = get().snapshot?.doc;
    const entry = doc ? modelOf(doc).nodes.get(node) : undefined;
    if (!entry) return;
    get().setLevel(entry.level);
    set({ selection: { node } });
  },
}));

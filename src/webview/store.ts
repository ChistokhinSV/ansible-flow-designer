import { create } from 'zustand';
import type { BindKind } from '../core/catalog/draft';
import { computeDrift } from '../core/drift/drift';
import type { CodeScan, DriftReport } from '../core/drift/types';
import { buildModel, ROOT } from '../core/flow/model';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import type { CatalogStatus, RunView, Snapshot } from '../core/protocol';

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
}

/** Port menu (04 §3), anchored at a point in the window. */
export interface PortMenuState {
  ref: PortRef;
  x: number;
  y: number;
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
export type PropTab = 'general' | 'implementation' | 'io' | 'ports' | 'execution';

/** Design edits the graph; Implementation shows it against the code (M6, mockup 04). */
export type Mode = 'design' | 'implementation';

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
  setSnapshot(s: Snapshot): void;
  setTestMode(on: boolean): void;
  select(s: Selection): void;
  openQuickAdd(q: QuickAddState | null): void;
  openPortMenu(m: PortMenuState | null): void;
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
  pick: null,
  decide: null,
  bannerDismissedAt: null,
  optimistic: {},
  error: null,
  run: null,
  level: ROOT,
  preview: null,
  properties: null,
  catalog: { state: 'idle' },
  mode: 'design',
  sync: { state: 'idle' },
  drift: null,
  ignore: null,
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
    const model = snapshot.doc ? buildModel(snapshot.doc) : undefined;
    const ids = new Set(model ? model.nodes.keys() : []);
    // The open subflow may be gone (deleted, or the text was edited): fall back to the top level.
    // A subflow without inner steps has no level in the model yet, but it can be open.
    const open = get().level;
    const level =
      model?.levels.has(open) || model?.nodes.get(open)?.node.type === 'subflow' ? open : ROOT;
    const sel = get().selection;
    const selection = sel.node && !ids.has(sel.node) ? {} : sel;
    const gone = (ref: PortRef | undefined) => ref !== undefined && !ids.has(ref.node);
    set({
      snapshot,
      optimistic,
      selection: level === get().level ? selection : {},
      level,
      ...(gone(get().portMenu?.ref) ? { portMenu: null } : {}),
      ...(gone(get().pick?.ref) ? { pick: null } : {}),
      ...(get().preview && !ids.has(get().preview?.node ?? '') ? { preview: null } : {}),
      ...(get().properties && !ids.has(get().properties?.node ?? '') ? { properties: null } : {}),
      drift: driftOf(snapshot, get().sync.scan),
    });
  },
  setTestMode: (testMode) => set({ testMode }),
  select: (selection) => set({ selection }),
  openQuickAdd: (quickAdd) => set({ quickAdd }),
  openPortMenu: (portMenu) => set({ portMenu }),
  setPick: (pick) => set({ pick, portMenu: null }),
  setDecide: (decide) => set({ decide, portMenu: null }),
  dismissBanner: (bannerDismissedAt) => set({ bannerDismissedAt }),
  setOptimistic: (p) => set({ optimistic: { ...get().optimistic, ...p } }),
  setError: (error) => set({ error }),
  setRun: (run) => set({ run }),
  setLevel(level) {
    if (level === get().level) return;
    clearTimeout(openTimer);
    set({
      level,
      selection: {},
      portMenu: null,
      pick: null,
      quickAdd: null,
      decide: null,
      preview: null,
    });
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
      if (s.portMenu || s.pick || s.quickAdd || s.decide) return;
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
    set({ properties: { node, tab, bindKind }, preview: null, portMenu: null, quickAdd: null });
  },
  setMode(mode) {
    set({ mode, portMenu: null, pick: null, quickAdd: null, preview: null });
  },
  setSync(sync) {
    set({ sync, drift: driftOf(get().snapshot, sync.scan) });
  },
  setIgnore: (ignore) => set({ ignore }),
  closeProperties: () => set({ properties: null }),
  setCatalog: (catalog) => set({ catalog }),
  reveal(node) {
    const doc = get().snapshot?.doc;
    const entry = doc ? buildModel(doc).nodes.get(node) : undefined;
    if (!entry) return;
    get().setLevel(entry.level);
    set({ selection: { node } });
  },
}));

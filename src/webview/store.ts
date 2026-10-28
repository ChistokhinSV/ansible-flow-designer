import { create } from 'zustand';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import type { Snapshot } from '../core/protocol';

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
    const ids = new Set(snapshot.doc?.nodes?.map((n) => n.id) ?? []);
    const sel = get().selection;
    const selection = sel.node && !ids.has(sel.node) ? {} : sel;
    const gone = (ref: PortRef | undefined) => ref !== undefined && !ids.has(ref.node);
    set({
      snapshot,
      optimistic,
      selection,
      ...(gone(get().portMenu?.ref) ? { portMenu: null } : {}),
      ...(gone(get().pick?.ref) ? { pick: null } : {}),
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
}));

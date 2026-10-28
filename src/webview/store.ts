import { create } from 'zustand';
import type { NodeType, PortRef, Position, Ulid } from '../core/flow/types';
import type { Snapshot } from '../core/protocol';

export interface QuickAddState {
  type: NodeType;
  position?: Position;
  connectFrom?: PortRef;
}

export interface Selection {
  node?: Ulid;
  edge?: Ulid;
}

interface UiState {
  snapshot: Snapshot | null;
  testMode: boolean;
  selection: Selection;
  quickAdd: QuickAddState | null;
  /** Banner hidden by the user for this count of open ports. */
  bannerDismissedAt: number | null;
  /** Positions dragged locally and not yet confirmed by a snapshot. */
  optimistic: Record<Ulid, Position>;
  error: string | null;
  setSnapshot(s: Snapshot): void;
  setTestMode(on: boolean): void;
  select(s: Selection): void;
  openQuickAdd(q: QuickAddState | null): void;
  dismissBanner(count: number | null): void;
  setOptimistic(p: Record<Ulid, Position>): void;
  setError(e: string | null): void;
}

export const useUi = create<UiState>((set, get) => ({
  snapshot: null,
  testMode: false,
  selection: {},
  quickAdd: null,
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
    set({ snapshot, optimistic, selection });
  },
  setTestMode: (testMode) => set({ testMode }),
  select: (selection) => set({ selection }),
  openQuickAdd: (quickAdd) => set({ quickAdd }),
  dismissBanner: (bannerDismissedAt) => set({ bannerDismissedAt }),
  setOptimistic: (p) => set({ optimistic: { ...get().optimistic, ...p } }),
  setError: (error) => set({ error }),
}));

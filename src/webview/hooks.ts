// The flow model and views derived from the current snapshot (AFD-34): built once per snapshot
// (`modelOf` caches by document), so components read them instead of building their own.
import { useMemo } from 'react';
import { type FlowModel, modelOf, type NodeEntry } from '../core/flow/model';
import { useUi } from './store';
import { type LevelView, levelView } from './viewModel';

/** The model of the snapshot's flow; undefined while there is no parsed flow. */
export function useModel(): FlowModel | undefined {
  return useUi((s) => (s.snapshot?.doc ? modelOf(s.snapshot.doc) : undefined));
}

/** A node and where it is (level, YAML path), at any level. */
export function useNode(id: string | undefined): NodeEntry | undefined {
  const model = useModel();
  return id ? model?.nodes.get(id) : undefined;
}

/** The canvas view of a level (the open one by default), with dragged positions applied. */
export function useLevelView(level?: string): LevelView {
  const snapshot = useUi((s) => s.snapshot);
  const optimistic = useUi((s) => s.optimistic);
  const open = useUi((s) => s.level);
  const at = level ?? open;
  return useMemo(
    () => (snapshot ? levelView(snapshot, optimistic, at) : { nodes: [], edges: [] }),
    [snapshot, optimistic, at],
  );
}

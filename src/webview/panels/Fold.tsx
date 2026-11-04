// A fold (AFD-72, ADR-0029): rarer fields behind a summary that says what is inside. It is open
// while a field inside has a value or a problem (`open`), else as this viewer last left it. A lazy
// fold renders its content only while open (AFD-80: a closed Change Module runs no search).
import { type ReactNode, useState } from 'react';
import { loadState, saveState } from '../bus';

type Folds = { folds?: Record<string, boolean> };

export function Fold({
  id,
  summary,
  open: needed = false,
  lazy = false,
  children,
}: {
  /** Names the fold in the viewer's saved state, so it stays as they left it. */
  id: string;
  summary: ReactNode;
  open?: boolean;
  lazy?: boolean;
  children: ReactNode;
}) {
  const [left, setLeft] = useState(() => loadState<Folds>().folds?.[id] ?? false);
  const open = needed || left;
  return (
    <details
      className="afd-fold"
      data-fold={id}
      open={open}
      onToggle={(e) => {
        const now = e.currentTarget.open;
        if (now === open) return;
        setLeft(now);
        const saved = loadState<Folds>();
        saveState({ ...saved, folds: { ...saved.folds, [id]: now } });
      }}
    >
      <summary>{summary}</summary>
      {open || !lazy ? children : null}
    </details>
  );
}

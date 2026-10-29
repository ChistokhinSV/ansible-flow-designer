// Run history entries and the statistics the Timing lens shows (decision M8-2). Pure; the host
// stores the entries.
import type { RunView } from '../protocol';
import type { TimingFacts } from './types';

export const HISTORY_LIMIT = 20;

export interface HistoryEntry {
  id: string;
  at: string;
  source: 'local' | 'awx';
  rc?: number;
  /** Seconds per node, from the run's first to last event of the node's plays. */
  timings: Record<string, number>;
}

/** A finished real run with timings becomes an entry; skeleton runs measure TODO stubs only. */
export function historyEntry(run: RunView): HistoryEntry | undefined {
  const t = run.summary?.timings;
  if (run.state !== 'done' || run.mode !== 'real' || !t || Object.keys(t).length === 0)
    return undefined;
  return {
    id: run.id,
    at: run.finishedAt ?? run.startedAt,
    source: run.source ?? 'local',
    rc: run.rc,
    timings: Object.fromEntries(
      Object.entries(t).map(([n, x]) => [n, Math.max(0, x.end - x.start)]),
    ),
  };
}

/** Adds an entry (once per run id), newest last, keeping the last HISTORY_LIMIT. */
export function appendEntry(entries: HistoryEntry[], entry: HistoryEntry): HistoryEntry[] {
  return [...entries.filter((e) => e.id !== entry.id), entry].slice(-HISTORY_LIMIT);
}

export function timingStats(entries: HistoryEntry[]): TimingFacts {
  const per = new Map<string, number[]>();
  for (const e of entries)
    for (const [node, s] of Object.entries(e.timings)) per.set(node, [...(per.get(node) ?? []), s]);
  const nodes: TimingFacts['nodes'] = {};
  for (const [node, list] of per) {
    const sorted = [...list].sort((a, b) => a - b);
    nodes[node] = {
      runs: list.length,
      avg: list.reduce((a, b) => a + b, 0) / list.length,
      // Nearest rank.
      p95: sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)] ?? 0,
      last: list.at(-1) ?? 0,
    };
  }
  return { runs: entries.length, nodes };
}

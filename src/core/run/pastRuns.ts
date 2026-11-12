// AFD-245: the runs kept of a flow, as the Run panel lists them. A finished local run is stored
// whole beside its events (run.json: the summary the canvas showed, no input values), so an
// earlier run can be shown again on the canvas as it was.
import type { RunView } from '../protocol';

export interface PastRun {
  /** The run id: its start time, sortable. */
  id: string;
  mode: 'check' | 'real';
  startedAt: string;
  /** Finished without an error of the run itself (hosts may still have failed). */
  ok: boolean;
  hosts: number;
  failed: number;
  /** The flow version it ran. */
  flowVersion?: number;
  /** AFD-244: what a partial run ran. */
  partial?: string;
}

/** What the list shows of a stored run; undefined for one that never got going. */
export function pastRunOf(run: RunView): PastRun | undefined {
  if (!run.summary || run.state === 'running') return undefined;
  const failed = new Set([
    ...Object.keys(run.summary.outcome ?? {}),
    ...(run.summary.failures ?? []).map((f) => f.host),
  ]).size;
  return {
    id: run.id,
    mode: run.mode,
    startedAt: run.startedAt,
    ok: run.state === 'done',
    hosts: run.summary.hosts.length,
    failed,
    ...(run.flowVersion !== undefined ? { flowVersion: run.flowVersion } : {}),
    ...(run.partial ? { partial: run.partial.line } : {}),
  };
}

/** "12 Nov 14:02 · skeleton · 12 hosts, 1 failed": one line of the list. */
export function pastRunLabel(run: PastRun, locale?: string): string {
  const when = new Date(run.startedAt);
  const at = Number.isNaN(when.getTime())
    ? run.id
    : when.toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });
  const kind = run.partial ? 'part of the flow' : run.mode === 'check' ? 'skeleton' : 'real run';
  const hosts = `${run.hosts} host${run.hosts === 1 ? '' : 's'}`;
  const result = !run.ok ? 'did not finish' : run.failed ? `${run.failed} failed` : 'all passed';
  return `${at} · ${kind} · ${hosts}, ${result}`;
}

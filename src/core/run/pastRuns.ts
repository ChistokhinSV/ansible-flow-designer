// AFD-245: the runs kept of a flow, as the Run panel lists them. A finished local run is stored
// whole beside its events (run.json: the summary the canvas showed, no input values), so an
// earlier run can be shown again on the canvas as it was.
import type { RunView } from '../protocol';
import { checkWord, hostsWord, type RunWords } from './words';

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
  /** AFS-139: a run of a host (Ansible Flow Server) that has not ended yet. */
  running?: boolean;
  /**
   * AFS-147: how a run that did not finish ended, in a word, when its host knows it (stopped,
   * failed, lost); without it the list says "did not finish".
   */
  ended?: string;
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

/**
 * "12 Nov 14:02 · skeleton · 12 hosts, 1 failed": one line of the list. AFS-153: in a server's
 * words, "18 Nov, 15:48 CET · check · 4 hosts, went well": the time with its zone.
 */
export function pastRunLabel(run: PastRun, locale?: string, words: RunWords = 'designer'): string {
  const server = words === 'server';
  const when = new Date(run.startedAt);
  const at = Number.isNaN(when.getTime())
    ? run.id
    : when.toLocaleString(locale, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
        ...(server ? { timeZoneName: 'short' as const } : {}),
      });
  const kind = run.partial
    ? 'part of the flow'
    : run.mode === 'check'
      ? checkWord(words)
      : 'real run';
  const hosts = hostsWord(run.hosts);
  // AFS-139: a run still going has no result yet, and its hosts are not counted until it goes.
  if (run.running) return `${at} · ${kind} · running`;
  const result = !run.ok
    ? (run.ended ?? (server ? 'failed' : 'did not finish'))
    : run.failed
      ? `${run.failed} failed`
      : server
        ? 'went well'
        : 'all passed';
  return `${at} · ${kind} · ${hosts}, ${result}`;
}

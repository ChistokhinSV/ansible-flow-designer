// AWX job events → the afd_events stream (M7, ADR-0013). AWX already records what our callback
// writes for local runs: play starts, per-host results with group_by's `add_group`, timestamps.
// Converting keeps one summarizer (core/run/events) for local and AWX runs.
import { buildModel } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import type { AwxJobEvent } from './types';

const STATUS: Record<string, string> = {
  runner_on_ok: 'ok',
  runner_item_on_ok: 'ok',
  runner_on_failed: 'failed',
  runner_item_on_failed: 'failed',
  runner_on_unreachable: 'unreachable',
  runner_on_skipped: 'skipped',
  runner_item_on_skipped: 'skipped',
};

const oneLine = (s: string) => s.replaceAll(/\s+/g, ' ').trim();

/** Generated play names (`[key] Title`, ADR-0009) → node, for plays whose events carry no vars. */
export function playNodes(doc: FlowDocument): Map<string, Ulid> {
  const out = new Map<string, Ulid>();
  for (const { node } of buildModel(doc).nodes.values()) {
    const name = `[${node.key}] ${oneLine(node.title)}`;
    if (!out.has(name)) out.set(name, node.id);
  }
  return out;
}

/**
 * The node of a play name: `[key] Title`, or one of the extra plays of a node, such as the
 * arriving-hosts and route plays of a node with an inventory_target (AFD-14).
 */
export function playNode(plays: Map<string, Ulid>, name: string): Ulid | null {
  const exact = plays.get(name);
  if (exact) return exact;
  const m = /^(.*): (arriving hosts|route|target done)$/.exec(name);
  return (m && plays.get(m[1] as string)) || null;
}

/** The events as afd_events JSON lines, in counter order. */
export function awxEventsToLines(events: AwxJobEvent[], plays: Map<string, Ulid>): string {
  const lines: string[] = [];
  let node: Ulid | null = null;
  for (const e of [...events].sort((a, b) => a.counter - b.counter)) {
    const ts = Math.round(Date.parse(e.created) / 10) / 100;
    const data = e.event_data ?? {};
    if (e.event === 'playbook_on_play_start') {
      const name = data.play ?? e.play ?? '';
      node = playNode(plays, name);
      lines.push(JSON.stringify({ event: 'play', name, node, ts }));
      continue;
    }
    if (e.event === 'playbook_on_stats') {
      lines.push(JSON.stringify({ event: 'stats', ts }));
      continue;
    }
    const status = STATUS[e.event];
    if (!status) continue;
    const res = (data.res ?? {}) as Record<string, unknown>;
    const out: Record<string, unknown> = {
      event: 'result',
      status,
      host: data.host ?? e.host_name,
      task: data.task ?? e.task,
      action: data.task_action,
      node,
      ts,
    };
    if (typeof res.add_group === 'string') out.group = res.add_group;
    const added = res.add_host as { host_name?: string; groups?: string[] | string } | undefined;
    if (added && typeof added === 'object')
      out.added = { host: added.host_name, groups: added.groups };
    const msg = res.msg ?? res.reason;
    if ((status === 'failed' || status === 'unreachable') && msg)
      out.msg = String(msg).slice(0, 500);
    if (status === 'failed' && data.ignore_errors) out.ignored = true;
    lines.push(JSON.stringify(out));
  }
  return lines.join('\n');
}

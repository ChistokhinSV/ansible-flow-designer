// Small readers the round checks share (round 3, AFD-99; round 4, AFD-109): parameter values as
// typed, file modes, template reads, wires and a run's events.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FlowDocument, FlowNode } from '../../src/core/flow/types';
import { level } from './verify';

/** A parameter value as typed: quotes and spaces aside. */
export const text = (v: unknown) =>
  String(v ?? '')
    .trim()
    .replace(/^["']|["']$/g, '');

/** A file mode written any usual way: "0644", "644", 0644 read as a number, or u=rw,g=r,o=r. */
export function sameMode(v: unknown, want: string): boolean {
  if (v === undefined || v === null) return false;
  const octal = want.replace(/^0/, '');
  const symbolic: Record<string, string> = { '644': 'u=rw,g=r,o=r', '600': 'u=rw,g=,o=' };
  const s = text(v).replace(/^0o?/, '');
  return (
    s === octal ||
    s === symbolic[octal] ||
    (typeof v === 'number' && (v === Number(octal) || v === Number.parseInt(octal, 8)))
  );
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Whether a template reads `name`: `{{ name }}`, `{{ name.stdout }}`, `{{ name | x }}`. */
export const reads = (value: unknown, name: string) =>
  new RegExp(`\\{\\{\\s*${literal(name)}\\b`).test(text(value));

/** Whether a template reads `name.field` (or `name['field']`). */
export const readsField = (value: unknown, name: string, field: string) =>
  new RegExp(
    `\\{\\{[^}]*\\b${literal(name)}(\\.${literal(field)}\\b|\\[["']${literal(field)}["']\\])`,
  ).test(text(value));

/** The node that a port leads to directly. */
export function next(doc: FlowDocument, from: FlowNode, port: string): FlowNode | undefined {
  const lv = level(doc);
  const e = lv?.edges.find((x) => x.from.node === from.id && x.from.port === port);
  return lv?.nodes.find((n) => n.id === e?.to.node);
}

/** The hosts a run's events name, from storage/runs/<flow id>/<run>/events.jsonl. */
export function runEvents(storage: string, flowId: string | undefined, run: string) {
  const file = flowId && join(storage, 'runs', flowId, run, 'events.jsonl');
  const raw = file && existsSync(file) ? readFileSync(file, 'utf8') : '';
  const hosts = new Set<string>();
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line) as { event?: string; host?: string };
      if (e.event === 'result' && e.host) hosts.add(e.host);
    } catch {
      // A line cut by a run that was stopped.
    }
  }
  return { raw, hosts };
}

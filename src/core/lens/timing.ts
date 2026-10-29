// Timing lens (04 §7): serial, timeout and measured durations per node, and whether the flow fits
// its maintenance window (decision M8-3). Durations come from the local run history (M8-2); the
// flow estimate is the slowest path from start to an end, summing node averages.
import { durationSeconds } from '../engine/util';
import { buildModel, type FlowModel, ROOT } from '../flow/model';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import { formatSeconds } from '../run/view';
import { isWork, plural, title } from './common';
import type { LensChip, LensFinding, LensItem, LensView, TimingFacts } from './types';

type Pick = 'avg' | 'p95';

/** A node's duration: its own measurement, else (subflows) the slowest path through its steps. */
function cost(model: FlowModel, t: TimingFacts | undefined, node: FlowNode, pick: Pick): number {
  const own = t?.nodes[node.id]?.[pick];
  if (own !== undefined) return own;
  if (node.type === 'subflow' && model.levels.has(node.id))
    return slowestPath(model, t, node.id, pick);
  return 0;
}

/** Longest path through a level's DAG (every port counts: a host may take any of them). */
export function slowestPath(
  model: FlowModel,
  t: TimingFacts | undefined,
  level: string,
  pick: Pick,
): number {
  const lv = model.levels.get(level);
  if (!lv) return 0;
  const out = new Map<Ulid, Ulid[]>();
  for (const e of lv.edges)
    if (e?.from && e.to) out.set(e.from.node, [...(out.get(e.from.node) ?? []), e.to.node]);
  const memo = new Map<Ulid, number>();
  const visiting = new Set<Ulid>();
  const best = (id: Ulid): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    if (visiting.has(id)) return 0;
    visiting.add(id);
    const node = lv.nodes.find((n) => n?.id === id);
    const here = node ? cost(model, t, node, pick) : 0;
    const next = Math.max(0, ...(out.get(id) ?? []).map(best));
    visiting.delete(id);
    memo.set(id, here + next);
    return here + next;
  };
  const targets = new Set(lv.edges.map((e) => e?.to?.node));
  const roots = lv.nodes.filter((n) => n && (n.type === 'start' || !targets.has(n.id)));
  return Math.max(0, ...roots.map((n) => best(n.id)));
}

function settingsChip(node: FlowNode): LensChip | undefined {
  const s = node.settings ?? {};
  const parts: string[] = [];
  if (s.serial !== undefined) parts.push(`serial ${s.serial}`);
  if (s.timeout) parts.push(parts.length ? s.timeout : `timeout ${s.timeout}`);
  if (parts.length === 0 && s.retries) parts.push(`retries ${s.retries}`);
  return parts.length ? { text: parts.join(' · ') } : undefined;
}

export function timingLens(doc: FlowDocument, t: TimingFacts | undefined): LensView {
  const model = buildModel(doc);
  const chips: Record<Ulid, LensChip[]> = {};
  const findings: LensFinding[] = [];
  const measured: LensItem[] = [];
  for (const { node } of model.nodes.values()) {
    if (!isWork(node)) continue;
    const list: LensChip[] = [];
    const sc = settingsChip(node);
    if (sc) list.push(sc);
    const m = t?.nodes[node.id];
    if (m)
      list.push({
        text: m.runs > 1 ? `avg ${formatSeconds(m.avg)}` : `last ${formatSeconds(m.last)}`,
        title: `${plural(m.runs, 'run')}: avg ${formatSeconds(m.avg)}, p95 ${formatSeconds(m.p95)}`,
      });
    chips[node.id] = list.slice(0, 2);
    if (m) {
      measured.push({
        key: `node:${node.id}`,
        label: node.title,
        value: formatSeconds(m.avg),
        detail: `p95 ${formatSeconds(m.p95)} · ${plural(m.runs, 'run')}`,
        nodes: [node.id],
      });
      const timeout = durationSeconds(node.settings?.timeout);
      if (timeout && m.p95 > 0.8 * timeout)
        findings.push({
          id: `timing:timeout:${node.id}`,
          lens: 'timing',
          severity: 'info',
          title: `${node.title} runs close to its timeout`,
          detail: `p95 ${formatSeconds(m.p95)} against a timeout of ${node.settings?.timeout}: a slow host will time out.`,
          node: node.id,
          nodes: [node.id],
          fixes: [],
        });
    }
  }
  const avg = slowestPath(model, t, ROOT, 'avg');
  const p95 = slowestPath(model, t, ROOT, 'p95');
  const windowText = doc.flow.maintenance_window;
  const window = durationSeconds(windowText);
  const notes: string[] = [];
  const work = [...model.nodes.values()].filter((e) => isWork(e.node) && e.node.type !== 'subflow');
  const missing = work.filter((e) => !t?.nodes[e.node.id]).length;
  if (!t || t.runs === 0)
    notes.push('No runs in the history yet: durations appear after the first run from VS Code.');
  else if (missing > 0)
    notes.push(
      `${plural(missing, 'node')} ${missing === 1 ? 'has' : 'have'} no measurement and count${missing === 1 ? 's' : ''} as 0 in the estimate.`,
    );
  if (!window)
    notes.push('No maintenance window: set one in the flow description to check the estimate.');
  if (window && t?.runs) {
    if (avg > window)
      findings.push({
        id: 'timing:window',
        lens: 'timing',
        severity: 'warning',
        title: `The flow does not fit its ${windowText} window`,
        detail: `The slowest path takes about ${formatSeconds(avg)} on average over ${plural(t.runs, 'run')} (p95 ${formatSeconds(p95)}). Raise serial, split the flow, or widen the window.`,
        nodes: [],
        fixes: [],
      });
    else if (p95 > window)
      findings.push({
        id: 'timing:window-p95',
        lens: 'timing',
        severity: 'info',
        title: `Slow runs overrun the ${windowText} window`,
        detail: `On average the slowest path takes ${formatSeconds(avg)}, but p95 is ${formatSeconds(p95)}.`,
        nodes: [],
        fixes: [],
      });
  }
  const timeouts: LensItem[] = work
    .filter((e) => e.node.settings?.timeout || e.node.settings?.serial !== undefined)
    .map((e) => ({
      key: `limit:${e.node.id}`,
      label: title(model, e.node.id),
      value: settingsChip(e.node)?.text,
      nodes: [e.node.id],
    }));
  return {
    lens: 'timing',
    chips,
    stats: [
      { label: 'window', value: windowText ?? 'not set' },
      { label: 'estimate', value: t?.runs ? formatSeconds(avg) : '-' },
      { label: 'p95', value: t?.runs ? formatSeconds(p95) : '-' },
      { label: 'runs', value: String(t?.runs ?? 0) },
    ],
    sections: [
      {
        title: 'Slowest nodes',
        items: measured
          .sort(
            (a, b) =>
              (t?.nodes[b.nodes[0] as Ulid]?.avg ?? 0) - (t?.nodes[a.nodes[0] as Ulid]?.avg ?? 0),
          )
          .slice(0, 8),
        empty: 'No measurements yet.',
      },
      { title: 'Serial and timeouts', items: timeouts, empty: 'No node sets serial or a timeout.' },
    ],
    findings,
    notes,
  };
}

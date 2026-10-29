// One entry point for the webview: the active lens's view with accepted findings marked, and the
// summary card rows of semantic zoom (D-19), which draw on every lens's facts.
import { durationSeconds } from '../engine/util';
import { buildModel } from '../flow/model';
import type { FlowDocument, FlowNode } from '../flow/types';
import type { RunView } from '../protocol';
import { formatSeconds, nodeHosts } from '../run/view';
import { accessLens } from './access';
import { codeLens } from './code';
import { incoming, title } from './common';
import { dataLens } from './data';
import { declaredTarget, inventoryLens } from './inventory';
import { timingLens } from './timing';
import type { LensFacts, LensId, LensView } from './types';

export function lensView(
  lens: LensId,
  doc: FlowDocument,
  facts: LensFacts,
  run: RunView | null,
): LensView {
  const view =
    lens === 'inventory'
      ? inventoryLens(doc, facts.inventory, run, facts.code)
      : lens === 'data'
        ? dataLens(doc)
        : lens === 'code'
          ? codeLens(doc, facts.code)
          : lens === 'access'
            ? accessLens(doc, facts.inventory, facts.code)
            : timingLens(doc, facts.timing);
  const accepted = new Map(
    (doc.decisions ?? [])
      .filter((d) => d?.kind === 'finding_accepted')
      .map((d) => [d.finding, { reason: d.reason ?? '', by: d.by }]),
  );
  const rank = (f: LensView['findings'][number]) =>
    (f.accepted ? 2 : 0) + (f.severity === 'warning' ? 0 : 1);
  view.findings = view.findings
    .map((f) => (accepted.has(f.id) ? { ...f, accepted: accepted.get(f.id) } : f))
    .sort((a, b) => rank(a) - rank(b));
  return view;
}

export interface SummaryRow {
  label: string;
  value: string;
}

/** Mockup 08 "zoomed in or selected": hosts, limit, data, binding, access, timing. */
export function summaryRows(
  doc: FlowDocument,
  node: FlowNode,
  facts: LensFacts,
  run: RunView | null,
): SummaryRow[] {
  const model = buildModel(doc);
  const rows: SummaryRow[] = [];
  const add = (label: string, value: string | undefined) => {
    if (value) rows.push({ label, value });
  };
  const inv = facts.inventory?.state === 'ready' ? facts.inventory.facts : undefined;
  const targets = inv?.targets ?? facts.inventory?.targets ?? '';
  const pattern = declaredTarget(doc, node, targets, facts.code)?.pattern ?? targets;
  if (pattern) {
    const count = inv?.patterns[pattern]?.count;
    const ran = run?.summary ? nodeHosts(run.summary, node.id).length : undefined;
    add('hosts', `${pattern}${count !== undefined ? ` · ${count}` : ''}${ran ? ` → ${ran}` : ''}`);
  }
  const from = incoming(model, node.id);
  if (from.length > 0)
    add(
      'limit',
      `${from[0]?.port} from ${title(model, from[0]?.from ?? '')}${from.length > 1 ? ` +${from.length - 1}` : ''}`,
    );
  add('inputs', Object.keys(node.inputs ?? {}).join(', '));
  add('outputs', Object.keys(node.outputs ?? {}).join(', '));
  const code = facts.code?.nodes[node.id];
  if (node.impl?.ref)
    add(node.impl.kind, `${node.impl.ref}${code?.version ? ` ${code.version}` : ''}`);
  if (code?.collection)
    add(
      'collection',
      `${code.collection}${facts.code?.collections[code.collection] ? ` ${facts.code.collections[code.collection]}` : ''}`,
    );
  add('credential', node.settings?.credential);
  if (node.settings?.become) add('become', 'yes');
  const s = node.settings ?? {};
  const limits = [
    s.serial !== undefined ? `${s.serial}` : '',
    s.timeout ? `timeout ${s.timeout}` : '',
    s.retries ? `retries ${s.retries}` : '',
  ].filter(Boolean);
  add('serial', limits.join(' · '));
  const t = facts.timing?.nodes[node.id];
  if (t) add('duration', `avg ${formatSeconds(t.avg)} · p95 ${formatSeconds(t.p95)}`);
  else if (durationSeconds(s.timeout) === undefined && run?.summary?.timings?.[node.id]) {
    const x = run.summary.timings[node.id];
    if (x) add('duration', `last ${formatSeconds(x.end - x.start)}`);
  }
  return rows;
}

export type { LensFacts, LensId, LensView } from './types';
export { LENSES } from './types';

// Content of the hover preview card (D-22, mockup 10): what a subflow runs inside, step by step
// with its exits and last-run results, or what a bound node runs. Pure, so it is testable.
import { buildModel } from '../core/flow/model';
import type { FlowDocument, FlowNode, ImplBinding, NodeSettings, Ulid } from '../core/flow/types';
import type { RunView } from '../core/protocol';

export interface PreviewStep {
  id: Ulid;
  title: string;
  type: FlowNode['type'];
  status: FlowNode['status'];
  entry: boolean;
  badges: string[];
  /** Parent ports this step leaves through, with the exit reason. */
  exits: { port: string; reason?: string }[];
  run?: string;
}

export interface Preview {
  node: FlowNode;
  binding?: string;
  subtitle: string;
  steps: PreviewStep[];
  undo?: string;
  settings: string[];
  run?: string;
  hasInner: boolean;
}

/** D-22: subflows and code-bound nodes get a card; draft tasks keep the plain port reveal. */
export function hasPreview(node: FlowNode): boolean {
  return node.type === 'subflow' || !!node.impl?.ref;
}

export function bindingText(impl: ImplBinding | null | undefined): string | undefined {
  if (!impl?.ref) return undefined;
  const from = impl.params?.tasks_from ? ` · ${impl.params.tasks_from}` : '';
  return `${impl.kind} ${impl.ref}${impl.collection_version ? ` ${impl.collection_version}` : ''}${from}`;
}

function settingBadges(s: NodeSettings | undefined): string[] {
  if (!s) return [];
  const out: string[] = [];
  if (s.retries) out.push(`retry ×${s.retries}`);
  if (s.serial !== undefined) out.push(`serial ${s.serial}`);
  if (s.timeout) out.push(`timeout ${s.timeout}`);
  if (s.max_fail_percentage !== undefined) out.push(`max fail ${s.max_fail_percentage}%`);
  if (s.become) out.push('become');
  if (s.credential) out.push(`credential ${s.credential}`);
  if (s.execution_environment) out.push(`EE ${s.execution_environment}`);
  return out;
}

/** "ok_hosts 47 · failed_hosts 1 (sw-edge-07)" from the last run of a node. */
function runText(run: RunView | null | undefined, id: Ulid): string | undefined {
  const ports = run?.state === 'done' ? run.summary?.nodes[id] : undefined;
  if (!ports) return undefined;
  return Object.entries(ports)
    .map(([port, hosts]) =>
      port === 'ok_hosts' || hosts.length > 3
        ? `${port} ${hosts.length}`
        : `${port} ${hosts.length} (${hosts.join(', ')})`,
    )
    .join(' · ');
}

/** Inner steps in graph order (ties keep document order), the entry first when it has no input. */
function ordered(
  nodes: FlowNode[],
  edges: { from: { node: Ulid }; to: { node: Ulid } }[],
): FlowNode[] {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const indegree = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges)
    if (index.has(e.to.node)) indegree.set(e.to.node, (indegree.get(e.to.node) ?? 0) + 1);
  const ready = nodes.filter((n) => indegree.get(n.id) === 0);
  const out: FlowNode[] = [];
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    const n = ready.shift() as FlowNode;
    out.push(n);
    for (const e of edges) {
      if (e.from.node !== n.id || !index.has(e.to.node)) continue;
      const left = (indegree.get(e.to.node) ?? 0) - 1;
      indegree.set(e.to.node, left);
      if (left === 0) ready.push(nodes[index.get(e.to.node) ?? 0] as FlowNode);
    }
  }
  // Cycles (the validator reports them) still list every step.
  for (const n of nodes) if (!out.includes(n)) out.push(n);
  return out;
}

export function previewOf(doc: FlowDocument, id: Ulid, run?: RunView | null): Preview | undefined {
  const node = buildModel(doc).nodes.get(id)?.node;
  if (!node || !hasPreview(node)) return undefined;
  const inner = (node.subflow?.nodes ?? []).filter((n): n is FlowNode => !!n?.id);
  const boundary = node.subflow?.boundary;
  const exits = new Map<Ulid, { port: string; reason?: string }[]>();
  for (const [port, refs] of Object.entries(boundary?.outputs ?? {}))
    for (const r of refs ?? [])
      if (r?.node) exits.set(r.node, [...(exits.get(r.node) ?? []), { port, reason: r.reason }]);
  const steps = ordered(
    inner,
    (node.subflow?.edges ?? []).filter((e) => e?.from && e.to),
  ).map(
    (n): PreviewStep => ({
      id: n.id,
      title: n.title,
      type: n.type,
      status: n.status,
      entry: boundary?.in === n.id,
      badges: [...(n.impl?.ref ? [n.impl.kind] : []), ...settingBadges(n.settings)],
      exits: exits.get(n.id) ?? [],
      run: runText(run, n.id),
    }),
  );
  const subtitle =
    node.type === 'subflow'
      ? inner.length > 0
        ? `Subflow · ${inner.length} step${inner.length === 1 ? '' : 's'}`
        : 'Subflow · no inner steps yet'
      : `${node.type[0]?.toUpperCase()}${node.type.slice(1)}`;
  return {
    node,
    binding: bindingText(node.impl),
    subtitle,
    steps,
    undo: bindingText(node.undo),
    settings: settingBadges(node.settings),
    run: runText(run, node.id),
    hasInner: inner.length > 0,
  };
}

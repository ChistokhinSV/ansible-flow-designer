// Run mode read-outs (04 §10, M7): what a run did per node, per wire and per host, and which nodes
// it tested (decision 15). Pure; the webview and the host share them.
import { buildModel, type FlowModel } from '../flow/model';
import { isFailPort } from '../flow/ports';
import type { Edge, FlowDocument, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import type { RunProblem, RunSummary } from './events';

/** ok: every host left through a normal port; warn: some took a fail port; failed: a failure was not routed. */
export type NodeRunState = 'ok' | 'warn' | 'failed' | 'idle';

export interface HostResult {
  host: string;
  /** Ports the host left through (`always` comes on top of the outcome port). */
  ports: string[];
  problem?: RunProblem;
}

export interface NodeRun {
  state: NodeRunState;
  hosts: number;
  /** Hosts that left through a fail port or failed without a route. */
  failed: number;
  /** Seconds between the first and last event of the node's plays. */
  seconds?: number;
}

export function nodeHosts(s: RunSummary, node: Ulid): HostResult[] {
  const rows = new Map<string, HostResult>();
  const row = (host: string) => {
    let r = rows.get(host);
    if (!r) {
      r = { host, ports: [] };
      rows.set(host, r);
    }
    return r;
  };
  for (const [port, hosts] of Object.entries(s.nodes[node] ?? {}))
    for (const h of hosts) row(h).ports.push(port);
  for (const [h, p] of Object.entries(s.problems?.[node] ?? {})) row(h).problem = p;
  for (const f of s.failures)
    if (f.node === node) row(f.host).problem ??= { task: f.task, status: 'failed', msg: f.msg };
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export function nodeRun(s: RunSummary, node: Ulid): NodeRun {
  const rows = nodeHosts(s, node);
  const t = s.timings?.[node];
  const seconds = t ? t.end - t.start : undefined;
  if (rows.length === 0) return { state: t ? 'ok' : 'idle', hosts: 0, failed: 0, seconds };
  const unrouted = s.failures.some((f) => f.node === node);
  const failed = rows.filter((r) => r.ports.length === 0 || r.ports.some(isFailPort)).length;
  const state: NodeRunState = unrouted ? 'failed' : failed > 0 ? 'warn' : 'ok';
  return { state, hosts: rows.length, failed, seconds };
}

/** Hosts that took a wire: those that left its source through the source port. */
export function wireHosts(s: RunSummary, node: Ulid, port: string): string[] {
  return s.nodes[node]?.[port] ?? [];
}

/** Start and end nodes have no play: start sends every host of the run, end counts arrivals. */
export function edgeHosts(model: FlowModel, s: RunSummary, edge: Edge): string[] {
  if (model.nodes.get(edge.from.node)?.node.type === 'start') return s.hosts;
  return wireHosts(s, edge.from.node, edge.from.port);
}

/** Hosts that arrived at a node over its wires. */
export function arrivals(model: FlowModel, s: RunSummary, node: Ulid): string[] {
  const level = model.levels.get(model.nodes.get(node)?.level ?? '');
  const hosts = new Set<string>();
  for (const e of level?.edges ?? [])
    if (e.to.node === node) for (const h of edgeHosts(model, s, e)) hosts.add(h);
  return [...hosts].sort();
}

/** Every node's run read-out, start and end nodes included (Run mode canvas). */
export function runStates(doc: FlowDocument, s: RunSummary): Record<Ulid, NodeRun> {
  const model = buildModel(doc);
  const out: Record<Ulid, NodeRun> = {};
  for (const { node } of model.nodes.values()) {
    if (node.type === 'start') {
      const n = s.hosts.length;
      out[node.id] = { state: n > 0 ? 'ok' : 'idle', hosts: n, failed: 0 };
    } else if (node.type === 'end') {
      const n = arrivals(model, s, node.id).length;
      const failed = node.outcome === 'failed' ? n : 0;
      out[node.id] = { state: n === 0 ? 'idle' : failed ? 'failed' : 'ok', hosts: n, failed };
    } else out[node.id] = nodeRun(s, node.id);
  }
  return out;
}

export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 1) return '<1 s';
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`;
  const m = Math.floor(seconds / 60);
  return `${m} min ${String(Math.round(seconds - m * 60)).padStart(2, '0')} s`;
}

/** The run passed: real (not check mode), exit 0, every host routed and no failed outcome. */
export function runPassed(run: RunView | null): boolean {
  const s = run?.summary;
  return (
    !!run &&
    !!s &&
    run.state === 'done' &&
    run.mode === 'real' &&
    run.rc === 0 &&
    !s.stoppedEarly &&
    s.failures.length === 0 &&
    Object.keys(s.outcome).length === 0
  );
}

/**
 * Decision 15: after a passing run of the current flow.version, the implemented nodes it ran
 * become tested (proposed; the user applies and saves the edit).
 */
export function testedCandidates(doc: FlowDocument, run: RunView | null): Ulid[] {
  if (!run || !runPassed(run) || run.flowVersion !== doc.flow.version) return [];
  const s = run.summary as RunSummary;
  return [...buildModel(doc).nodes.values()]
    .map((e) => e.node)
    .filter((n) => n.status === 'implemented' && (s.nodes[n.id] || s.timings?.[n.id]))
    .map((n) => n.id);
}

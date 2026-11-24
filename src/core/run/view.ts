// Run mode read-outs (04 §10, M7): what a run did per node, per wire and per host, and which nodes
// it tested (decision 15). Pure; the webview and the host share them.
import { type FlowModel, modelOf } from '../flow/model';
import { type Origin, originHead, originValue } from '../flow/origin';
import { isFailPort } from '../flow/ports';
import { nodeDesigns } from '../flow/semantic';
import type { Edge, FlowDocument, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import type { RecordedInput, RunProblem, RunSummary } from './events';

/**
 * ok: every host left through a normal port; warn: some took a fail port; failed: a failure was
 * not routed; running (AFD-81): its play runs now, or a step inside it does (a subflow).
 */
export type NodeRunState = 'ok' | 'warn' | 'failed' | 'idle' | 'running';

export interface HostResult {
  host: string;
  /** Ports the host left through (`always` comes on top of the outcome port). */
  ports: string[];
  problem?: RunProblem;
}

export interface NodeRun {
  state: NodeRunState;
  hosts: number;
  /** Hosts that left through a fail port or failed without a route (`unreachable` included). */
  failed: number;
  /**
   * AFD-379: of `failed`, the hosts that could not be reached (the unreachable port, or dropped
   * unreachable): a badge says "1 failed · 1 unreachable" with `failed - unreachable` failed.
   */
  unreachable?: number;
  /**
   * Seconds between the first and last event of the node's plays; AFS-205: without the time a
   * step-by-step run waited before it (`waited`).
   */
  seconds?: number;
  /** AFS-205: seconds a step-by-step run was paused before this step. */
  waited?: number;
}

/**
 * The ports a node's hosts left through: those it routed, and (AFD-353) those that led out of its
 * subflow, which the run counts at the subflow.
 */
export function nodePorts(
  s: RunSummary | undefined,
  node: Ulid,
): Record<string, string[]> | undefined {
  const own = s?.nodes[node];
  const out = s?.exits?.[node];
  if (!out) return own;
  const ports: Record<string, string[]> = { ...own };
  for (const [port, hosts] of Object.entries(out))
    ports[port] = [...new Set([...(ports[port] ?? []), ...hosts])].sort();
  return ports;
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
  for (const [port, hosts] of Object.entries(nodePorts(s, node) ?? {}))
    for (const h of hosts) row(h).ports.push(port);
  for (const [h, p] of Object.entries(s.problems?.[node] ?? {})) row(h).problem = p;
  for (const f of s.failures)
    if (f.node === node) row(f.host).problem ??= { task: f.task, status: 'failed', msg: f.msg };
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host));
}

export function nodeRun(s: RunSummary, node: Ulid): NodeRun {
  const rows = nodeHosts(s, node);
  const t = s.timings?.[node];
  const waited = s.waited?.[node];
  const seconds = t ? Math.max(0, t.end - t.start - (waited ?? 0)) : undefined;
  const wait = waited ? { waited } : {};
  // AFD-327: a play that ran for no host (the hosts went elsewhere, or the run failed before)
  // did nothing: not reached, not a green "0 hosts".
  if (rows.length === 0) return { state: 'idle', hosts: 0, failed: 0, seconds, ...wait };
  const unrouted = s.failures.some((f) => f.node === node);
  const failing = rows.filter((r) => r.ports.length === 0 || r.ports.some(isFailPort));
  // AFD-379: a host that could not be reached is counted as unreachable, not failed.
  const gone = failing.filter((r) =>
    r.ports.length === 0
      ? r.problem?.status === 'unreachable' || s.unreachable.includes(r.host)
      : r.ports.every((p) => p === 'unreachable' || !isFailPort(p)),
  ).length;
  const failed = failing.length;
  const state: NodeRunState = unrouted ? 'failed' : failing.length > 0 ? 'warn' : 'ok';
  return {
    state,
    hosts: rows.length,
    failed,
    ...(gone ? { unreachable: gone } : {}),
    seconds,
    ...wait,
  };
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
  const model = modelOf(doc);
  const out: Record<Ulid, NodeRun> = {};
  for (const { node } of model.nodes.values()) {
    if (node.type === 'start') {
      const n = s.hosts.length;
      out[node.id] = { state: n > 0 ? 'ok' : 'idle', hosts: n, failed: 0 };
    } else if (node.type === 'end') {
      const n = arrivals(model, s, node.id).length;
      const failed = node.outcome === 'failed' ? n : 0;
      out[node.id] = { state: n === 0 ? 'idle' : failed ? 'failed' : 'ok', hosts: n, failed };
    } else if (node.type === 'approval' && nodeHosts(s, node.id).length === 0) {
      // AFD-327: an approval has no play of its own on a server that splits the run there: the
      // hosts it decides for are those that arrived (the segments before it ran them there).
      const n = arrivals(model, s, node.id).length;
      out[node.id] = { state: n === 0 ? 'idle' : 'ok', hosts: n, failed: 0 };
    } else out[node.id] = nodeRun(s, node.id);
  }
  // A live run (AFD-81): the running step and every subflow around it.
  for (let at = s.running; at && at !== 'root'; at = model.nodes.get(at)?.level) {
    const r = out[at];
    if (r) out[at] = { ...r, state: 'running' };
  }
  return out;
}

export function formatSeconds(seconds: number | undefined): string {
  if (seconds === undefined) return '';
  if (seconds < 1) return '<1 s';
  if (seconds < 10) return `${seconds.toFixed(1)} s`;
  // AFS-205: rounded once, so 419.6 s reads "7 min 00 s", not "6 min 60 s".
  const whole = Math.round(seconds);
  if (whole < 60) return `${whole} s`;
  const m = Math.floor(whole / 60);
  return `${m} min ${String(whole - m * 60).padStart(2, '0')} s`;
}

/** AFS-205: a step's time with the time a step-by-step run waited before it: "ran 1 s, waited 31 s". */
export function stepTime(r: Pick<NodeRun, 'seconds' | 'waited'>): string {
  if (r.seconds === undefined) return '';
  if (!r.waited || r.waited < 1) return formatSeconds(r.seconds);
  return `ran ${formatSeconds(r.seconds)}, waited ${formatSeconds(r.waited)}`;
}

/**
 * A finished run at a glance, one verdict for the top bar and the run panel (AFD-30): ok when it
 * exited 0, did not stop early and failed no host (a failure routed to a handler still counts).
 */
export function runVerdict(run: RunView): { ok: boolean; failed: number } {
  const s = run.summary;
  const failed = s ? Object.keys(s.outcome).length + s.failures.length : 0;
  return { ok: run.rc === 0 && failed === 0 && !s?.stoppedEarly, failed };
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
 * become tested (proposed; the user applies and saves the edit). A node whose design changed after
 * the run started is left out: that design did not run.
 */
export function testedCandidates(doc: FlowDocument, run: RunView | null): Ulid[] {
  if (!run || !runPassed(run) || run.flowVersion !== doc.flow.version) return [];
  const s = run.summary as RunSummary;
  const now = run.design ? nodeDesigns(doc) : undefined;
  return [...modelOf(doc).nodes.values()]
    .map((e) => e.node)
    .filter(
      (n) =>
        n.status === 'implemented' &&
        (nodePorts(s, n.id) || s.timings?.[n.id]) &&
        (!now || run.design?.[n.id] === now[n.id]),
    )
    .map((n) => n.id);
}

// ---- AFD-341: the values a step's inputs had in a run --------------------------------------------

/** One recorded input in words: its value as one line of YAML (cut), or why there is none. */
export function recordedText(r: RecordedInput | undefined, max = 80): string {
  if (!r) return 'not recorded';
  if (r.missing === 'secret') return 'secret: not recorded';
  if (r.missing === 'undefined') return 'not defined for this host';
  if (r.missing === 'limit') return "not recorded: the run's limit for values was reached";
  const text = r.cut !== undefined ? originValue(String(r.value), max) : originValue(r.value, max);
  return r.cut !== undefined ? `${text} (cut: ${r.cut} characters)` : text;
}

/** Whether the run recorded any input of the node (for any host). */
export function nodeInputsRecorded(s: RunSummary | undefined, node: Ulid): boolean {
  return !!s?.inputs?.[node] && Object.keys(s.inputs[node]).length > 0;
}

/** A host's recorded inputs at a node, by name. */
export function hostInputs(
  s: RunSummary | undefined,
  node: Ulid,
  host: string,
): Record<string, RecordedInput> | undefined {
  return s?.inputs?.[node]?.[host];
}

export interface InputValueGroup {
  /** The value in words (recordedText). */
  text: string;
  /** The longer text (a title): up to 2000 characters. */
  full: string;
  hosts: string[];
  input: RecordedInput;
}

/** The values one input had at a node, hosts with the same value together, most hosts first. */
export function inputValueGroups(
  s: RunSummary | undefined,
  node: Ulid,
  name: string,
): InputValueGroup[] {
  const groups = new Map<string, InputValueGroup>();
  for (const [host, byName] of Object.entries(s?.inputs?.[node] ?? {})) {
    const input = byName[name];
    if (!input) continue;
    const full = recordedText(input, 2000);
    const g = groups.get(full);
    if (g) g.hosts.push(host);
    else groups.set(full, { text: recordedText(input), full, hosts: [host], input });
  }
  for (const g of groups.values()) g.hosts.sort();
  return [...groups.values()].sort(
    (a, b) => b.hosts.length - a.hosts.length || (a.hosts[0] ?? '').localeCompare(b.hosts[0] ?? ''),
  );
}

/**
 * When the run had another value than the flow or the repository states for the host: what was
 * predicted, in words. Only a static, uncut value is compared; a secret chain never is.
 */
export function differsFromPredicted(
  origin: Origin | undefined,
  r: RecordedInput | undefined,
): string | undefined {
  if (!origin || origin.secret || !r || r.missing || r.cut !== undefined) return undefined;
  const head = originHead(origin);
  if (!head?.static || head.value === undefined || head.value.includes('…')) return undefined;
  if (originValue(r.value) === head.value) return undefined;
  const who = head.file !== undefined ? 'the repository' : 'the flow';
  return `differs from what ${who} predicted (${head.value})`;
}

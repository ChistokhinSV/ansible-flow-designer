// Reads the afd_events callback stream of a run and maps it back to flow nodes and ports through
// the routing groups of the generated code (AFD-4 acceptance 5; full Run mode is M7). AFD-81: line
// by line while the run goes (createSummarizer), with a partial summary for the canvas.
import type { Route } from '../engine/types';
import type { Ulid } from '../flow/types';

export interface RunFailure {
  host: string;
  node?: Ulid;
  task: string;
  msg?: string;
}

export interface RunSummary {
  /** Per node, per port: the hosts that left through it. */
  nodes: Record<Ulid, Record<string, string[]>>;
  /** Hosts the outcome play failed, with the reason (open port, failed end). */
  outcome: Record<string, string>;
  /** Failures that were not rescued into a port (the run stopped there or a host dropped out). */
  failures: RunFailure[];
  /** Hosts Ansible dropped as unreachable without a route (role nodes, ADR-0009). */
  unreachable: string[];
  hosts: string[];
  /** The outcome play never ran: the run stopped early (max_fail_percentage, an include error). */
  stoppedEarly: boolean;
  /** Per node: first and last event time (epoch seconds) of its plays (Run mode, M7). */
  timings?: Record<Ulid, { start: number; end: number }>;
  /** Per node, per host: the first failed or unreachable result, rescued or not (Run mode, M7). */
  problems?: Record<Ulid, Record<string, RunProblem>>;
  /** A partial summary (AFD-81): the node whose play is running. */
  running?: Ulid;
}

export interface RunProblem {
  task: string;
  status: 'failed' | 'unreachable';
  msg?: string;
}

interface Event {
  event?: string;
  status?: string;
  host?: string;
  task?: string;
  node?: string | null;
  name?: string;
  group?: string;
  added?: { host?: string; groups?: string[] | string };
  msg?: string;
  ignored?: boolean;
  hosts?: Record<string, unknown>;
  ts?: number;
}

/** Summarizes a whole events.jsonl (a finished run). */
export function summarizeRun(text: string, routes: Record<string, Route>): RunSummary {
  const s = createSummarizer(routes);
  for (const line of text.split('\n')) s.push(line);
  return s.summary();
}

export interface Summarizer {
  /** One line of events.jsonl; blank and unreadable lines are skipped. */
  push(line: string): void;
  /**
   * The summary so far; it changes nothing pushed. `partial`: the run goes on, so a failure the
   * play may still rescue into a port is not counted yet (a full summary would call it lost), the
   * run has not stopped early, and the node of the running play is named.
   */
  summary(options?: { partial?: boolean }): RunSummary;
}

export function createSummarizer(routes: Record<string, Route>): Summarizer {
  const nodes: RunSummary['nodes'] = {};
  const outcome: Record<string, string> = {};
  const failures: RunFailure[] = [];
  const unreachable = new Set<string>();
  const hosts = new Set<string>();
  const add = (group: string, host: string) => {
    const route = routes[group];
    if (!route) return;
    const ports = nodes[route.node] ?? {};
    nodes[route.node] = ports;
    const list = ports[route.port] ?? [];
    if (!list.includes(host)) list.push(host);
    ports[route.port] = list;
  };
  const timings: Record<Ulid, { start: number; end: number }> = {};
  const problems: Record<Ulid, Record<string, RunProblem>> = {};
  let playNode: string | null = null;
  let finished = false;
  const clock = (ts: number | undefined) => {
    if (!playNode || typeof ts !== 'number') return;
    const t = timings[playNode];
    if (!t) timings[playNode] = { start: ts, end: ts };
    else t.end = Math.max(t.end, ts);
  };
  let outcomePlay = false;
  let sawOutcome = false;
  // A failure inside a block is followed by its rescue routing the host, and an unreachable module
  // result by the route to `unreachable`; only those without a later route for the same host in
  // the same play were lost.
  let pending: RunFailure[] = [];
  let lost = new Set<string>();
  const settle = () => {
    failures.push(...pending);
    for (const h of lost) unreachable.add(h);
    pending = [];
    lost = new Set();
  };
  const push = (line: string) => {
    if (!line.trim()) return;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      return;
    }
    if (e.event === 'stats') finished = true;
    if (e.event === 'play') {
      settle();
      playNode = e.node ?? null;
      clock(e.ts);
      outcomePlay = (e.name ?? '').endsWith('] Outcome');
      sawOutcome ||= outcomePlay;
      return;
    }
    if (e.event !== 'result' || !e.host) return;
    clock(e.ts);
    // The generator's own plays run on localhost and name no node; a step's play on localhost
    // (Ansible's implicit localhost as the target, AFD-281) is a host of the run.
    if (e.host !== 'localhost' || (e.node ?? playNode)) hosts.add(e.host);
    if (e.status === 'ok' && e.group) {
      add(e.group, e.host);
      pending = pending.filter((f) => f.host !== e.host);
      lost.delete(e.host);
    }
    if (e.status === 'ok' && e.added?.host) {
      const groups = Array.isArray(e.added.groups) ? e.added.groups : [e.added.groups ?? ''];
      for (const g of groups) add(g, e.added.host);
    }
    if (e.status === 'unreachable') lost.add(e.host);
    const at = e.node ?? playNode;
    if (
      at &&
      !outcomePlay &&
      (e.status === 'unreachable' || (e.status === 'failed' && !e.ignored))
    ) {
      const byHost = problems[at] ?? {};
      problems[at] = byHost;
      byHost[e.host] ??= { task: e.task ?? '', status: e.status, msg: e.msg };
    }
    if (e.status === 'failed' && !e.ignored) {
      if (outcomePlay) outcome[e.host] = e.msg ?? e.task ?? 'failed';
      else
        pending.push({ host: e.host, node: e.node ?? undefined, task: e.task ?? '', msg: e.msg });
    }
  };
  const summary = ({ partial = false }: { partial?: boolean } = {}): RunSummary => {
    // Copies: the summarizer goes on taking lines after a partial summary.
    const done = partial ? [...failures] : [...failures, ...pending];
    const gone = new Set(unreachable);
    if (!partial) for (const h of lost) gone.add(h);
    const byNode: RunSummary['nodes'] = {};
    for (const [node, ports] of Object.entries(nodes))
      byNode[node] = Object.fromEntries(
        Object.entries(ports).map(([port, list]) => [port, [...list].sort()]),
      );
    return {
      nodes: byNode,
      outcome: { ...outcome },
      failures: done,
      unreachable: [...gone].sort(),
      hosts: [...hosts].sort(),
      stoppedEarly: !partial && !sawOutcome && done.length > 0,
      timings: Object.fromEntries(Object.entries(timings).map(([k, t]) => [k, { ...t }])),
      problems: Object.fromEntries(
        Object.entries(problems).map(([k, byHost]) => [k, { ...byHost }]),
      ),
      ...(partial && playNode && !finished && !outcomePlay ? { running: playNode } : {}),
    };
  };
  return { push, summary };
}

/**
 * Complete lines from a growing file: `carry` is the part of the last chunk after its last line
 * break, kept until the next chunk ends it.
 */
export function splitLines(carry: string, chunk: string): { lines: string[]; carry: string } {
  const text = carry + chunk;
  const end = text.lastIndexOf('\n');
  if (end < 0) return { lines: [], carry: text };
  return { lines: text.slice(0, end).split('\n'), carry: text.slice(end + 1) };
}

/** A task's result for one host, as the per-host Output shows it (AFD-81). */
export interface OutputEntry {
  task: string;
  status: string;
  changed?: boolean;
  rc?: number;
  /** stdout, stderr and msg, each cut at 2000 characters by the callback. */
  out?: { stdout?: string; stderr?: string; msg?: string };
  /** The failure message (failed, unreachable). */
  msg?: string;
  /** A no_log task: the callback recorded no output. */
  censored?: boolean;
  /** One item of a loop. */
  item?: boolean;
}

/** The results one host had in one node's plays, routing tasks left out. */
export function hostOutput(text: string, node: Ulid, host: string): OutputEntry[] {
  const out: OutputEntry[] = [];
  let playNode: string | null = null;
  for (const line of text.split(String.fromCharCode(10))) {
    if (!line.trim()) continue;
    let e: Event & {
      changed?: boolean;
      rc?: number;
      out?: OutputEntry['out'];
      censored?: boolean;
      item?: boolean;
    };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.event === 'play') playNode = e.node ?? null;
    if (e.event !== 'result' || e.host !== host || (e.node ?? playNode) !== node) continue;
    if (e.group || e.added) continue;
    out.push({
      task: e.task ?? '',
      status: e.status ?? '',
      ...(e.changed !== undefined ? { changed: e.changed } : {}),
      ...(e.rc !== undefined ? { rc: e.rc } : {}),
      ...(e.out ? { out: e.out } : {}),
      ...(e.msg ? { msg: e.msg } : {}),
      ...(e.censored ? { censored: true } : {}),
      ...(e.item ? { item: true } : {}),
    });
  }
  return out;
}

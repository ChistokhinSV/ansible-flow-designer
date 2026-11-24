// Reads the afd_events callback stream of a run and maps it back to flow nodes and ports through
// the routing groups of the generated code (AFD-4 acceptance 5; full Run mode is M7). AFD-81: line
// by line while the run goes (createSummarizer), with a partial summary for the canvas.
import type { Route } from '../engine/types';
import type { Ulid } from '../flow/types';
import { SECRET } from '../import/secrets';

export interface RunFailure {
  host: string;
  node?: Ulid;
  task: string;
  msg?: string;
}

export interface RunSummary {
  /** Per node, per port: the hosts that left through it. */
  nodes: Record<Ulid, Record<string, string[]>>;
  /**
   * AFD-353: per step inside a subflow, per port: the hosts that left through a port leading out
   * of its subflow (counted in `nodes` at the subflow's port). Apart from `nodes`, which says
   * where a host ended (scenarios read it so).
   */
  exits?: Record<Ulid, Record<string, string[]>>;
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
  /**
   * AFS-205: per node, the seconds a step-by-step run waited before it (paused, between its play's
   * start and Step or Continue): inside `timings`, so a step's time leaves it out.
   */
  waited?: Record<Ulid, number>;
  /** Per node, per host: the first failed or unreachable result, rescued or not (Run mode, M7). */
  problems?: Record<Ulid, Record<string, RunProblem>>;
  /** A partial summary (AFD-81): the node whose play is running. */
  running?: Ulid;
  /** AFD-309: the flow's outputs, per host, as the run ended (hosts without values left out). */
  outputs?: Record<string, Record<string, unknown>>;
  /** AFD-309: the outputs were larger than a run keeps (OUTPUTS_MAX), and are left out. */
  outputsTooLarge?: boolean;
  /**
   * AFD-341: per node, per host, per input: the value the step had (the afd_events `inputs`
   * events). A run without any has none: the run did not record them.
   */
  inputs?: Record<Ulid, Record<string, Record<string, RecordedInput>>>;
  /** AFD-341: the run turned recording input values off (afd.run.recordInputs, AFS setting). */
  inputsOff?: boolean;
}

/** AFD-341: one input's value for one host, as the callback recorded it. */
export interface RecordedInput {
  /** The value (as JSON). When `cut`, its JSON text, cut in the middle. */
  value?: unknown;
  /** Why there is no value: a secret (never recorded), not defined for the host, the run's limit. */
  missing?: 'secret' | 'undefined' | 'limit';
  /** The value was this many characters long as JSON; `value` is the cut text. */
  cut?: number;
}

/** AFD-309: how large the flow's outputs of one run may be, as JSON. */
export const OUTPUTS_MAX = 256 * 1024;

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
  /** set_stats data (per_host: false) of the run, on the stats event. */
  custom?: { afd_outputs?: unknown };
  /** AFD-341: an inputs event's values; the start event's switch. */
  inputs?: Record<string, RecordedInput>;
  record_inputs?: boolean;
}

/** AFD-341: an input as the run view keeps it; a name that looks secret never keeps a value. */
function recorded(name: string, r: unknown): RecordedInput {
  if (SECRET.test(name)) return { missing: 'secret' };
  if (!r || typeof r !== 'object') return { missing: 'undefined' };
  const { value, missing, cut } = r as RecordedInput;
  if (missing === 'secret' || missing === 'undefined' || missing === 'limit') return { missing };
  return typeof cut === 'number' ? { value, cut } : { value };
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
  const exits: NonNullable<RunSummary['exits']> = {};
  const put = (into: RunSummary['nodes'], route: Route, host: string) => {
    const ports = into[route.node] ?? {};
    into[route.node] = ports;
    const list = ports[route.port] ?? [];
    if (!list.includes(host)) list.push(host);
    ports[route.port] = list;
  };
  /** `at`: the node whose play routed the host (AFD-353: a step inside a subflow, on the way). */
  /** AFS-208: hosts in a group the outcome play fails, by group. */
  const failing = new Map<string, Set<string>>();
  /** ADR-0040 §7: where each step's play routed each host, so a Retry can take it back. */
  const placed: { at: string; host: string; group: string }[] = [];
  const add = (group: string, host: string, at: string | null | undefined) => {
    const route = routes[group];
    if (!route) return;
    put(nodes, route, host);
    if (route.fails !== undefined) failing.set(group, (failing.get(group) ?? new Set()).add(host));
    for (const r of (at && route.via?.[at]) || []) put(exits, r, host);
    if (at) placed.push({ at, host, group });
  };
  const take = (into: RunSummary['nodes'], route: Route, host: string) => {
    const list = into[route.node]?.[route.port];
    if (!list) return;
    const i = list.indexOf(host);
    if (i >= 0) list.splice(i, 1);
    // A port no host left by is not one: no "0 hosts" wire.
    const ports = into[route.node];
    if (ports && list.length === 0) delete ports[route.port];
    if (ports && Object.keys(ports).length === 0) delete into[route.node];
  };
  /** A retry event: the step's results for these hosts are forgotten (its next attempt counts). */
  const forget = (node: string, again: string[]) => {
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i] as (typeof placed)[number];
      if (p.at !== node || !again.includes(p.host)) continue;
      placed.splice(i, 1);
      const route = routes[p.group];
      if (!route) continue;
      take(nodes, route, p.host);
      for (const r of route.via?.[node] ?? []) take(exits, r, p.host);
      failing.get(p.group)?.delete(p.host);
    }
    for (const h of again) {
      delete problems[node]?.[h];
      lost.delete(h);
    }
    pending = pending.filter((f) => !(again.includes(f.host) && (f.node ?? playNode) === node));
  };
  /**
   * AFD-379: Stop at a failure pause (a stopped event `after` the step, its `failed` hosts). The
   * step's rescue had already sent them out by its fail port; the run ends there instead, so they
   * failed at the step: not routed (a failure of it), not failed at the flow's end. The hosts
   * that passed keep their port: they ran the step, and stopped after it.
   */
  const stopAfter = (node: string, held: string[]) => {
    for (let i = placed.length - 1; i >= 0; i--) {
      const p = placed[i] as (typeof placed)[number];
      if (p.at !== node || !held.includes(p.host)) continue;
      placed.splice(i, 1);
      const route = routes[p.group];
      if (!route) continue;
      take(nodes, route, p.host);
      for (const r of route.via?.[node] ?? []) take(exits, r, p.host);
      failing.get(p.group)?.delete(p.host);
    }
    for (const h of held) {
      pending = pending.filter((f) => !(f.host === h && (f.node ?? playNode) === node));
      if (failures.some((f) => f.host === h && f.node === node)) continue;
      const problem = problems[node]?.[h];
      failures.push({
        host: h,
        node,
        task: problem?.task ?? '',
        ...(problem?.msg ? { msg: problem.msg } : {}),
      });
    }
  };
  const timings: Record<Ulid, { start: number; end: number }> = {};
  const waited: Record<Ulid, number> = {};
  let pausedSince: { node: string; ts: number } | undefined;
  const problems: Record<Ulid, Record<string, RunProblem>> = {};
  let playNode: string | null = null;
  let finished = false;
  let outputs: RunSummary['outputs'];
  let outputsTooLarge = false;
  const inputs: NonNullable<RunSummary['inputs']> = {};
  let inputsOff = false;
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
    if (e.event === 'start' && e.record_inputs === false) inputsOff = true;
    if (e.event === 'retry') {
      const again = (e as { hosts?: unknown }).hosts;
      if (typeof e.node === 'string' && Array.isArray(again)) forget(e.node, again.map(String));
      return;
    }
    // AFS-205: a step-by-step run's pause (ADR-0039) is time the step did not run.
    if (e.event === 'pause' && typeof e.node === 'string' && typeof e.ts === 'number') {
      pausedSince = { node: e.node, ts: e.ts };
      return;
    }
    if (e.event === 'stopped') {
      const held = (e as { failed?: unknown }).failed;
      if ((e as { after?: unknown }).after === true && typeof e.node === 'string')
        stopAfter(e.node, Array.isArray(held) ? held.map(String) : []);
    }
    if (e.event === 'resume' || e.event === 'stopped') {
      if (pausedSince && typeof e.ts === 'number')
        waited[pausedSince.node] =
          (waited[pausedSince.node] ?? 0) + Math.max(0, e.ts - pausedSince.ts);
      pausedSince = undefined;
      return;
    }
    if (e.event === 'inputs') {
      const at = e.node ?? playNode;
      if (!at || !e.host || !e.inputs || typeof e.inputs !== 'object') return;
      clock(e.ts);
      const byHost = inputs[at] ?? {};
      inputs[at] = byHost;
      byHost[e.host] = Object.fromEntries(
        Object.entries(e.inputs).map(([name, r]) => [name, recorded(name, r)]),
      );
      return;
    }
    if (e.event === 'stats') {
      finished = true;
      // AFD-309: the flow's outputs (set_stats afd_outputs); a segment that carries hosts has none.
      const recorded = e.custom?.afd_outputs;
      if (recorded && typeof recorded === 'object') {
        const text = JSON.stringify(recorded);
        if (text.length > OUTPUTS_MAX) outputsTooLarge = true;
        else outputs = JSON.parse(text) as RunSummary['outputs'];
      }
    }
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
      add(e.group, e.host, e.node ?? playNode);
      pending = pending.filter((f) => f.host !== e.host);
      lost.delete(e.host);
    }
    if (e.status === 'ok' && e.added?.host) {
      const groups = Array.isArray(e.added.groups) ? e.added.groups : [e.added.groups ?? ''];
      for (const g of groups) add(g, e.added.host, e.node ?? playNode);
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
    // AFS-208: a finished run failed the hosts its outcome play fails, also those Ansible left out
    // of that play (an include error a rescue routed keeps the host failed: no later play runs on
    // it, the play's fail never reports it, and Ansible ends with 0). Not in a run that stopped
    // early (max_fail_percentage): its hosts failed where it stopped, not at the outcome.
    const failed = { ...outcome };
    if (!partial && finished && (sawOutcome || done.length === 0))
      for (const [group, held] of failing)
        for (const h of held) failed[h] ??= routes[group]?.fails || 'failed';
    const gone = new Set(unreachable);
    if (!partial) for (const h of lost) gone.add(h);
    const sorted = (from: RunSummary['nodes']) => {
      const byNode: RunSummary['nodes'] = {};
      for (const [node, ports] of Object.entries(from))
        byNode[node] = Object.fromEntries(
          Object.entries(ports).map(([port, list]) => [port, [...list].sort()]),
        );
      return byNode;
    };
    return {
      nodes: sorted(nodes),
      ...(Object.keys(exits).length ? { exits: sorted(exits) } : {}),
      outcome: failed,
      failures: done,
      unreachable: [...gone].sort(),
      hosts: [...hosts].sort(),
      stoppedEarly: !partial && !sawOutcome && done.length > 0,
      timings: Object.fromEntries(Object.entries(timings).map(([k, t]) => [k, { ...t }])),
      ...(Object.keys(waited).length ? { waited: { ...waited } } : {}),
      problems: Object.fromEntries(
        Object.entries(problems).map(([k, byHost]) => [k, { ...byHost }]),
      ),
      ...(partial && playNode && !finished && !outcomePlay ? { running: playNode } : {}),
      ...(outputs ? { outputs } : {}),
      ...(outputsTooLarge ? { outputsTooLarge: true } : {}),
      ...(Object.keys(inputs).length
        ? {
            inputs: Object.fromEntries(
              Object.entries(inputs).map(([k, byHost]) => [k, { ...byHost }]),
            ),
          }
        : {}),
      ...(inputsOff ? { inputsOff: true } : {}),
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

// Step-by-step runs (AFD-346, ADR-0039): the channel between a run and its driver. The run's
// afd_step strategy appends pause, resume and stopped events to events.jsonl; the driver answers in
// control.json, replaced whole. Pure: the files are written and read by the hosts.
import { type FlowModel, ROOT } from '../flow/model';
import type { Ulid } from '../flow/types';

export const STEP_VERSION = 1;
/** The driver's file in the run folder (AFD_STEP_CONTROL). */
export const STEP_CONTROL = 'control.json';
/** How long a pause waits for an answer when the setting says nothing (seconds). */
export const STEP_TIMEOUT_S = 3600;

/**
 * - step: go on, pause before the next step;
 * - continue: go on, pause only at a pause point;
 * - pause: (while running) pause before the next step;
 * - stop: end the run before the next step (now, when paused).
 */
export type StepCommand = 'step' | 'continue' | 'pause' | 'stop' | 'retry';

/**
 * ADR-0040 §6 (AFD-371): a pause point with settings, read in debug runs only.
 * - condition: Jinja, checked per host at the step's gate; all hosts pause if any matches;
 * - hits: pause where the count of hosts arriving here (matching the condition, if any) reaches N;
 * - log: a message rendered per host into a masked log event; a log point never pauses.
 */
export interface PausePoint {
  node: Ulid;
  condition?: string;
  hits?: number;
  log?: string;
}

/** A pause point as control.json takes it: a bare node id (always) or one with settings. */
export type PointSpec = Ulid | PausePoint;

/** ADR-0040 §7: which failures pause a debug run (a host failed: on unless turned off). */
export interface FailureFilters {
  failed?: boolean;
  unreachable?: boolean;
}

export interface StepControl {
  v: typeof STEP_VERSION;
  command: StepCommand;
  /** Pause points: node ids (or points with settings) the run pauses before, also after Continue. */
  points: PointSpec[];
  /** The pause this answers; none for a command sent while the run goes (pause, stop). */
  reply?: string | null;
  /** After Retry: how the run goes on at the next steps (step: pause before each). */
  after?: 'step' | 'continue';
  /** Debug runs: which failures pause the run. */
  failures?: FailureFilters;
  /** Debug runs: hit counts so far, per point (carried into an approval's later segment). */
  hits?: Record<Ulid, number>;
}

/** The node id of a pause point. */
export const pointNode = (p: PointSpec): Ulid => (typeof p === 'string' ? p : p.node);

/** Whether a point has settings (a condition, a hit count, a log message). */
export function hasSettings(p: PointSpec): p is PausePoint {
  return typeof p !== 'string' && !!(p.condition?.trim() || p.hits || p.log?.trim());
}

/** Points as control.json takes them: a point without settings as its bare id; one per node. */
export function normalPoints(points: readonly PointSpec[]): PointSpec[] {
  const out = new Map<Ulid, PointSpec>();
  for (const p of points) {
    if (!hasSettings(p)) {
      out.set(pointNode(p), pointNode(p));
      continue;
    }
    const q: PausePoint = { node: p.node };
    if (p.condition?.trim()) q.condition = p.condition.trim();
    if (typeof p.hits === 'number' && Number.isInteger(p.hits) && p.hits > 0) q.hits = p.hits;
    if (p.log?.trim()) q.log = p.log;
    out.set(p.node, q);
  }
  return [...out.values()];
}

/** The control a step-by-step run starts with: pause before the first step, or at a point. */
export function startControl(every: boolean, points: PointSpec[] = []): StepControl {
  return { v: STEP_VERSION, command: every ? 'step' : 'continue', points, reply: null };
}

/** The answer to a pause (or a command while running, with no pause). */
export function answer(command: StepCommand, points: PointSpec[], pause?: string): StepControl {
  return { v: STEP_VERSION, command, points, reply: pause ?? null };
}

/** ADR-0040 §1: what made a debug run pause. */
export type PauseKind = 'step' | 'point' | 'condition' | 'failure';

/** A host that failed the step a failure pause is after. */
export interface FailedHost {
  host: string;
  /** The task that failed, and its message. */
  task: string;
  msg: string;
  /** It failed outside the step's rescue: Retry is refused. */
  hard?: boolean;
  /** Unreachable (the unreachable filter). */
  unreachable?: boolean;
}

export interface StepPause {
  id: string;
  node: Ulid;
  /** The play's name ("[key] Title"). */
  play: string;
  /** The hosts that run the step next, all waiting before it. */
  hosts: string[];
  /** When it paused (seconds, the run's clock) and how long it waits. */
  since: number;
  timeout: number;
  /** Debug runs (ADR-0040): why it paused. */
  kind?: PauseKind;
  /** A condition's pause: the hosts the condition matched (all hosts wait). */
  matched?: string[];
  /** A hit count's pause: the count of arrivals it was set to (N). */
  reached?: number;
  /** A failure pause: the hosts that failed, with their task and message. */
  failed?: FailedHost[];
  /** A failure pause: which attempt of the step failed (2 after one Retry). */
  attempt?: number;
  /** A failure pause where Retry is not offered: why, in words. */
  retryRefused?: string;
  /** Debug runs: the run answers inspect requests at this pause (false: `why` says why not). */
  debug?: boolean;
  why?: string;
}

/** ADR-0040 §6: a log point's line for a host, or a condition or message that failed. */
export interface PointLog {
  node: Ulid;
  host?: string;
  message?: string;
  /** Why parts of the message were masked. */
  masked?: string[];
  /** A condition or a message that could not be rendered: the error, in words. */
  error?: string;
  source?: 'condition' | 'log' | 'point';
  ts: number;
}

/** How many log lines a run view keeps (the newest). */
export const LOGS_KEPT = 500;

export interface StepState {
  /** Paused now: where, and which hosts wait there. */
  paused?: StepPause;
  /**
   * AFS-205: the step that runs now, after Step or Continue answered its pause (until the next
   * pause, stop or the end): the bar says "Running <step>…" with Pause.
   */
  running?: { node: Ulid; play: string };
  /** How many pauses so far. */
  pauses: number;
  /**
   * The run was stopped at a step boundary: by its driver or by the pause timeout. `after`: at a
   * failure pause, after the step ran; `hosts` then stopped after it and `failed` failed it.
   */
  stopped?: {
    node: Ulid;
    hosts: string[];
    reason: 'driver' | 'timeout';
    after?: boolean;
    failed?: string[];
  };
  /** Debug runs: log point lines and condition errors, the newest `LOGS_KEPT`. */
  logs?: PointLog[];
  /** Debug runs: hit counts so far, per point. */
  hits?: Record<Ulid, number>;
  /** Debug runs: each Retry, the step and the hosts it ran again. */
  retries?: { node: Ulid; hosts: string[]; attempt: number }[];
  /** The last command the run refused, and why (Retry where it is not offered). */
  refused?: { pause: string; command: string; why: string };
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

function failedHosts(v: unknown): FailedHost[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter((f): f is Record<string, unknown> => !!f && typeof f === 'object')
    .map((f) => ({
      host: String(f.host ?? ''),
      task: String(f.task ?? ''),
      msg: String(f.msg ?? ''),
      ...(f.hard ? { hard: true } : {}),
      ...(f.unreachable ? { unreachable: true } : {}),
    }));
}

const KINDS = new Set<PauseKind>(['step', 'point', 'condition', 'failure']);

/** What the step events of a run (in order) say now. Other events are ignored. */
export function stepState(events: Iterable<Record<string, unknown>>): StepState {
  const state: StepState = { pauses: 0 };
  for (const e of events) {
    if (e.event === 'pause' && typeof e.id === 'string' && typeof e.node === 'string') {
      state.pauses += 1;
      state.running = undefined;
      const retry = e.retry as { refused?: unknown } | undefined;
      state.paused = {
        id: e.id,
        node: e.node,
        play: String(e.play ?? ''),
        hosts: strings(e.hosts),
        since: Number(e.ts ?? 0),
        timeout: Number(e.timeout ?? STEP_TIMEOUT_S),
        ...(KINDS.has(e.kind as PauseKind) ? { kind: e.kind as PauseKind } : {}),
        ...(Array.isArray(e.matched) ? { matched: strings(e.matched) } : {}),
        ...(typeof e.reached === 'number' ? { reached: e.reached } : {}),
        ...(Array.isArray(e.failed) ? { failed: failedHosts(e.failed) } : {}),
        ...(typeof e.attempt === 'number' ? { attempt: e.attempt } : {}),
        ...(retry && typeof retry.refused === 'string' ? { retryRefused: retry.refused } : {}),
        ...(typeof e.debug === 'boolean' ? { debug: e.debug } : {}),
        ...(typeof e.why === 'string' ? { why: e.why } : {}),
      };
    } else if (e.event === 'log' && typeof e.node === 'string') {
      const logs = state.logs ?? [];
      state.logs = logs;
      logs.push({
        node: e.node,
        ...(typeof e.host === 'string' ? { host: e.host } : {}),
        ...(typeof e.message === 'string' ? { message: e.message } : {}),
        ...(Array.isArray(e.masked) ? { masked: strings(e.masked) } : {}),
        ...(typeof e.error === 'string' ? { error: e.error } : {}),
        ...(e.source === 'condition' || e.source === 'log' || e.source === 'point'
          ? { source: e.source }
          : {}),
        ts: Number(e.ts ?? 0),
      });
      if (logs.length > LOGS_KEPT) logs.splice(0, logs.length - LOGS_KEPT);
    } else if (e.event === 'hits' && typeof e.node === 'string' && typeof e.count === 'number') {
      state.hits = { ...state.hits, [e.node]: e.count };
    } else if (e.event === 'retry' && typeof e.node === 'string') {
      state.retries = [
        ...(state.retries ?? []),
        { node: e.node, hosts: strings(e.hosts), attempt: Number(e.attempt ?? 2) },
      ];
    } else if (e.event === 'refused' && typeof e.id === 'string') {
      state.refused = { pause: e.id, command: String(e.command ?? ''), why: String(e.why ?? '') };
    } else if (e.event === 'resume') {
      const was = state.paused;
      if (was && was.id === e.id) {
        state.running = { node: was.node, play: was.play };
        state.paused = undefined;
      }
    } else if (e.event === 'stopped' && typeof e.node === 'string') {
      state.paused = undefined;
      state.running = undefined;
      state.stopped = {
        node: e.node,
        hosts: Array.isArray(e.hosts) ? e.hosts.map(String) : [],
        reason: e.reason === 'timeout' ? 'timeout' : 'driver',
        ...(e.after === true ? { after: true } : {}),
        ...(Array.isArray(e.failed) ? { failed: strings(e.failed) } : {}),
      };
    } else if (e.event === 'stats') {
      state.paused = undefined;
      state.running = undefined;
    }
  }
  return state;
}

/** What a run view says of a step-by-step run (`RunView.step`). */
export interface RunStep extends StepState {
  /** Pauses before every step (Run Step by Step), not only at pause points. */
  every: boolean;
  /** The pause points the run was given (and has now): their node ids. */
  points: Ulid[];
  /** ADR-0040: the points with settings (a condition, a hit count, a log message). */
  settings?: PausePoint[];
  /** ADR-0040: a debug run (variables, evaluate, watch, conditions, pause on failure). */
  debug?: boolean;
  /**
   * AFS-205: who may go on from a pause, in the host's words ("Dana Whitfield or an operator of
   * this flow"), for a reader who may not: set by a host where others look at a run.
   */
  who?: string;
}

/** A step event line of events.jsonl (pause, resume, stopped), parsed; undefined for others. */
export function stepEvent(line: string): Record<string, unknown> | undefined {
  if (!/"event":\s*"(pause|resume|stopped|log|hits|retry|refused)"/.test(line)) return undefined;
  try {
    const e = JSON.parse(line) as Record<string, unknown>;
    return e && typeof e === 'object' && !Array.isArray(e) ? e : undefined;
  } catch {
    return undefined;
  }
}

/** Where step-by-step runs run, said where the command is not offered (ADR-0039 §6). */
export const STEP_NOT_ON_AWX =
  'Step-by-step runs run here (local, WSL, SSH, container) or on Ansible Flow Server, not on AWX';

/** Whether a run target can run step by step: the reason when it cannot. */
export function stepRefusal(target: 'local' | 'awx' | 'runner'): string | undefined {
  return target === 'awx' ? STEP_NOT_ON_AWX : undefined;
}

const hostsOf = (n: number) => `${n} host${n === 1 ? '' : 's'}`;

/** "in 59 min", "in 40 s": how long until a pause stops the run by itself. */
export function stopsIn(pause: Pick<StepPause, 'since' | 'timeout'>, nowMs: number): string {
  // AFS-205: never more than the timeout ("61 s" of a 60 s one): the run's clock (a container's)
  // may be a little ahead of the page's.
  const left = Math.min(
    pause.timeout,
    Math.max(0, Math.round(pause.since + pause.timeout - nowMs / 1000)),
  );
  return left >= 120 ? `${Math.round(left / 60)} min` : `${left} s`;
}

/**
 * A failure pause's count: "1 of 4 hosts failed (attempt 2)", "2 of 4 hosts unreachable"; every
 * host waits at it, also after a Retry.
 */
export function failedCount(pause: Pick<StepPause, 'hosts' | 'failed' | 'attempt'>): string {
  const failed = pause.failed ?? [];
  const total = Math.max(pause.hosts.length, failed.length);
  const of = total > 1 ? `${failed.length} of ${hostsOf(total)}` : hostsOf(failed.length);
  const what = failed.length && failed.every((f) => f.unreachable) ? 'unreachable' : 'failed';
  return `${of} ${what} (attempt ${pause.attempt ?? 1})`;
}

/**
 * The Run panel's line for a paused run: "Paused before Ping · 3 hosts · stops by itself in 59 min";
 * at a failure pause "Paused after Ping · 1 of 3 hosts failed (attempt 1) · …".
 */
export function pausedLine(pause: StepPause, title: string, nowMs: number): string {
  const what =
    pause.kind === 'failure'
      ? `Paused after ${title} · ${failedCount(pause)}`
      : `Paused before ${title} · ${hostsOf(pause.hosts.length)}`;
  return `${what} · stops by itself in ${stopsIn(pause, nowMs)}`;
}

/** Why a step-by-step run stopped, in words: by its driver, or because nobody answered. */
export function stoppedLine(
  stopped: NonNullable<StepState['stopped']>,
  title: string,
  timeoutS: number,
): string {
  if (stopped.reason === 'timeout') {
    const min = Math.round(timeoutS / 60);
    const span = timeoutS >= 120 ? `${min} minutes` : `${Math.round(timeoutS)} s`;
    return `Stopped ${stopped.after ? 'after' : 'before'} ${title}: nobody answered for ${span}`;
  }
  return `Stopped ${stopped.after ? 'after' : 'before'} ${title}`;
}

/**
 * AFS-205: a step by its path from the top level: "Pre-checks › Read device status" for a step
 * inside a subflow, so a pause there names where it is; the id when the flow does not have it.
 */
export function stepPath(model: FlowModel, id: Ulid): string {
  const entry = model.nodes.get(id);
  if (!entry) return id;
  const titles = [entry.node.title || entry.node.key || id];
  for (let level = entry.level; level && level !== ROOT; ) {
    const around = model.nodes.get(level);
    if (!around) break;
    titles.unshift(around.node.title || around.node.key || level);
    level = around.level;
  }
  return titles.join(' › ');
}

/** AFS-205: the line of a step-by-step run whose step runs now: "Running Pre-checks…". */
export function runningLine(title: string | undefined, every: boolean): string {
  if (title) return `Running ${title}…`;
  return every ? 'Running a step…' : 'Running on to the next pause point…';
}

/**
 * ADR-0040 §2 (AFD-370): requests a driver sends a paused debug run, as request-<n>.json beside
 * control.json; the run answers with answer-<n>.json.
 * - scopes: a host's scopes with each variable's name, type and size, no values;
 * - vars: the value at a path in a scope (a scalar, cut at 64 KB; a container's items, paged);
 * - facts: the same in the facts scope (read only when asked);
 * - eval: a Jinja expression for one host (lookups refused, 2 s limit, the result masked);
 * - watch: expressions for hosts (all paused hosts by default), which also compares hosts.
 */
export type InspectOp = 'scopes' | 'vars' | 'facts' | 'eval' | 'watch';
export type VarScope = 'inputs' | 'host' | 'flow' | 'facts';
export type MaskKind = 'vault' | 'no_log' | 'credential' | 'external' | 'name';

export interface InspectArgs {
  host?: string;
  hosts?: string[];
  scope?: VarScope;
  path?: (string | number)[];
  start?: number;
  count?: number;
  /** scopes: list the facts too. */
  facts?: boolean;
  expr?: string;
  exprs?: string[];
  /** eval and watch: seconds (default 2, at most 10). */
  timeout?: number;
}

/** A variable or an item: a scalar's value, a container's count; masked ones say why only. */
export interface VarEntry {
  name: string | number;
  /** dict, list, str, int, float, bool, null, template, masked, ... */
  type: string;
  size?: number;
  count?: number;
  value?: unknown;
  /** The value was this long; `value` is its start. */
  cut?: number;
  masked?: MaskKind;
}

export interface InspectAnswer {
  v?: number;
  pause?: string;
  n?: number;
  /** How long the run took to answer (ms). */
  ms?: number;
  /** The pause asked about is over. */
  gone?: boolean;
  error?: string;
  /** eval: refused before it ran (a lookup, the vault filters). */
  refused?: boolean;
  /** eval: stopped at its time limit. */
  timeout?: boolean;
  host?: string;
  scope?: VarScope;
  scopes?: { id: VarScope; name: string; expensive?: boolean; vars?: VarEntry[] }[];
  /** vars: `scope` at a path's root, or the container's type; eval: the result's type. */
  type?: string;
  total?: number;
  start?: number;
  children?: VarEntry[];
  more?: boolean;
  value?: unknown;
  cut?: number;
  count?: number;
  size?: number;
  masked?: MaskKind;
  expr?: string;
  results?: (InspectAnswer & { host: string; expr: string })[];
}

/** The request file's body. */
export function inspectRequest(
  n: number,
  pause: string,
  op: InspectOp,
  args: InspectArgs,
): Record<string, unknown> {
  return { ...args, v: STEP_VERSION, pause, n, op };
}

export const requestFile = (n: number) => `request-${n}.json`;
export const answerFile = (n: number) => `answer-${n}.json`;

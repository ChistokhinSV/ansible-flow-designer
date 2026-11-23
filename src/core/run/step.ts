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
export type StepCommand = 'step' | 'continue' | 'pause' | 'stop';

export interface StepControl {
  v: typeof STEP_VERSION;
  command: StepCommand;
  /** Pause points: node ids the run pauses before, also after Continue. */
  points: Ulid[];
  /** The pause this answers; none for a command sent while the run goes (pause, stop). */
  reply?: string | null;
}

/** The control a step-by-step run starts with: pause before the first step, or at a point. */
export function startControl(every: boolean, points: Ulid[] = []): StepControl {
  return { v: STEP_VERSION, command: every ? 'step' : 'continue', points, reply: null };
}

/** The answer to a pause (or a command while running, with no pause). */
export function answer(command: StepCommand, points: Ulid[], pause?: string): StepControl {
  return { v: STEP_VERSION, command, points, reply: pause ?? null };
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
}

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
  /** The run was stopped at a step boundary: by its driver or by the pause timeout. */
  stopped?: { node: Ulid; hosts: string[]; reason: 'driver' | 'timeout' };
}

/** What the step events of a run (in order) say now. Other events are ignored. */
export function stepState(events: Iterable<Record<string, unknown>>): StepState {
  const state: StepState = { pauses: 0 };
  for (const e of events) {
    if (e.event === 'pause' && typeof e.id === 'string' && typeof e.node === 'string') {
      state.pauses += 1;
      state.running = undefined;
      state.paused = {
        id: e.id,
        node: e.node,
        play: String(e.play ?? ''),
        hosts: Array.isArray(e.hosts) ? e.hosts.map(String) : [],
        since: Number(e.ts ?? 0),
        timeout: Number(e.timeout ?? STEP_TIMEOUT_S),
      };
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
  /** The pause points the run was given (and has now). */
  points: Ulid[];
  /**
   * AFS-205: who may go on from a pause, in the host's words ("Dana Whitfield or an operator of
   * this flow"), for a reader who may not: set by a host where others look at a run.
   */
  who?: string;
}

/** A step event line of events.jsonl (pause, resume, stopped), parsed; undefined for others. */
export function stepEvent(line: string): Record<string, unknown> | undefined {
  if (!/"event":\s*"(pause|resume|stopped)"/.test(line)) return undefined;
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

/** The Run panel's line for a paused run: "Paused before Ping · 3 hosts · stops by itself in 59 min". */
export function pausedLine(pause: StepPause, title: string, nowMs: number): string {
  return `Paused before ${title} · ${hostsOf(pause.hosts.length)} · stops by itself in ${stopsIn(pause, nowMs)}`;
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
    return `Stopped before ${title}: nobody answered for ${span}`;
  }
  return `Stopped before ${title}`;
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

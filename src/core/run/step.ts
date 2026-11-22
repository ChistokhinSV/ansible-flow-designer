// Step-by-step runs (AFD-346, ADR-0039): the channel between a run and its driver. The run's
// afd_step strategy appends pause, resume and stopped events to events.jsonl; the driver answers in
// control.json, replaced whole. Pure: the files are written and read by the hosts.
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
      state.paused = {
        id: e.id,
        node: e.node,
        play: String(e.play ?? ''),
        hosts: Array.isArray(e.hosts) ? e.hosts.map(String) : [],
        since: Number(e.ts ?? 0),
        timeout: Number(e.timeout ?? STEP_TIMEOUT_S),
      };
    } else if (e.event === 'resume') {
      if (state.paused?.id === e.id) state.paused = undefined;
    } else if (e.event === 'stopped' && typeof e.node === 'string') {
      state.paused = undefined;
      state.stopped = {
        node: e.node,
        hosts: Array.isArray(e.hosts) ? e.hosts.map(String) : [],
        reason: e.reason === 'timeout' ? 'timeout' : 'driver',
      };
    } else if (e.event === 'stats') {
      state.paused = undefined;
    }
  }
  return state;
}

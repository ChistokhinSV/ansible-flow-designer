// Step-by-step runs in VS Code (AFD-346, ADR-0039): the step-by-step run going per flow, the
// commands that drive it (Step, Continue, Pause, Stop) and the flow's pause points, kept in
// workspace state (not in the flow file). `afd.stepping` and `afd.stepPaused` tell the keys (F10,
// F5, F6, Shift+F5) when they apply.
import * as vscode from 'vscode';
import type { Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import {
  type FailureFilters,
  hasSettings,
  normalPoints,
  type PausePoint,
  type PointSpec,
  pointNode,
  type StepCommand,
} from '../../core/run/step';
import type { StepDriver } from '../../node/run/runFlow';

const going = new Map<string, StepDriver>();
/** ADR-0040: runs a debug session drives: its adapter sets their points and filters. */
const debugged = new Set<StepDriver>();
const paused = new Set<string>();

function updateContext(): void {
  void vscode.commands.executeCommand('setContext', 'afd.stepping', going.size > 0);
  void vscode.commands.executeCommand('setContext', 'afd.stepPaused', paused.size > 0);
}

/** Registers the driver of a flow's step-by-step run; dispose it when the run ends. */
export function stepStarted(
  flow: vscode.Uri,
  driver: StepDriver,
  /** ADR-0040: a debug session drives it (breakpoints reach it through its adapter). */
  debug = false,
): vscode.Disposable {
  const key = flow.toString();
  going.set(key, driver);
  if (debug) debugged.add(driver);
  updateContext();
  return {
    dispose() {
      debugged.delete(driver);
      if (going.get(key) === driver) going.delete(key);
      paused.delete(key);
      updateContext();
    },
  };
}

/** A run of the flow was reported: whether a step-by-step run of it waits now. */
export function stepReported(flow: vscode.Uri, run: RunView): void {
  const key = flow.toString();
  const was = paused.has(key);
  const now = run.state === 'running' && !!run.step?.paused && going.has(key);
  if (now === was) return;
  if (now) paused.add(key);
  else paused.delete(key);
  updateContext();
}

/** The step-by-step run of `flow`, or the only one going when no flow is named. */
export function steppingOf(flow?: vscode.Uri): StepDriver | undefined {
  if (flow) return going.get(flow.toString());
  return going.size === 1 ? [...going.values()][0] : undefined;
}

/**
 * Sends Step, Continue, Pause or Stop to the step-by-step run of `flow`. Returns what it did:
 * `sent`, `none` (no step-by-step run going) or the reason it could not be written.
 */
export async function sendStep(
  command: StepCommand,
  flow?: vscode.Uri,
): Promise<'sent' | 'none' | { error: string }> {
  const driver = steppingOf(flow);
  if (!driver) return 'none';
  const error = await driver.send(command);
  return error ? { error } : 'sent';
}

const pointsKey = (flowId: string) => `afd.pausePoints.${flowId}`;
const failuresKey = (flowId: string) => `afd.failureFilters.${flowId}`;

/** ADR-0040: a flow's pause points changed (the canvas, a command): VS Code's breakpoints follow. */
const changed = new vscode.EventEmitter<{ flow: vscode.Uri; flowId: string }>();
export const onPausePointsChanged = changed.event;

/**
 * The flow's pause points as kept (workspace state): bare node ids, or (ADR-0040 §6, AFD-371)
 * points with a condition, a hit count or a log message. 1.1 kept bare ids only.
 */
export function pointSpecs(state: vscode.Memento, flowId: string): PointSpec[] {
  const v = state.get<unknown>(pointsKey(flowId), []);
  if (!Array.isArray(v)) return [];
  return normalPoints(
    v.filter(
      (x): x is PointSpec =>
        typeof x === 'string' ||
        (!!x && typeof x === 'object' && typeof (x as PausePoint).node === 'string'),
    ),
  );
}

/** The flow's pause points: their node ids. */
export function pausePoints(state: vscode.Memento, flowId: string): Ulid[] {
  return pointSpecs(state, flowId).map(pointNode);
}

/** The points with settings, for the canvas's dots and Edit Pause Point…. */
export function pointSettings(state: vscode.Memento, flowId: string): PausePoint[] {
  return pointSpecs(state, flowId).filter(hasSettings);
}

/** ADR-0040 §7: which failures pause this flow's debug runs (a host failed: on by default). */
export function failureFilters(state: vscode.Memento, flowId: string): FailureFilters {
  const v = state.get<unknown>(failuresKey(flowId));
  if (!v || typeof v !== 'object') return { failed: true };
  const f = v as FailureFilters;
  return { failed: f.failed !== false, unreachable: f.unreachable === true };
}

/** Keeps the points, and gives them to a step-by-step run going (a debug run's adapter does). */
async function keepPoints(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  points: PointSpec[],
  quiet = false,
): Promise<void> {
  const next = normalPoints(points);
  await state.update(pointsKey(flowId), next.length ? next : undefined);
  const driver = going.get(flow.toString());
  if (driver && !debugged.has(driver)) await driver.setPoints(next);
  if (!quiet) changed.fire({ flow, flowId });
}

/** Sets or takes away a pause point; the run going gets the new points at its next step. */
export async function togglePausePoint(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  node: Ulid,
): Promise<Ulid[]> {
  const now = pointSpecs(state, flowId);
  const on = now.some((p) => pointNode(p) === node);
  const next = on ? now.filter((p) => pointNode(p) !== node) : [...now, node];
  await keepPoints(state, flow, flowId, next);
  return next.map(pointNode);
}

/** AFD-371: a point's settings (Edit Pause Point…), or null to take the point away. */
export async function setPausePoint(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  node: Ulid,
  point: PointSpec | null,
): Promise<PointSpec[]> {
  const others = pointSpecs(state, flowId).filter((p) => pointNode(p) !== node);
  const next =
    point === null ? others : [...others, typeof point === 'string' ? node : { ...point, node }];
  await keepPoints(state, flow, flowId, next);
  return normalPoints(next);
}

/**
 * ADR-0040: the points as VS Code's breakpoints say (a person changed them in the Breakpoints
 * view): kept without firing the change back.
 */
export async function pointsFromBreakpoints(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  points: PointSpec[],
): Promise<void> {
  await keepPoints(state, flow, flowId, points, true);
}

/** AFD-372: which failures pause this flow's debug runs; a step-by-step run going gets them. */
export async function setFailureFilters(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  failures: FailureFilters,
): Promise<FailureFilters> {
  const next = { failed: failures.failed !== false, unreachable: failures.unreachable === true };
  await state.update(failuresKey(flowId), next);
  const driver = going.get(flow.toString());
  if (driver) await driver.setFailures(next);
  failuresChanged.fire({ flow, failures: next });
  return next;
}

const failuresChanged = new vscode.EventEmitter<{ flow: vscode.Uri; failures: FailureFilters }>();
/** The failure filters of a flow changed on its canvas: a debug session going takes them. */
export const onFailureFiltersChanged = failuresChanged.event;

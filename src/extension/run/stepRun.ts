// Step-by-step runs in VS Code (AFD-346, ADR-0039): the step-by-step run going per flow, the
// commands that drive it (Step, Continue, Pause, Stop) and the flow's pause points, kept in
// workspace state (not in the flow file). `afd.stepping` and `afd.stepPaused` tell the keys (F10,
// F5, F6, Shift+F5) when they apply.
import * as vscode from 'vscode';
import type { Ulid } from '../../core/flow/types';
import type { RunView } from '../../core/protocol';
import type { StepCommand } from '../../core/run/step';
import type { StepDriver } from '../../node/run/runFlow';

const going = new Map<string, StepDriver>();
const paused = new Set<string>();

function updateContext(): void {
  void vscode.commands.executeCommand('setContext', 'afd.stepping', going.size > 0);
  void vscode.commands.executeCommand('setContext', 'afd.stepPaused', paused.size > 0);
}

/** Registers the driver of a flow's step-by-step run; dispose it when the run ends. */
export function stepStarted(flow: vscode.Uri, driver: StepDriver): vscode.Disposable {
  const key = flow.toString();
  going.set(key, driver);
  updateContext();
  return {
    dispose() {
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

/** The flow's pause points (workspace state). */
export function pausePoints(state: vscode.Memento, flowId: string): Ulid[] {
  const v = state.get<unknown>(pointsKey(flowId), []);
  return Array.isArray(v) ? v.filter((x): x is Ulid => typeof x === 'string') : [];
}

/** Sets or takes away a pause point; the run going gets the new points at its next step. */
export async function togglePausePoint(
  state: vscode.Memento,
  flow: vscode.Uri,
  flowId: string,
  node: Ulid,
): Promise<Ulid[]> {
  const now = pausePoints(state, flowId);
  const next = now.includes(node) ? now.filter((n) => n !== node) : [...now, node];
  await state.update(pointsKey(flowId), next.length ? next : undefined);
  await going.get(flow.toString())?.setPoints(next);
  return next;
}

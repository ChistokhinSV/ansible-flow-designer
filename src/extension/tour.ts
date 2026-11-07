// Walkthrough progress (AFD-22): designer edits set `afd.tour.*` context keys, which check off the
// steps of "Design your first Ansible flow" (`onContext` completion events in package.json).
// AFD-73: the keys are kept for the user (globalState) and feed the designer's first-flow
// checklist, with `codeSeen` (the generated code shown) and `skeletonRun` (a check run done).
import * as vscode from 'vscode';
import type { FlowCommand } from '../core/flow/commands';
import { isFailPort } from '../core/flow/ports';

/** The tour keys a successful command reaches. */
export function tourKeys(command: FlowCommand): string[] {
  switch (command.kind) {
    case 'addNode':
      return command.type === 'subflow' ? ['nodeAdded', 'subflow'] : ['nodeAdded'];
    case 'pasteNodes':
      return ['nodeAdded'];
    case 'applyPattern':
    case 'setDecision':
      return ['failureHandled'];
    case 'connect':
      return isFailPort(command.from.port) ? ['failureHandled'] : [];
    case 'extractSubflow':
      return ['subflow'];
    default:
      return [];
  }
}

const reached = new Set<string>();

/** The keys set so far in this session (tests). */
export function tourReached(): string[] {
  return [...reached];
}

export function markTour(command: FlowCommand): void {
  for (const key of tourKeys(command)) markTourKey(key);
}

/** What the first-flow checklist reads: the keys reached for this user, and whether it is hidden. */
export interface FirstFlowState {
  hidden: boolean;
  done: string[];
}

/** Keys the host reaches outside designer commands: the generated code shown, a check run done. */
export const CODE_SEEN = 'codeSeen';
export const SKELETON_RUN = 'skeletonRun';
/** AFD-118: a scenario added in the designer (the walkthrough's "Test where hosts end"). */
export const SCENARIO_ADDED = 'scenarioAdded';

const STATE = 'afd.firstFlow';
let saved: vscode.Memento | undefined;
const changed = new vscode.EventEmitter<FirstFlowState>();
export const onFirstFlow = changed.event;

/** At activation: the user's progress, and the walkthrough's context keys from it. */
export function initTour(state: vscode.Memento): void {
  saved = state;
  for (const key of firstFlowState().done)
    void vscode.commands.executeCommand('setContext', `afd.tour.${key}`, true);
}

export function firstFlowState(): FirstFlowState {
  const s = saved?.get<Partial<FirstFlowState>>(STATE);
  return { hidden: !!s?.hidden, done: Array.isArray(s?.done) ? s.done : [] };
}

async function save(next: FirstFlowState): Promise<void> {
  await saved?.update(STATE, next);
  changed.fire(next);
}

export function markTourKey(key: string): void {
  if (!reached.has(key)) {
    reached.add(key);
    void vscode.commands.executeCommand('setContext', `afd.tour.${key}`, true);
  }
  const now = firstFlowState();
  if (!now.done.includes(key)) void save({ ...now, done: [...now.done, key] });
}

export function setFirstFlowHidden(hidden: boolean): void {
  void save({ ...firstFlowState(), hidden });
}

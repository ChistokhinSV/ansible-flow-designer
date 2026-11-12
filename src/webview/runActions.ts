// AFD-81: a run asked for from the designer (top bar, Run menu, first-flow checklist). The canvas
// switches to Run mode once the host reports it running, so the run shows where the person looks.
import { send } from './bus';
import { useUi } from './store';

export function startRun(mode: 'check' | 'real'): void {
  useUi.getState().setRunAsked(true);
  send({ type: 'run', mode });
}

/** AFD-244: a skeleton run from a top-level step on, or of that step alone. */
export function startPartialRun(node: string, only: boolean): void {
  useUi.getState().setRunAsked(true);
  send({ type: 'runPartial', node, only });
}

/** AFD-245: an earlier run of this flow, on the canvas again. */
export function showPastRun(id: string): void {
  send({ type: 'showRun', id });
}

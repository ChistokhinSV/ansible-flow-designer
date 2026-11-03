// The first-flow checklist (AFD-73): four things that make a first flow, ticked from the flow and
// from the user's progress (tour keys the host keeps for them).
import type { FlowDocument } from '../flow/types';

export type FirstFlowId = 'step' | 'code' | 'failure' | 'run';

export interface FirstFlowItem {
  id: FirstFlowId;
  label: string;
  detail: string;
  done: boolean;
}

/** Steps on the top level: what the checklist counts (Start and the ends are not steps). */
export function topSteps(doc: FlowDocument): number {
  return (doc.nodes ?? []).filter((n) => n && n.type !== 'start' && n.type !== 'end').length;
}

export function firstFlowItems(
  doc: FlowDocument,
  openPorts: number,
  done: readonly string[],
): FirstFlowItem[] {
  const steps = topSteps(doc);
  return [
    {
      id: 'step',
      label: 'Add a step',
      detail: 'Add a Step (N) puts one between Start and Done.',
      done: steps > 0,
    },
    {
      id: 'code',
      label: 'See the playbook it makes',
      detail: "One play per step, in generated/. Peek Code shows a step's play.",
      done: done.includes('codeSeen'),
    },
    {
      id: 'failure',
      label: 'Decide what happens when it fails',
      detail: 'A fail port needs a handler, or a reason to stay open.',
      done: steps > 0 && openPorts === 0,
    },
    {
      id: 'run',
      label: 'Run it as a skeleton',
      detail: 'Steps without code print TODO. It needs an Ansible environment.',
      done: done.includes('skeletonRun'),
    },
  ];
}

/** A first flow: one to five steps on the top level (an empty one has the empty-level card). */
export function isFirstFlowSize(doc: FlowDocument): boolean {
  const steps = topSteps(doc);
  return steps >= 1 && steps <= 5;
}

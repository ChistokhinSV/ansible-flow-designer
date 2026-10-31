// What a node's Code-mode line says about it (mockup 04): the drift that matters first, then a TODO
// stub, the last run, an open subflow, and whether the generated code has it. Pure, so the canvas
// and the tests share it (AFD-34).
import type { DriftItem, NodeCode } from '../drift/types';
import type { FlowNode } from '../flow/types';
import type { RunSummary } from '../run/events';

export interface CodeState {
  /** "3 tasks", or undefined when the node is not bound. */
  count?: string;
  state: string;
  tone: 'ok' | 'warn' | 'neutral';
}

export function codeState(
  node: FlowNode,
  code: NodeCode,
  issue: DriftItem | undefined,
  ran: RunSummary | undefined,
): CodeState {
  const inner = node.type === 'subflow' && (node.subflow?.nodes?.length ?? 0) > 0;
  const count =
    code.artifact === 'not bound'
      ? undefined
      : `${code.tasks.length} task${code.tasks.length === 1 ? '' : 's'}`;
  if (issue) return { count, state: `drift: ${issue.label}`, tone: 'warn' };
  if (!node.impl?.ref && !inner && (node.type === 'task' || node.type === 'subflow'))
    return { count, state: 'runs as TODO stub', tone: 'neutral' };
  if (ran?.failures.some((f) => f.node === node.id))
    return { count, state: 'last run failed', tone: 'warn' };
  if (ran?.nodes[node.id]) return { count, state: 'last run ok', tone: 'ok' };
  if (inner) return { count, state: 'open subflow', tone: 'neutral' };
  return code.matched
    ? { count, state: 'matched by ID', tone: 'neutral' }
    : { count, state: 'not in generated code', tone: 'warn' };
}

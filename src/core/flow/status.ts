// Node lifecycle rules shared by every writer (AFD-31): the properties page, the AI tools, imports.
// A tested node whose design changes drops back to implemented in planCommand (ADR-0004, AFD-12).
import type { NodeStatus } from './types';

/**
 * The status after a binding change: a bound node is implemented (a tested one keeps its status
 * when the binding did not change); an unbound one goes back to specified.
 */
export function statusAfterBinding(
  current: NodeStatus,
  bound: boolean,
  unchanged: boolean,
): NodeStatus {
  if (bound) return current === 'tested' && unchanged ? 'tested' : 'implemented';
  return current === 'implemented' || current === 'tested' ? 'specified' : current;
}

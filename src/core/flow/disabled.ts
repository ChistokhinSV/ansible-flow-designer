// AFD-242 (ADR-0035): a disabled node does nothing. Its hosts pass straight through to where it
// went on (its one wired main output), its tasks are not generated, and what it would have handled
// (its fail ports) cannot happen. Everything inside a disabled subflow is disabled with it.
import type { FlowModel } from './model';
import type { FlowNode, Ulid } from './types';

/** The types that can be switched off: start and end nodes are the path's ends, not steps on it. */
export function canDisable(node: Pick<FlowNode, 'type'>): boolean {
  return node.type !== 'start' && node.type !== 'end';
}

/** The nodes marked disabled (not those inside them). */
export function disabledIds(model: FlowModel): Ulid[] {
  return [...model.nodes.values()].filter((e) => e.node.disabled === true).map((e) => e.node.id);
}

/** The node is disabled, or a subflow around it is: the disabled node (itself or the subflow). */
export function disabledBy(model: FlowModel, id: Ulid): FlowNode | undefined {
  for (let at: string | undefined = id; at; ) {
    const entry = model.nodes.get(at);
    if (!entry) return undefined;
    if (entry.node.disabled === true) return entry.node;
    at = entry.level;
  }
  return undefined;
}

// Notify links (AFD-292): Ansible's handlers, as a flow has them. A step names what it notifies
// (`notify: [<handler step key or topic>]`); a handler step is marked `notified` (with the topics it
// listens to, as `listen`). Both are on one level. The handler runs at its place in the flow, once,
// for the hosts on which any step that notifies it changed something; other hosts pass by it. The
// generator writes that as the handler's `when` over the notifying steps' registers.
import { successors } from './adjacency';
import type { Edge, FlowNode } from './types';

/** A name in `notify` that is a handler's key reaches that handler; otherwise it is a topic. */
export function handlersNotifiedBy(node: FlowNode, level: readonly FlowNode[]): FlowNode[] {
  const out: FlowNode[] = [];
  for (const name of node.notify ?? []) {
    const byKey = level.find((n) => n.key === name && n.notified);
    const reached = byKey
      ? [byKey]
      : level.filter((n) => n.notified?.listen?.includes(name) && n.id !== node.id);
    for (const h of reached) if (!out.includes(h)) out.push(h);
  }
  return out;
}

/** The steps of the level that notify a handler, in level order. */
export function notifiersOf(handler: FlowNode, level: readonly FlowNode[]): FlowNode[] {
  if (!handler.notified) return [];
  return level.filter(
    (n) => n.id !== handler.id && handlersNotifiedBy(n, level).some((h) => h.id === handler.id),
  );
}

/** Names in a step's `notify` that reach no handler of its level. */
export function unknownNotifyNames(node: FlowNode, level: readonly FlowNode[]): string[] {
  return (node.notify ?? []).filter(
    (name) =>
      !level.some(
        (n) =>
          n.id !== node.id && n.notified && (n.key === name || n.notified.listen?.includes(name)),
      ),
  );
}

/** Whether `to` is on a path from `from` along the level's wires. */
export function reaches(edges: readonly Edge[], from: string, to: string): boolean {
  const seen = new Set<string>([from]);
  const queue = [from];
  while (queue.length) {
    const at = queue.shift() as string;
    for (const next of successors(edges, at)) {
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

/** A step that can say it changed something: one bound to a module (its result registers). */
export const reportsChange = (node: FlowNode): boolean =>
  node.type === 'task' && node.impl?.kind === 'module' && !!node.impl.ref;

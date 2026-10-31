// Walking a node list and every subflow inside it (AFD-40). Levels with their paths and parents
// come from buildModel; these walks serve code that has plain nodes (imports, the clipboard, design
// fingerprints) or a node whose inner steps it needs.
import type { FlowNode, Ulid } from './types';

/** Every node, depth first: each node before its inner steps. Entries that are not objects are skipped. */
export function* walkNodes(
  nodes: readonly (FlowNode | null | undefined)[] | undefined,
): Generator<FlowNode> {
  for (const n of nodes ?? []) {
    if (!n || typeof n !== 'object') continue;
    yield n;
    if (n.subflow && typeof n.subflow === 'object') yield* walkNodes(n.subflow.nodes);
  }
}

/** IDs of the steps inside a subflow, at every depth (a step without an ID hides its own). */
export function descendantIds(node: FlowNode): Ulid[] {
  return (node.subflow?.nodes ?? []).flatMap((n) => (n?.id ? [n.id, ...descendantIds(n)] : []));
}

// Keyboard pick (AFD-47): the nodes "Connect to Another Node…", "Rewire…" and "Connect from…" can
// choose on the open level, in reading order (top to bottom, then left to right), so Tab and the
// arrow keys walk them the way the eye does.
import type { FlowModel } from '../flow/model';
import { freeOutput } from '../flow/portMenu';
import { portsFor } from '../flow/ports';
import type { FlowNode, Position, Ulid } from '../flow/types';

export type PickMode = 'to' | 'from' | 'rewire';

export function pickCandidates(
  model: FlowModel,
  nodes: readonly { node: FlowNode; position: Position }[],
  pick: { mode: PickMode; node: Ulid },
): Ulid[] {
  // Wiring to a node needs its `in` port; wiring from one needs an output that is still free.
  const fits = (node: FlowNode) =>
    pick.mode === 'from'
      ? freeOutput(model, node.id) !== undefined
      : portsFor(node).some((p) => p.name === 'in');
  return nodes
    .filter(({ node }) => node.id !== pick.node && fits(node))
    .sort((a, b) => a.position.y - b.position.y || a.position.x - b.position.x)
    .map(({ node }) => node.id);
}

/** The next candidate after `at` (or the first; the last going back), wrapping at the ends. */
export function stepPick(list: readonly Ulid[], at: Ulid | null, step: 1 | -1): Ulid | undefined {
  if (list.length === 0) return undefined;
  const i = at ? list.indexOf(at) : -1;
  if (i < 0) return step > 0 ? list[0] : list.at(-1);
  return list[(i + step + list.length) % list.length];
}

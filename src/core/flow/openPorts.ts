// Open fail-type ports (D-15) with subflow bubbling (ADR-0004): an inner open fail port counts at
// the parent's port of the same name when the parent has that port, and only counts on its own
// when it cannot bubble.
import { bubbles, levelTaken, openOnPurpose, portKey, untakenFailPorts } from './bubbling';
import { disabledBy } from './disabled';
import type { FlowModel } from './model';
import type { Ulid } from './types';

export interface OpenPort {
  node: Ulid;
  port: string;
  level: string;
}

export function openFailPorts(model: FlowModel): OpenPort[] {
  const decided = openOnPurpose(model.doc);
  const open: OpenPort[] = [];
  for (const level of model.levels.values()) {
    const parent = level.parent ? model.nodes.get(level.parent)?.node : undefined;
    const taken = levelTaken(level.edges, parent);
    for (const node of level.nodes) {
      // AFD-242: a disabled node runs nothing, so nothing of it fails.
      if (!node || disabledBy(model, node.id)) continue;
      for (const port of untakenFailPorts(node, taken)) {
        if (decided.has(portKey(node.id, port)) || bubbles(parent, node.id, port, taken)) continue;
        open.push({ node: node.id, port, level: level.id });
      }
    }
  }
  return open;
}

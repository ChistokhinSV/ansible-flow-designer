// Rolling subflows (AFD-55): `settings.rolling` on a subflow sends its hosts through the whole inner
// level in batches, so one batch finishes every step before the next one starts. The engine
// compiles the inner level into one play with `serial`, which only some steps can live in; the
// validator and the engine ask the same question here.
import { enclosing } from './dataRefs';
import type { FlowModel } from './model';
import type { FlowNode } from './types';

/** Why a step cannot run inside a rolling subflow's one play, or undefined when it can. */
export function rollingObstacle(node: FlowNode): string | undefined {
  switch (node.type) {
    case 'start':
    case 'end':
    case 'decision':
      return undefined;
    case 'task':
      if (node.impl?.kind === 'playbook') return 'a playbook binding runs plays of its own';
      if (node.settings?.inventory_target?.trim())
        return 'it runs on its inventory_target, in plays of its own';
      if (node.settings?.serial !== undefined)
        return 'serial batches a play of its own; the subflow sets the batch';
      if (node.settings?.max_fail_percentage !== undefined)
        return 'max_fail_percentage counts a play of its own';
      return undefined;
    case 'subflow':
      return node.subflow?.nodes?.length ? 'a subflow with steps is a level of its own' : undefined;
    default:
      return `a ${node.type} node needs plays of its own`;
  }
}

/** The steps that keep a rolling subflow from compiling into one play, and why. */
export function rollingObstacles(
  model: FlowModel,
  subflow: FlowNode,
): { node: FlowNode; why: string }[] {
  const out: { node: FlowNode; why: string }[] = [];
  const level = model.nodes.get(subflow.id)?.level;
  const around = level ? enclosing(model, level) : [];
  const target = [subflow, ...around].find((n) => n.settings?.inventory_target?.trim());
  if (target)
    out.push({
      node: subflow,
      why: `its steps run on the inventory_target of ${target.title}, in plays of their own`,
    });
  for (const n of model.levels.get(subflow.id)?.nodes ?? []) {
    if (!n) continue;
    const why = rollingObstacle(n);
    if (why) out.push({ node: n, why });
  }
  return out;
}

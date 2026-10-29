// Nodes whose work runs on an inventory_target instead of the arriving hosts (AFD-14): a task, or
// a subflow without inner steps, with its own target or the nearest enclosing subflow's. Shared by
// Option A and the real-run confirmation, which names every target a run touches.
import { type FlowModel, ROOT } from '../flow/model';
import type { Ulid } from '../flow/types';

export function effectiveTargets(model: FlowModel): Map<Ulid, string> {
  const out = new Map<Ulid, string>();
  for (const [id, { node, level }] of model.nodes) {
    if (node.type !== 'task' && node.type !== 'subflow') continue;
    // A subflow with inner steps is a level: its target is inherited by those steps.
    if (node.subflow?.nodes?.length) continue;
    let target = node.settings?.inventory_target?.trim();
    for (let at = level; !target && at !== ROOT; ) {
      const parent = model.nodes.get(at);
      if (!parent) break;
      target = parent.node.settings?.inventory_target?.trim();
      at = parent.level;
    }
    if (target) out.set(id, target);
  }
  return out;
}

/** Each distinct target with the keys of the nodes that run on it, in flow order. */
export function targetUses(model: FlowModel): { target: string; nodes: string[] }[] {
  const uses = new Map<string, string[]>();
  for (const [id, target] of effectiveTargets(model)) {
    const key = model.nodes.get(id)?.node.key ?? id;
    uses.set(target, [...(uses.get(target) ?? []), key]);
  }
  return [...uses].map(([target, nodes]) => ({ target, nodes }));
}

/** `{{ name }}` and `{{ name | join(',') }}` filled in from the run inputs. */
export function resolvePattern(
  target: string,
  inputs: Record<string, unknown>,
): string | undefined {
  const out = target.replaceAll(
    /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?:\|\s*join\((['"])(.*?)\2\)\s*)?\}\}/g,
    (m, name: string, _q: string | undefined, sep: string | undefined) => {
      const v = inputs[name];
      if (v === undefined) return m;
      return Array.isArray(v) ? v.join(sep ?? ',') : String(v);
    },
  );
  return out.includes('{{') ? undefined : out;
}

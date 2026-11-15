// AFD-287: the facts a step sets (set_fact's parameters' keys), and the step before a reader that
// sets a name. Steps pass data through declared inputs and outputs; a fact that is no output yet
// is still a value a later step may want, so the @ list, the unknown-variable warning and the Data
// lens offer it, and `useFact` declares it on both steps in one edit.
import { takesFreeKeys } from '../catalog/freeKeys';
import { upstreamNodes } from './dataRefs';
import type { FlowModel } from './model';
import type { FlowNode } from './types';

/** The facts a set_fact step sets: its parameters' keys (`cacheable` is an option). */
export function setFactNames(impl: FlowNode['impl']): string[] {
  if (impl?.kind !== 'module' || !takesFreeKeys(impl.ref)) return [];
  return Object.keys(impl.params ?? {}).filter(
    (k) => k !== 'cacheable' && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k),
  );
}

/** The nearest step that runs before `reader` and sets `name` with set_fact. */
export function factSetter(model: FlowModel, reader: FlowNode, name: string): FlowNode | undefined {
  // upstreamNodes lists the nearest first.
  return upstreamNodes(model, reader.id).find((up) => setFactNames(up.impl).includes(name));
}

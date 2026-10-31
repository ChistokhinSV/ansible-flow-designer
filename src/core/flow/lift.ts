// Lifting an inner step's output to its subflow (AFD-7, AFD-21): the subflow gets an output whose
// `from` reads the step, so readers outside read the subflow and the file stays encapsulated. One
// naming rule for Extract into Subflow and for references that reach into subflows (AFD-40).
import { liftOf } from './dataRefs';
import type { ContractField, FlowNode } from './types';

/** The output of `sub` that already lifts `child.name` as it is, if any. */
export function existingLift(sub: FlowNode, child: FlowNode, name: string): string | undefined {
  for (const o of Object.keys(sub.outputs ?? {})) {
    const l = liftOf(sub, o);
    if (l && 'inner' in l && l.inner.id === child.id && l.output === name && !l.path.length)
      return o;
  }
  return undefined;
}

/** A free name for a new lift of `childKey.name`: the output's own, else prefixed by the step key. */
export function liftName(taken: ReadonlySet<string>, childKey: string, name: string): string {
  if (!taken.has(name)) return name;
  const prefixed = `${childKey.replaceAll('-', '_')}_${name}`;
  let as = prefixed;
  for (let i = 2; taken.has(as); i++) as = `${prefixed}_${i}`;
  return as;
}

/** The subflow output that lifts `child.name`. */
export function liftField(child: FlowNode, name: string): ContractField {
  return { type: child.outputs?.[name]?.type ?? 'any', from: `${child.key}.${name}` };
}

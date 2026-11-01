// Names of the host variables a flow's data lives in (ADR-0011): what a module step registers and
// which variable holds a node's output. The validator checks references against the same names the
// engine writes, without importing the engine (AFD-40).
import { enclosing, liftOf } from './dataRefs';
import type { FlowModel } from './model';
import type { FlowNode, ImplBinding } from './types';

/** Ansible group names: lowercase letters, digits and underscores. */
export function groupPart(key: string): string {
  return key.toLowerCase().replaceAll(/[^a-z0-9_]/g, '_');
}

/** The variable a module node registers its result in. */
export function registerName(
  node: FlowNode,
  impl: ImplBinding | null | undefined = node.impl,
): string {
  return impl?.register || `${groupPart(node.key)}_result`;
}

/** Whether a step's output is read from its register (`from: impl.register[.path]`). */
export function fromRegister(node: FlowNode, output: string): boolean {
  const from = node.outputs?.[output]?.from;
  return node.impl?.kind === 'module' && !!from?.startsWith('impl.register');
}

const keyUses = new WeakMap<FlowModel, Map<string, number>>();

/** Whether a key names nodes on more than one level (keys are unique per level only). */
function keyRepeats(model: FlowModel, key: string): boolean {
  let uses = keyUses.get(model);
  if (!uses) {
    uses = new Map();
    for (const { node } of model.nodes.values()) uses.set(node.key, (uses.get(node.key) ?? 0) + 1);
    keyUses.set(model, uses);
  }
  return (uses.get(key) ?? 0) > 1;
}

/**
 * Where a step keeps an output that is not its register (AFD-53): a role, a playbook or a stub
 * sets a fact of the output's own name, which any other step setting that name overwrites, so the
 * generated code copies it right away into a variable of the step's own: `afd_<key>__<output>`,
 * with the keys of the subflows around it in front when its key is used on another level too (so
 * moving a step into a subflow keeps the name; slugs never hold `__`).
 */
export function capturedVar(model: FlowModel, node: FlowNode, output: string): string {
  const level = model.nodes.get(node.id)?.level;
  const scope = level && keyRepeats(model, node.key) ? enclosing(model, level).reverse() : [];
  return `afd_${[...scope, node].map((n) => groupPart(n.key)).join('__')}__${groupPart(output)}`;
}

/** The task that captures an output; Code sync tells it from the step's own tasks by its name. */
export const captureTaskName = (key: string, output: string) => `[${key}] keep output ${output}`;
export const CAPTURE_TASK = /^\[[a-z0-9-]+\] keep output [a-z][a-z0-9_]*$/;

/** The outputs a step's code captures after it runs, with the variable each goes to. */
export function capturedOutputs(model: FlowModel, node: FlowNode): [string, string][] {
  if (node.type !== 'task') return [];
  return Object.keys(node.outputs ?? {})
    .filter((out) => !fromRegister(node, out))
    .map((out) => [out, capturedVar(model, node, out)]);
}

/**
 * The host variable that holds a node's output: `from: impl.register[.path]` reads the registered
 * result; any other output of a step is the variable its code captures it in (AFD-53).
 */
export function outputVar(model: FlowModel, node: FlowNode, output: string): string {
  if (fromRegister(node, output)) {
    const rest = (node.outputs?.[output]?.from ?? '').slice('impl.register'.length);
    return `${registerName(node)}${rest}`;
  }
  if (node.type === 'task') return capturedVar(model, node, output);
  // A subflow output lifted from an inner step (AFD-7), named by from or by the same name (AFD-21),
  // is that step's variable.
  if (node.type === 'subflow') {
    const lift = liftOf(node, output);
    if (lift && 'inner' in lift)
      return [outputVar(model, lift.inner, lift.output), ...lift.path].join('.');
  }
  return output;
}

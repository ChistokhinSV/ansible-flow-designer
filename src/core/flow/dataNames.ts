// Names of the host variables a flow's data lives in (ADR-0011): what a module step registers and
// which variable holds a node's output. The validator checks references against the same names the
// engine writes, without importing the engine (AFD-40).
import { liftOf } from './dataRefs';
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

/**
 * The host variable that holds a node's output: `from: impl.register[.path]` reads the registered
 * result, anything else (roles, set_fact stubs) is a fact of the output's own name.
 */
export function outputVar(node: FlowNode, output: string): string {
  const from = node.outputs?.[output]?.from;
  if (node.impl?.kind === 'module' && from?.startsWith('impl.register')) {
    const rest = from.slice('impl.register'.length);
    return `${registerName(node)}${rest}`;
  }
  // A subflow output lifted from an inner step (AFD-7), named by from or by the same name (AFD-21),
  // is that step's variable.
  if (node.type === 'subflow') {
    const lift = liftOf(node, output);
    if (lift && 'inner' in lift)
      return [outputVar(lift.inner, lift.output), ...lift.path].join('.');
  }
  return output;
}

// What a bound node runs and how data reaches it (M5, ADR-0011): the module task or include_role
// Option A emits, the play vars that pass upstream outputs in as node inputs, and set_fact
// placeholders that let an unbound node's outputs flow through a skeleton run.
import { type FlowModel, keyScope } from '../flow/model';
import type { ContractType, FlowNode, ImplBinding } from '../flow/types';
import { groupPart } from './util';
import { flow, type Out, type OutMap, writeBlock } from './yamlWriter';

/** include_role options; every other role param becomes a role var. */
export const INCLUDE_OPTIONS = new Set([
  'tasks_from',
  'vars_from',
  'defaults_from',
  'handlers_from',
  'public',
  'allow_duplicates',
  'rolespec_validate',
]);

/** The variable a module node registers its result in. */
export function registerName(
  node: FlowNode,
  impl: ImplBinding | null | undefined = node.impl,
): string {
  return impl?.register || `${groupPart(node.key)}_result`;
}

function oneLine(text: string): string {
  return text.replaceAll(/\s+/g, ' ').trim();
}

/** The module task or include_role of a bound node (without Option A's routing around it). */
export function bindingTask(node: FlowNode, impl: ImplBinding, timeout?: number): OutMap {
  const tag = `node_${node.id}`;
  if (impl.kind === 'role') {
    const options: OutMap = { name: impl.ref };
    const roleVars: OutMap = {};
    for (const [k, v] of Object.entries(impl.params ?? {}))
      (INCLUDE_OPTIONS.has(k) ? options : roleVars)[k] = v as Out;
    options.apply = { tags: flow([tag]), timeout };
    return {
      name: `[${node.key}] Apply role`,
      'ansible.builtin.include_role': options,
      vars: Object.keys(roleVars).length > 0 ? roleVars : undefined,
    };
  }
  const reg = registerName(node, impl);
  const retries = node.settings?.retries;
  return {
    name: `[${node.key}] ${oneLine(node.title)}`,
    [impl.ref]: (impl.params ?? {}) as Out,
    register: reg,
    ignore_unreachable: true,
    timeout,
    retries,
    until: retries ? `${reg} is succeeded` : undefined,
  };
}

/** The generated task as text, for the properties view ("Generated task", mockup 11). */
export function bindingTaskText(node: FlowNode, impl: ImplBinding): string {
  if (impl.kind === 'playbook')
    return writeBlock(
      [{ import_playbook: impl.ref, vars: { afd_hosts: '<hosts arriving here>' } }],
      0,
    ).join('\n');
  const task = bindingTask(node, impl);
  if (impl.kind === 'module') {
    // The preview shows what the user configured; Option A adds ignore_unreachable for routing.
    delete task.ignore_unreachable;
    task.tags = flow([`node_${node.id}`]);
  }
  return writeBlock([task], 0).join('\n');
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
  return output;
}

/**
 * Play vars for a node's inputs (05 §4): `from: <key>.<output>[.path]` reads the upstream node's
 * output variable (hostvars persist across plays and imported levels in one run), `from:
 * flow.<input>` reads the extra var. Same-name references need no var (and `x: "{{ x }}"` would
 * recurse).
 */
export function inputVars(model: FlowModel, level: string, node: FlowNode): OutMap {
  const vars: OutMap = {};
  const scope = keyScope(model, level);
  for (const [name, field] of Object.entries(node.inputs ?? {})) {
    const from = field?.from?.trim();
    if (!from) continue;
    const [head, output, ...path] = from.split('.');
    let expr: string | undefined;
    if (head === 'flow' && output) expr = [output, ...path].join('.');
    else if (head && output) {
      const upstream = model.nodes.get(scope.get(head) ?? '')?.node;
      if (upstream) expr = [outputVar(upstream, output), ...path].join('.');
    }
    if (expr && expr !== name) vars[name] = `{{ ${expr} }}`;
  }
  return vars;
}

const PLACEHOLDER: Record<ContractType, Out> = {
  string: 'TODO',
  integer: 0,
  boolean: false,
  list: [],
  dict: {},
  host_list: [],
  any: 'TODO',
};

/** set_fact placeholders for the outputs of an unbound node, so downstream inputs resolve. */
export function stubFacts(node: FlowNode): OutMap | undefined {
  const outputs = Object.entries(node.outputs ?? {});
  if (outputs.length === 0) return undefined;
  const facts: OutMap = {};
  for (const [name, field] of outputs) {
    const value = field?.default ?? PLACEHOLDER[field?.type ?? 'any'] ?? 'TODO';
    facts[name] = value as Out;
  }
  return { name: `[${node.key}] TODO outputs`, 'ansible.builtin.set_fact': facts };
}

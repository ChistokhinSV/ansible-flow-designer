// What a bound node runs and how data reaches it (M5, ADR-0011): the module task or include_role
// Option A emits, the play vars that pass upstream outputs in as node inputs, and set_fact
// placeholders that let an unbound node's outputs flow through a skeleton run.

import { outputVar, registerName } from '../flow/dataNames';
import { resolveFrom } from '../flow/dataRefs';
import { ROLE_TASK_KEYWORDS, WITH } from '../flow/keywords';
import type { FlowModel } from '../flow/model';
import type { ContractType, FlowNode, ImplBinding } from '../flow/types';
import { jinjaLiteral } from './util';
import { flow, type Out, type OutMap, oneLine, writeBlock } from './yamlWriter';

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

/** The module task or include_role of a bound node (without Option A's routing around it). */
export function bindingTask(node: FlowNode, impl: ImplBinding, timeout?: number | string): OutMap {
  const tag = `node_${node.id}`;
  const keywords = Object.entries(impl.keywords ?? {});
  if (impl.kind === 'role') {
    const options: OutMap = { name: impl.ref };
    const roleVars: OutMap = {};
    for (const [k, v] of Object.entries(impl.params ?? {}))
      (INCLUDE_OPTIONS.has(k) ? options : roleVars)[k] = v as Out;
    // Task keywords (AFD-26): conditions and loops stay on include_role; the rest reach every task
    // of the role through apply, as a static roles: entry would. Role variables live in params.
    const onTask: OutMap = {};
    const applied: OutMap = {};
    for (const [k, v] of keywords) {
      if (k === 'vars') continue;
      (ROLE_TASK_KEYWORDS.has(k) || WITH.test(k) ? onTask : applied)[k] = v as Out;
    }
    options.apply = { tags: flow([tag]), timeout, ...applied };
    return {
      name: `[${node.key}] Apply role`,
      'ansible.builtin.include_role': options,
      ...onTask,
      vars: Object.keys(roleVars).length > 0 ? roleVars : undefined,
    };
  }
  const reg = registerName(node, impl);
  const { retries, delay, until } = node.settings ?? {};
  // A polling step stops when `until` holds (AFD-21); plain retries stop on the first success.
  const condition = until?.trim() || (retries ? `${reg} is succeeded` : undefined);
  return {
    name: `[${node.key}] ${jinjaLiteral(oneLine(node.title))}`,
    [impl.ref]: (impl.params ?? {}) as Out,
    ...(Object.fromEntries(keywords) as OutMap),
    register: reg,
    ignore_unreachable: true,
    timeout,
    retries,
    delay: condition ? delay : undefined,
    until: condition,
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
 * The expression a `from:` reads, and whether it is a host variable of the producing host (an
 * output) rather than an extra var. Inside a subflow, `<subflow>.<input>` follows the subflow's
 * input to where it comes from (AFD-21); an input without `from` is read by its own name.
 */
export function sourceExpr(
  model: FlowModel,
  node: FlowNode,
  level: string,
  from: string,
  depth = 0,
): { expr: string; host: boolean } | undefined {
  const src = resolveFrom(model, node, level, 'inputs', from);
  switch (src.kind) {
    case 'flow':
      return { expr: [src.name, ...src.path].join('.'), host: false };
    case 'output':
      return src.name
        ? { expr: [outputVar(model, src.node, src.name), ...src.path].join('.'), host: true }
        : undefined;
    case 'subflowInput': {
      const up = src.field.from?.trim();
      const at = model.nodes.get(src.node.id)?.level;
      const inner =
        up && at && depth < 16 ? sourceExpr(model, src.node, at, up, depth + 1) : undefined;
      if (!inner) return { expr: [src.name, ...src.path].join('.'), host: false };
      return { expr: [inner.expr, ...src.path].join('.'), host: inner.host };
    }
    case 'unresolved': {
      // The validator reports it; the code reads the name, as it did before AFD-21.
      const [head, name = '', ...path] = from.split('.');
      if (src.target && name)
        return { expr: [outputVar(model, src.target, name), ...path].join('.'), host: true };
      return head === 'flow' && name ? { expr: [name, ...path].join('.'), host: false } : undefined;
    }
    default:
      return undefined;
  }
}

/**
 * Play vars for a node's inputs (05 §4): `from: <key>.<output>[.path]` reads the upstream node's
 * output variable (hostvars persist across plays and imported levels in one run), `from:
 * flow.<input>` reads the extra var. Same-name references need no var (and `x: "{{ x }}"` would
 * recurse). `via` reads upstream outputs from another host's hostvars: a node that runs on its
 * inventory_target reads them from the first arriving host (AFD-14).
 */
export function inputVars(model: FlowModel, level: string, node: FlowNode, via?: string): OutMap {
  const vars: OutMap = {};
  for (const [name, field] of Object.entries(node.inputs ?? {})) {
    const from = field?.from?.trim();
    if (!from) continue;
    const src = sourceExpr(model, node, level, from);
    const expr = src && (src.host && via ? `${via}.${src.expr}` : src.expr);
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

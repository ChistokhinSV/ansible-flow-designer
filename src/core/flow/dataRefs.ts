// Where a `from:` reference reads (AFD-21): a flow input, an upstream node's output (a subflow's
// output lifted from an inner step), or, inside a subflow, that subflow's own input. One resolver
// for the validator, the generator, the data lens and the AI tools.
import { predecessors } from './adjacency';
import { type FlowModel, keyScope, ROOT } from './model';
import type { ContractField, FlowNode, Ulid } from './types';

export type Source =
  | { kind: 'flow'; name: string; path: string[] }
  | { kind: 'impl'; path: string[] }
  /** An output of a node that runs before (any level the reader can see). */
  | { kind: 'output'; node: FlowNode; name: string; path: string[] }
  /** Inside a subflow, `<that subflow>.<name>` is the subflow's input. */
  | { kind: 'subflowInput'; node: FlowNode; name: string; field: ContractField; path: string[] }
  /** `target`: the node the key names when only the output is missing. */
  | { kind: 'unresolved'; why: string; target?: FlowNode };

/** The subflows that enclose a level, innermost first (the level itself when it is a subflow). */
export function enclosing(model: FlowModel, levelId: string): FlowNode[] {
  const out: FlowNode[] = [];
  let at: string | undefined = levelId;
  while (at && at !== ROOT) {
    const entry = model.nodes.get(at);
    if (!entry) break;
    out.push(entry.node);
    at = entry.level;
  }
  return out;
}

/**
 * The inner step a subflow output reads: the one `from` names, else the only inner step with an
 * output of the same name (AFD-21). `ambiguous` lists the steps when several have it.
 */
export function liftOf(
  node: FlowNode,
  output: string,
): { inner: FlowNode; output: string; path: string[] } | { ambiguous: string[] } | undefined {
  const inner = (node.subflow?.nodes ?? []).filter((n): n is FlowNode => !!n?.key);
  const from = node.outputs?.[output]?.from;
  if (from) {
    const [head, out, ...path] = from.split('.');
    const step = inner.find((n) => n.key === head);
    return step && out ? { inner: step, output: out, path } : undefined;
  }
  if (!node.outputs || !(output in node.outputs)) return undefined;
  const same = inner.filter((n) => n.outputs && output in n.outputs);
  if (same.length === 1) return { inner: same[0] as FlowNode, output, path: [] };
  return same.length > 1 ? { ambiguous: same.map((n) => n.key) } : undefined;
}

function names(contract: Record<string, unknown> | undefined): string {
  const all = Object.keys(contract ?? {});
  return all.length ? ` (it has ${all.join(', ')})` : ' (it has none)';
}

/**
 * The level a `from` on `node`'s `side` resolves against: a subflow's outputs read its inner
 * level (AFD-7), everything else the node's own level. AFD-142: the commands that rewrite
 * references (renames, extract) ask this too, so they rewrite exactly what resolveFrom reads.
 */
export function readerLevel(
  model: FlowModel,
  node: FlowNode,
  level: string,
  side: 'inputs' | 'outputs',
): string {
  return side === 'outputs' && model.levels.has(node.id) ? node.id : level;
}

/**
 * Resolves `from` as read by `node` on `level`. A subflow's outputs read its inner level (AFD-7),
 * so they resolve against that level.
 */
export function resolveFrom(
  model: FlowModel,
  node: FlowNode,
  level: string,
  side: 'inputs' | 'outputs',
  from: string,
): Source {
  const [head = '', name = '', ...path] = from.trim().split('.');
  if (head === 'flow') {
    if (name in (model.doc.flow?.inputs ?? {})) return { kind: 'flow', name, path };
    return { kind: 'unresolved', why: `the flow has no input ${name}` };
  }
  if (head === 'impl') return { kind: 'impl', path: [name, ...path].filter(Boolean) };
  if (head.includes('/')) {
    const [sub = '', ...inner] = head.split('/');
    return {
      kind: 'unresolved',
      why: `reads a step inside subflow ${sub}; from outside, read what ${sub} lifts: give ${sub} an output ${name} (from: ${inner.join('/')}.${name}) and read ${sub}.${name} (the AI tools and the @ picker lift it for you)`,
    };
  }
  const at = readerLevel(model, node, level, side);
  const id = keyScope(model, at).get(head);
  const target = id ? model.nodes.get(id)?.node : undefined;
  if (!target) return { kind: 'unresolved', why: `no node "${head}" on this level or around it` };
  if (enclosing(model, at).some((s) => s.id === target.id)) {
    const field = target.inputs?.[name];
    if (field) return { kind: 'subflowInput', node: target, name, field, path };
    return {
      kind: 'unresolved',
      why: `inside subflow ${head}, ${head}.<name> reads its input, and it has no input ${name}${names(target.inputs)}`,
    };
  }
  if (!name) return { kind: 'output', node: target, name, path };
  if (target.outputs && name in target.outputs) return { kind: 'output', node: target, name, path };
  const inner = (target.subflow?.nodes ?? []).find((n) => n?.outputs && name in n.outputs);
  if (target.type === 'subflow' && inner)
    return {
      kind: 'unresolved',
      target,
      why: `${head} does not lift ${name}; its step ${inner.key} has it: give ${head} an output ${name} (from: ${inner.key}.${name}), or pass the path ${head}/${inner.key}.${name} to the AI tools, which lift it`,
    };
  return {
    kind: 'unresolved',
    target,
    why: `${head} has no output ${name}${names(target.outputs)}`,
  };
}

/** Nodes whose hosts reach this one: earlier on its level, then before each enclosing subflow. */
export function upstreamNodes(model: FlowModel, id: Ulid): FlowNode[] {
  const out: FlowNode[] = [];
  let entry = model.nodes.get(id);
  while (entry) {
    const level = model.levels.get(entry.level);
    if (!level) break;
    const seen = new Set([entry.node.id]);
    const queue = [entry.node.id];
    // AFD-162: wires by node, built once per level (every wire per visited node before).
    for (let i = 0; i < queue.length; i++)
      for (const from of predecessors(level.edges, queue[i] as Ulid)) {
        if (seen.has(from)) continue;
        seen.add(from);
        queue.push(from);
        const n = model.nodes.get(from)?.node;
        if (n && n.type !== 'start') out.push(n);
      }
    entry = level.parent ? model.nodes.get(level.parent) : undefined;
  }
  return out;
}

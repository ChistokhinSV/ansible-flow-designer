// AFD-309: a flow's outputs, what a run gives back to whoever launched it (Ansible Flow Server's
// collection, a calling flow): name -> a top-level step's output, `from: <key>.<output>[.path]`.
// Each host that has the value at the end of the run gives it; the run records them per host.
import { outputVar } from './dataNames';
import { type FlowModel, ROOT } from './model';
import type { FlowNode } from './types';

/** The step and output a flow output reads, or why it reads none. */
export type FlowOutputSource =
  | { node: FlowNode; output: string; path: string[] }
  | { problem: string };

export function resolveFlowOutput(model: FlowModel, from: string | undefined): FlowOutputSource {
  const text = (from ?? '').trim();
  if (!text) return { problem: 'says no `from:`: name a step and its output (<step>.<output>)' };
  const [key = '', output, ...path] = text.split('.');
  if (!output) return { problem: `reads "${text}": name a step and its output (<step>.<output>)` };
  const node = model.levels
    .get(ROOT)
    ?.nodes.find((n): n is FlowNode => !!n && n.key === key && n.type !== 'start');
  if (!node) return { problem: `reads ${text}: there is no top-level step ${key}` };
  if (!node.outputs || !(output in node.outputs))
    return { problem: `reads ${text}: ${node.title} has no output ${output}` };
  return { node, output, path };
}

/** The Jinja expression of a flow output on a host (undefined when it reads nothing). */
export function flowOutputExpr(model: FlowModel, from: string | undefined): string | undefined {
  const src = resolveFlowOutput(model, from);
  if ('problem' in src) return undefined;
  return [outputVar(model, src.node, src.output), ...src.path].join('.');
}

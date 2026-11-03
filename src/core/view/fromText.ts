// A `from:` reference in words (AFD-72): where a step's value comes from, as a newcomer reads it.
// The raw reference stays in the tooltip.
import { resolveFrom } from '../flow/dataRefs';
import type { FlowModel } from '../flow/model';
import type { FlowNode } from '../flow/types';

export function fromText(
  model: FlowModel,
  node: FlowNode,
  side: 'inputs' | 'outputs',
  from: string,
): string {
  const entry = model.nodes.get(node.id);
  if (!entry) return from;
  const src = resolveFrom(model, node, entry.level, side, from);
  const rest = (path: readonly string[]) => (path.length ? ` · ${path.join('.')}` : '');
  switch (src.kind) {
    case 'flow':
      return `flow input ${src.name}${rest(src.path)}`;
    case 'impl':
      // impl.register[.x]: what the step's module or role returned.
      return `this step's result${rest(src.path[0] === 'register' ? src.path.slice(1) : src.path)}`;
    case 'output':
    case 'subflowInput':
      return `"${src.node.title}" · ${src.name}${rest(src.path)}`;
    case 'unresolved':
      return from;
  }
}

// AFD-240: a flow as an outline, for VS Code's Outline view and breadcrumbs when the flow is open
// as text: its nodes in file order, a subflow holding its inner nodes. And the reverse lookup: the
// node whose YAML holds a text position, so a symbol or a problem chosen there can be shown on the
// canvas.
import { elementRangeOf } from '../flow/document';
import type { FlowModel } from '../flow/model';
import type { FlowNode, Ulid } from '../flow/types';
import type { YamlFile } from '../yaml/parse';

export interface OutlineItem {
  id: Ulid;
  name: string;
  /** Type, and status where a node has one. */
  detail: string;
  subflow: boolean;
  /** The node's whole element in the text. */
  range: [number, number];
  children: OutlineItem[];
}

function item(file: YamlFile, model: FlowModel, node: FlowNode): OutlineItem | undefined {
  const entry = model.nodes.get(node.id);
  if (!entry) return undefined;
  const status = node.type === 'start' || node.type === 'end' ? '' : ` · ${node.status ?? 'draft'}`;
  return {
    id: node.id,
    name: node.title || node.key,
    detail: `${node.type}${status}`,
    subflow: node.type === 'subflow',
    range: elementRangeOf(file, entry.path),
    children: itemsOf(file, model, node.subflow?.nodes ?? []),
  };
}

function itemsOf(file: YamlFile, model: FlowModel, nodes: readonly (FlowNode | null)[]) {
  return nodes
    .filter((n): n is FlowNode => !!n?.id)
    .map((n) => item(file, model, n))
    .filter((i): i is OutlineItem => !!i);
}

export function flowOutline(file: YamlFile, model: FlowModel): OutlineItem[] {
  return itemsOf(file, model, model.doc.nodes ?? []);
}

/** The innermost node whose element holds the offset. */
export function nodeAtOffset(outline: readonly OutlineItem[], offset: number): Ulid | undefined {
  for (const i of outline) {
    if (offset < i.range[0] || offset > i.range[1]) continue;
    return nodeAtOffset(i.children, offset) ?? i.id;
  }
  return undefined;
}

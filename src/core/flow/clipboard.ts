// Nodes on the clipboard (AFD-17): copied as readable YAML in the shape of a flow document, so a
// snippet kept in a text file stays understandable and pastes back. Paste also takes a plain list
// of nodes or a single node written by hand.
import { parse } from 'yaml';
import { renderBlock, type YamlValue } from '../yaml/render';
import { annotationValue } from './annotations';
import { withIds } from './completeIds';
import { acceptedOf } from './decisions';
import { buildModel } from './model';
import {
  type Annotation,
  type Decision,
  type Edge,
  type FlowDocument,
  type FlowNode,
  type Layout,
  NODE_TYPES,
  type Position,
  type Ulid,
} from './types';
import { descendantIds } from './walk';

export const CLIP_HEADER = '# Ansible Flow Designer nodes: paste them on a flow canvas (Ctrl+V)';

export interface Clip {
  nodes: FlowNode[];
  edges: Edge[];
  /** AFD-64: the Notes on the copied nodes and the annotations picked with them. */
  annotations: Annotation[];
  layout: Layout;
  decisions: Decision[];
}

/**
 * The selected nodes of one level as clipboard text: the nodes (with their inner levels), the
 * wires between them, their positions and their open-on-purpose decisions. `shown` adds the
 * positions the canvas shows for nodes the layout block does not place yet (auto layout).
 * AFD-64: the Notes on the copied nodes come along, and the annotations in `annotationIds`.
 */
export function copyNodes(
  doc: FlowDocument,
  ids: readonly Ulid[],
  shown: Readonly<Record<Ulid, Position>> = {},
  annotationIds: readonly Ulid[] = [],
): string {
  const model = buildModel(doc);
  const first = [
    ...ids.map((id) => model.nodes.get(id)),
    ...annotationIds.map((id) => model.annotations.get(id)),
  ].find(Boolean);
  const level = first ? model.levels.get(first.level) : undefined;
  if (!level) return '';
  const picked = new Set(ids);
  const pickedAnnotations = new Set(annotationIds);
  const nodes = level.nodes.filter((n) => n && picked.has(n.id));
  const annotations = level.annotations.filter(
    (a) => a && (pickedAnnotations.has(a.id) || (a.on !== undefined && picked.has(a.on))),
  );
  const edges = level.edges.filter((e) => picked.has(e?.from?.node) && picked.has(e?.to?.node));
  const all = new Set(nodes.flatMap((n) => [n.id, ...descendantIds(n)]));
  const layout = Object.fromEntries(
    Object.entries({ ...shown, ...doc.layout }).filter(([id]) => all.has(id)),
  );
  // The ports left open on purpose, in either format (AFD-51).
  const decisions = (doc.decisions ?? []).filter((d, i) => {
    const a = acceptedOf(d, i);
    return a?.area === 'port' && !!a.node && all.has(a.node);
  });
  const value: Record<string, unknown> = { nodes };
  if (edges.length > 0) value.edges = edges;
  if (annotations.length > 0) value.annotations = annotations.map(annotationValue);
  if (Object.keys(layout).length > 0) value.layout = layout;
  if (decisions.length > 0) value.decisions = decisions;
  const lines = renderBlock(value as YamlValue, 0, {
    eol: '\n',
    indentUnit: 2,
    seqIndentless: true,
  });
  return `${CLIP_HEADER}\n${lines.join('\n')}\n`;
}

const isAnnotation = (v: unknown): v is Annotation =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  typeof (v as Annotation).text === 'string' &&
  Number.isFinite((v as Annotation).x) &&
  Number.isFinite((v as Annotation).y);

const isNode = (v: unknown): v is FlowNode =>
  !!v &&
  typeof v === 'object' &&
  !Array.isArray(v) &&
  (NODE_TYPES as readonly string[]).includes((v as FlowNode).type) &&
  (typeof (v as FlowNode).key === 'string' || typeof (v as FlowNode).title === 'string');

/** Clipboard text → nodes, or why it is not nodes. */
export function parseClip(text: string): Clip | string {
  let data: unknown;
  try {
    data = parse(text);
  } catch {
    return 'The clipboard does not hold flow nodes (it is not YAML)';
  }
  const obj: Record<string, unknown> =
    data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {};
  const nodes = Array.isArray(data)
    ? data
    : Array.isArray(obj.nodes)
      ? (obj.nodes as unknown[])
      : isNode(data)
        ? [data]
        : undefined;
  const annotations = (Array.isArray(obj.annotations) ? (obj.annotations as unknown[]) : []).filter(
    isAnnotation,
  );
  // A clip of annotations only (AFD-64) has no nodes, or an empty list of them.
  const none = !nodes || nodes.length === 0;
  if ((none && annotations.length === 0) || (!none && !nodes.every(isNode)))
    return 'The clipboard does not hold flow nodes: copy nodes from a flow, or a nodes: list';
  const edges = (Array.isArray(obj.edges) ? (obj.edges as Edge[]) : []).filter(
    (e) => e?.from?.node && e.to?.node && e.from.port && e.to.port,
  );
  const layout =
    obj.layout && typeof obj.layout === 'object' && !Array.isArray(obj.layout)
      ? (obj.layout as Layout)
      : {};
  const decisions = Array.isArray(obj.decisions) ? (obj.decisions as Decision[]) : [];
  // A snippet written by hand may leave IDs out and wire nodes by key (AFD-19): fill the gaps, so
  // its wires paste with it (paste gives every node and wire a new ID anyway).
  const filled = withIds({
    nodes: nodes ?? [],
    edges,
    annotations,
    layout,
    decisions,
  } as unknown as FlowDocument);
  return {
    nodes: filled.nodes,
    edges: filled.edges,
    annotations: filled.annotations ?? [],
    layout: filled.layout ?? {},
    decisions: filled.decisions ?? [],
  };
}

/** Whether text looks like nodes to paste (cheap check before asking the host). */
export function looksLikeNodes(text: string): boolean {
  return typeof parseClip(text) !== 'string';
}

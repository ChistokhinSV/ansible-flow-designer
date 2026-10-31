// Flow document → indexed model: every node and edge with its level and YAML path.
import type { Path } from '../yaml/parse';
import type { Edge, FlowDocument, FlowNode, Ulid } from './types';

/** Level id of the top level; subflow levels use their subflow node's id. */
export const ROOT = 'root';

export interface Level {
  id: string;
  /** Subflow node owning this level (undefined for the top level). */
  parent?: Ulid;
  nodesPath: Path;
  edgesPath: Path;
  nodes: FlowNode[];
  edges: Edge[];
}

export interface NodeEntry {
  node: FlowNode;
  level: string;
  path: Path;
}

export interface EdgeEntry {
  edge: Edge;
  level: string;
  path: Path;
}

export interface FlowModel {
  doc: FlowDocument;
  levels: Map<string, Level>;
  nodes: Map<Ulid, NodeEntry>;
  edges: Map<Ulid, EdgeEntry>;
}

/** How often a model was built: the UX baseline counts builds per snapshot (AFD-33). */
export const modelStats = { builds: 0 };

const models = new WeakMap<FlowDocument, FlowModel>();

/**
 * The model of a document that nobody changes any more, built once (AFD-34): the webview's
 * snapshot, and the views derived from it. Code that edits a document builds its own model.
 */
export function modelOf(doc: FlowDocument): FlowModel {
  let model = models.get(doc);
  if (!model) {
    model = buildModel(doc);
    models.set(doc, model);
  }
  return model;
}

export function buildModel(doc: FlowDocument): FlowModel {
  modelStats.builds++;
  const model: FlowModel = { doc, levels: new Map(), nodes: new Map(), edges: new Map() };
  addLevel(model, ROOT, undefined, [], doc.nodes ?? [], doc.edges ?? []);
  return model;
}

function addLevel(
  model: FlowModel,
  id: string,
  parent: Ulid | undefined,
  base: Path,
  nodes: FlowNode[],
  edges: Edge[],
): void {
  const nodesPath = [...base, 'nodes'];
  const edgesPath = [...base, 'edges'];
  model.levels.set(id, { id, parent, nodesPath, edgesPath, nodes, edges });
  nodes.forEach((node, i) => {
    if (!node || typeof node !== 'object') return;
    const path = [...nodesPath, i];
    // Nodes without an ID (written by hand, AFD-19) stay in the level but are not indexed.
    if (typeof node.id !== 'string') return;
    // First occurrence wins; duplicates are reported by the validator.
    if (!model.nodes.has(node.id)) model.nodes.set(node.id, { node, level: id, path });
    if (node.subflow && typeof node.subflow === 'object') {
      addLevel(
        model,
        node.id,
        node.id,
        [...path, 'subflow'],
        node.subflow.nodes ?? [],
        node.subflow.edges ?? [],
      );
    }
  });
  edges.forEach((edge, i) => {
    if (!edge || typeof edge !== 'object' || typeof edge.id !== 'string') return;
    if (!model.edges.has(edge.id))
      model.edges.set(edge.id, { edge, level: id, path: [...edgesPath, i] });
  });
}

/** Keys visible from a level: its own nodes' keys, then those of enclosing levels. */
export function keyScope(model: FlowModel, levelId: string): Map<string, Ulid> {
  const scope = new Map<string, Ulid>();
  let level = model.levels.get(levelId);
  while (level) {
    for (const n of level.nodes) if (n && !scope.has(n.key)) scope.set(n.key, n.id);
    level = level.parent ? model.levels.get(model.nodes.get(level.parent)?.level ?? '') : undefined;
  }
  return scope;
}

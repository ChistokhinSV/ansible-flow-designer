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

export function buildModel(doc: FlowDocument): FlowModel {
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
    if (!edge || typeof edge !== 'object') return;
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

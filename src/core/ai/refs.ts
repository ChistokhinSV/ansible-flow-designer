// Nodes and ports named by key for AI tools (AFD-19): `check-ntp`, `fix-ntp/push` (a step inside a
// subflow), `check-ntp.failed_hosts`. IDs never appear in what tools take or say.
import { type FlowModel, ROOT } from '../flow/model';
import { defaultPortNames, legalPorts, optionalPortNames } from '../flow/ports';
import type { FlowNode, Ulid } from '../flow/types';

export class RefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RefError';
  }
}

export interface ResolvedNode {
  id: Ulid;
  node: FlowNode;
  /** Level id: `root` or the subflow node's id. */
  level: string;
  /** `key`, or `sub/inner` inside subflows. */
  path: string;
}

/** Key path of a node: its key, prefixed by the keys of the subflows that hold it. */
export function keyPath(model: FlowModel, id: Ulid): string {
  const parts: string[] = [];
  let entry = model.nodes.get(id);
  while (entry) {
    parts.unshift(entry.node.key);
    const level = model.levels.get(entry.level);
    entry = level?.parent ? model.nodes.get(level.parent) : undefined;
  }
  return parts.join('/');
}

/** Name of a level for messages: "the top level" or "subflow fix-ntp". */
export function levelName(model: FlowModel, level: string): string {
  return level === ROOT ? 'the top level' : `subflow ${keyPath(model, level)}`;
}

function distance(a: string, b: string): number {
  const d = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = d[0] as number;
    d[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cur = d[j] as number;
      d[j] = Math.min(cur + 1, (d[j - 1] as number) + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return d[b.length] as number;
}

/** Every node with its key path. */
function allNodes(model: FlowModel): ResolvedNode[] {
  return [...model.nodes.values()].map((e) => ({
    id: e.node.id,
    node: e.node,
    level: e.level,
    path: keyPath(model, e.node.id),
  }));
}

/**
 * A node by key path. A bare key is looked up on `context` (a level id) first, then over the whole
 * flow; it must be unique there. Unknown keys get the nearest keys as suggestions.
 */
export function resolveNode(model: FlowModel, ref: string, context?: string): ResolvedNode {
  const all = allNodes(model);
  const wanted = ref.trim();
  if (wanted.includes('/')) {
    const hit = all.find((n) => n.path === wanted);
    if (hit) return hit;
  } else {
    const local = context ? all.filter((n) => n.level === context && n.node.key === wanted) : [];
    if (local.length === 1) return local[0] as ResolvedNode;
    const any = all.filter((n) => n.node.key === wanted);
    if (any.length === 1) return any[0] as ResolvedNode;
    if (any.length > 1)
      throw new RefError(
        `"${wanted}" names ${any.length} nodes: ${any.map((n) => n.path).join(', ')}. Use the full path`,
      );
  }
  const near = all
    .map((n) => ({ n, d: distance(n.path, wanted) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 3)
    .filter((x) => x.d <= Math.max(3, wanted.length / 2))
    .map((x) => x.n.path);
  const top = all.filter((n) => n.level === ROOT).map((n) => n.path);
  throw new RefError(
    `No node "${wanted}"${near.length ? `; did you mean ${near.join(' or ')}?` : ''} Nodes on the top level: ${top.join(', ')}`,
  );
}

/** Ports a node type has: its defaults and the optional ones it may enable. */
export function portsText(node: FlowNode): string {
  const optional = optionalPortNames(node.type);
  return `${node.type} ports: ${defaultPortNames(node).join(', ')}${optional.length ? `; optional (enable_port first): ${optional.join(', ')}` : ''}`;
}

/**
 * A port by `node.port` (or a bare node with `defaultPort`, e.g. `in` for wire targets). The port
 * must exist on the node's type; it may still need enabling.
 */
export function resolvePort(
  model: FlowModel,
  ref: string,
  context?: string,
  defaultPort?: string,
): { node: ResolvedNode; port: string } {
  const dot = ref.lastIndexOf('.');
  const nodeRef = dot === -1 ? ref : ref.slice(0, dot);
  const port = dot === -1 ? defaultPort : ref.slice(dot + 1);
  const node = resolveNode(model, nodeRef, context);
  if (!port)
    throw new RefError(
      `"${ref}" names no port: write ${node.path}.<port> (${portsText(node.node)})`,
    );
  if (!legalPorts(node.node).some((p) => p.name === port))
    throw new RefError(`${node.path} has no port "${port}" (${portsText(node.node)})`);
  return { node, port };
}

/** IDs in a message replaced by key paths, so tool output never shows IDs. */
export function withoutIds(model: FlowModel, text: string): string {
  return text.replace(/[0-9A-HJKMNP-TV-Z]{26}/g, (id) => {
    if (model.nodes.has(id)) return keyPath(model, id);
    const edge = model.edges.get(id)?.edge;
    if (edge)
      return `wire ${keyPath(model, edge.from.node)}.${edge.from.port} -> ${keyPath(model, edge.to.node)}`;
    return id === model.doc.flow?.id ? 'the flow' : 'an unknown node';
  });
}

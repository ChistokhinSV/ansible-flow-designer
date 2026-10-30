// Flows written by hand, by a person or an AI, may leave IDs out and name nodes by key (AFD-19).
// `idGaps` lists what is missing; `withIds` fills it in for checks and the canvas, with IDs derived
// from the keys so they stay put while the text changes; `completeIds` writes real IDs in one
// byte-preserving edit (the "Complete IDs" quick fix). One analysis serves all three.
import { renameKey, setIn } from '../yaml/ops';
import type { Path } from '../yaml/parse';
import { YamlTransaction } from '../yaml/transaction';
import type { IdFactory } from './ids';
import type { Edge, FlowDocument, FlowNode, SubflowBody } from './types';

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const isId = (v: unknown): v is string => typeof v === 'string' && ULID.test(v);
const isKey = (v: unknown): v is string => typeof v === 'string' && v !== '' && !isId(v);

export interface IdGap {
  kind: 'flow' | 'node' | 'wire' | 'ref' | 'layout';
  /** YAML path of the node, wire or reference. */
  path: Path;
  /** Worded with keys, never IDs. */
  message: string;
  /** Complete IDs cannot fill it: the key is unknown or on several levels. */
  unresolved?: boolean;
}

type Fix =
  | { op: 'id'; of: 'flow' | 'node' | 'wire'; path: Path; id: string; before: string[] }
  | { op: 'set'; path: Path; id: string }
  | { op: 'rename'; mapPath: Path; key: string; id: string };

interface LevelInfo {
  label: string;
  nodesPath: Path;
  edgesPath: Path;
  nodes: FlowNode[];
  edges: Edge[];
  boundaryPath?: Path;
  boundary?: SubflowBody['boundary'];
}

function levelsOf(doc: FlowDocument): LevelInfo[] {
  const out: LevelInfo[] = [];
  const walk = (
    base: Path,
    label: string,
    nodes: unknown,
    edges: unknown,
    boundaryPath?: Path,
    boundary?: SubflowBody['boundary'],
  ) => {
    const list = Array.isArray(nodes) ? (nodes as FlowNode[]) : [];
    out.push({
      label,
      nodesPath: [...base, 'nodes'],
      edgesPath: [...base, 'edges'],
      nodes: list,
      edges: Array.isArray(edges) ? (edges as Edge[]) : [],
      boundaryPath,
      boundary,
    });
    list.forEach((n, i) => {
      if (!n || typeof n !== 'object' || !n.subflow || typeof n.subflow !== 'object') return;
      const p = [...base, 'nodes', i, 'subflow'];
      walk(
        p,
        `subflow ${n.key}`,
        n.subflow.nodes,
        n.subflow.edges,
        [...p, 'boundary'],
        n.subflow.boundary,
      );
    });
  };
  walk([], 'the top level', doc.nodes, doc.edges);
  return out;
}

/** What is missing, and how to fill it with the IDs `mint` gives (one per node or wire, in order). */
function analyse(
  doc: FlowDocument,
  mint: (seed: string) => string,
): { gaps: IdGap[]; fixes: Fix[] } {
  const gaps: IdGap[] = [];
  const fixes: Fix[] = [];
  const flow = doc.flow;
  if (flow && typeof flow === 'object' && !isId(flow.id)) {
    fixes.push({
      op: 'id',
      of: 'flow',
      path: ['flow', 'id'],
      id: mint('flow'),
      before: Object.keys(flow),
    });
    gaps.push({
      kind: 'flow',
      path: ['flow'],
      message: `Flow "${flow.key ?? flow.name ?? ''}" has no id`,
    });
  }
  const levels = levelsOf(doc);
  /** Key -> ID per level, and over the whole flow (null when a key is on several levels). */
  const local = new Map<LevelInfo, Map<string, string | null>>();
  const global = new Map<string, string | null>();
  for (const level of levels) {
    const keys = new Map<string, string | null>();
    level.nodes.forEach((n, i) => {
      if (!n || typeof n !== 'object') return;
      const path = [...level.nodesPath, i];
      let id = n.id;
      if (!isId(id)) {
        id = mint(`node|${path.join('.')}|${n.key ?? ''}`);
        fixes.push({ op: 'id', of: 'node', path: [...path, 'id'], id, before: Object.keys(n) });
        gaps.push({
          kind: 'node',
          path,
          message: `Node "${n.key ?? n.title ?? i}" on ${level.label} has no id`,
        });
      }
      if (typeof n.key === 'string') {
        keys.set(n.key, keys.has(n.key) ? null : id);
        global.set(n.key, global.has(n.key) ? null : id);
      }
    });
    local.set(level, keys);
  }

  const resolve = (keys: Map<string, string | null>, key: string, where: string, path: Path) => {
    const id = keys.get(key);
    if (id) return id;
    gaps.push({
      kind: 'ref',
      path,
      unresolved: true,
      message:
        id === null
          ? `Key "${key}" (${where}) is used by several nodes: name the node by its id`
          : `No node with key "${key}" (${where})`,
    });
    return undefined;
  };

  for (const level of levels) {
    const keys = local.get(level) ?? new Map();
    level.edges.forEach((e, i) => {
      if (!e || typeof e !== 'object') return;
      const path = [...level.edgesPath, i];
      const missing: string[] = [];
      if (!isId(e.id)) {
        const id = mint(`wire|${path.join('.')}`);
        fixes.push({ op: 'id', of: 'wire', path: [...path, 'id'], id, before: Object.keys(e) });
        missing.push('no id');
      }
      let byKey = false;
      for (const end of ['from', 'to'] as const) {
        const ref = e[end]?.node;
        if (!isKey(ref)) continue;
        const id = resolve(keys, ref, `wire ${end} on ${level.label}`, [...path, end, 'node']);
        if (id) {
          fixes.push({ op: 'set', path: [...path, end, 'node'], id });
          byKey = true;
        }
      }
      if (byKey) missing.push('names nodes by key');
      if (missing.length > 0)
        gaps.push({
          kind: 'wire',
          path,
          message: `Wire ${e.from?.node}.${e.from?.port} -> ${e.to?.node}.${e.to?.port} on ${level.label}: ${missing.join(', ')}`,
        });
    });
    const b = level.boundary;
    if (level.boundaryPath && b && typeof b === 'object') {
      if (isKey(b.in)) {
        const path = [...level.boundaryPath, 'in'];
        const id = resolve(keys, b.in, `entry of ${level.label}`, path);
        if (id) {
          fixes.push({ op: 'set', path, id });
          gaps.push({
            kind: 'ref',
            path,
            message: `The entry of ${level.label} names "${b.in}" by key`,
          });
        }
      }
      for (const [port, refs] of Object.entries(b.outputs ?? {}))
        (refs ?? []).forEach((r, i) => {
          if (!isKey(r?.node)) return;
          const path = [...(level.boundaryPath as Path), 'outputs', port, i, 'node'];
          const id = resolve(keys, r.node, `exit ${port} of ${level.label}`, path);
          if (id) {
            fixes.push({ op: 'set', path, id });
            gaps.push({
              kind: 'ref',
              path,
              message: `Exit ${port} of ${level.label} names "${r.node}" by key`,
            });
          }
        });
    }
  }

  (doc.decisions ?? []).forEach((d, i) => {
    if (!isKey(d?.node)) return;
    const path = ['decisions', i, 'node'];
    const id = resolve(global, d.node, `decision ${i + 1}`, path);
    if (id) {
      fixes.push({ op: 'set', path, id });
      gaps.push({ kind: 'ref', path, message: `Decision ${i + 1} names "${d.node}" by key` });
    }
  });

  for (const key of Object.keys(doc.layout ?? {})) {
    if (isId(key)) continue;
    const id = global.get(key);
    // An unknown key is an orphan position (reported as such); a known one is moved to its ID.
    if (!id || Object.hasOwn(doc.layout ?? {}, id)) continue;
    fixes.push({ op: 'rename', mapPath: ['layout'], key, id });
    gaps.push({
      kind: 'layout',
      path: ['layout', key],
      message: `Position of "${key}" is keyed by key`,
    });
  }
  return { gaps, fixes };
}

/** A ULID-shaped ID derived from a seed: the same seed gives the same ID (display only). */
function stableId(seed: string): string {
  const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < seed.length; i++) {
    h1 = Math.imul(h1 ^ seed.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ seed.charCodeAt(i), 0x5bd1e995) >>> 0;
  }
  let out = '0';
  for (let i = 0; i < 25; i++) {
    const h = i % 2 === 0 ? h1 : h2;
    out += ALPHABET[(h >>> ((i * 5) % 27)) & 31];
    if (i % 2 === 1) h1 = Math.imul(h1 ^ (h2 >>> 7), 0x01000193) >>> 0;
    else h2 = Math.imul(h2 ^ (h1 >>> 11), 0x5bd1e995) >>> 0;
  }
  return out;
}

/** What a flow written by hand still lacks: empty for a complete file. */
export function idGaps(doc: FlowDocument): IdGap[] {
  return analyse(doc, stableId).gaps;
}

function setPath(target: unknown, path: Path, value: unknown): void {
  let node = target as Record<string | number, unknown>;
  for (const step of path.slice(0, -1)) node = node[step] as Record<string | number, unknown>;
  node[path.at(-1) as string | number] = value;
}

/**
 * The flow with every gap filled for checks and the canvas: missing IDs derived from the keys (the
 * same on every parse) and keys resolved to them. The text is not changed.
 */
export function withIds(doc: FlowDocument): FlowDocument {
  const { fixes } = analyse(doc, stableId);
  if (fixes.length === 0) return doc;
  const copy = structuredClone(doc);
  for (const f of fixes) {
    if (f.op === 'rename') {
      const layout = copy.layout as Record<string, unknown>;
      layout[f.id] = layout[f.key];
      delete layout[f.key];
    } else setPath(copy, f.path, f.id);
  }
  return copy;
}

export interface CompleteResult {
  text: string;
  /** How many of each kind were filled. */
  filled: { nodes: number; wires: number; refs: number };
  /** Gaps Complete IDs could not fill (unknown or ambiguous keys). */
  unresolved: IdGap[];
}

/** Complete IDs: real IDs for every gap, keys replaced by them, in one edit of the text. */
export function completeIds(text: string, newId: IdFactory): CompleteResult {
  const tx = new YamlTransaction(text);
  const doc = tx.current.doc.toJS() as FlowDocument;
  const { gaps, fixes } = analyse(doc, () => newId());
  tx.applyAll(
    fixes.map((f) =>
      f.op === 'rename'
        ? (file) => renameKey(file, f.mapPath, f.key, f.id)
        : f.op === 'id'
          ? (file) => setIn(file, f.path, f.id, { before: f.before })
          : (file) => setIn(file, f.path, f.id),
    ),
  );
  const count = (f: (x: Fix) => boolean) => fixes.filter(f).length;
  return {
    text: tx.text,
    filled: {
      nodes: count((f) => f.op === 'id' && f.of === 'node'),
      wires: count((f) => f.op === 'id' && f.of === 'wire'),
      refs: count((f) => f.op !== 'id'),
    },
    unresolved: gaps.filter((g) => g.unresolved),
  };
}

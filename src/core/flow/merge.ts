// AFD-283: a three-way merge of a flow, by the nodes' IDs rather than the YAML's lines. Two people
// change one flow apart (two clones, a push through the server, a live session whose branch moved
// on); what they changed in different places comes together on its own, and what they changed in
// the same place is a conflict with both sides named. Pure: the merge driver, the designer and
// the server call it with the three versions and the choices made so far.
//
// The flow is taken apart into its nodes, wires and Notes with the level each is on, so a step
// one side moved into a subflow is still the same step. Fields are merged one by one (records a
// few levels deep: a step's settings, inputs, its binding's parameters); a value both sides
// changed differently is a conflict, kept as "ours" until someone chooses. Positions never
// conflict: ours wins. Rules a merge could break on its own are conflicts too: a step one side
// removed and the other changed or wired, and two wires on one output port.
import { withIds } from './completeIds';
import { ROOT } from './model';
import { canonical } from './semantic';
import type {
  Annotation,
  Decision,
  Edge,
  FlowDocument,
  FlowHeader,
  FlowNode,
  Position,
  SubflowBody,
  Ulid,
} from './types';

export type MergeSide = 'ours' | 'theirs';

export interface MergeConflict {
  /** Stable across merges of the same versions: choices are given by it. */
  id: string;
  kind: 'value' | 'removed' | 'wire' | 'format';
  /** Where and what, in words: "Say hello: settings.timeout". */
  label: string;
  node?: Ulid;
  annotation?: Ulid;
  edge?: Ulid;
  /** The field, dotted (`settings.timeout`); absent for a whole step, wire or the format. */
  field?: string;
  base?: unknown;
  ours?: unknown;
  theirs?: unknown;
}

export interface FlowMerge {
  /** The merged flow, each conflict as its choice says (ours until chosen). */
  doc: FlowDocument;
  conflicts: MergeConflict[];
}

// --- taking a flow apart

interface FlatNode {
  level: string;
  /** The node without its inner level. */
  own: Omit<FlowNode, 'subflow'>;
  /** Present for a subflow: its boundary, and which keys its body had (kept as they were). */
  body?: { boundary?: SubflowBody['boundary']; keys: string[] };
  position?: Position;
}
interface FlatEdge {
  level: string;
  edge: Edge;
}
interface FlatAnnotation {
  level: string;
  annotation: Annotation;
}
interface Flat {
  doc: FlowDocument;
  nodes: Map<Ulid, FlatNode>;
  edges: Map<Ulid, FlatEdge>;
  annotations: Map<Ulid, FlatAnnotation>;
  /** Which optional keys the top level had (kept as they were). */
  rootKeys: string[];
}

function flatten(doc: FlowDocument): Flat {
  const flat: Flat = {
    doc,
    nodes: new Map(),
    edges: new Map(),
    annotations: new Map(),
    rootKeys: ['annotations', 'layout', 'decisions'].filter((k) => k in doc),
  };
  const visit = (
    level: string,
    nodes: FlowNode[] | undefined,
    edges: Edge[] | undefined,
    annotations: Annotation[] | undefined,
    layout: Record<string, Position> | undefined,
  ) => {
    for (const node of nodes ?? []) {
      if (!node?.id) continue;
      const { subflow, ...own } = node;
      flat.nodes.set(node.id, {
        level,
        own,
        ...(subflow
          ? {
              body: {
                ...(subflow.boundary ? { boundary: subflow.boundary } : {}),
                keys: Object.keys(subflow),
              },
            }
          : {}),
        ...(layout?.[node.id] ? { position: layout[node.id] } : {}),
      });
      if (subflow)
        visit(node.id, subflow.nodes, subflow.edges, subflow.annotations, subflow.layout);
    }
    for (const edge of edges ?? []) if (edge?.id) flat.edges.set(edge.id, { level, edge });
    for (const a of annotations ?? [])
      if (a?.id) flat.annotations.set(a.id, { level, annotation: a });
  };
  visit(ROOT, doc.nodes, doc.edges, doc.annotations, doc.layout);
  return flat;
}

// --- merging values

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

class Merger {
  readonly conflicts: MergeConflict[] = [];
  constructor(private readonly choices: Record<string, MergeSide>) {}

  pick(id: string): MergeSide {
    return this.choices[id] ?? 'ours';
  }

  conflict(c: MergeConflict): MergeSide {
    this.conflicts.push(c);
    return this.pick(c.id);
  }

  /**
   * One value, three ways. Records are merged key by key `depth` levels down; a value both sides
   * changed differently is a conflict named by `id` (`<owner>:<field>`).
   */
  value(
    base: unknown,
    ours: unknown,
    theirs: unknown,
    at: { id: string; label: string; field: string; owner: Partial<MergeConflict> },
    depth: number,
  ): unknown {
    if (same(ours, theirs)) return ours;
    if (same(base, ours)) return theirs;
    if (same(base, theirs)) return ours;
    if (depth > 0 && isRecord(ours) && isRecord(theirs) && (base === undefined || isRecord(base))) {
      const out: Record<string, unknown> = {};
      for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
        const v = this.value(
          (base as Record<string, unknown> | undefined)?.[key],
          ours[key],
          theirs[key],
          {
            ...at,
            id: `${at.id}.${key}`,
            field: at.field ? `${at.field}.${key}` : key,
          },
          depth - 1,
        );
        if (v !== undefined) out[key] = v;
      }
      return out;
    }
    const side = this.conflict({
      ...at.owner,
      id: at.id,
      kind: 'value',
      label: at.field ? `${at.label}: ${at.field}` : at.label,
      ...(at.field ? { field: at.field } : {}),
      base,
      ours,
      theirs,
    });
    return side === 'ours' ? ours : theirs;
  }

  /** The fields of a record, each merged on its own (`depth` levels down inside each). */
  fields(
    base: Record<string, unknown> | undefined,
    ours: Record<string, unknown>,
    theirs: Record<string, unknown>,
    at: { id: string; label: string; owner: Partial<MergeConflict> },
    depth: number,
  ): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
      const v = this.value(
        base?.[key],
        ours[key],
        theirs[key],
        { ...at, id: `${at.id}:${key}`, field: key },
        depth,
      );
      if (v !== undefined) out[key] = v;
    }
    return out;
  }
}

/** A position, or another value that never conflicts: the side that moved it, else ours. */
function quiet<T>(base: T | undefined, ours: T | undefined, theirs: T | undefined): T | undefined {
  return same(base, ours) ? theirs : ours;
}

// --- the merge

/**
 * Merges what `ours` and `theirs` changed since `base`. `choices` settle conflicts by id (ours
 * when not given). Flows without IDs are matched by the IDs their keys give (Complete IDs).
 */
export function mergeFlows(
  baseDoc: FlowDocument,
  oursDoc: FlowDocument,
  theirsDoc: FlowDocument,
  choices: Record<string, MergeSide> = {},
): FlowMerge {
  const m = new Merger(choices);
  if (oursDoc.schema_version !== theirsDoc.schema_version) {
    const side = m.conflict({
      id: 'format',
      kind: 'format',
      label: `The flow's format: ${oursDoc.schema_version} here, ${theirsDoc.schema_version} in theirs (upgrade both first)`,
      ours: oursDoc.schema_version,
      theirs: theirsDoc.schema_version,
    });
    return { doc: side === 'ours' ? oursDoc : theirsDoc, conflicts: m.conflicts };
  }
  const base = flatten(withIds(baseDoc));
  const ours = flatten(withIds(oursDoc));
  const theirs = flatten(withIds(theirsDoc));
  const titleOf = (id: Ulid) =>
    (ours.nodes.get(id) ?? theirs.nodes.get(id) ?? base.nodes.get(id))?.own.title ?? id;

  // What a side did to a step, its wires, or anything inside it: a removal by the other side then
  // loses work and is a conflict.
  const touched = (side: Flat, id: Ulid, seen = new Set<Ulid>()): boolean => {
    if (seen.has(id)) return false;
    seen.add(id);
    const now = side.nodes.get(id);
    const was = base.nodes.get(id);
    if (!now) return false;
    if (!was || !same(now.own, was.own) || now.level !== was.level || !same(now.body, was.body))
      return true;
    for (const [eid, e] of side.edges)
      if ((e.edge.from.node === id || e.edge.to.node === id) && !same(e, base.edges.get(eid)))
        return true;
    for (const [aid, a] of side.annotations)
      if ((a.annotation.on === id || a.level === id) && !same(a, base.annotations.get(aid)))
        return true;
    for (const [cid, c] of side.nodes) if (c.level === id && touched(side, cid, seen)) return true;
    return false;
  };

  // Steps.
  const order = (key: 'nodes' | 'edges' | 'annotations') => [
    ...new Set([...ours[key].keys(), ...theirs[key].keys(), ...base[key].keys()]),
  ];
  const nodes = new Map<Ulid, FlatNode>();
  for (const id of order('nodes')) {
    const b = base.nodes.get(id);
    const o = ours.nodes.get(id);
    const t = theirs.nodes.get(id);
    if (!o && !t) continue;
    if (b && (!o || !t)) {
      // One side removed it: gone, unless the other side changed it meanwhile.
      const kept = (o ?? t) as FlatNode;
      if (!touched(o ? ours : theirs, id)) continue;
      const side = m.conflict({
        id: `node:${id}`,
        kind: 'removed',
        node: id,
        label: `${titleOf(id)}: removed ${o ? 'in theirs' : 'here'}, changed ${o ? 'here' : 'in theirs'}`,
        ours: o ? 'changed' : 'removed',
        theirs: o ? 'removed' : 'changed',
      });
      if ((side === 'ours') === !!o) nodes.set(id, kept);
      continue;
    }
    if (!o || !t) {
      nodes.set(id, (o ?? t) as FlatNode);
      continue;
    }
    const owner = { node: id };
    const label = titleOf(id);
    const own = m.fields(
      b?.own as Record<string, unknown> | undefined,
      o.own as Record<string, unknown>,
      t.own as Record<string, unknown>,
      { id: `node:${id}`, label, owner },
      3,
    ) as FlatNode['own'];
    const level = m.value(
      b?.level,
      o.level,
      t.level,
      { id: `node:${id}:level`, label, field: 'level (moved into another subflow)', owner },
      0,
    ) as string;
    let body: FlatNode['body'];
    const hasBody = m.value(
      !!b?.body,
      !!o.body,
      !!t.body,
      { id: `node:${id}:subflow`, label, field: 'subflow', owner },
      0,
    );
    if (hasBody) {
      const boundary = m.value(
        b?.body?.boundary,
        o.body?.boundary,
        t.body?.boundary,
        { id: `node:${id}:boundary`, label, field: 'boundary', owner },
        2,
      ) as SubflowBody['boundary'];
      body = {
        ...(boundary ? { boundary } : {}),
        keys: [...new Set([...(o.body?.keys ?? []), ...(t.body?.keys ?? [])])],
      };
    }
    const position = quiet(b?.position, o.position, t.position);
    nodes.set(id, {
      level,
      own,
      ...(body ? { body } : {}),
      ...(position ? { position } : {}),
    });
  }
  // A step whose subflow is gone goes with it.
  for (let again = true; again; ) {
    again = false;
    for (const [id, n] of nodes)
      if (n.level !== ROOT && !nodes.get(n.level)?.body) {
        nodes.delete(id);
        again = true;
      }
  }

  // Wires.
  const edges = new Map<Ulid, FlatEdge & { from: MergeSide | 'both' }>();
  for (const id of order('edges')) {
    const b = base.edges.get(id);
    const o = ours.edges.get(id);
    const t = theirs.edges.get(id);
    if (!o && !t) continue;
    if (b && (!o || !t)) {
      const kept = (o ?? t) as FlatEdge;
      if (same(kept, b)) continue;
      // Removed on one side, rewired on the other.
      const side = m.conflict({
        id: `wire:${id}`,
        kind: 'wire',
        edge: id,
        label: `The wire from ${titleOf(kept.edge.from.node)} (${kept.edge.from.port}): removed ${o ? 'in theirs' : 'here'}, changed ${o ? 'here' : 'in theirs'}`,
        ours: o ? kept.edge : undefined,
        theirs: o ? undefined : kept.edge,
      });
      if ((side === 'ours') === !!o) edges.set(id, { ...kept, from: o ? 'ours' : 'theirs' });
      continue;
    }
    if (!o || !t) {
      edges.set(id, { ...((o ?? t) as FlatEdge), from: o ? 'ours' : 'theirs' });
      continue;
    }
    const merged = m.value(
      b,
      o,
      t,
      {
        id: `wire:${id}`,
        label: `The wire from ${titleOf(o.edge.from.node)} (${o.edge.from.port})`,
        field: '',
        owner: { edge: id },
      },
      0,
    ) as FlatEdge;
    edges.set(id, { ...merged, from: 'both' });
  }
  // Wires whose ends are gone or now on another level go; the same wire added twice is one.
  const ends = new Set<string>();
  for (const [id, e] of edges) {
    const a = nodes.get(e.edge.from.node);
    const z = nodes.get(e.edge.to.node);
    const key = `${e.level}|${e.edge.from.node}.${e.edge.from.port}>${e.edge.to.node}.${e.edge.to.port}`;
    if (!a || !z || a.level !== e.level || z.level !== e.level || ends.has(key)) edges.delete(id);
    else ends.add(key);
  }
  // One wire per output port: two from different sides are a conflict.
  const byPort = new Map<string, Ulid[]>();
  for (const [id, e] of edges) {
    const key = `${e.edge.from.node}|${e.edge.from.port}`;
    byPort.set(key, [...(byPort.get(key) ?? []), id]);
  }
  for (const [key, ids] of byPort) {
    if (ids.length < 2) continue;
    const sides = new Set(ids.map((id) => edges.get(id)?.from));
    if (!sides.has('ours') && !sides.has('theirs')) continue;
    const [node = '', port = ''] = key.split('|');
    const target = (s: MergeSide) =>
      ids
        .filter((id) => (s === 'ours' ? ours : theirs).edges.has(id))
        .map((id) => titleOf(edges.get(id)?.edge.to.node ?? ''))
        .join(', ');
    const side = m.conflict({
      id: `port:${node}.${port}`,
      kind: 'wire',
      node,
      label: `${titleOf(node)}: port ${port} wired to ${target('ours') || 'nothing'} here, to ${target('theirs') || 'nothing'} in theirs`,
      field: `ports.${port}`,
      ours: target('ours'),
      theirs: target('theirs'),
    });
    const keep = side === 'ours' ? ours : theirs;
    for (const id of ids) if (!keep.edges.has(id)) edges.delete(id);
  }

  // Notes, Sections and Text.
  const annotations = new Map<Ulid, FlatAnnotation>();
  const PLACE = ['x', 'y', 'width', 'height'];
  for (const id of order('annotations')) {
    const b = base.annotations.get(id);
    const o = ours.annotations.get(id);
    const t = theirs.annotations.get(id);
    if (!o && !t) continue;
    if (b && (!o || !t)) {
      const kept = (o ?? t) as FlatAnnotation;
      if (same(kept, b)) continue;
      const side = m.conflict({
        id: `note:${id}`,
        kind: 'removed',
        annotation: id,
        label: `The note "${kept.annotation.text.split('\n')[0]}": removed ${o ? 'in theirs' : 'here'}, changed ${o ? 'here' : 'in theirs'}`,
        ours: o ? 'changed' : 'removed',
        theirs: o ? 'removed' : 'changed',
      });
      if ((side === 'ours') === !!o) annotations.set(id, kept);
      continue;
    }
    if (!o || !t) {
      annotations.set(id, (o ?? t) as FlatAnnotation);
      continue;
    }
    const strip = (a?: Annotation) =>
      a && Object.fromEntries(Object.entries(a).filter(([k]) => !PLACE.includes(k)));
    const label = `The note "${o.annotation.text.split('\n')[0]}"`;
    const fields = m.fields(
      strip(b?.annotation),
      strip(o.annotation) as Record<string, unknown>,
      strip(t.annotation) as Record<string, unknown>,
      { id: `note:${id}`, label, owner: { annotation: id } },
      1,
    );
    const place: Record<string, unknown> = {};
    for (const k of PLACE) {
      const v = quiet(
        (b?.annotation as unknown as Record<string, unknown> | undefined)?.[k],
        (o.annotation as unknown as Record<string, unknown>)[k],
        (t.annotation as unknown as Record<string, unknown>)[k],
      );
      if (v !== undefined) place[k] = v;
    }
    const level = quiet(b?.level, o.level, t.level) ?? o.level;
    annotations.set(id, { level, annotation: { ...fields, ...place } as unknown as Annotation });
  }
  for (const [id, a] of annotations)
    if (
      (a.level !== ROOT && !nodes.get(a.level)?.body) ||
      (a.annotation.on && !nodes.has(a.annotation.on))
    )
      annotations.delete(id);

  // The flow itself: its fields; its version moves on when both sides moved it.
  const { version: vb, ...hb } = base.doc.flow;
  const { version: vo, ...ho } = ours.doc.flow;
  const { version: vt, ...ht } = theirs.doc.flow;
  const header = m.fields(
    hb as Record<string, unknown>,
    ho as Record<string, unknown>,
    ht as Record<string, unknown>,
    { id: 'flow', label: 'The flow', owner: {} },
    2,
  ) as Omit<FlowHeader, 'version'>;
  const version = vo === vt ? vo : vo === vb ? vt : vt === vb ? vo : Math.max(vo, vt) + 1;

  // Decisions: a set; what a side added is in, what a side took out is out.
  const ident = (d: Decision) => JSON.stringify(canonical(d));
  const baseDecisions = new Set((base.doc.decisions ?? []).map(ident));
  const theirsDecisions = new Set((theirs.doc.decisions ?? []).map(ident));
  const decisions = [
    ...(ours.doc.decisions ?? []).filter(
      (d) => !baseDecisions.has(ident(d)) || theirsDecisions.has(ident(d)),
    ),
    ...(theirs.doc.decisions ?? []).filter(
      (d) =>
        !baseDecisions.has(ident(d)) &&
        !(ours.doc.decisions ?? []).some((x) => ident(x) === ident(d)),
    ),
  ];

  // Put it back together, level by level, in ours's order with theirs's new parts after.
  const level = (id: string) => {
    const levelNodes: FlowNode[] = [];
    const layout: Record<string, Position> = {};
    for (const [nid, n] of nodes) {
      if (n.level !== id) continue;
      const node = { ...n.own } as FlowNode;
      if (n.body) {
        const inner = level(nid);
        const keys = new Set(n.body.keys);
        const body: SubflowBody = { nodes: inner.nodes, edges: inner.edges };
        if (inner.annotations.length || keys.has('annotations'))
          body.annotations = inner.annotations;
        if (Object.keys(inner.layout).length || keys.has('layout')) body.layout = inner.layout;
        if (n.body.boundary) body.boundary = n.body.boundary;
        node.subflow = body;
      }
      levelNodes.push(node);
      if (n.position) layout[nid] = n.position;
    }
    return {
      nodes: levelNodes,
      edges: [...edges.values()].filter((e) => e.level === id).map((e) => e.edge),
      annotations: [...annotations.values()].filter((a) => a.level === id).map((a) => a.annotation),
      layout,
    };
  };
  const top = level(ROOT);
  const keys = new Set([...ours.rootKeys, ...theirs.rootKeys]);
  const doc: FlowDocument = {
    schema_version: oursDoc.schema_version,
    flow: { ...header, version } as FlowHeader,
    nodes: top.nodes,
    edges: top.edges,
    ...(top.annotations.length || keys.has('annotations') ? { annotations: top.annotations } : {}),
    ...(Object.keys(top.layout).length || keys.has('layout') ? { layout: top.layout } : {}),
    ...(decisions.length || keys.has('decisions') ? { decisions } : {}),
  };
  return { doc, conflicts: m.conflicts };
}

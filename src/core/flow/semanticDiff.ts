// What changed between two versions of a flow, node by node (AFD-57): the steps added, removed or
// changed (and which of their fields), the wires added or removed on each level, and the changes
// to the flow itself, as a review reads them. Nodes match by ID, which edits never change; a node
// whose ID is new on one side and gone on the other matches by its key path and type (a flow
// written by key, then given IDs by Complete IDs).
import { withIds } from './completeIds';
import { acceptedAll } from './decisions';
import { buildModel, type FlowModel, ROOT } from './model';
import { canonical } from './semantic';
import type {
  Annotation,
  AnnotationKind,
  FlowDocument,
  FlowNode,
  NodeType,
  PortRef,
  Position,
  Ulid,
} from './types';

export interface FieldChange {
  field: string;
  before?: unknown;
  after?: unknown;
}

export interface NodeChange {
  id: Ulid;
  kind: 'added' | 'removed' | 'changed';
  key: string;
  title: string;
  type: NodeType;
  /** The level the node is on: in the current version, or in the base for a removed node. */
  level: string;
  /** Titles of the subflows around it, outermost first. */
  where: string[];
  fields: FieldChange[];
  /** Where a removed node stood in the base, when the base stored it. */
  position?: Position;
}

export interface WireChange {
  kind: 'added' | 'removed';
  level: string;
  /** The wire's id in the version that has it. */
  edge?: Ulid;
  from: PortRef;
  to: PortRef;
  label: string;
}

/** AFD-66: a Note, Section or Text added, removed or changed (its place is not a change). */
export interface AnnotationChange {
  id: Ulid;
  kind: 'added' | 'removed' | 'changed';
  key: string;
  annotation: AnnotationKind;
  /** Its first line of text. */
  label: string;
  level: string;
  where: string[];
  fields: FieldChange[];
}

export interface FlowDiff {
  nodes: NodeChange[];
  wires: WireChange[];
  annotations: AnnotationChange[];
  /** The flow's own fields (name, goal, inputs, runtime, …) and its format. */
  flow: FieldChange[];
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * A node's reviewable fields: its entry without the ID, the inner level (its nodes are compared
 * on their own) and the `tested` evidence, with the decisions about it and the subflow boundary.
 * Format 1 `handler` reads as `purpose` (AFD-52), so an upgrade alone shows no change there.
 */
function fieldsOf(doc: FlowDocument, node: FlowNode): Record<string, unknown> {
  const { id: _id, subflow, tested: _tested, handler, ...rest } = node;
  const out: Record<string, unknown> = { ...rest };
  if (handler !== undefined && out.purpose === undefined) out.purpose = handler;
  if (subflow?.boundary) out.boundary = subflow.boundary;
  const accepted = acceptedAll(doc)
    .filter((a) => a.node === node.id)
    .map((a) => `${a.area}:${a.what}${a.reason ? ` (${a.reason})` : ''}`)
    .sort();
  if (accepted.length > 0) out.accepted = accepted;
  return out;
}

function fieldChanges(before: Record<string, unknown>, after: Record<string, unknown>) {
  const out: FieldChange[] = [];
  for (const field of new Set([...Object.keys(before), ...Object.keys(after)]))
    if (!same(before[field], after[field]))
      out.push({ field, before: before[field], after: after[field] });
  return out;
}

function whereOf(model: FlowModel, level: string): string[] {
  const titles: string[] = [];
  for (let at = level; at !== ROOT; ) {
    const parent = model.nodes.get(at);
    if (!parent) break;
    titles.unshift(parent.node.title);
    at = parent.level;
  }
  return titles;
}

function positionOf(doc: FlowDocument, model: FlowModel, id: Ulid): Position | undefined {
  const level = model.nodes.get(id)?.level;
  const inner = level && level !== ROOT ? model.nodes.get(level)?.node.subflow?.layout : undefined;
  return inner?.[id] ?? doc.layout?.[id];
}

function wireKey(level: string, from: PortRef, to: PortRef) {
  return `${level}|${from.node}.${from.port}>${to.node}.${to.port}`;
}

function wiresOf(model: FlowModel, as: (id: Ulid) => Ulid = (id) => id) {
  const out = new Map<string, { level: string; edge?: Ulid; from: PortRef; to: PortRef }>();
  for (const level of model.levels.values())
    for (const e of level.edges)
      if (e?.from && e.to)
        out.set(
          wireKey(
            level.id === ROOT ? ROOT : as(level.id),
            { ...e.from, node: as(e.from.node) },
            { ...e.to, node: as(e.to.node) },
          ),
          { level: level.id, edge: e.id, from: e.from, to: e.to },
        );
  return out;
}

const keyPath = (model: FlowModel, id: Ulid): string => {
  const entry = model.nodes.get(id);
  if (!entry) return '';
  const up = entry.level === ROOT ? '' : keyPath(model, entry.level);
  return `${up}/${entry.node.key}:${entry.node.type}`;
};

/** Current ID for each base node: the same ID, else the same key path and type (once). */
function matchIds(was: FlowModel, now: FlowModel): Map<Ulid, Ulid> {
  const map = new Map<Ulid, Ulid>();
  for (const id of was.nodes.keys()) if (now.nodes.has(id)) map.set(id, id);
  const free = new Map<string, Ulid>();
  for (const id of now.nodes.keys()) if (!was.nodes.has(id)) free.set(keyPath(now, id), id);
  for (const id of was.nodes.keys()) {
    if (map.has(id)) continue;
    const path = keyPath(was, id);
    const hit = free.get(path);
    if (hit) {
      map.set(id, hit);
      free.delete(path);
    }
  }
  return map;
}

export function diffFlows(baseDoc: FlowDocument, currentDoc: FlowDocument): FlowDiff {
  const base = withIds(baseDoc);
  const current = withIds(currentDoc);
  const was = buildModel(base);
  const now = buildModel(current);
  const ids = matchIds(was, now);
  const back = new Map([...ids].map(([b, c]) => [c, b]));
  const nodes: NodeChange[] = [];
  for (const [id, { node, level }] of now.nodes) {
    const prior = back.get(id);
    const old = prior ? was.nodes.get(prior) : undefined;
    const entry = {
      id,
      key: node.key,
      title: node.title,
      type: node.type,
      level,
      where: whereOf(now, level),
    };
    if (!old) {
      nodes.push({ ...entry, kind: 'added', fields: [] });
      continue;
    }
    const fields = fieldChanges(fieldsOf(base, old.node), fieldsOf(current, node));
    // A node moved to another level (extracted into a subflow) changed where it is.
    if ((ids.get(old.level) ?? old.level) !== level)
      fields.unshift({
        field: 'level',
        before: whereOf(was, old.level).join(' › ') || 'top level',
        after: entry.where.join(' › ') || 'top level',
      });
    if (fields.length > 0) nodes.push({ ...entry, kind: 'changed', fields });
  }
  for (const [id, { node, level }] of was.nodes)
    if (!ids.has(id))
      nodes.push({
        id,
        kind: 'removed',
        key: node.key,
        title: node.title,
        type: node.type,
        level,
        where: whereOf(was, level),
        fields: [],
        position: positionOf(base, was, id),
      });

  const label = (model: FlowModel, w: { from: PortRef; to: PortRef }) =>
    `${model.nodes.get(w.from.node)?.node.key ?? '?'}.${w.from.port} → ${model.nodes.get(w.to.node)?.node.key ?? '?'}`;
  // Base wires in current IDs, so a wire between matched nodes is the same wire.
  const before = wiresOf(was, (id) => ids.get(id) ?? id);
  const after = wiresOf(now);
  const wires: WireChange[] = [
    ...[...after]
      .filter(([k]) => !before.has(k))
      .map(([, w]) => ({ kind: 'added' as const, ...w, label: label(now, w) })),
    ...[...before]
      .filter(([k]) => !after.has(k))
      .map(([, w]) => ({ kind: 'removed' as const, ...w, label: label(was, w) })),
  ];

  const annotations = annotationChanges(was, now, ids, back);

  const { version: _v1, id: _i1, ...flowWas } = base.flow;
  const { version: _v2, id: _i2, ...flowNow } = current.flow;
  const flow = fieldChanges(
    { ...flowWas, format: base.schema_version },
    { ...flowNow, format: current.schema_version },
  );
  return { nodes, wires, annotations, flow };
}

/** What a review compares in an annotation: its words and look, and the node a note is on. */
function annotationFields(model: FlowModel, a: Annotation): Record<string, unknown> {
  const kind = a.kind ?? 'note';
  return {
    kind,
    text: a.text,
    color: a.color ?? (kind === 'note' ? 'yellow' : 'gray'),
    ...(a.size ? { size: a.size } : {}),
    on: a.on ? (model.nodes.get(a.on)?.node.key ?? a.on) : undefined,
  };
}

/** Annotations matched by ID, else by key on the same level (written by hand, then completed). */
function annotationChanges(
  was: FlowModel,
  now: FlowModel,
  ids: Map<Ulid, Ulid>,
  back: Map<Ulid, Ulid>,
): AnnotationChange[] {
  const out: AnnotationChange[] = [];
  const first = (a: Annotation) => String(a.text ?? '').split('\n')[0] ?? '';
  const matched = new Set<Ulid>();
  for (const [id, { annotation: a, level }] of now.annotations) {
    const baseLevel = level === ROOT ? ROOT : (back.get(level) ?? level);
    const prior =
      was.annotations.get(id) ??
      [...was.annotations.values()].find(
        (e) =>
          !now.annotations.has(e.annotation.id) &&
          e.level === baseLevel &&
          e.annotation.key === a.key,
      );
    const entry = {
      id,
      key: a.key,
      annotation: a.kind ?? 'note',
      label: first(a),
      level,
      where: whereOf(now, level),
    };
    if (!prior) {
      out.push({ ...entry, kind: 'added', fields: [] });
      continue;
    }
    matched.add(prior.annotation.id);
    const fields = fieldChanges(annotationFields(was, prior.annotation), annotationFields(now, a));
    if (fields.length > 0) out.push({ ...entry, kind: 'changed', fields });
  }
  for (const [id, { annotation: a, level }] of was.annotations)
    if (!matched.has(id))
      out.push({
        id,
        kind: 'removed',
        key: a.key,
        annotation: a.kind ?? 'note',
        label: first(a),
        level: ids.get(level) ?? level,
        where: whereOf(was, level),
        fields: [],
      });
  return out;
}

/** The changes inside a subflow's level, on every level below it. */
export function changesInside(diff: FlowDiff, model: FlowModel, subflow: Ulid): number {
  const inside = (level: string): boolean => {
    for (let at = level; at !== ROOT; ) {
      if (at === subflow) return true;
      const parent = model.nodes.get(at);
      if (!parent) return false;
      at = parent.level;
    }
    return false;
  };
  return (
    diff.nodes.filter((n) => n.kind !== 'removed' && inside(n.level)).length +
    diff.nodes.filter((n) => n.kind === 'removed' && (n.level === subflow || inside(n.level)))
      .length
  );
}

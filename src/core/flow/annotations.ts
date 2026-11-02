// Annotations (AFD-64): Notes, Sections and Text on a level. They explain a flow and never run, so
// they are not design (semantic.ts `withoutAnnotations`). A Note `on` a node keeps its position
// relative to that node; everything else is placed on the canvas like a node.
import { Literal, type YamlValue } from '../yaml/render';
import { ANNOTATION_ORDER } from './format';
import { annotationSize, NODE_WIDTH } from './geometry';
import type { Level } from './model';
import type { Annotation, AnnotationKind, Position, Ulid } from './types';

export interface AnnotationView {
  annotation: Annotation;
  kind: AnnotationKind;
  /** Top-left corner on the canvas (a tied Note's offset added to its node's position). */
  position: Position;
  width: number;
  height: number;
  /** A tied Note's node, when that node is on the level. */
  on?: Ulid;
}

/** Where a Note tied to a node goes when nothing says otherwise: right of the node. */
export const TIE_OFFSET = { x: NODE_WIDTH + 24, y: 0 };

export const kindOf = (a: Pick<Annotation, 'kind'>): AnnotationKind => a.kind ?? 'note';

/**
 * The level's annotations as drawn. `optimistic` holds positions in their stored form (relative
 * for a tied Note), `nodePositions` where the level's nodes are shown.
 */
export function annotationViews(
  level: Pick<Level, 'annotations'>,
  nodePositions: ReadonlyMap<Ulid, Position>,
  optimistic: Record<Ulid, Position> = {},
): AnnotationView[] {
  const out: AnnotationView[] = [];
  for (const a of level.annotations) {
    if (!a || typeof a !== 'object' || typeof a.id !== 'string') continue;
    const at = optimistic[a.id] ?? { x: Number(a.x) || 0, y: Number(a.y) || 0 };
    const kind = kindOf(a);
    const base = kind === 'note' && a.on ? nodePositions.get(a.on) : undefined;
    out.push({
      annotation: a,
      kind,
      position: base ? { x: base.x + at.x, y: base.y + at.y } : at,
      ...annotationSize(a),
      ...(base ? { on: a.on } : {}),
    });
  }
  return out;
}

interface Box {
  position: Position;
  width: number;
  height: number;
}

const inside = (b: Box, s: Box) =>
  b.position.x >= s.position.x &&
  b.position.y >= s.position.y &&
  b.position.x + b.width <= s.position.x + s.width &&
  b.position.y + b.height <= s.position.y + s.height;

/**
 * What a Section carries when dragged: the nodes and the annotations wholly inside it (tied Notes
 * go with their node, so they are not listed). Nothing stores this; it is read from where things are.
 */
export function sectionContents(
  view: { nodes: (Box & { node: { id: Ulid } })[]; annotations: AnnotationView[] },
  id: Ulid,
): { nodes: Ulid[]; annotations: Ulid[] } {
  const section = view.annotations.find((a) => a.annotation.id === id && a.kind === 'section');
  if (!section) return { nodes: [], annotations: [] };
  return {
    nodes: view.nodes.filter((n) => inside(n, section)).map((n) => n.node.id),
    annotations: view.annotations
      .filter((a) => a.annotation.id !== id && !a.on && inside(a, section))
      .map((a) => a.annotation.id),
  };
}

/** A key for a new annotation on a level: by kind, never from the text (which changes). */
export function nextAnnotationKey(
  taken: Iterable<string | undefined>,
  kind: AnnotationKind,
): string {
  const keys = new Set(taken);
  let n = 1;
  while (keys.has(`${kind}-${n}`)) n++;
  return `${kind}-${n}`;
}

/** An annotation as written: keys in ANNOTATION_ORDER, the text as a literal block when long. */
export function annotationValue(a: Partial<Annotation>): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {};
  for (const k of ANNOTATION_ORDER) {
    const v = a[k];
    if (v === undefined || v === null) continue;
    out[k] = k === 'text' ? new Literal(String(v)) : (v as YamlValue);
  }
  return out;
}

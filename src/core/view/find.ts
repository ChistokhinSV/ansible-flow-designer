// Find a node (AFD-48): every level of the flow, by title, key or what it is bound to, best match
// first. Each word of the query has to match somewhere; a title that starts with the query wins.
// AFD-86: filters (`type:approval`, `status:draft`, `open:fail`, findQuery.ts) narrow it, alone or
// with words; a query of filters only lists every node that passes them.
import { type FlowModel, ROOT } from '../flow/model';
import type { AnnotationKind, NodeType, Ulid } from '../flow/types';
import { type FindContext, hasFilters, matchesFilters, parseFind } from './findQuery';
import { plainText } from './markdown';

export interface FoundNode {
  id: Ulid;
  title: string;
  key: string;
  type: NodeType;
  level: Ulid;
  /** The titles of the subflows around it, outermost first; empty on the top level. */
  trail: string[];
  /** The module, role or playbook it is bound to. */
  ref?: string;
  /** AFD-65: a Note, Section or Text found by its words (`type` is unused then). */
  annotation?: AnnotationKind;
}

export function trailOf(model: FlowModel, level: Ulid): string[] {
  const trail: string[] = [];
  for (let at = level; at !== ROOT; ) {
    const entry = model.nodes.get(at);
    if (!entry) break;
    trail.unshift(entry.node.title);
    at = entry.level;
  }
  return trail;
}

/**
 * Where a node is (AFD-87): "in Drain the switch" or "on the top level", the same on every level.
 * AFD-91: said only for a step on another level, the line came and went as a click opened that
 * level, and the rows under it moved beneath the pointer (round 2: S10).
 */
export function placeOf(model: FlowModel, node: Ulid): string | undefined {
  const entry = model.nodes.get(node);
  if (!entry) return undefined;
  const trail = trailOf(model, entry.level);
  return trail.length ? `in ${trail.join(' › ')}` : 'on the top level';
}

/**
 * A list names its rows' places once one of its single-step rows is in a subflow; a list of
 * top-level steps needs none. It depends on the rows only, never on the level on screen (AFD-91).
 */
export function namesPlaces(model: FlowModel, rows: readonly (readonly Ulid[])[]): boolean {
  return rows.some((nodes) => {
    const entry = nodes.length === 1 ? model.nodes.get(nodes[0] as Ulid) : undefined;
    return !!entry && entry.level !== ROOT;
  });
}

/**
 * What stands for these nodes on a level (AFD-91): each one on it, or the subflow on it that holds
 * it. A node in a subflow beside this level stands for nothing, so lighting it dims nothing (round
 * 2: S11, every node dimmed and none lit).
 */
export function shownOn(model: FlowModel, nodes: readonly Ulid[], level: string): Ulid[] {
  const shown = new Set<Ulid>();
  for (const id of nodes) {
    for (let at: Ulid | undefined = id; at; ) {
      const entry = model.nodes.get(at);
      if (!entry) break;
      if (entry.level === level) {
        shown.add(at);
        break;
      }
      // A level's id is the subflow node that owns it; the top level has none.
      at = entry.level === ROOT ? undefined : entry.level;
    }
  }
  return [...shown];
}

export function findNodes(
  model: FlowModel,
  query: string,
  limit = 50,
  ctx: FindContext = {},
): FoundNode[] {
  const q = parseFind(query);
  const { words } = q;
  const filtered = hasFilters(q);
  if (words.length === 0 && !filtered) return [];
  const whole = words.join(' ');
  const scored: { found: FoundNode; score: number; depth: number }[] = [];
  for (const { node, level } of model.nodes.values()) {
    const title = node.title.toLowerCase();
    const key = node.key?.toLowerCase() ?? '';
    const ref = node.impl?.ref?.toLowerCase() ?? '';
    if (!words.every((w) => title.includes(w) || key.includes(w) || ref.includes(w))) continue;
    if (filtered && !matchesFilters(node, q, ctx)) continue;
    const score = !whole
      ? 0
      : title.startsWith(whole)
        ? 0
        : title.split(/\W+/).some((w) => w.startsWith(words[0] ?? ''))
          ? 1
          : title.includes(whole)
            ? 2
            : key.includes(whole)
              ? 3
              : 4;
    const trail = trailOf(model, level);
    scored.push({
      found: {
        id: node.id,
        title: node.title,
        key: node.key ?? '',
        type: node.type,
        level,
        trail,
        ...(node.impl?.ref ? { ref: node.impl.ref } : {}),
      },
      score,
      depth: trail.length,
    });
  }
  // AFD-65: annotations by their words, after the nodes that match as well (filters are for steps).
  for (const { annotation: a, level } of filtered ? [] : model.annotations.values()) {
    const text = plainText(a.text ?? '');
    const lower = text.toLowerCase();
    if (!words.every((w) => lower.includes(w))) continue;
    const trail = trailOf(model, level);
    const first = text.split('\n')[0] ?? '';
    scored.push({
      found: {
        id: a.id,
        title: first.length > 60 ? `${first.slice(0, 59)}…` : first,
        key: a.key ?? '',
        type: 'task',
        level,
        trail,
        annotation: a.kind ?? 'note',
      },
      score: lower.startsWith(whole) ? 3 : 4,
      depth: trail.length,
    });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score || a.depth - b.depth || a.found.title.localeCompare(b.found.title),
    )
    .slice(0, limit)
    .map((s) => s.found);
}

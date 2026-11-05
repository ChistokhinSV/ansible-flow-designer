// AFD-85 (wave 8 group H): what changed in a flow outside the designer, since it was opened. An
// agent, a command line or another extension can rewrite the file; the canvas then rebuilt with no
// trace of it (round 1: P21). Each outside edit adds its steps and wires to the marks, which stay
// apart from the Changes lens (Git): the person's own edits in between never count. AFD-92 (wave
// 9): also what changed while the flow was closed, against what the designer last showed. Pure.

import { modelOf } from '../flow/model';
import { diffFlows } from '../flow/semanticDiff';
import type { FlowDocument, Ulid } from '../flow/types';

export interface OutsideMarks {
  /** Steps added or changed outside the designer. */
  nodes: Ulid[];
  /** Wires added outside the designer (a changed wire is one removed, one added). */
  edges: Ulid[];
  /** Steps removed outside the designer. */
  removed: number;
  /** When the first of these edits came. */
  since: string;
  /**
   * AFD-92: some of them came while the flow was closed. `since` is then when the designer last
   * showed it (round 2: S12, an agent's edit to a closed flow left no mark).
   */
  closed?: boolean;
}

/** One outside edit: what it added or changed between the flow as shown and the flow now. */
export function outsideChanges(
  before: FlowDocument,
  after: FlowDocument,
): Omit<OutsideMarks, 'since'> {
  const diff = diffFlows(before, after);
  return {
    nodes: diff.nodes.filter((n) => n.kind !== 'removed').map((n) => n.id),
    edges: diff.wires.filter((w) => w.kind === 'added' && w.edge).map((w) => w.edge as Ulid),
    removed: diff.nodes.filter((n) => n.kind === 'removed').length,
  };
}

/**
 * The marks after another outside edit, keeping only what the flow still has (a step the person
 * then deleted loses its mark).
 */
export function addMarks(
  marks: OutsideMarks | undefined,
  edit: Omit<OutsideMarks, 'since'>,
  doc: FlowDocument,
  now: string,
): OutsideMarks | undefined {
  const model = modelOf(doc);
  const nodes = [...new Set([...(marks?.nodes ?? []), ...edit.nodes])].filter((id) =>
    model.nodes.has(id),
  );
  const edges = [...new Set([...(marks?.edges ?? []), ...edit.edges])].filter((id) =>
    model.edges.has(id),
  );
  const removed = (marks?.removed ?? 0) + edit.removed;
  if (!nodes.length && !edges.length && !removed) return undefined;
  return {
    nodes,
    edges,
    removed,
    since: marks?.since ?? now,
    ...(marks?.closed ? { closed: true } : {}),
  };
}

/**
 * AFD-92: the marks once the designer opens a flow again, against the flow it last showed
 * (`shown`, saved when its last panel closed). Every change it did not write counts: an agent, a
 * text editor, a Git pull or checkout. A file that now holds another flow (another ID) is not
 * compared. `at` is when the designer last showed it.
 */
export function closedMarks(
  marks: OutsideMarks | undefined,
  shown: FlowDocument,
  now: FlowDocument,
  at: string,
): OutsideMarks | undefined {
  if (shown.flow.id && now.flow.id && shown.flow.id !== now.flow.id) return marks;
  const edit = outsideChanges(shown, now);
  if (!edit.nodes.length && !edit.edges.length && !edit.removed) return marks;
  const next = addMarks(marks, edit, now, at);
  if (!next) return marks;
  const since = marks && marks.since < at ? marks.since : at;
  return { ...next, since, closed: true };
}

/**
 * The flows the designer remembers (AFD-92), oldest dropped first: those not shown for `days`, then
 * any past the `max` most recent. Returns the keys to drop.
 */
export function shownToDrop(
  entries: Readonly<Record<string, { at: string }>>,
  now: number,
  days = 90,
  max = 300,
): string[] {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  // An entry whose time does not read counts as the oldest.
  const time = (at: string) => Date.parse(at) || Number.NEGATIVE_INFINITY;
  const byAge = Object.entries(entries).sort(([, a], [, b]) => time(b.at) - time(a.at));
  return byAge.filter(([, e], i) => i >= max || time(e.at) < cutoff).map(([key]) => key);
}

/** The marks the flow still has, after the person's own edit. */
export function keepMarks(
  marks: OutsideMarks | undefined,
  doc: FlowDocument,
): OutsideMarks | undefined {
  if (!marks) return undefined;
  return addMarks(marks, { nodes: [], edges: [], removed: 0 }, doc, marks.since);
}

/** The subflows around marked steps, so a mark inside one shows from the level above. */
export function markedAround(marks: OutsideMarks, doc: FlowDocument): Ulid[] {
  const model = modelOf(doc);
  const out = new Set<Ulid>();
  for (const id of marks.nodes)
    for (let at = model.nodes.get(id)?.level; at && at !== 'root'; at = model.nodes.get(at)?.level)
      out.add(at);
  return [...out];
}

/** The note's words: "2 steps and 1 wire changed outside the designer", removals included. */
export function marksText(marks: OutsideMarks): string {
  const n = (count: number, one: string) => `${count} ${one}${count === 1 ? '' : 's'}`;
  const parts = [
    marks.nodes.length ? n(marks.nodes.length, 'step') : '',
    marks.edges.length ? n(marks.edges.length, 'wire') : '',
  ].filter(Boolean);
  if (!parts.length) return `${n(marks.removed, 'step')} removed outside the designer`;
  const gone = marks.removed ? `, ${n(marks.removed, 'step')} removed` : '';
  return `${parts.join(' and ')} changed outside the designer${gone}`;
}

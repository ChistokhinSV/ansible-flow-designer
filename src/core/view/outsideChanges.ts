// AFD-85 (wave 8 group H): what changed in a flow outside the designer, since it was opened. An
// agent, a command line or another extension can rewrite the file; the canvas then rebuilt with no
// trace of it (round 1: P21). Each outside edit adds its steps and wires to the marks, which stay
// apart from the Changes lens (Git): the person's own edits in between never count. AFD-92 (wave
// 9): also what changed while the flow was closed, against what the designer last showed.
// AFD-104 (wave 10, round 3: R9): and what each change was, in words, not only which steps. Pure.

import { modelOf } from '../flow/model';
import { canonical } from '../flow/semantic';
import { diffFlows, type FieldChange } from '../flow/semanticDiff';
import type { FlowDocument, Ulid } from '../flow/types';

/** AFD-104: one step's outside change, merged over the edits since the marks began. */
export interface OutsideChange {
  id: Ulid;
  kind: 'added' | 'changed' | 'removed';
  title: string;
  /** Titles of the subflows around it, outermost first. */
  where: string[];
  /** Each changed field with its value before the first edit and after the last. */
  fields: FieldChange[];
}

/** AFD-104: a wire added or removed outside, by its label ("check.ok_hosts → done"). */
export interface OutsideWire {
  kind: 'added' | 'removed';
  label: string;
  /** An added wire's ID: when the person removes it, its line goes too. */
  edge?: Ulid;
}

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
  /**
   * AFD-104 (round 3: R9): what changed in each step. The participant found the marked steps but
   * not what a colleague's commit had done to them, and gave up.
   */
  changes?: OutsideChange[];
  /** AFD-104: wires added or removed (a removed wire left no mark before). */
  wires?: OutsideWire[];
  /** AFD-104: the flow's own fields that changed (goal, inputs, …). */
  flow?: string[];
}

/** One outside edit: what it added or changed between the flow as shown and the flow now. */
export function outsideChanges(
  before: FlowDocument,
  after: FlowDocument,
): Omit<OutsideMarks, 'since'> {
  const diff = diffFlows(before, after);
  // A wire that only came or went with its step says nothing the step's own line does not.
  const came = new Set(diff.nodes.filter((n) => n.kind === 'added').map((n) => n.id));
  const went = new Set(diff.nodes.filter((n) => n.kind === 'removed').map((n) => n.id));
  const own = (w: (typeof diff.wires)[number]) => {
    const steps = w.kind === 'added' ? came : went;
    return steps.has(w.from.node) || steps.has(w.to.node);
  };
  return {
    nodes: diff.nodes.filter((n) => n.kind !== 'removed').map((n) => n.id),
    edges: diff.wires.filter((w) => w.kind === 'added' && w.edge).map((w) => w.edge as Ulid),
    removed: diff.nodes.filter((n) => n.kind === 'removed').length,
    changes: diff.nodes.map((n) => ({
      id: n.id,
      kind: n.kind,
      title: n.title,
      where: n.where,
      fields: n.fields,
    })),
    wires: diff.wires
      .filter((w) => !own(w))
      .map((w) => ({
        kind: w.kind,
        label: w.label,
        ...(w.kind === 'added' && w.edge ? { edge: w.edge } : {}),
      })),
    flow: diff.flow.map((f) => f.field),
  };
}

const same = (a: unknown, b: unknown) =>
  JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

/**
 * Two edits' changes as one: a field keeps its value from before the first edit and takes the
 * last edit's; a step added then changed is still added; added then removed is no change.
 */
function mergeChanges(prev: OutsideChange[], next: OutsideChange[]): OutsideChange[] {
  const byId = new Map(prev.map((c) => [c.id, c]));
  for (const c of next) {
    const old = byId.get(c.id);
    if (!old) byId.set(c.id, c);
    else if (old.kind === 'added' && c.kind === 'removed') byId.delete(c.id);
    else if (old.kind === 'added') byId.set(c.id, { ...c, kind: 'added', fields: [] });
    else if (c.kind === 'removed') byId.set(c.id, { ...c, title: old.title });
    else {
      const fields = new Map(old.fields.map((f) => [f.field, f]));
      for (const f of c.fields) {
        const first = fields.get(f.field);
        fields.set(f.field, first ? { field: f.field, before: first.before, after: f.after } : f);
      }
      const kept = [...fields.values()].filter((f) => !same(f.before, f.after));
      if (kept.length) byId.set(c.id, { ...c, kind: 'changed', fields: kept });
      else byId.delete(c.id);
    }
  }
  return [...byId.values()];
}

/** Wires by label: one added then removed again (or the reverse) is no change. */
function mergeWires(prev: OutsideWire[], next: OutsideWire[]): OutsideWire[] {
  const out = [...prev];
  for (const w of next) {
    const back = out.findIndex((o) => o.label === w.label && o.kind !== w.kind);
    if (back >= 0) out.splice(back, 1);
    else if (!out.some((o) => o.label === w.label && o.kind === w.kind)) out.push(w);
  }
  return out;
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
  // A change to a step that is gone since (the person deleted it) goes with its mark.
  const changes = mergeChanges(marks?.changes ?? [], edit.changes ?? []).filter(
    (c) => c.kind === 'removed' || model.nodes.has(c.id),
  );
  const wires = mergeWires(marks?.wires ?? [], edit.wires ?? []).filter(
    (w) => !w.edge || model.edges.has(w.edge),
  );
  const flow = [...new Set([...(marks?.flow ?? []), ...(edit.flow ?? [])])];
  if (!nodes.length && !edges.length && !removed && !wires.length && !flow.length) return undefined;
  return {
    nodes,
    edges,
    removed,
    since: marks?.since ?? now,
    ...(marks?.closed ? { closed: true } : {}),
    ...(changes.length ? { changes } : {}),
    ...(wires.length ? { wires } : {}),
    ...(flow.length ? { flow } : {}),
  };
}

/** Whether an edit changed anything the marks show. */
const anything = (edit: Omit<OutsideMarks, 'since'>) =>
  edit.nodes.length > 0 ||
  edit.edges.length > 0 ||
  edit.removed > 0 ||
  (edit.wires?.length ?? 0) > 0 ||
  (edit.flow?.length ?? 0) > 0;

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
  if (!anything(edit)) return marks;
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
  const wiresGone = (marks.wires ?? []).filter((w) => w.kind === 'removed').length;
  const gone = [
    marks.removed ? `${n(marks.removed, 'step')} removed` : '',
    wiresGone ? `${n(wiresGone, 'wire')} removed` : '',
    marks.flow?.length ? `the flow's ${marks.flow.join(', ')} changed` : '',
  ].filter(Boolean);
  if (!parts.length) {
    const [first = '', ...rest] = gone;
    const lead = `${first.charAt(0).toUpperCase()}${first.slice(1)}`;
    return `${[lead, ...rest].join(', ')} outside the designer`;
  }
  const tail = gone.length ? `, ${gone.join(', ')}` : '';
  return `${parts.join(' and ')} changed outside the designer${tail}`;
}

/** "14:02" today, "4 Nov, 20:49" before: marks can be days old since AFD-92. */
export function whenText(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const time = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (at.toDateString() === now.toDateString()) return time;
  return `${at.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

const FIELD_WORDS: Record<string, string> = {
  impl: 'binding',
  accepted: 'accepted findings',
};

interface Bound {
  ref?: string;
  params?: Record<string, unknown>;
  register?: string;
  keywords?: unknown;
}

/** The keys of two maps whose values differ. */
function changedKeys(a: unknown, b: unknown): string[] {
  const x = (a ?? {}) as Record<string, unknown>;
  const y = (b ?? {}) as Record<string, unknown>;
  return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter((k) => !same(x[k], y[k]));
}

/** A binding's change in words: "bound to X", "binding changed (msg)". */
function bindingWords(before: unknown, after: unknown): string {
  const b = before as Bound | undefined;
  const a = after as Bound | undefined;
  if (!b?.ref && a?.ref) return `bound to ${a.ref}`;
  if (b?.ref && !a?.ref) return 'binding removed';
  if (b?.ref !== a?.ref) return `bound to ${a?.ref} instead of ${b?.ref}`;
  const what = [
    ...changedKeys(b?.params, a?.params),
    ...(same(b?.register, a?.register) ? [] : ['register']),
    ...(same(b?.keywords, a?.keywords) ? [] : ['task keywords']),
  ];
  return `binding changed${what.length ? ` (${what.join(', ')})` : ''}`;
}

/**
 * One step's outside change in words (AFD-104): "Added Check the session table is empty, in Fail
 * over to the peer", "Renamed A to B", "Copy the image: binding changed (msg)".
 */
export function changeWords(c: OutsideChange): string {
  const where = c.where.length ? `, in ${c.where[c.where.length - 1]}` : '';
  if (c.kind === 'added') return `Added ${c.title}${where}`;
  if (c.kind === 'removed') return `Removed ${c.title}${where}`;
  let renamed = '';
  const parts: string[] = [];
  for (const f of c.fields) {
    if (f.field === 'title') renamed = `Renamed ${String(f.before)} to ${String(f.after)}${where}`;
    else if (f.field === 'impl') parts.push(bindingWords(f.before, f.after));
    else if (f.field === 'settings')
      parts.push(`settings changed (${changedKeys(f.before, f.after).join(', ')})`);
    else if (f.field === 'level') parts.push('moved to another level');
    else parts.push(`${FIELD_WORDS[f.field] ?? f.field} changed`);
  }
  if (renamed) return [renamed, ...parts].join('; ');
  return `${c.title}${where}: ${parts.join(', ') || 'changed'}`;
}

/** The note's list (AFD-104): each change in words, with the step to show when there is one. */
export function changeLines(marks: OutsideMarks): { id?: Ulid; text: string }[] {
  return [
    ...(marks.changes ?? []).map((c) => ({
      id: c.kind === 'removed' ? undefined : c.id,
      text: changeWords(c),
    })),
    ...(marks.wires ?? []).map((w) => ({
      text: `Wire ${w.kind === 'added' ? 'added' : 'removed'}: ${w.label}`,
    })),
    ...(marks.flow ?? []).map((f) => ({ text: `The flow's ${f} changed` })),
  ];
}

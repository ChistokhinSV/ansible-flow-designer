// AFD-239: what an undo or a redo did, in a sentence, and a node to show. Undo is VS Code's text
// undo, so the designer learns only that the text changed; the difference between the flow before
// and after says what that was (usability round 2: "undo shows nothing").
import { modelOf } from '../flow/model';
import { diffFlows } from '../flow/semanticDiff';
import type { FlowDocument, Ulid } from '../flow/types';

export interface UndoSummary {
  text: string;
  /** A node of the flow as it is now that the change touched, to bring into view. */
  node?: Ulid;
}

const count = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The stored positions that differ between two versions, among nodes both have. */
function moved(before: FlowDocument, after: FlowDocument): Ulid[] {
  const was = before.layout ?? {};
  const now = after.layout ?? {};
  const here = modelOf(after).nodes;
  return [...new Set([...Object.keys(was), ...Object.keys(now)])].filter(
    (id) => here.has(id) && JSON.stringify(was[id]) !== JSON.stringify(now[id]),
  );
}

export function undoSummary(
  before: FlowDocument,
  after: FlowDocument,
  verb: 'Undid' | 'Redid',
): UndoSummary {
  const diff = diffFlows(before, after);
  const of = (kind: 'added' | 'removed' | 'changed') => diff.nodes.filter((n) => n.kind === kind);
  const parts: string[] = [];
  const named = (kind: 'added' | 'removed' | 'changed', word: string) => {
    const nodes = of(kind);
    if (nodes.length === 1) parts.push(`${word} ${nodes[0]?.title}`);
    else if (nodes.length > 1) parts.push(`${word} ${count(nodes.length, 'node')}`);
  };
  named('added', 'added');
  named('removed', 'removed');
  const changed = of('changed');
  if (changed.length === 1) {
    const fields = (changed[0]?.fields ?? []).map((f) => f.field);
    const shown = fields.slice(0, 3).join(', ');
    parts.push(
      `changed ${changed[0]?.title}${shown ? ` (${shown}${fields.length > 3 ? '…' : ''})` : ''}`,
    );
  } else if (changed.length > 1) parts.push(`changed ${count(changed.length, 'node')}`);
  const wiresAdded = diff.wires.filter((w) => w.kind === 'added').length;
  const wiresRemoved = diff.wires.length - wiresAdded;
  if (wiresAdded) parts.push(`added ${count(wiresAdded, 'wire')}`);
  if (wiresRemoved) parts.push(`removed ${count(wiresRemoved, 'wire')}`);
  if (diff.annotations.length)
    parts.push(`changed ${count(diff.annotations.length, 'annotation')}`);
  if (diff.flow.length) parts.push('changed the flow');
  const places = moved(before, after);
  if (places.length && parts.length === 0) parts.push(`moved ${count(places.length, 'node')}`);
  const shown = of('added')[0]?.id ?? changed[0]?.id ?? places[0];
  // A wire alone: one of its ends that is still there.
  const end = diff.wires[0];
  const here = modelOf(after).nodes;
  const wireEnd = end ? [end.from.node, end.to.node].find((id) => here.has(id)) : undefined;
  const node = shown ?? wireEnd;
  return {
    text: `${verb}: ${parts.length ? parts.join(', ') : 'a change in the text'}`,
    ...(node ? { node } : {}),
  };
}

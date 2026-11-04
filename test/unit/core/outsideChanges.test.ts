// AFD-85: what changed outside the designer, kept apart from the person's own edits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowDocument } from '../../../src/core/flow/types';
import {
  addMarks,
  keepMarks,
  markedAround,
  marksText,
  outsideChanges,
} from '../../../src/core/view/outsideChanges';

const base = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (doc: FlowDocument, key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

/** The agent's edit: a step retitled, a step removed, a wire added. */
function agentEdit(doc: FlowDocument): FlowDocument {
  const next = structuredClone(doc);
  const push = next.nodes.find((n) => n.key === 'push-baseline');
  if (push) push.title = 'Push the baseline and verify';
  next.nodes = next.nodes.filter((n) => n.key !== 'rollback');
  next.edges = next.edges.filter(
    (e) => e.from.node !== id(doc, 'rollback') && e.to.node !== id(doc, 'rollback'),
  );
  next.edges.push({
    id: '01M7AFD85W0000000000000000',
    from: { node: id(doc, 'validate'), port: 'failed_hosts' },
    to: { node: id(doc, 'failed'), port: 'in' },
  });
  return next;
}

describe('outside changes', () => {
  const after = agentEdit(base);
  const edit = outsideChanges(base, after);

  it('one edit: the steps added or changed, the wires added, the steps removed', () => {
    expect(edit.nodes).toEqual([id(base, 'push-baseline')]);
    expect(edit.edges).toEqual(['01M7AFD85W0000000000000000']);
    expect(edit.removed).toBe(1);
  });

  it('marks add up across edits, from the first one on, and name themselves', () => {
    const marks = addMarks(undefined, edit, after, '2026-11-04T10:00:00Z');
    expect(marks).toMatchObject({ removed: 1, since: '2026-11-04T10:00:00Z' });
    expect(marksText(marks as NonNullable<typeof marks>)).toBe(
      '1 step and 1 wire changed outside the designer, 1 step removed',
    );
    const second = addMarks(
      marks,
      { nodes: [id(base, 'validate')], edges: [], removed: 0 },
      after,
      'later',
    );
    expect(second?.nodes).toEqual([id(base, 'push-baseline'), id(base, 'validate')]);
    expect(second?.since).toBe('2026-11-04T10:00:00Z');
  });

  it("the person's own edit only drops marks on what is gone", () => {
    const marks = addMarks(undefined, edit, after, 'now');
    const own = structuredClone(after);
    own.nodes = own.nodes.filter((n) => n.key !== 'push-baseline');
    const kept = keepMarks(marks, own);
    expect(kept?.nodes).toEqual([]);
    expect(kept?.edges).toEqual(['01M7AFD85W0000000000000000']);
    // The removed step still counts: the note says so.
    // A new object: the flow model is cached per document object.
    const wireGone = {
      ...own,
      edges: own.edges.filter((e) => e.id !== '01M7AFD85W0000000000000000'),
    };
    const left = keepMarks(kept, wireGone);
    expect(left).toMatchObject({ nodes: [], edges: [], removed: 1 });
    expect(marksText(left as NonNullable<typeof left>)).toBe('1 step removed outside the designer');
    expect(
      keepMarks({ ...(left as NonNullable<typeof left>), removed: 0 }, wireGone),
    ).toBeUndefined();
  });

  it('a marked step inside a subflow marks the subflows around it', () => {
    const marks = addMarks(undefined, edit, after, 'now');
    expect(markedAround(marks as NonNullable<typeof marks>, after)).toEqual([]);
  });
});

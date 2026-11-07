// AFD-85: what changed outside the designer, kept apart from the person's own edits.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { applyOps } from '../../../src/core/ai/ops';
import { createIdFactory } from '../../../src/core/flow/ids';
import type { FlowDocument } from '../../../src/core/flow/types';
import {
  addMarks,
  changeLines,
  changeWords,
  closedMarks,
  keepMarks,
  markedAround,
  marksText,
  outsideChanges,
  shownToDrop,
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
      // AFD-104: nothing left, the step's removal included, means no marks.
      keepMarks({ ...(left as NonNullable<typeof left>), removed: 0, changes: [] }, wireGone),
    ).toBeUndefined();
  });

  it('a marked step inside a subflow marks the subflows around it', () => {
    const marks = addMarks(undefined, edit, after, 'now');
    expect(markedAround(marks as NonNullable<typeof marks>, after)).toEqual([]);
  });
});

describe('changes made while the flow was closed (AFD-92)', () => {
  const after = agentEdit(base);
  const at = '2026-11-04T19:49:00.000Z';

  it('marks what changed since the designer last showed it, from then', () => {
    const marks = closedMarks(undefined, base, after, at);
    expect(marks?.closed).toBe(true);
    expect(marks?.since).toBe(at);
    expect(marks?.nodes).toContain(id(base, 'push-baseline'));
    expect(marks?.removed).toBe(1);
  });

  it('nothing changed, or another flow now in the file: the marks stay as they were', () => {
    expect(closedMarks(undefined, base, structuredClone(base), at)).toBeUndefined();
    const other = { ...after, flow: { ...after.flow, id: '01M7OTHERFL0W0000000000000' } };
    expect(closedMarks(undefined, base, other, at)).toBeUndefined();
  });

  it('joins marks made while the file was open without a designer; the earlier time wins', () => {
    const open = addMarks(
      undefined,
      { nodes: [id(base, 'backup-config')], edges: [], removed: 0 },
      after,
      '2026-11-05T08:00:00.000Z',
    );
    const marks = closedMarks(open, base, after, at);
    expect(marks?.nodes).toEqual(
      expect.arrayContaining([id(base, 'backup-config'), id(base, 'push-baseline')]),
    );
    expect(marks?.since).toBe(at);
  });

  it('forgets flows not shown for 90 days, then all past the 300 most recent', () => {
    const now = Date.parse('2026-11-05T00:00:00Z');
    const day = (n: number) => new Date(now - n * 86_400_000).toISOString();
    expect(shownToDrop({ a: { at: day(1) }, b: { at: day(91) }, c: { at: 'bad' } }, now)).toEqual([
      'b',
      'c',
    ]);
    const many = Object.fromEntries(
      Array.from({ length: 302 }, (_, i) => [`f${i}`, { at: day(i / 100) }]),
    );
    expect(shownToDrop(many, now).sort()).toEqual(['f300', 'f301']);
  });
});

// AFD-104 (round 3: R9): what each outside change was, in words.
describe('what changed outside, in words (AFD-104)', () => {
  const after = agentEdit(base);

  it('names each change: renamed, removed, a wire added, the flow itself', () => {
    const marks = addMarks(undefined, outsideChanges(base, after), after, 'now');
    expect(changeLines(marks as NonNullable<typeof marks>).map((l) => l.text)).toEqual([
      'Renamed Push baseline to Push the baseline and verify',
      'Removed Rollback',
      'Wire added: Validate (failed_hosts) → Failed',
    ]);
    // A wire that only went with its step is not a line of its own.
    expect(marks?.wires).toEqual([
      {
        kind: 'added',
        label: 'validate.failed_hosts → failed',
        words: 'Validate (failed_hosts) → Failed',
        edge: '01M7AFD85W0000000000000000',
      },
    ]);
    const goal = { ...after, flow: { ...after.flow, goal: 'Something else' } };
    const flowOnly = addMarks(undefined, outsideChanges(after, goal), goal, 'now');
    expect(flowOnly && marksText(flowOnly)).toBe("The flow's goal changed outside the designer");
  });

  it('says what a binding change was, and an added step with its subflow', () => {
    const bound = structuredClone(after);
    const validate = bound.nodes.find((n) => n.key === 'validate');
    if (validate)
      validate.impl = { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: 'a' } };
    const rebound = structuredClone(bound);
    const again = rebound.nodes.find((n) => n.key === 'validate');
    if (again?.impl) again.impl.params = { msg: 'b' };
    if (again) again.settings = { retries: 3 };
    const one = addMarks(undefined, outsideChanges(after, bound), bound, 'now');
    const both = addMarks(one, outsideChanges(bound, rebound), rebound, 'now');
    const line = changeLines(both as NonNullable<typeof both>).find((l) =>
      l.text.startsWith('Validate'),
    );
    // Merged over the two edits: from no binding to debug, and retries set.
    expect(line?.text).toBe('Validate: bound to ansible.builtin.debug, settings changed (retries)');
    expect(
      changeWords({
        id: 'x',
        kind: 'added',
        title: 'Check the session table is empty',
        where: ['Fail over to the peer'],
        fields: [],
      }),
    ).toBe('Added Check the session table is empty, in Fail over to the peer');
    expect(
      changeWords({
        id: 'x',
        kind: 'changed',
        title: 'Copy the image',
        where: [],
        fields: [
          {
            field: 'impl',
            before: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: 'a' } },
            after: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: 'b' } },
          },
        ],
      }),
    ).toBe('Copy the image: binding changed (msg)');
  });

  // AFD-111 (round 4: Q6, Z4): D10's change list had six lines for four changes. Inserting one
  // step on a wire inside a subflow, with an exit for its failures, also gave "<subflow>: boundary
  // changed" and "Wire removed: <key>.ok_hosts → <key>".
  it('a step put on a wire inside a subflow, with its exit, is one line', async () => {
    const text = readFileSync(
      join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'),
      'utf8',
    );
    const was = parse(text) as FlowDocument;
    const edited = await applyOps(
      text,
      [
        {
          op: 'add_node',
          type: 'task',
          key: 'verify-backup',
          title: 'Verify the backup',
          on_wire: 'backup/export.ok_hosts',
          impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: 'ok' } },
        },
        { op: 'add_exit', from: 'backup/verify-backup.failed_hosts', port: 'failed_hosts' },
        { op: 'update_node', node: 'backup/store', title: 'Store the backup off the box' },
      ],
      { newId: createIdFactory() },
    );
    const now = parse(edited.text) as FlowDocument;
    const marks = addMarks(undefined, outsideChanges(was, now), now, 'now');
    expect(changeLines(marks as NonNullable<typeof marks>).map((l) => l.text)).toEqual([
      'Renamed Store the backup to Store the backup off the box, in Backup',
      'Added Verify the backup, in Backup, after Export configuration',
    ]);
    // Backup itself is not marked changed; it is marked around its changed steps.
    const backup = now.nodes.find((n) => n.key === 'backup')?.id;
    expect(marks?.nodes).not.toContain(backup);
    expect(markedAround(marks as NonNullable<typeof marks>, now)).toEqual([backup]);
    // A later edit to the added step keeps where it was put.
    const later = structuredClone(now);
    const step = later.nodes
      .find((n) => n.key === 'backup')
      ?.subflow?.nodes?.find((n) => n.key === 'verify-backup');
    if (step) step.title = 'Verify the backup file';
    const both = addMarks(marks, outsideChanges(now, later), later, 'later');
    expect(changeLines(both as NonNullable<typeof both>).map((l) => l.text)).toContain(
      'Added Verify the backup file, in Backup, after Export configuration',
    );
  });

  it('an exit of a step that was there before still changes the subflow', () => {
    const was = parse(
      readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8'),
    ) as FlowDocument;
    const now = structuredClone(was);
    const backup = now.nodes.find((n) => n.key === 'backup');
    const exportId = backup?.subflow?.nodes?.find((n) => n.key === 'export')?.id as string;
    const outputs = backup?.subflow?.boundary?.outputs ?? {};
    outputs.ok_hosts = [...(outputs.ok_hosts ?? []), { node: exportId, port: 'ok_hosts' }];
    const marks = addMarks(undefined, outsideChanges(was, now), now, 'now');
    expect(changeLines(marks as NonNullable<typeof marks>).map((l) => l.text)).toEqual([
      'Backup: boundary changed',
    ]);
  });

  it('an edit undone by the next one leaves no line', () => {
    const renamed = structuredClone(base);
    const push = renamed.nodes.find((n) => n.key === 'push-baseline');
    if (push) push.title = 'Something';
    const one = addMarks(undefined, outsideChanges(base, renamed), renamed, 'now');
    const back = addMarks(one, outsideChanges(renamed, base), base, 'now');
    expect(back?.changes ?? []).toEqual([]);
  });
});

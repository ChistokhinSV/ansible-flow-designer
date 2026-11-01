// Decision 15 (AFD-12): a tested node whose design changes is implemented again, in the same edit
// on the canvas or on save for hand edits; a run proposes `tested` only for the design that ran.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand, testedFinding } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { planSave } from '../../../src/core/flow/save';
import { nodeDesigns, testedDropBack } from '../../../src/core/flow/semantic';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { testedCandidates } from '../../../src/core/run/view';
import { applyEdits } from '../../../src/core/yaml';

const ctx = { newId: createIdFactory() };
const OS = readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8');

function walk(nodes: FlowNode[] | undefined): FlowNode[] {
  return (nodes ?? []).flatMap((n) => [n, ...walk(n.subflow?.nodes)]);
}
const nodes = (text: string) => walk((parse(text) as FlowDocument).nodes);
const byKey = (text: string, key: string) => nodes(text).find((n) => n.key === key) as FlowNode;
const run = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  return r;
};
/** os-upgrade with every implemented node marked tested, as after a passing run. */
const TESTED = run(OS, {
  kind: 'setStatuses',
  statuses: Object.fromEntries(
    nodes(OS)
      .filter((n) => n.status === 'implemented')
      .map((n) => [n.id, 'tested' as const]),
  ),
}).text;
const id = (key: string) => byKey(TESTED, key).id;

describe('canvas commands', () => {
  it('a design change of a tested node makes it implemented in the same edit', () => {
    const r = run(TESTED, { kind: 'updateNode', id: id('post-checks'), patch: { intent: 'More' } });
    expect(r.dropped).toEqual([id('post-checks')]);
    expect(byKey(r.text, 'post-checks').status).toBe('implemented');
    expect(byKey(r.text, 'pre-checks').status).toBe('tested');
  });

  it('positions, statuses and wiring are not the node design', () => {
    const moved = run(TESTED, {
      kind: 'moveNodes',
      positions: { [id('post-checks')]: { x: 9, y: 9 } },
    });
    expect(moved.dropped).toBeUndefined();
    expect(byKey(moved.text, 'post-checks').status).toBe('tested');
    const doc = parse(TESTED) as FlowDocument;
    const edge = doc.edges.find((e) => e.from.node === id('post-checks')) as { id: string };
    const cut = run(TESTED, { kind: 'disconnect', edge: edge.id });
    expect(cut.dropped).toBeUndefined();
  });

  it('a status set by the same command stays', () => {
    const r = run(TESTED, {
      kind: 'updateNode',
      id: id('post-checks'),
      patch: { intent: 'More', status: 'specified' },
    });
    expect(r.dropped).toBeUndefined();
    expect(byKey(r.text, 'post-checks').status).toBe('specified');
  });

  it('a change inside a tested subflow drops the inner node and the subflow', () => {
    const r = run(TESTED, { kind: 'updateNode', id: id('reload'), patch: { title: 'Reboot' } });
    expect(r.dropped?.sort()).toEqual([id('reload'), id('upgrade-os')].sort());
    expect(byKey(r.text, 'upgrade-os').status).toBe('implemented');
    expect(byKey(r.text, 'stage-image').status).toBe('tested');
  });

  it('inner statuses alone do not change the subflow design', () => {
    const before = parse(TESTED) as FlowDocument;
    const after = parse(
      run(TESTED, { kind: 'setStatuses', statuses: { [id('reload')]: 'implemented' } }).text,
    ) as FlowDocument;
    expect(testedDropBack(before, after)).toEqual([]);
    expect(nodeDesigns(after)[id('upgrade-os')]).toBe(nodeDesigns(before)[id('upgrade-os')]);
  });
});

describe('save', () => {
  it('a hand edit of a tested node drops it once, next to the version bump', () => {
    const hand = TESTED.replace('title: Post-checks', 'title: Post-checks by hand');
    const plan = planSave(hand, TESTED, TESTED);
    expect(plan.dropped).toEqual([id('post-checks')]);
    const saved = applyEdits(hand, plan.edits);
    expect(byKey(saved, 'post-checks').status).toBe('implemented');
    const version = (parse(TESTED) as FlowDocument).flow.version;
    expect((parse(saved) as FlowDocument).flow.version).toBe(version + 1);
    // Saving again: nothing left to drop, and the version moved once relative to the base.
    expect(planSave(saved, saved, TESTED).edits).toEqual([]);
  });

  it('marking nodes tested and saving keeps them tested', () => {
    const plan = planSave(TESTED, OS, OS);
    expect(plan.dropped).toEqual([]);
    expect(nodes(applyEdits(TESTED, plan.edits)).filter((n) => n.status === 'tested')).toHaveLength(
      nodes(TESTED).filter((n) => n.status === 'tested').length,
    );
  });
});

describe('tested proposals', () => {
  const doc = parse(OS) as FlowDocument;
  const passed: RunView = {
    id: 'r1',
    mode: 'real',
    state: 'done',
    rc: 0,
    startedAt: '2026-10-29T08:00:00Z',
    flowVersion: doc.flow.version,
    design: nodeDesigns(doc),
    summary: {
      nodes: {
        [id('pre-checks')]: { ok_hosts: ['h01'] },
        [id('post-checks')]: { ok_hosts: ['h01'] },
      },
      hosts: ['h01'],
      outcome: {},
      failures: [],
      unreachable: [],
      stoppedEarly: false,
    },
  };

  it('a node changed after the run started is not proposed', () => {
    expect(testedCandidates(doc, passed).sort()).toEqual(
      [id('pre-checks'), id('post-checks')].sort(),
    );
    const changed = parse(
      run(OS, { kind: 'updateNode', id: id('post-checks'), patch: { intent: 'Later' } }).text,
    ) as FlowDocument;
    expect(testedCandidates(changed, passed)).toEqual([id('pre-checks')]);
  });
});

describe('tested by hand (AFD-44)', () => {
  const decisions = (text: string) => (parse(text) as FlowDocument).decisions ?? [];
  const node = () => byKey(OS, 'stage-image').id;

  it('takes a reason: a plain status edit to tested is refused', () => {
    expect(() =>
      planCommand(OS, { kind: 'updateNode', id: node(), patch: { status: 'tested' } }, ctx),
    ).toThrow('Say why it counts as tested');
  });

  it('marks it tested with the reason and the author, in one edit', () => {
    const r = run(OS, { kind: 'markTested', id: node(), reason: 'Ran in the lab', by: 'Jane' });
    expect(byKey(r.text, 'stage-image').status).toBe('tested');
    expect(decisions(r.text)).toContainEqual({
      kind: 'finding_accepted',
      finding: testedFinding(node()),
      node: node(),
      reason: 'Ran in the lab',
      by: 'Jane',
    });
  });

  it('another status or a design change drops the record with the status', () => {
    const marked = run(OS, { kind: 'markTested', id: node(), reason: 'Ran in the lab' }).text;
    const back = run(marked, { kind: 'updateNode', id: node(), patch: { status: 'implemented' } });
    expect(decisions(back.text).some((d) => d.kind === 'finding_accepted')).toBe(false);
    const changed = run(marked, { kind: 'updateNode', id: node(), patch: { title: 'Stage it' } });
    expect(changed.dropped).toEqual([node()]);
    expect(decisions(changed.text).some((d) => d.kind === 'finding_accepted')).toBe(false);
  });
});

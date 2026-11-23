// AFD-283: two people change one flow apart; the merge brings what they did in different places
// together on its own, names what they did in the same place, and keeps the rules a merge could
// break (a step removed but changed, two wires on one port). Written over "ours", the file keeps
// its comments.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { fieldWords, mergeFlows } from '../../../src/core/flow/merge';
import { writeMergedFlow } from '../../../src/core/flow/mergeText';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const BASE = readExample('edge-baseline.flow.yaml');
const doc = (text: string) => parse(text) as FlowDocument;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const entry = (d: FlowDocument | string, key: string) =>
  [...buildModel(typeof d === 'string' ? doc(d) : d).nodes.values()].find(
    (e) => e.node.key === key,
  );
const id = (text: string, key: string) => entry(text, key)?.node.id as string;
const errors = (d: FlowDocument) =>
  validateFlow(d)
    .findings.filter((f) => f.severity === 'error')
    .map((f) => f.code);

describe('mergeFlows (AFD-283)', () => {
  it('changes in different places come together, and the file keeps its comments', () => {
    const ours = run(`# Owned by the edge team\n${BASE}`, {
      kind: 'updateNode',
      id: id(BASE, 'validate'),
      patch: { title: 'Validate the baseline', settings: { retries: 2 } },
    });
    const added = planCommand(
      BASE,
      { kind: 'addNode', type: 'task', title: 'Check NTP', insertOn: undefined },
      ctx,
    ).text;
    let theirs = run(added, {
      kind: 'updateNode',
      id: id(added, 'validate'),
      patch: { settings: { timeout: '5m' } },
    });
    theirs = run(theirs, {
      kind: 'updateNode',
      id: id(theirs, 'backup-config'),
      patch: { title: 'Back up the config' },
    });
    const merged = mergeFlows(doc(BASE), doc(ours), doc(theirs));
    expect(merged.conflicts).toEqual([]);
    const validate = entry(merged.doc, 'validate')?.node;
    expect(validate?.title).toBe('Validate the baseline');
    expect(validate?.settings).toMatchObject({ retries: 2, timeout: '5m' });
    expect(entry(merged.doc, 'backup-config')?.node.title).toBe('Back up the config');
    expect(entry(merged.doc, 'check-ntp')).toBeTruthy();
    expect(errors(merged.doc)).toEqual(errors(doc(theirs)));

    const text = writeMergedFlow(ours, merged.doc);
    expect(text.startsWith('# Owned by the edge team\n')).toBe(true);
    expect(entry(text, 'check-ntp')).toBeTruthy();
    expect(entry(text, 'backup-config')?.node.title).toBe('Back up the config');
    // Merging again changes nothing: what is written is what was merged.
    expect(mergeFlows(doc(BASE), doc(text), doc(theirs)).conflicts).toEqual([]);
    expect(writeMergedFlow(text, mergeFlows(doc(BASE), doc(text), doc(theirs)).doc)).toBe(text);
  });

  it('the same field changed differently is a conflict: ours until chosen', () => {
    const v = id(BASE, 'validate');
    const ours = run(BASE, { kind: 'updateNode', id: v, patch: { title: 'Validate it' } });
    const theirs = run(BASE, { kind: 'updateNode', id: v, patch: { title: 'Check it' } });
    const merged = mergeFlows(doc(BASE), doc(ours), doc(theirs));
    expect(merged.conflicts).toEqual([
      expect.objectContaining({
        id: `node:${v}:title`,
        kind: 'value',
        node: v,
        field: 'title',
        label: 'Validate it: Title',
        base: 'Validate',
        ours: 'Validate it',
        theirs: 'Check it',
      }),
    ]);
    expect(entry(merged.doc, 'validate')?.node.title).toBe('Validate it');
    const chosen = mergeFlows(doc(BASE), doc(ours), doc(theirs), { [`node:${v}:title`]: 'theirs' });
    expect(entry(chosen.doc, 'validate')?.node.title).toBe('Check it');
    // The conflict is still listed, with what was chosen applied.
    expect(chosen.conflicts.map((c) => c.id)).toEqual([`node:${v}:title`]);
  });

  it("AFS-232: a conflict names the field as the panel does, not by the file's word", () => {
    const v = id(BASE, 'validate');
    const ours = run(BASE, { kind: 'updateNode', id: v, patch: { intent: 'Check twice' } });
    const theirs = run(BASE, { kind: 'updateNode', id: v, patch: { intent: 'Check once' } });
    const [c] = mergeFlows(doc(BASE), doc(ours), doc(theirs)).conflicts;
    expect(c?.label).toBe('Validate: What it does');
    expect(c?.field).toBe('intent');
    expect(fieldWords('impl.params.msg')).toBe('Binding (params.msg)');
    expect(fieldWords('approval.approvers')).toBe('Approvers');
    expect(fieldWords('somethingnew')).toBe('somethingnew');
  });

  it('a step removed on one side and changed on the other is a conflict', () => {
    const r = id(BASE, 'rollback');
    const ours = run(BASE, { kind: 'deleteNodes', ids: [r] });
    const theirs = run(BASE, { kind: 'updateNode', id: r, patch: { title: 'Roll back' } });
    const merged = mergeFlows(doc(BASE), doc(ours), doc(theirs));
    expect(merged.conflicts).toEqual([
      expect.objectContaining({ id: `node:${r}`, kind: 'removed', ours: 'removed' }),
    ]);
    expect(entry(merged.doc, 'rollback')).toBeUndefined();
    const kept = mergeFlows(doc(BASE), doc(ours), doc(theirs), { [`node:${r}`]: 'theirs' });
    expect(entry(kept.doc, 'rollback')?.node.title).toBe('Roll back');
    // Removed on one side and untouched on the other: just gone.
    const quiet = mergeFlows(doc(BASE), doc(ours), doc(BASE));
    expect(quiet.conflicts).toEqual([]);
    expect(entry(quiet.doc, 'rollback')).toBeUndefined();
    expect(quiet.doc.edges.some((e) => e.from.node === r || e.to.node === r)).toBe(false);
  });

  it('two wires on one output port are a conflict; the choice keeps one side', () => {
    const base = doc(BASE);
    const free = base.edges[0] as FlowDocument['edges'][number];
    base.edges = base.edges.slice(1);
    const ours = structuredClone(base);
    ours.edges.push({ ...free, id: '01KQQQQQQQQQQQQQQQQQQQQQQ1' });
    const theirs = structuredClone(base);
    const elsewhere = id(BASE, 'failed');
    theirs.edges.push({
      id: '01KQQQQQQQQQQQQQQQQQQQQQQ2',
      from: free.from,
      to: { node: elsewhere, port: 'in' },
    });
    const merged = mergeFlows(base, ours, theirs);
    expect(merged.conflicts.map((c) => [c.id, c.kind])).toEqual([
      [`port:${free.from.node}.${free.from.port}`, 'wire'],
    ]);
    const from = (d: FlowDocument) =>
      d.edges.filter((e) => e.from.node === free.from.node && e.from.port === free.from.port);
    expect(from(merged.doc).map((e) => e.id)).toEqual(['01KQQQQQQQQQQQQQQQQQQQQQQ1']);
    const theirsWin = mergeFlows(base, ours, theirs, {
      [`port:${free.from.node}.${free.from.port}`]: 'theirs',
    });
    expect(from(theirsWin.doc).map((e) => e.id)).toEqual(['01KQQQQQQQQQQQQQQQQQQQQQQ2']);
  });

  it('a step moved into a subflow on one side keeps what the other side changed', () => {
    const b = id(BASE, 'backup-config');
    const ours = run(BASE, { kind: 'extractSubflow', nodes: [b], title: 'Safety' });
    const theirs = run(BASE, {
      kind: 'updateNode',
      id: b,
      patch: { title: 'Back up the config' },
    });
    const merged = mergeFlows(doc(BASE), doc(ours), doc(theirs));
    expect(merged.conflicts).toEqual([]);
    const moved = entry(merged.doc, 'backup-config');
    expect(moved?.node.title).toBe('Back up the config');
    expect(moved?.level).toBe(id(ours, 'safety'));
    expect(errors(merged.doc)).toEqual([]);
  });

  it("the flow's version moves past both when both moved it; formats must match", () => {
    const ours = doc(BASE);
    const theirs = doc(BASE);
    const base = doc(BASE);
    ours.flow.version = base.flow.version + 1;
    theirs.flow.version = base.flow.version + 1;
    ours.flow.goal = 'Ours';
    theirs.flow.owner = 'netops';
    const merged = mergeFlows(base, ours, theirs);
    expect(merged.doc.flow).toMatchObject({
      version: base.flow.version + 1,
      goal: 'Ours',
      owner: 'netops',
    });
    theirs.flow.version = base.flow.version + 2;
    expect(mergeFlows(base, ours, theirs).doc.flow.version).toBe(base.flow.version + 3);
    theirs.schema_version = theirs.schema_version === 2 ? 1 : 2;
    expect(mergeFlows(base, ours, theirs).conflicts.map((c) => c.kind)).toEqual(['format']);
  });
});

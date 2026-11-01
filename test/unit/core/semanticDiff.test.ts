// AFD-57: what changed between two versions of a flow, node by node, and the Changes lens over it.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { diffFlows } from '../../../src/core/flow/semanticDiff';
import type { FlowDocument } from '../../../src/core/flow/types';
import { changesLens } from '../../../src/core/lens/changes';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const EDGE = readExample('edge-baseline.flow.yaml');
const doc = (text: string) => parse(text) as FlowDocument;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const id = (text: string, key: string) =>
  [...buildModel(doc(text)).nodes.values()].find((e) => e.node.key === key)?.node.id as string;
const ready = (base: string) => ({
  state: 'ready' as const,
  ref: 'HEAD',
  label: 'HEAD (main)',
  refs: [{ ref: 'HEAD', label: 'HEAD (main)' }],
  base: doc(base),
});

describe('diffFlows (AFD-57)', () => {
  it('finds the nodes added, removed and changed (with their fields), and the wires', () => {
    const added = planCommand(
      EDGE,
      { kind: 'addNode', type: 'task', title: 'Check NTP', insertOn: undefined },
      ctx,
    );
    let text = run(added.text, {
      kind: 'connect',
      from: { node: id(added.text, 'check-ntp'), port: 'ok_hosts' },
      to: { node: id(added.text, 'done'), port: 'in' },
    });
    text = run(text, {
      kind: 'updateNode',
      id: id(text, 'validate'),
      patch: { title: 'Validate the baseline', settings: { retries: 2 } },
    });
    text = run(text, { kind: 'deleteNodes', ids: [id(text, 'rollback')] });
    const diff = diffFlows(doc(EDGE), doc(text));
    const by = (kind: string) => diff.nodes.filter((n) => n.kind === kind).map((n) => n.key);
    expect(by('added')).toEqual(['check-ntp']);
    expect(by('removed')).toEqual(['rollback']);
    const validate = diff.nodes.find((n) => n.key === 'validate');
    expect(validate?.fields.map((f) => f.field).sort()).toEqual(['settings', 'title']);
    expect(validate?.fields.find((f) => f.field === 'title')).toMatchObject({
      before: 'Validate',
      after: 'Validate the baseline',
    });
    expect(diff.wires.filter((w) => w.kind === 'added').map((w) => w.label)).toEqual([
      'check-ntp.ok_hosts → done',
    ]);
    expect(diff.wires.filter((w) => w.kind === 'removed').length).toBeGreaterThan(0);
    expect(diff.flow).toEqual([]);
  });

  it('the format upgrade alone shows as the format, not as every node changing its handler', () => {
    const up = run(EDGE, { kind: 'upgradeFormat' });
    const diff = diffFlows(doc(EDGE), doc(up));
    expect(diff.flow.map((f) => f.field)).toContain('format');
    expect(diff.nodes.flatMap((n) => n.fields.map((f) => f.field))).not.toContain('purpose');
  });

  it('a step moved into a subflow changed its level; a flow given IDs matches by key path', () => {
    const extracted = run(EDGE, {
      kind: 'extractSubflow',
      nodes: [id(EDGE, 'backup-config')],
      title: 'Backup',
    });
    const moved = diffFlows(doc(EDGE), doc(extracted)).nodes.find((n) => n.key === 'backup-config');
    expect(moved?.fields[0]).toEqual({ field: 'level', before: 'top level', after: 'Backup' });
    // The same flow, once without and once with real IDs, has no node changes.
    const byKey = doc(EDGE);
    const stripped = structuredClone(byKey);
    for (const n of stripped.nodes) delete (n as { id?: string }).id;
    const keyed = doc(EDGE);
    for (const e of keyed.edges) {
      e.from.node = byKey.nodes.find((n) => n.id === e.from.node)?.key as string;
      e.to.node = byKey.nodes.find((n) => n.id === e.to.node)?.key as string;
    }
    stripped.edges = keyed.edges.map(({ id: _id, ...e }) => e) as typeof keyed.edges;
    delete stripped.layout;
    delete stripped.decisions;
    const withIdsNow = structuredClone(byKey);
    delete withIdsNow.layout;
    delete withIdsNow.decisions;
    const same = diffFlows(stripped, withIdsNow);
    expect(same.nodes).toEqual([]);
    expect(same.wires).toEqual([]);
  });
});

describe('Changes lens (AFD-57)', () => {
  it('chips added and changed nodes, ghosts removed ones, and lists every change', () => {
    let text = run(EDGE, { kind: 'updateNode', id: id(EDGE, 'validate'), patch: { title: 'V2' } });
    text = run(text, { kind: 'deleteNodes', ids: [id(text, 'rollback')] });
    const view = changesLens(doc(text), ready(EDGE));
    expect(view.chips[id(text, 'validate')]?.[0]?.text).toBe('changed: title');
    expect(view.ghosts?.map((g) => g.title)).toEqual(['Rollback']);
    expect(view.stats).toContainEqual({ label: 'Compared with', value: 'HEAD (main)' });
    expect(view.sections.map((s) => [s.title, s.items.length])).toEqual([
      ['Changed', 1],
      ['Added', 0],
      ['Removed', 1],
      ['Wires', view.sections[3]?.items.length],
      ['Flow', 0],
    ]);
    expect(changesLens(doc(EDGE), ready(EDGE)).notes).toEqual(['No changes since HEAD (main)']);
    expect(
      changesLens(doc(EDGE), { ...ready(EDGE), state: 'error', base: undefined, error: 'no repo' })
        .notes,
    ).toEqual(['no repo']);
  });

  it('a subflow says how many changes are inside it', () => {
    const OS = readExample('os-upgrade.flow.yaml');
    const text = run(OS, {
      kind: 'updateNode',
      id: id(OS, 'reload'),
      patch: { intent: 'Reload in batches' },
    });
    const view = changesLens(doc(text), ready(OS));
    expect(view.chips[id(text, 'upgrade-os')]?.map((c) => c.text)).toContain('1 change inside');
  });
});

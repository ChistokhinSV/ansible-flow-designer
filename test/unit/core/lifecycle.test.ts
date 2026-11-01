// AFD-50: the status lifecycle in format 2. The status follows what a node has, for every writer;
// tested needs a record (a run, or a reason by hand) and goes with a design change; a subflow is as
// far as its steps; the runtime kind is worked out from the flow. The upgrade brings a format 1
// file there, keeping why tested nodes are tested.
import { describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { upgradeNotes } from '../../../src/core/flow/migrate';
import { buildModel } from '../../../src/core/flow/model';
import { runtimeKind } from '../../../src/core/flow/status';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const ctx = { newId: createIdFactory() };
const V1 = readExample('edge-baseline.flow.yaml');
const V2 = planCommand(V1, { kind: 'upgradeFormat' }, ctx).text;
const run = (text: string, cmd: FlowCommand) => planCommand(text, cmd, ctx).text;
const nodeOf = (text: string, key: string): FlowNode => {
  for (const { node } of buildModel(parse(text) as FlowDocument).nodes.values())
    if (node.key === key) return node;
  throw new Error(`no node ${key}`);
};
const id = (key: string) => nodeOf(V2, key).id;
const ping = { kind: 'module' as const, ref: 'ansible.builtin.ping' };
const refused = (text: string, cmd: FlowCommand): string => {
  try {
    planCommand(text, cmd, ctx);
  } catch (e) {
    if (e instanceof CommandError) return e.code;
    throw e;
  }
  return 'accepted';
};

describe('the upgrade (format 1 → 2)', () => {
  it('sets each status from the content, keeps the AWX template, and says so first', () => {
    const notes = upgradeNotes(parse(V1) as FlowDocument);
    expect(notes.join(' | ')).toMatch(
      /status(es)? follow what the nodes have \(Pre-checks → specified/,
    );
    expect(notes).toContain('the runtime kind is worked out from the flow');
    expect(nodeOf(V1, 'precheck').status).toBe('draft');
    expect(nodeOf(V2, 'precheck').status).toBe('specified');
    const flow = (parse(V2) as FlowDocument).flow;
    expect(flow.runtime).toEqual({ template: 'AFD · edge-baseline' });
  });

  it('keeps why a tested node is tested: the reason by hand, else that it predates run records', () => {
    const doc = parse(V1) as FlowDocument;
    const pushId = doc.nodes.find((n) => n.key === 'push-baseline')?.id as string;
    const backup = doc.nodes.find((n) => n.key === 'backup-config') as FlowNode;
    const withTested = structuredClone(doc);
    for (const n of withTested.nodes) {
      if (n.id === pushId) n.status = 'tested';
      // Tested by hand but not even bound: the content wins.
      if (n.id === backup.id) n.status = 'tested';
    }
    withTested.decisions = [
      ...(withTested.decisions ?? []),
      {
        kind: 'finding_accepted',
        finding: `status:tested|${pushId}`,
        node: pushId,
        reason: 'Ran it on the lab switches',
        by: 'Pat',
      },
    ];
    const up = run(stringify(withTested), { kind: 'upgradeFormat' });
    expect(nodeOf(up, 'push-baseline')).toMatchObject({
      status: 'tested',
      tested: { reason: 'Ran it on the lab switches', by: 'Pat' },
    });
    expect(nodeOf(up, 'backup-config').status).toBe('specified');
    expect(nodeOf(up, 'backup-config').tested).toBeUndefined();
    const left = (parse(up) as FlowDocument).decisions ?? [];
    expect(left.some((d) => d.kind === 'finding_accepted')).toBe(false);

    const unrecorded = structuredClone(doc);
    for (const n of unrecorded.nodes) if (n.id === pushId) n.status = 'tested';
    const plain = run(stringify(unrecorded), { kind: 'upgradeFormat' });
    expect(nodeOf(plain, 'push-baseline').tested).toEqual({
      reason: 'Tested in flow format 1, before runs were recorded',
      flow_version: doc.flow.version,
    });
  });
});

describe('format 2: the status follows the content, for every writer', () => {
  it('a binding implements, unbinding goes back to what the contract gives', () => {
    const bound = run(V2, { kind: 'setBinding', id: id('precheck'), impl: ping });
    expect(nodeOf(bound, 'precheck').status).toBe('implemented');
    const unbound = run(bound, { kind: 'setBinding', id: id('precheck'), impl: null });
    expect(nodeOf(unbound, 'precheck').status).toBe('specified');
  });

  it('a status by hand is refused, except the one the content gives (which clears tested)', () => {
    expect(
      refused(V2, { kind: 'updateNode', id: id('precheck'), patch: { status: 'implemented' } }),
    ).toBe('status-follows-content');
    const tested = run(run(V2, { kind: 'setBinding', id: id('precheck'), impl: ping }), {
      kind: 'markTested',
      id: id('precheck'),
      reason: 'Checked by hand',
      by: 'Pat',
      at: '2026-11-01',
    });
    expect(nodeOf(tested, 'precheck')).toMatchObject({
      status: 'tested',
      tested: { reason: 'Checked by hand', by: 'Pat', at: '2026-11-01' },
    });
    const cleared = run(tested, {
      kind: 'updateNode',
      id: id('precheck'),
      patch: { status: 'implemented' },
    });
    expect(nodeOf(cleared, 'precheck').status).toBe('implemented');
    expect(nodeOf(cleared, 'precheck').tested).toBeUndefined();
  });

  it('only implemented content can be tested; a design change drops it with its record', () => {
    expect(refused(V2, { kind: 'markTested', id: id('precheck'), reason: 'x' })).toBe(
      'not-implemented',
    );
    const tested = run(run(V2, { kind: 'setBinding', id: id('precheck'), impl: ping }), {
      kind: 'markTested',
      id: id('precheck'),
      reason: 'Checked by hand',
    });
    const changed = run(tested, {
      kind: 'setBinding',
      id: id('precheck'),
      impl: { kind: 'module', ref: 'ansible.builtin.debug' },
    });
    expect(nodeOf(changed, 'precheck').status).toBe('implemented');
    expect(nodeOf(changed, 'precheck').tested).toBeUndefined();
  });

  it('a passing run records itself on each node; without the run it is refused', () => {
    const statuses = { [id('push-baseline')]: 'tested' as const };
    expect(refused(V2, { kind: 'setStatuses', statuses })).toBe('needs-run');
    const ran = run(V2, {
      kind: 'setStatuses',
      statuses,
      run: { id: 'r7', flowVersion: 3, commit: 'abc1234' },
    });
    expect(nodeOf(ran, 'push-baseline')).toMatchObject({
      status: 'tested',
      tested: { run: 'r7', flow_version: 3, commit: 'abc1234' },
    });
    expect(validateFlow(parse(ran) as FlowDocument).findings.map((f) => f.code)).not.toContain(
      'tested-without-record',
    );
  });

  it('a decision is implemented by its condition; a subflow is as far as its steps', () => {
    // On the wire out of Pre-checks, so the two can be extracted together.
    const wire = (parse(V2) as FlowDocument).edges.find((e) => e.from.node === id('precheck'));
    const added = planCommand(
      V2,
      { kind: 'addNode', type: 'decision', title: 'Is it an edge?', insertOn: wire?.id },
      ctx,
    );
    const decision = added.created as string;
    expect(nodeOf(added.text, 'is-it-an-edge').status ?? 'draft').toBe('draft');
    const set = run(added.text, {
      kind: 'updateNode',
      id: decision,
      patch: { condition: "inventory_hostname is match('sw-edge')" },
    });
    expect(nodeOf(set, 'is-it-an-edge').status).toBe('implemented');
    const extracted = planCommand(
      set,
      { kind: 'extractSubflow', nodes: [id('precheck'), decision], title: 'Checks' },
      ctx,
    );
    // Its steps: precheck (specified) and the decision (implemented): the lowest is specified.
    expect(nodeOf(extracted.text, 'checks').status).toBe('specified');
  });

  it('the node menu offers Mark Tested… on implemented content and Clear Tested on tested', () => {
    const bound = run(V2, { kind: 'setBinding', id: id('precheck'), impl: ping });
    const labels = (text: string) =>
      canvasMenu(
        buildModel(parse(text) as FlowDocument),
        { kind: 'node', id: id('precheck') },
        { mode: 'design', level: 'root', stale: false, openPorts: [], hasPlay: () => true },
      )
        .flatMap((e) => (e.type === 'item' ? [e.label] : e.type === 'submenu' ? [e.label] : []))
        .filter((l) => /Tested|Status/.test(l));
    expect(labels(V2)).toEqual([]);
    expect(labels(bound)).toEqual(['Mark Tested…']);
    const tested = run(bound, { kind: 'markTested', id: id('precheck'), reason: 'ok' });
    expect(labels(tested)).toEqual(['Clear Tested']);
    expect(labels(V1)).toEqual(['Status']);
  });
});

describe('format 2: where the flow runs', () => {
  it('AWX when a template is named (a job without approvals), else a playbook run', () => {
    const doc = parse(V2) as FlowDocument;
    expect(runtimeKind(buildModel(doc))).toBe('awx_job');
    const local = { ...doc, flow: { ...doc.flow, runtime: undefined } };
    expect(runtimeKind(buildModel(local))).toBe('ansible_playbook');
    // Format 1 says what it stores.
    expect(runtimeKind(buildModel(parse(V1) as FlowDocument))).toBe('awx_workflow');
    const written = { ...doc, flow: { ...doc.flow, runtime: { kind: 'awx_job' as const } } };
    expect(validateFlow(written).findings.map((f) => f.code)).toContain('runtime-kind');
  });
});

// AFD-11: AWX workflow segments at top-level approvals. The engine suite chains the segment runs
// like AWX does (test/engine); here: the plan, the shape of the segment playbooks, the validator.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { planSegments } from '../../../src/core/engine/segments';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';

const ROOT = join(__dirname, '../../..');
const load = (path: string) => parse(readFileSync(join(ROOT, path), 'utf8')) as FlowDocument;
const SEG = 'test/fixtures/engine/approval-segments.flow.yaml';
type Play = { name?: string; hosts?: string; tasks?: Record<string, unknown>[] };

function plan(doc: FlowDocument) {
  const p = planSegments(buildModel(doc));
  const keys = new Map(doc.nodes.map((n) => [n.id, n.key]));
  return {
    p,
    members: Object.fromEntries(
      (p?.segments ?? []).map((s) => [s.name, [...s.nodes].map((id) => keys.get(id)).sort()]),
    ),
  };
}

describe('segment plan', () => {
  it('flows without approvals have none', () => {
    expect(planSegments(buildModel(load('examples/edge-baseline.flow.yaml')))).toBeUndefined();
  });

  it('a gate splits into start, approved, rejected and finish; shared nodes are in each side', () => {
    const { p, members } = plan(load(SEG));
    expect(p?.problems).toEqual([]);
    expect(members).toEqual({
      start: ['check', 'failed', 'gate', 'notify'],
      'gate-approved': ['change', 'done', 'failed', 'rollback'],
      'gate-rejected': ['failed', 'notify'],
      finish: [],
    });
    const byName = Object.fromEntries((p?.segments ?? []).map((s) => [s.name, s]));
    expect(byName.start?.gate).toBe(load(SEG).nodes.find((n) => n.key === 'gate')?.id);
    expect(byName['gate-rejected']?.entry?.outcome).toBe('rejected');
    expect(byName['gate-approved']?.parent).toBe('start');
  });

  it('the examples split where their approvals are', () => {
    expect(Object.keys(plan(load('examples/os-upgrade.flow.yaml')).members)).toEqual([
      'start',
      'change-approval-approved',
      'change-approval-rejected',
      'finish',
    ]);
    // The M9 import: notify is reachable before the approval and on both sides of it.
    const imported = plan(load('test/fixtures/awx/import/edge-upgrade.flow.yaml')).members;
    for (const seg of ['start', 'approve-approved', 'approve-rejected'])
      expect(imported[seg], seg).toContain('afd-fixture-notify-on-call');
  });

  it('two approvals waiting at once, and approvals inside subflows, are problems', () => {
    const doc = load(SEG);
    const check = doc.nodes.find((n) => n.key === 'check') as FlowNode;
    // A second gate on check's failure path: both can wait at the same time.
    const second: FlowNode = {
      id: '01JCRBN000000000000000000Z',
      key: 'second',
      type: 'approval',
      title: 'Second gate',
    };
    doc.nodes.push(second);
    const edge = doc.edges.find((e) => e.from.node === check.id && e.from.port === 'failed_hosts');
    if (edge) edge.to.node = second.id;
    expect(plan(doc).p?.problems.map((x) => x.message)).toEqual([
      '"Approve the change" and "Second gate" can wait for approval at the same time: an AWX workflow runs one approval at a time',
    ]);
    const inner = load('examples/os-upgrade.flow.yaml');
    const sub = inner.nodes.find((n) => n.subflow?.nodes?.length) as FlowNode;
    sub.subflow?.nodes?.push({
      id: '01JCRBN000000000000000000Y',
      key: 'inner-gate',
      type: 'approval',
      title: 'Inner gate',
    });
    expect(plan(inner).p?.problems.map((x) => x.message)).toContain(
      '"Inner gate" is inside a subflow: AWX workflows split at top-level approvals only',
    );
  });
});

describe('segment playbooks', () => {
  const doc = load(SEG);
  const out = optionA.generate(doc, { source: 'approval-segments.flow.yaml' });
  const file = (name: string) =>
    parse(
      out.files.find((f) => f.name === `approval-segments.seg_${name}.yml`)?.text ?? '',
    ) as Play[];

  it('are generated after the level files, one per segment', () => {
    expect(out.ok).toBe(true);
    expect(out.files.map((f) => f.name)).toEqual([
      'approval-segments.yml',
      'approval-segments.seg_start.yml',
      'approval-segments.seg_gate-approved.yml',
      'approval-segments.seg_gate-rejected.yml',
      'approval-segments.seg_finish.yml',
    ]);
    expect(out.segments?.map((s) => [s.name, !!s.gate, !!s.finish])).toEqual([
      ['start', true, false],
      ['gate-approved', false, false],
      ['gate-rejected', false, false],
      ['finish', false, true],
    ]);
  });

  it('start: the gate parks its hosts; carry, then stop when nobody waits; no outcome', () => {
    const plays = file('start');
    expect(plays.map((p) => p.name)).toEqual([
      '[check] Check the change window',
      '[gate] Approve the change',
      '[notify] Notify on-call',
      '[approval-segments] Segment start: carry host sets',
    ]);
    expect(plays[1]?.tasks).toEqual([
      {
        name: '[gate] wait for approval in AWX',
        'ansible.builtin.group_by': { key: 'flow_gate_waiting' },
      },
    ]);
    const carry = plays[3]?.tasks?.[0]?.['ansible.builtin.set_stats'] as {
      data: { afd_hostsets: Record<string, string> };
    };
    // The hosts at the gate, and every group the outcome fails (failed end, open fail ports).
    expect(Object.keys(carry.data.afd_hostsets).sort()).toEqual([
      'flow_gate_waiting',
      'flow_notify_failed_hosts',
      'flow_notify_ok_hosts',
      'flow_rollback_failed_hosts',
      'flow_rollback_ok_hosts',
    ]);
    expect(plays[3]?.tasks?.[1]?.when).toBe(
      "groups['flow_gate_waiting'] | default([]) | length == 0",
    );
  });

  it('continuations restore, route the waiting hosts, and end in the whole outcome', () => {
    const approved = file('gate-approved');
    expect(approved.map((p) => p.name)).toEqual([
      '[approval-segments] Segment gate-approved: restore host sets',
      '[gate] Approve the change: route',
      '[change] Apply the change',
      '[rollback] Rollback',
      '[approval-segments] Outcome',
    ]);
    expect(approved[1]?.hosts).toBe(
      "{{ groups['flow_gate_waiting'] | default([]) | join(',') or 'afd_no_hosts' }}",
    );
    expect(approved[1]?.tasks?.[0]?.['ansible.builtin.group_by']).toEqual({
      key: 'flow_gate_approved',
    });
    const rejected = file('gate-rejected');
    expect(rejected[1]?.tasks?.[0]?.['ansible.builtin.group_by']).toEqual({
      key: 'flow_gate_rejected',
    });
    // The whole flow's outcome: hosts that failed before the gate fail here too.
    const whole = parse(out.files[0]?.text ?? '') as Play[];
    expect(approved.at(-1)?.hosts).toBe(whole.at(-1)?.hosts);
  });

  it('finish runs only after an empty gate, then the outcome', () => {
    const plays = file('finish');
    expect(plays.map((p) => p.name)).toEqual([
      '[approval-segments] Segment finish: restore host sets',
      '[approval-segments] Outcome',
    ]);
    expect(plays[0]?.tasks?.[1]?.when).toBe('not (afd_gate_empty | default(false) | bool)');
  });

  it('local runs keep the single playbook, auto-approved', () => {
    const whole = parse(out.files[0]?.text ?? '') as Play[];
    expect(whole.find((p) => p.name === '[gate] Approve the change')?.tasks?.[0]?.name).toBe(
      '[gate] local approval',
    );
  });
});

describe('validator', () => {
  it('segment problems warn, and fail an awx_workflow runtime; runtime kind follows the plan', () => {
    const doc = load(SEG);
    const second: FlowNode = {
      id: '01JCRBN000000000000000000Z',
      key: 'second',
      type: 'approval',
      title: 'Second gate',
    };
    doc.nodes.push(second);
    const check = doc.nodes.find((n) => n.key === 'check') as FlowNode;
    const edge = doc.edges.find((e) => e.from.node === check.id && e.from.port === 'failed_hosts');
    if (edge) edge.to.node = second.id;
    const sev = (d: FlowDocument) =>
      validateFlow(d)
        .findings.filter((f) => f.code === 'awx-segments')
        .map((f) => f.severity);
    expect(sev(doc)).toEqual(['warning']);
    doc.flow.runtime = { kind: 'awx_workflow', template: 'AFD · approval-segments' };
    expect(sev(doc)).toEqual(['error']);
    const ok = load(SEG);
    ok.flow.runtime = { kind: 'awx_job' };
    expect(validateFlow(ok).findings.find((f) => f.code === 'runtime-kind')?.message).toContain(
      'produces awx_workflow',
    );
  });
});

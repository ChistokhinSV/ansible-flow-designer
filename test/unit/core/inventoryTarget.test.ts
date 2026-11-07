// AFD-14: codegen applies settings.inventory_target. A node's work runs once on its target (or the
// nearest enclosing subflow's) and the arriving hosts leave together. The engine suite runs these
// plays for real (test/engine, `just test-engine`); here: their shape and the helpers.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { playNode } from '../../../src/core/awx/events';
import { optionA } from '../../../src/core/engine/optionA';
import { effectiveTargets, resolvePattern, targetUses } from '../../../src/core/engine/targets';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';

const FIXTURE = join(__dirname, '../../fixtures/engine/inventory-target.flow.yaml');
const base = () => parse(readFileSync(FIXTURE, 'utf8')) as FlowDocument;
type Play = Record<string, unknown> & {
  name?: string;
  hosts?: string;
  vars?: Record<string, unknown>;
  tasks?: Record<string, unknown>[];
};

function plays(doc: FlowDocument) {
  const out = optionA.generate(doc, { source: 'inventory-target.flow.yaml' });
  expect(out.ok, JSON.stringify(out.findings)).toBe(true);
  const all = out.files.flatMap((f) => parse(f.text) as Play[]);
  const of = (node: FlowNode) =>
    all.filter((p) => (p.tags as string[] | undefined)?.includes(`node_${node.id}`));
  return { out, all, of };
}
const find = (doc: FlowDocument, key: string) =>
  [...buildModel(doc).nodes.values()].find((n) => n.node.key === key)?.node as FlowNode;

describe('inventory_target in Option A', () => {
  const doc = base();
  const { of, out } = plays(doc);

  it('a node with a target gets three plays: arriving hosts, the work on the target, route', () => {
    const [arrive, work, route] = of(find(doc, 'drain'));
    expect(arrive).toMatchObject({
      name: '[drain] Drain the pool: arriving hosts',
      hosts: 'flow_precheck_ok_hosts',
      tasks: [{ 'ansible.builtin.group_by': { key: 'flow_drain_arriving' } }],
    });
    expect(work?.name).toBe('[drain] Drain the pool');
    expect(work?.hosts).toBe('{{ lb_group }}');
    expect(work?.vars?.afd_arriving).toBe("{{ groups['flow_drain_arriving'] | default([]) }}");
    expect(work?.tasks?.[0]).toEqual({
      name: '[drain] no host arrived',
      'ansible.builtin.meta': 'end_play',
      when: 'afd_arriving | length == 0',
    });
    expect(route?.hosts).toBe('flow_drain_arriving');
    expect(route?.vars?.afd_target_pattern).toBe('{{ lb_group }}');
    // max_fail_percentage 50 tolerates a share of the target; an empty target fails everyone.
    const routeTask = route?.tasks?.find((t) => String(t.name).startsWith('[drain] route'));
    expect((routeTask?.['ansible.builtin.group_by'] as { key: string } | undefined)?.key).toBe(
      "{{ 'flow_drain_failed_hosts' if (afd_target | length == 0 or (afd_target_failed | length) * 100 > 50 * (afd_target | length)) else 'flow_drain_ok_hosts' }}",
    );
  });

  it('inputs come from the first arriving host; outputs go back from the first finished target host', () => {
    const [, work, route] = of(find(doc, 'announce'));
    expect(work?.vars?.word).toBe('{{ hostvars[afd_arriving | first].afd_precheck__note }}');
    const facts = route?.tasks?.find((t) => t['ansible.builtin.set_fact']);
    expect(facts).toMatchObject({
      'ansible.builtin.set_fact': {
        announce_out: '{{ hostvars[afd_target_done | first].announce_out }}',
      },
      when: 'afd_target_done | length > 0',
    });
    // The consumer reads the copied register as usual.
    const [consume] = of(find(doc, 'consume'));
    expect(consume?.vars?.line).toBe('{{ announce_out.stdout }}');
  });

  it('inner steps inherit the subflow target; its decision stays on the arriving hosts', () => {
    expect(of(find(doc, 'quiesce')).map((p) => p.hosts)).toEqual([
      'flow_announce_ok_hosts',
      'lb',
      'flow_maint__quiesce_arriving',
    ]);
    const decision = of(find(doc, 'still-ok'));
    expect(decision).toHaveLength(1);
    expect(decision[0]?.hosts).toBe('flow_maint__quiesce_ok_hosts');
    expect(out.files.map((f) => f.name)).toEqual([
      'inventory-target.yml',
      'inventory-target.maint.yml',
    ]);
  });

  it('a timeout port routes on a target that timed out', () => {
    const d = base();
    const drain = find(d, 'drain');
    drain.ports = ['timeout'];
    drain.settings = { inventory_target: 'lb', timeout: '30s' };
    const [, work, route] = plays(d).of(drain);
    const block = work?.tasks?.[1] as { rescue: Record<string, { key: string }>[] };
    expect(block.rescue[0]?.['ansible.builtin.group_by']?.key).toContain(
      "'flow_drain_target_timeout' if",
    );
    const routeTask = route?.tasks?.find((t) => String(t.name).startsWith('[drain] route'));
    expect(routeTask?.name).toBe('[drain] route ok_hosts, failed_hosts, timeout');
  });

  it('a playbook binding runs on the target through afd_hosts; ports it cannot route are warned', () => {
    const d = base();
    const drain = find(d, 'drain');
    drain.impl = { kind: 'playbook', ref: 'playbooks/drain.yml' };
    drain.ports = ['unreachable'];
    const { of: ofD, out: o } = plays(d);
    const [arrive, imported, done, route] = ofD(drain);
    expect(arrive?.name).toBe('[drain] Drain the pool: arriving hosts');
    expect(imported?.import_playbook).toBe('../../../playbooks/drain.yml');
    expect(imported?.vars?.afd_hosts).toBe(
      "{{ (afd_arriving | length > 0) | ternary(afd_target_pattern, 'afd_no_hosts') }}",
    );
    expect(done?.name).toBe('[drain] Drain the pool: target done');
    expect(route?.name).toBe('[drain] Drain the pool: route');
    expect(o.findings.map((f) => f.code)).toContain('codegen-target-ports');
  });

  it('decisions, approvals, parallels and joins ignore it, with a validator warning', () => {
    const d = base();
    const decision = find(d, 'still-ok');
    decision.settings = { inventory_target: 'lb' };
    expect(effectiveTargets(buildModel(d)).has(decision.id)).toBe(false);
    expect(validateFlow(d).findings.filter((f) => f.code === 'inventory-target-ignored')).toEqual([
      expect.objectContaining({ node: decision.id, severity: 'warning' }),
    ]);
  });
});

describe('target helpers', () => {
  it('targetUses lists each target with its nodes, inherited ones included', () => {
    expect(targetUses(buildModel(base()))).toEqual([
      { target: '{{ lb_group }}', nodes: ['drain'] },
      { target: 'lb', nodes: ['announce', 'quiesce'] },
    ]);
  });

  it('resolvePattern fills in flow inputs and leaves other Jinja alone', () => {
    expect(resolvePattern('{{ lb_group }}', { lb_group: 'lb' })).toBe('lb');
    expect(resolvePattern("{{ devices | join(',') }}:&prod", { devices: ['a', 'b'] })).toBe(
      'a,b:&prod',
    );
    expect(resolvePattern('{{ groups.x | first }}', {})).toBeUndefined();
    expect(resolvePattern('edge_switches,core_spines', {})).toBe('edge_switches,core_spines');
  });

  it('AWX events map the extra plays of a node back to it', () => {
    const map = new Map([['[drain] Drain the pool', 'ID']]);
    expect(playNode(map, '[drain] Drain the pool')).toBe('ID');
    expect(playNode(map, '[drain] Drain the pool: arriving hosts')).toBe('ID');
    expect(playNode(map, '[drain] Drain the pool: route')).toBe('ID');
    expect(playNode(map, '[other] Thing: route')).toBeNull();
  });
});

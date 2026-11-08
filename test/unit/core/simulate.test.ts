// AFD-114: the scenario simulator. Where each host goes, per rule, on the engine fixtures; the
// differential suite (test/engine/simulate.test.ts) holds it to what Ansible does.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { matchHosts } from '../../../src/core/scenario/hostPattern';
import {
  blocking,
  checkScenarios,
  parseScenarios,
  type Scenario,
  targetsInput,
} from '../../../src/core/scenario/scenarios';
import { prepare, simulateRun, simulateScenario } from '../../../src/core/scenario/simulate';

const FIX = join(__dirname, '../../fixtures/engine');
const load = (name: string, dir = FIX) =>
  parse(readFileSync(join(dir, name), 'utf8')) as FlowDocument;
const LEVELS = load('routing-levels.flow.yaml');
const PORTS = load('routing-ports.flow.yaml');
const TARGET = load('inventory-target.flow.yaml');

/** Per host: every `key.port` it left through, as the engine tests read a run. */
function ports(doc: FlowDocument, s: Omit<Scenario, 'expect' | 'name'>) {
  const sim = simulateRun(doc, s);
  const keys = new Map([...buildModel(doc).nodes.values()].map((n) => [n.node.id, n.node.key]));
  const out: Record<string, string[]> = {};
  for (const [node, byPort] of Object.entries(sim.summary?.nodes ?? {}))
    for (const [port, hosts] of Object.entries(byPort))
      for (const h of hosts) out[h] = [...(out[h] ?? []), `${keys.get(node)}.${port}`];
  for (const list of Object.values(out)) list.sort();
  return { ports: out, sim, summary: sim.summary };
}

describe('the scenario simulator (AFD-114)', () => {
  it('passes the routing-levels scenarios and names a host ending elsewhere', () => {
    const file = parseScenarios(readFileSync(join(FIX, 'routing-levels.scenarios.yaml'), 'utf8'))
      .file as NonNullable<ReturnType<typeof parseScenarios>['file']>;
    const results = [
      ...file.scenarios,
      {
        name: 'wrong on purpose',
        inputs: { devices: ['h01'] },
        force: { gate: { failed: ['h01'] } },
        expect: { h01: 'done' },
      },
    ].map((s) => simulateScenario(LEVELS, s));
    expect(results.map((r) => [r.name, r.passed, r.error, r.engine, r.needsAnsible])).toEqual([
      ['every host goes through', true, undefined, 'simulated', undefined],
      [
        'hosts as comma-separated text, as an AWX survey answers',
        true,
        undefined,
        'simulated',
        undefined,
      ],
      [
        'a failed stage is handled, a failed gate stops the host there',
        true,
        undefined,
        'simulated',
        undefined,
      ],
      ['wrong on purpose', false, undefined, 'simulated', undefined],
    ]);
    expect(results[3]?.hosts).toEqual([
      { host: 'h01', expected: 'done', actual: 'gate.failed_hosts' },
    ]);
  });

  it('records a stub failure as the TODO task, with the intent as its message', () => {
    const { summary } = ports(LEVELS, {
      inputs: { devices: ['h01', 'h02'] },
      force: { 'stage/prepare': { failed: ['h02'] } },
    });
    const prepare = LEVELS.nodes[1]?.subflow?.nodes?.[0]?.id as string;
    expect(summary?.problems?.[prepare]).toEqual({
      h02: { task: '[prepare] TODO', status: 'failed', msg: 'TODO: Prepare' },
    });
    // Rescued into a port: not a failure of the run.
    expect(summary?.failures).toEqual([]);
    expect(summary?.stoppedEarly).toBe(false);
    expect(summary?.hosts).toEqual(['h01', 'h02']);
  });

  it('stops the flow when max_fail_percentage is exceeded, as Ansible stops the playbook', () => {
    const hosts = ['h01', 'h02', 'h03', 'h04', 'h05'];
    // 2 of 5 is 40 %: not over the limit.
    const within = ports(LEVELS, {
      inputs: { devices: hosts },
      force: { gate: { failed: ['h01', 'h02'] } },
    });
    expect(within.summary?.stoppedEarly).toBe(false);
    expect(within.summary?.outcome.h01).toBe('Stopped at [gate] Gate: failed_hosts is not wired');
    const over = ports(LEVELS, {
      inputs: { devices: hosts },
      force: { gate: { failed: ['h01', 'h02', 'h03'] } },
    });
    expect(over.summary?.stoppedEarly).toBe(true);
    expect(over.summary?.outcome).toEqual({});
    expect(over.summary?.failures.map((f) => [f.host, f.task, f.msg])).toEqual(
      hosts.map((h) => [
        h,
        '[gate] max_fail_percentage 40 exceeded',
        'Flow stopped at [gate]: 3 of 5 hosts failed',
      ]),
    );
  });

  it('takes ports in the order the generated code tests them', () => {
    const { ports: p, summary } = ports(PORTS, {
      inputs: { devices: ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08'] },
      force: {
        // unreachable before unchanged; failed before both.
        probe: {
          unreachable: ['h01', 'h08'],
          unchanged: ['h02', 'h03', 'h04', 'h05', 'h06', 'h08'],
          failed: ['h07'],
        },
        // timeout before failed; always for every host.
        work: { timeout: ['h02'], failed: ['h02', 'h03'] },
        decide: { false: ['h05'] },
        br2: { failed: ['h06'] },
      },
    });
    expect(p).toEqual({
      h01: ['notify.ok_hosts', 'probe.unreachable'],
      h02: ['probe.unchanged', 'work.always', 'work.timeout'],
      h03: ['probe.unchanged', 'rollback.ok_hosts', 'work.always', 'work.failed_hosts'],
      h04: [
        'br1.ok_hosts',
        'br2.ok_hosts',
        'decide.true',
        'fan.branch_1',
        'fan.branch_2',
        'join.ok_hosts',
        'probe.unchanged',
        'work.always',
        'work.ok_hosts',
      ],
      h05: ['approve.approved', 'decide.false', 'probe.unchanged', 'work.always', 'work.ok_hosts'],
      h06: [
        'br1.ok_hosts',
        'br2.failed_hosts',
        'decide.true',
        'fan.branch_1',
        'fan.branch_2',
        'join.failed_hosts',
        'probe.unchanged',
        'work.always',
        'work.ok_hosts',
      ],
      h07: ['probe.failed_hosts'],
      h08: ['notify.ok_hosts', 'probe.unreachable'],
    });
    // The first outcome entry that holds a host fails it there.
    expect(summary?.outcome).toEqual({
      h01: 'Ended at [stopped] Stopped (outcome: failed)',
      h02: 'Stopped at [work] Work: timeout is not wired',
      h03: 'Ended at [failed] Failed (outcome: failed)',
      h06: 'Stopped at [br2] Branch two: failed_hosts is not wired',
      h07: 'Stopped at [probe] Probe: failed_hosts is not wired',
      h08: 'Ended at [stopped] Stopped (outcome: failed)',
    });
  });

  it('ignores a forced port the step does not have, as the generated code does', () => {
    const { ports: p } = ports(PORTS, {
      inputs: { devices: ['h01'] },
      force: { probe: { unchanged: ['h01'] }, work: { unreachable: ['h01'] } },
    });
    expect(p.h01).toContain('work.ok_hosts');
  });

  it('runs approvals: approved unless the scenario chooses; an outcome without a port stops', () => {
    const base = {
      inputs: { devices: ['h01', 'h02'] },
      force: { probe: { unchanged: ['h01', 'h02'] }, decide: { false: ['h01', 'h02'] } },
    };
    const at = (s: typeof base & { approvals?: Record<string, string> }) =>
      ports(PORTS, s as Omit<Scenario, 'expect' | 'name'>).ports.h01?.filter((x) =>
        x.startsWith('approve.'),
      );
    expect(at(base)).toEqual(['approve.approved']);
    expect(at({ ...base, approvals: { approve: 'rejected' } })).toEqual(['approve.rejected']);
    expect(at({ ...base, approvals: { approve: 'timeout' } })).toEqual(['approve.timeout']);
    // One host sent down rejected, as afd_simulate can (a scenario file chooses for the run).
    const forced = ports(PORTS, {
      ...base,
      force: { ...base.force, approve: { rejected: ['h02'] } as Record<string, string[]> },
    }).ports;
    expect(forced.h01).toContain('approve.approved');
    expect(forced.h02).toContain('approve.rejected');
    const bad = ports(PORTS, {
      ...base,
      approvals: { approve: 'maybe' as 'approved' },
    }).summary;
    expect(bad?.stoppedEarly).toBe(true);
    expect(bad?.failures.map((f) => f.msg)).toEqual([
      "afd_approvals['approve'] must be one of approved, rejected, timeout",
      "afd_approvals['approve'] must be one of approved, rejected, timeout",
    ]);
  });

  it('runs inventory_target work on the target hosts; the arrivals leave together', () => {
    const run = (force: Scenario['force'], lb_group = 'lb') =>
      ports(TARGET, {
        inputs: { devices: ['h01', 'h02'], lb_group },
        groups: { lb: ['lb-01', 'lb-02'] },
        force,
      });
    const happy = [
      'announce.ok_hosts',
      'consume.ok_hosts',
      'drain.ok_hosts',
      'maint.ok_hosts',
      'precheck.ok_hosts',
      'quiesce.ok_hosts',
      // still-ok.true is the subflow's exit: it counts as maint.ok_hosts.
    ].sort();
    const ok = run(undefined);
    expect(ok.ports.h01).toEqual(happy);
    expect(ok.summary?.hosts).toEqual(['h01', 'h02', 'lb-01', 'lb-02']);
    expect(ok.sim.needsAnsible).toEqual([]);
    // One of two is within max_fail_percentage 50.
    expect(run({ drain: { failed: ['lb-02'] } }).ports.h02).toEqual(happy);
    const failedPath = ['drain.failed_hosts', 'notify.ok_hosts', 'precheck.ok_hosts'];
    expect(run({ drain: { failed: ['lb-01', 'lb-02'] } }).ports.h01).toEqual(failedPath);
    expect(run(undefined, 'no_such_group').ports.h02).toEqual(failedPath);
    // Inherited inside a subflow: a failure bubbles out of it for every arrival.
    expect(run({ 'maint/quiesce': { failed: ['lb-01'] } }).ports.h01).toEqual([
      'announce.ok_hosts',
      'drain.ok_hosts',
      'maint.failed_hosts',
      'notify.ok_hosts',
      'precheck.ok_hosts',
    ]);
  });

  it('says what it does not model, so the scenario is checked in Ansible', () => {
    const regex = ports(TARGET, {
      inputs: { devices: ['h01'], lb_group: '~lb-0[12]' },
      groups: { lb: ['lb-01', 'lb-02'] },
    });
    expect(regex.sim.needsAnsible.map((u) => u.code)).toEqual(['target-pattern']);
    const pattern = ports(LEVELS, { inputs: { devices: ['web*'] } });
    expect(pattern.sim.needsAnsible.map((u) => u.code)).toEqual(['start-pattern']);
    const jinja = structuredClone(LEVELS);
    (jinja.nodes[2] as { intent?: string }).intent = 'Handle {{ inventory_hostname }}';
    expect(simulateRun(jinja, { inputs: { devices: ['h01'] } }).needsAnsible).toEqual([
      expect.objectContaining({ code: 'jinja-text', node: jinja.nodes[2]?.id }),
    ]);
    const result = simulateScenario(jinja, {
      name: 'x',
      inputs: { devices: ['h01'] },
      expect: { h01: 'done' },
    });
    expect(result.passed).toBe(true);
    expect(result.needsAnsible?.[0]?.code).toBe('jinja-text');
  });

  it('asks for IDs on a flow written by hand, which generates no plays', () => {
    const byKey = structuredClone(LEVELS);
    for (const n of byKey.nodes) delete (n as { id?: string }).id;
    expect(simulateRun(byKey, { inputs: { devices: ['h01'] } }).error).toBe(
      'This flow was written by hand: Complete IDs first',
    );
  });

  it('builds the plan once per document and leaves the generated code as it was', () => {
    expect(prepare(LEVELS)).toBe(prepare(LEVELS));
    const plain = prepare(structuredClone(LEVELS));
    expect(plain.files.map((f) => f.text)).toEqual(prepare(LEVELS).files.map((f) => f.text));
    expect(prepare(LEVELS).plan?.start).toBe('devices');
  });

  it('is quick', () => {
    const t = performance.now();
    for (let i = 0; i < 50; i++)
      simulateRun(PORTS, {
        inputs: { devices: Array.from({ length: 50 }, (_, k) => `h${k}`) },
        force: { probe: { unchanged: ['h1', 'h2'] } },
      });
    expect((performance.now() - t) / 50).toBeLessThan(10);
  });
});

describe('host patterns (AFD-114)', () => {
  const inv = {
    hosts: ['web-01', 'web-02', 'db-01', 'lb-01'],
    groups: { web: ['web-01', 'web-02'], prod: ['web-01', 'db-01'] },
  };
  it('reads names, groups, wildcards, unions, intersections and exclusions', () => {
    expect(matchHosts('web', inv)).toEqual(['web-01', 'web-02']);
    expect(matchHosts('all', inv)).toEqual(inv.hosts);
    expect(matchHosts('db-01,lb-01', inv)).toEqual(['db-01', 'lb-01']);
    expect(matchHosts('web:&prod', inv)).toEqual(['web-01']);
    expect(matchHosts('all:!web', inv)).toEqual(['db-01', 'lb-01']);
    expect(matchHosts('*-01', inv)).toEqual(['web-01', 'db-01', 'lb-01']);
    expect(matchHosts('pro?', inv)).toEqual(['web-01', 'db-01']);
    expect(matchHosts('nothing', inv)).toEqual([]);
    // AFD-150: only `&` or `!` terms start from every host, as ansible --list-hosts shows
    // (`&web` → web's hosts, `!web` → every host but web's).
    expect(matchHosts('&web', inv)).toEqual(['web-01', 'web-02']);
    expect(matchHosts('!web', inv)).toEqual(['db-01', 'lb-01']);
    expect(matchHosts('!web:&prod', inv)).toEqual(['db-01']);
  });
  it('leaves regex, slices and the implicit localhost to Ansible', () => {
    expect(matchHosts('~web', inv)).toBeUndefined();
    expect(matchHosts('web[0]', inv)).toBeUndefined();
    // Ansible answers localhost and 127.0.0.1 with its implicit localhost (AFD-150).
    expect(matchHosts('localhost', inv)).toBeUndefined();
    expect(matchHosts('web:127.0.0.1', inv)).toBeUndefined();
    expect(matchHosts('localhost', { hosts: ['localhost'], groups: {} })).toEqual(['localhost']);
  });
});

describe('scenario file checks added with the simulator (AFD-114)', () => {
  const base = { name: 'x', inputs: { devices: ['h01'] }, expect: { h01: 'done' } };
  const problems = (s: Scenario, doc = LEVELS) => checkScenarios(doc, { scenarios: [s] });
  it('names a force that is not a list, a wired port and a host without an expectation', () => {
    expect(
      problems({ ...base, force: { gate: { failed: 'h01' as unknown as string[] } } }).map(
        (p) => p.message,
      ),
    ).toEqual(['gate.failed: give a list of hosts, like [host-01]']);
    expect(problems({ ...base, expect: { h01: 'gate.ok_hosts' } }).map((p) => p.message)).toEqual([
      'gate.ok_hosts is wired: a host goes on from there; expect the end it reaches',
    ]);
    const open = problems({ ...base, inputs: { devices: ['h01', 'h02'] } });
    expect(open.map((p) => [p.message, p.severity])).toEqual([
      ['h02 runs but has no expectation, so where it ends is not checked', 'warning'],
    ]);
    expect(blocking(open)).toEqual([]);
  });
  it('names an approval outcome the approval has no port for', () => {
    const s = {
      name: 'x',
      inputs: { devices: ['h01'] },
      approvals: { approve: 'nope' as 'approved' },
      expect: { h01: 'done' },
    };
    expect(problems(s, PORTS).map((p) => p.message)).toEqual([
      'approve: give one of approved, rejected, timeout',
    ]);
  });
  it('reads the targets input as the generated start play does', () => {
    const doc = structuredClone(LEVELS);
    doc.flow.inputs = {
      spare: { type: 'host_list' },
      devices: { type: 'host_list', targets: true },
    };
    expect(targetsInput(doc)).toBe('devices');
    delete doc.flow.inputs.devices?.targets;
    expect(targetsInput(doc)).toBe('spare');
  });
});

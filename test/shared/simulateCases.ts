// The cases the scenario simulator is held to Ansible on (AFD-114): the engine fixtures and
// examples, the transforms the engine tests make (extracted, rolled, privileged), and seeded random
// flows with random scenarios. test/engine/simulate.test.ts runs them in Ansible; the unit tier
// checks they generate and that the simulator models nearly all of them.
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import { planCommand } from '../../src/core/flow/commands';
import { completeIds } from '../../src/core/flow/completeIds';
import { createIdFactory } from '../../src/core/flow/ids';
import { buildModel } from '../../src/core/flow/model';
import type { FlowDocument } from '../../src/core/flow/types';
import type { RunSummary } from '../../src/core/run/events';
import { type Scenario, targetsInput } from '../../src/core/scenario/scenarios';
import { fuzzFlow, fuzzScenario } from './flowFuzz';

const REPO = resolve(__dirname, '../..');

export type Run = Omit<Scenario, 'expect' | 'name'>;
export interface Case {
  name: string;
  doc: FlowDocument;
  s: Run;
}

const read = (file: string) => readFileSync(join(REPO, file), 'utf8');
/** Fixtures written by key get their IDs first, as the engine tests give them (byKey). */
const load = (file: string, transform?: (text: string) => string) => {
  const text = completeIds(read(file), createIdFactory()).text;
  return parse(transform ? transform(text) : text) as FlowDocument;
};
const idOf = (text: string, key: string) =>
  [...buildModel(parse(text) as FlowDocument).nodes.values()].find((n) => n.node.key === key)?.node
    .id as string;
const extracted = (keys: string[], title: string) => (text: string) =>
  planCommand(
    text,
    { kind: 'extractSubflow', nodes: keys.map((k) => idOf(text, k)), title },
    { newId: createIdFactory() },
  ).text;
const rolled = (subflow: string, batch: number) => (text: string) =>
  planCommand(
    text,
    { kind: 'updateNode', id: idOf(text, subflow), patch: { settings: { rolling: batch } } },
    { newId: createIdFactory() },
  ).text;
const privileged = (subflow: string, user: string) => (text: string) => {
  const ctx = { newId: createIdFactory() };
  const v2 = planCommand(text, { kind: 'upgradeFormat' }, ctx).text;
  return planCommand(
    v2,
    {
      kind: 'updateNode',
      id: idOf(v2, subflow),
      patch: { settings: { become: true, become_user: user } },
    },
    ctx,
  ).text;
};

/** A random scenario on any flow: its targets input gets the hosts, other inputs a value. */
function randomRun(doc: FlowDocument, seed: number, groups?: Record<string, string[]>): Run {
  const s = fuzzScenario(doc, seed);
  const hosts = s.inputs?.devices as string[];
  const inputs: Record<string, unknown> = {};
  for (const [name, f] of Object.entries(doc.flow.inputs ?? {}))
    inputs[name] =
      f?.type === 'host_list' ? hosts : f?.type === 'boolean' ? false : (f?.default ?? 'x');
  inputs[targetsInput(doc) ?? 'devices'] = hosts;
  return { ...s, inputs, ...(groups ? { groups } : {}) };
}

const LEVELS = 'test/fixtures/engine/routing-levels.flow.yaml';
const PORTS = 'test/fixtures/engine/routing-ports.flow.yaml';
const TARGET = 'test/fixtures/engine/inventory-target.flow.yaml';
const OS = 'examples/os-upgrade.flow.yaml';
const FIVE = ['h01', 'h02', 'h03', 'h04', 'h05'];
const LB = { lb: ['lb-01', 'lb-02'] };
const OS_GROUPS = { edge_switches: ['sw-edge-01', 'sw-edge-02'], core_spines: ['sp-01'] };

/** Every case; `fuzz` seeded random flows at the end. */
export function simulateCases(fuzz = 60): Case[] {
  const out: Case[] = [];
  const add = (name: string, doc: FlowDocument, s: Run) => out.push({ name, doc, s });
  const levels = load(LEVELS);
  add('levels: every host goes through', levels, { inputs: { devices: ['h01', 'h02'] } });
  add('levels: hosts as text', levels, { inputs: { devices: 'h01,h02' } });
  add('levels: a stage failure is handled, a gate failure stops', levels, {
    inputs: { devices: FIVE },
    force: { 'stage/prepare': { failed: ['h02'] }, gate: { failed: ['h03'] } },
  });
  add('levels: within max_fail_percentage', levels, {
    inputs: { devices: FIVE },
    force: { gate: { failed: ['h01', 'h02'] } },
  });
  add('levels: over max_fail_percentage stops the flow', levels, {
    inputs: { devices: FIVE },
    force: { gate: { failed: ['h01', 'h02', 'h03'] } },
  });
  add('levels: rolled stage', load(LEVELS, rolled('stage', 2)), {
    inputs: { devices: FIVE },
    force: { 'stage/prepare': { failed: ['h02'] }, 'stage/connect': { failed: ['h04'] } },
  });
  const ports = load(PORTS);
  const eight = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07', 'h08'];
  add('ports: every port in the order the code tests them', ports, {
    inputs: { devices: eight },
    force: {
      probe: {
        unreachable: ['h01', 'h08'],
        unchanged: ['h02', 'h03', 'h04', 'h05', 'h06', 'h08'],
        failed: ['h07'],
      },
      work: { timeout: ['h02'], failed: ['h02', 'h03'] },
      decide: { false: ['h05'] },
      br2: { failed: ['h06'] },
    },
  });
  const toApproval = {
    probe: { unchanged: ['h01', 'h02'] },
    decide: { false: ['h01', 'h02'] },
  };
  for (const pick of ['rejected', 'timeout', 'maybe'])
    add(`ports: approval ${pick}`, ports, {
      inputs: { devices: ['h01', 'h02'] },
      force: toApproval,
      approvals: { approve: pick as 'approved' },
    });
  add('ports: one host rejected', ports, {
    inputs: { devices: ['h01', 'h02'] },
    force: { ...toApproval, approve: { rejected: ['h02'] } as Record<string, string[]> },
  });
  const target = load(TARGET);
  const lb = (force?: Run['force'], lb_group = 'lb'): Run => ({
    inputs: { devices: ['h01', 'h02'], lb_group },
    groups: LB,
    ...(force ? { force } : {}),
  });
  add('target: arrivals pass', target, lb());
  add('target: one of two within the limit', target, lb({ drain: { failed: ['lb-02'] } }));
  add('target: the whole target fails', target, lb({ drain: { failed: ['lb-01', 'lb-02'] } }));
  add('target: no host matched', target, lb(undefined, 'no_such_group'));
  add('target: inherited, bubbles', target, lb({ 'maint/quiesce': { failed: ['lb-01'] } }));
  const files: [string, string, ((t: string) => string)?, Record<string, string[]>?][] = [
    ['edge-baseline', 'examples/edge-baseline.flow.yaml'],
    ['os-upgrade', OS, undefined, OS_GROUPS],
    [
      'os-upgrade extracted',
      OS,
      extracted(['set-boot-variable', 'reload'], 'Switch image'),
      OS_GROUPS,
    ],
    ['os-upgrade privileged', OS, privileged('upgrade-os', 'netops'), OS_GROUPS],
    ['data-passing', 'test/fixtures/engine/data-passing.flow.yaml'],
    ['data-across', 'test/fixtures/engine/data-across.flow.yaml'],
    ['same-fact', 'test/fixtures/engine/same-fact.flow.yaml'],
    ['approval-segments', 'test/fixtures/engine/approval-segments.flow.yaml'],
    ['run-time-timing', 'test/fixtures/engine/run-time-timing.flow.yaml'],
    ['ports', PORTS],
    ['target', TARGET, undefined, LB],
  ];
  for (const [name, file, transform, groups] of files)
    for (const seed of [1, 2, 3]) {
      const doc = load(file, transform);
      const s = randomRun(doc, seed, groups);
      if (name === 'target') (s.inputs as Record<string, unknown>).lb_group = 'lb';
      add(`${name} #${seed}`, doc, s);
    }
  for (let seed = 1; seed <= fuzz; seed++) {
    const doc = fuzzFlow(seed);
    add(`fuzz ${seed}`, doc, fuzzScenario(doc, seed));
  }
  return out;
}

/** What both summaries say, in one order: timings and run order are Ansible's own. */
export function normal(s: RunSummary | undefined) {
  if (!s) return undefined;
  return {
    nodes: s.nodes,
    outcome: s.outcome,
    failures: s.failures.map((f) => `${f.host} | ${f.node} | ${f.task} | ${f.msg}`).sort(),
    unreachable: s.unreachable,
    hosts: s.hosts,
    stoppedEarly: s.stoppedEarly,
    problems: s.problems ?? {},
  };
}

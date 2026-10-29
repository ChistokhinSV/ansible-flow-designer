// Engine contract tests (AFD-4 acceptance 3 and 4): generated code runs for real in each Ansible
// image against a fictional inventory, with simulated outcomes, and every host must take exactly the
// ports the flow designs. Opt-in (Docker): `just test-engine`. One container per image runs all
// scenarios; the afd_events callback reports routing groups, mapped back to nodes via the routes.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../src/core/engine/optionA';
import type { GenerateResult } from '../../src/core/engine/types';
import { buildModel } from '../../src/core/flow/model';
import type { FlowDocument } from '../../src/core/flow/types';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');
const REPO = resolve(__dirname, '../..');
const CONTENT = join(REPO, 'test/fixtures/engine/content');
const CALLBACKS = join(REPO, 'probe/callback_plugins');

interface Scenario {
  name: string;
  flow: string;
  check?: boolean;
  syntaxOnly?: boolean;
  vars: Record<string, unknown>;
  /** Per host: every `key.port` it was routed through, and the outcome task that failed it. */
  expect?: Record<string, { ports: string[]; outcome?: string }>;
  rc?: number;
  /** Extra assertion on the parsed run. */
  also?: (run: Run) => void;
  /** Repository root as seen from generated/ (playbook bindings). */
  root?: string;
  /**
   * AWX workflow segments to run in order (AFD-11): each one gets the set_stats data of the one
   * before it as extra vars, as AWX passes artifacts down a workflow.
   */
  chain?: string[];
}

interface Run {
  rc: number;
  events: Record<string, unknown>[];
  ports: Map<string, Set<string>>;
  outcome: Map<string, string>;
}

const flowPath = (f: string) => join(REPO, f);
const nodeId = (flow: string, key: string) =>
  [...buildModel(parse(readFileSync(flowPath(flow), 'utf8')) as FlowDocument).nodes.values()].find(
    (n) => n.node.key === key,
  )?.node.id;

const EDGE = 'examples/edge-baseline.flow.yaml';
const OS = 'examples/os-upgrade.flow.yaml';
const PORTS = 'test/fixtures/engine/routing-ports.flow.yaml';
const LEVELS = 'test/fixtures/engine/routing-levels.flow.yaml';
const DATA = 'test/fixtures/engine/data-passing.flow.yaml';
const TARGET = 'test/fixtures/engine/inventory-target.flow.yaml';
const SEG = 'test/fixtures/engine/approval-segments.flow.yaml';
/** How often a node's TODO task ran for a host, across every segment of a chain. */
const todoRuns = (run: Run, key: string, host: string) =>
  run.events.filter(
    (e) =>
      e.event === 'result' &&
      e.host === host &&
      e.node === nodeId(SEG, key) &&
      e.task === `[${key}] TODO`,
  ).length;
const LAB = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07'];
const EDGE_HOSTS = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'];

const targetHappy = [
  'precheck.ok_hosts',
  'drain.ok_hosts',
  'announce.ok_hosts',
  'quiesce.ok_hosts',
  'maint.ok_hosts',
  'consume.ok_hosts',
];

const portsHappy = [
  'probe.unchanged',
  'work.ok_hosts',
  'work.always',
  'decide.true',
  'fan.branch_1',
  'fan.branch_2',
];
const portsExpect: Scenario['expect'] = {
  h01: { ports: [...portsHappy, 'br1.ok_hosts', 'br2.ok_hosts', 'join.ok_hosts'] },
  h02: {
    ports: ['probe.unchanged', 'work.ok_hosts', 'work.always', 'decide.false', 'approve.approved'],
  },
  h03: {
    ports: [
      ...portsHappy,
      'br1.failed_hosts',
      'notify.ok_hosts',
      'br2.ok_hosts',
      'join.failed_hosts',
    ],
    outcome: '[stopped] Stopped',
  },
  h04: {
    ports: ['probe.unchanged', 'work.ok_hosts', 'work.always', 'decide.false', 'approve.rejected'],
    outcome: '[stopped] Stopped',
  },
  h05: {
    ports: ['probe.unchanged', 'work.failed_hosts', 'work.always', 'rollback.ok_hosts'],
    outcome: '[failed] Failed',
  },
  h06: {
    ports: ['probe.unchanged', 'work.timeout', 'work.always'],
    outcome: '[work] timeout is open',
  },
  h07: { ports: ['probe.unreachable', 'notify.ok_hosts'], outcome: '[stopped] Stopped' },
};
const portsVars = {
  devices: LAB,
  afd_simulate: {
    work: { timeout: ['h06'], failed: ['h05'] },
    decide: { false: ['h02', 'h04'] },
    approve: { rejected: ['h04'] },
    br1: { failed: ['h03'] },
  },
};

const SCENARIOS: Scenario[] = [
  {
    name: 'edge-baseline skeleton (check)',
    flow: EDGE,
    check: true,
    vars: {
      devices: EDGE_HOSTS,
      afd_simulate: { precheck: { failed: ['sw-edge-04'] }, validate: { failed: ['sw-edge-02'] } },
      afd_stub_fail: { [nodeId(EDGE, 'push-baseline') as string]: ['sw-edge-03'] },
    },
    rc: 2,
    expect: {
      'sw-edge-01': {
        ports: [
          'precheck.ok_hosts',
          'backup-config.ok_hosts',
          'push-baseline.ok_hosts',
          'validate.ok_hosts',
        ],
      },
      'sw-edge-02': {
        ports: [
          'precheck.ok_hosts',
          'backup-config.ok_hosts',
          'push-baseline.ok_hosts',
          'validate.failed_hosts',
        ],
        outcome: '[validate] failed_hosts is open',
      },
      'sw-edge-03': {
        ports: [
          'precheck.ok_hosts',
          'backup-config.ok_hosts',
          'push-baseline.failed_hosts',
          'rollback.ok_hosts',
        ],
        outcome: '[failed] Failed',
      },
      'sw-edge-04': {
        ports: ['precheck.failed_hosts'],
        outcome: '[precheck] failed_hosts is open',
      },
    },
  },
  {
    name: 'os-upgrade skeleton (check): module failure inside a subflow bubbles to rollback',
    flow: OS,
    check: true,
    vars: {
      devices: EDGE_HOSTS,
      ansible_net_version: '15.2',
      target_version: '17.3',
      target_image: 'edge-17.3.bin',
      afd_simulate: { 'pre-checks': { failed: ['sw-edge-04'] } },
    },
    rc: 2,
    expect: {
      ...Object.fromEntries(
        ['sw-edge-01', 'sw-edge-02', 'sw-edge-03'].map((h) => [
          h,
          {
            ports: [
              'pre-checks.ok_hosts',
              'upgrade-needed.true',
              'change-approval.approved',
              'backup-config.ok_hosts',
              'drain-traffic.ok_hosts',
              'stage-image.ok_hosts',
              'verify-checksum.ok_hosts',
              'upgrade-os.failed_hosts',
              'rollback.ok_hosts',
            ],
            outcome: '[failed] Failed',
          },
        ]),
      ),
      'sw-edge-04': { ports: ['pre-checks.failed_hosts'], outcome: '[excluded] Excluded' },
    },
  },
  {
    name: 'ports, parallel, join, approval, handlers',
    flow: PORTS,
    vars: portsVars,
    rc: 2,
    expect: portsExpect,
  },
  {
    name: 'same in check mode',
    flow: PORTS,
    check: true,
    vars: portsVars,
    rc: 2,
    expect: portsExpect,
  },
  {
    name: 'subflow bubbling and max_fail_percentage below the limit',
    flow: LEVELS,
    vars: {
      devices: LAB,
      afd_simulate: { 'stage/prepare': { failed: ['h02'] }, gate: { failed: ['h03', 'h04'] } },
    },
    rc: 2,
    expect: {
      ...Object.fromEntries(
        ['h01', 'h05', 'h06'].map((h) => [
          h,
          { ports: ['prepare.ok_hosts', 'stage.ok_hosts', 'gate.ok_hosts'] },
        ]),
      ),
      h02: { ports: ['stage.failed_hosts', 'handle.ok_hosts'], outcome: '[failed] Failed' },
      h03: {
        ports: ['prepare.ok_hosts', 'stage.ok_hosts', 'gate.failed_hosts'],
        outcome: '[gate] failed_hosts is open',
      },
      h04: {
        ports: ['prepare.ok_hosts', 'stage.ok_hosts', 'gate.failed_hosts'],
        outcome: '[gate] failed_hosts is open',
      },
      h07: {
        ports: ['prepare.ok_hosts', 'stage.unreachable', 'handle.ok_hosts'],
        outcome: '[failed] Failed',
      },
    },
  },
  {
    name: 'max_fail_percentage exceeded stops the whole flow',
    flow: LEVELS,
    vars: {
      devices: LAB,
      afd_simulate: {
        'stage/prepare': { failed: ['h02'] },
        gate: { failed: ['h03', 'h04', 'h05'] },
      },
    },
    rc: 2,
    also: (run) => {
      const stopped = run.events.filter(
        (e) => e.status === 'failed' && String(e.task).includes('max_fail_percentage 40 exceeded'),
      );
      expect(stopped.map((e) => e.host).sort()).toEqual(['h01', 'h03', 'h04', 'h05', 'h06']);
      expect(run.events.some((e) => e.event === 'play' && String(e.name).endsWith('Outcome'))).toBe(
        false,
      );
      expect(run.ports.get('h02')).toEqual(new Set(['stage.failed_hosts', 'handle.ok_hosts']));
    },
  },
  {
    // M5: real run (command does not run in check mode). produce → stub → playbook → assert.
    name: 'data passing: module output, stub output, flow input and a playbook binding',
    flow: DATA,
    root: '../../content',
    vars: { devices: ['h01', 'h02'], greeting: 'hello' },
    rc: 0,
    expect: Object.fromEntries(
      ['h01', 'h02'].map((h) => [
        h,
        { ports: ['produce.ok_hosts', 'stub.ok_hosts', 'report.ok_hosts', 'consume.ok_hosts'] },
      ]),
    ),
  },
  // AFD-14: nodes that run on their inventory_target; the arriving hosts leave together.
  {
    name: 'inventory_target: the work runs on the target, arrivals pass with its outputs',
    flow: TARGET,
    vars: { devices: ['h01', 'h02'], lb_group: 'lb' },
    rc: 0,
    expect: Object.fromEntries(['h01', 'h02'].map((h) => [h, { ports: targetHappy }])),
    also: (run) => {
      // Hosts with results in the node's plays; `work` leaves out the arrivals' bookkeeping.
      const ran = (key: string, work = true) =>
        new Set(
          run.events
            .filter(
              (e) =>
                e.event === 'result' &&
                e.node === nodeId(TARGET, key) &&
                !(
                  work &&
                  /route|arriving|matched no host|did not finish|outputs from/.test(String(e.task))
                ),
            )
            .map((e) => String(e.host)),
        );
      expect([...ran('drain')].sort()).toEqual(['lb-01', 'lb-02']);
      expect([...ran('announce')].sort()).toEqual(['lb-01', 'lb-02']);
      // Inherited inside the subflow: the task on lb, the decision on the arrivals.
      expect([...ran('quiesce')].sort()).toEqual(['lb-01', 'lb-02']);
      expect([...ran('still-ok', false)].sort()).toEqual(['h01', 'h02']);
    },
  },
  {
    name: 'inventory_target: one of two target hosts failing is within max_fail_percentage 50',
    flow: TARGET,
    vars: {
      devices: ['h01', 'h02'],
      lb_group: 'lb',
      afd_simulate: { drain: { failed: ['lb-02'] } },
    },
    rc: 0,
    expect: Object.fromEntries(['h01', 'h02'].map((h) => [h, { ports: targetHappy }])),
  },
  {
    name: 'inventory_target: the whole target failing fails every arrival; nobody reaches announce',
    flow: TARGET,
    vars: {
      devices: ['h01', 'h02'],
      lb_group: 'lb',
      afd_simulate: { drain: { failed: ['lb-01', 'lb-02'] } },
    },
    rc: 2,
    expect: Object.fromEntries(
      ['h01', 'h02'].map((h) => [
        h,
        {
          ports: ['precheck.ok_hosts', 'drain.failed_hosts', 'notify.ok_hosts'],
          outcome: '[failed] Failed',
        },
      ]),
    ),
    also: (run) =>
      expect(
        run.events.some(
          (e) =>
            e.event === 'result' &&
            e.node === nodeId(TARGET, 'announce') &&
            String(e.host).startsWith('lb-'),
        ),
      ).toBe(false),
  },
  {
    name: 'inventory_target: a pattern that matches no host fails every arrival',
    flow: TARGET,
    vars: { devices: ['h01', 'h02'], lb_group: 'no_such_group' },
    rc: 2,
    expect: Object.fromEntries(
      ['h01', 'h02'].map((h) => [
        h,
        {
          ports: ['precheck.ok_hosts', 'drain.failed_hosts', 'notify.ok_hosts'],
          outcome: '[failed] Failed',
        },
      ]),
    ),
  },
  {
    name: 'inventory_target inherited: a failure on the subflow target bubbles for every arrival',
    flow: TARGET,
    vars: {
      devices: ['h01', 'h02'],
      lb_group: 'lb',
      afd_simulate: { 'maint/quiesce': { failed: ['lb-01'] } },
    },
    rc: 2,
    expect: Object.fromEntries(
      ['h01', 'h02'].map((h) => [
        h,
        {
          ports: [
            'precheck.ok_hosts',
            'drain.ok_hosts',
            'announce.ok_hosts',
            'maint.failed_hosts',
            'notify.ok_hosts',
          ],
          outcome: '[failed] Failed',
        },
      ]),
    ),
  },
  // AFD-11: AWX workflow segments, chained like AWX chains them.
  {
    name: 'segments approved: failures fail in the last segment, hosts notified before stay done',
    flow: SEG,
    chain: ['start', 'gate-approved'],
    vars: {
      devices: ['h01', 'h02', 'h03'],
      afd_simulate: { check: { failed: ['h03'] }, change: { failed: ['h02'] } },
    },
    rc: 2,
    expect: {
      h01: { ports: ['check.ok_hosts', 'gate.approved', 'change.ok_hosts'] },
      h02: {
        ports: ['check.ok_hosts', 'gate.approved', 'change.failed_hosts', 'rollback.ok_hosts'],
        outcome: '[failed] Failed',
      },
      h03: { ports: ['check.failed_hosts', 'notify.ok_hosts'], outcome: '[failed] Failed' },
    },
    also: (run) => {
      expect(todoRuns(run, 'notify', 'h03')).toBe(1);
      expect(todoRuns(run, 'check', 'h01')).toBe(1);
    },
  },
  {
    name: 'segments rejected: notify runs once per host, before and after the gate',
    flow: SEG,
    chain: ['start', 'gate-rejected'],
    vars: { devices: ['h01', 'h02', 'h03'], afd_simulate: { check: { failed: ['h03'] } } },
    rc: 2,
    expect: {
      ...Object.fromEntries(
        ['h01', 'h02'].map((h) => [
          h,
          {
            ports: ['check.ok_hosts', 'gate.rejected', 'notify.ok_hosts'],
            outcome: '[failed] Failed',
          },
        ]),
      ),
      h03: { ports: ['check.failed_hosts', 'notify.ok_hosts'], outcome: '[failed] Failed' },
    },
    also: (run) => {
      for (const h of ['h01', 'h02', 'h03']) expect(todoRuns(run, 'notify', h), h).toBe(1);
      expect(todoRuns(run, 'change', 'h01')).toBe(0);
    },
  },
  {
    name: 'segments: nobody reaches the gate, start stops and finish fails the right hosts',
    flow: SEG,
    chain: ['start', 'finish'],
    vars: { devices: ['h01', 'h02'], afd_simulate: { check: { failed: ['h01', 'h02'] } } },
    rc: 2,
    expect: Object.fromEntries(
      ['h01', 'h02'].map((h) => [
        h,
        { ports: ['check.failed_hosts', 'notify.ok_hosts'], outcome: '[failed] Failed' },
      ]),
    ),
    also: (run) => {
      const failed = (text: string) =>
        run.events.some(
          (e) => e.event === 'result' && e.status === 'failed' && String(e.task).includes(text),
        );
      expect(failed('no host reached')).toBe(true);
      expect(failed('only after an approval')).toBe(false);
    },
  },
  ...[EDGE, OS, PORTS, LEVELS, DATA, TARGET].map((flow) => ({
    name: `syntax check ${basename(flow)}`,
    flow,
    syntaxOnly: true,
    vars: { devices: LAB, greeting: 'hello', lb_group: 'lb' },
    rc: 0,
    root: '../../content',
  })),
];

function generate(flow: string, simulate: boolean, root?: string): GenerateResult {
  const doc = parse(readFileSync(flowPath(flow), 'utf8')) as FlowDocument;
  const result = optionA.generate(doc, { source: basename(flow), simulate, root });
  expect(result.ok, JSON.stringify(result.findings)).toBe(true);
  return result;
}

/** Merges the set_stats data of a segment's run into the next segment's extra vars (AFD-11). */
const CARRY = `import json, sys
events, given, out = sys.argv[1:4]
data = json.load(open(given))
for line in open(events):
    e = json.loads(line)
    if e.get("event") == "stats" and e.get("custom"):
        data.update(e["custom"])
json.dump(data, open(out, "w"))
`;

function stage(dir: string): GenerateResult[] {
  cpSync(CONTENT, join(dir, 'content'), { recursive: true });
  writeFileSync(join(dir, 'carry.py'), CARRY);
  const lines = ['#!/bin/sh', 'export ANSIBLE_ROLES_PATH=/work/content/roles'];
  const results = SCENARIOS.map((s, i) => {
    const result = generate(s.flow, !s.syntaxOnly, s.root);
    const sdir = join(dir, `s${i}`);
    mkdirSync(join(sdir, 'generated'), { recursive: true });
    for (const f of result.files) writeFileSync(join(sdir, 'generated', f.name), f.text);
    writeFileSync(join(sdir, 'vars.json'), JSON.stringify(s.vars));
    if (s.chain) {
      writeFileSync(join(sdir, 'vars-0.json'), JSON.stringify(s.vars));
      s.chain.forEach((name, k) => {
        const file = result.segments?.find((g) => g.name === name)?.file;
        if (!file) throw new Error(`${s.name}: no segment ${name}`);
        lines.push(
          `cd /work/s${i} && AFD_EVENTS=/work/s${i}/events-${k}.jsonl ansible-playbook -i /work/content/inventory.ini -e @vars-${k}.json generated/${file} > out-${k}.txt 2>&1; echo $? > rc`,
        );
        if (k < (s.chain?.length ?? 0) - 1)
          lines.push(
            `python3 -I /work/carry.py /work/s${i}/events-${k}.jsonl /work/s${i}/vars-${k}.json /work/s${i}/vars-${k + 1}.json`,
          );
      });
      lines.push(`cd /work/s${i} && cat events-*.jsonl > events.jsonl; cat out-*.txt > out.txt`);
      return result;
    }
    const root = result.files[0]?.name;
    const flags = [s.check ? '--check' : '', s.syntaxOnly ? '--syntax-check' : ''].join(' ');
    lines.push(
      `cd /work/s${i} && AFD_EVENTS=/work/s${i}/events.jsonl ansible-playbook -i /work/content/inventory.ini -e @vars.json ${flags} generated/${root} > out.txt 2>&1; echo $? > rc`,
    );
    return result;
  });
  writeFileSync(join(dir, 'run-all.sh'), `${lines.join('\n')}\n`);
  return results;
}

function readRun(dir: string, result: GenerateResult, flow: string): Run {
  const rc = Number(readFileSync(join(dir, 'rc'), 'utf8').trim());
  let raw = '';
  try {
    raw = readFileSync(join(dir, 'events.jsonl'), 'utf8');
  } catch {}
  const events = raw
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const keys = new Map(
    [...buildModel(parse(readFileSync(flowPath(flow), 'utf8')) as FlowDocument).nodes.values()].map(
      (n) => [n.node.id, n.node.key],
    ),
  );
  const ports = new Map<string, Set<string>>();
  const outcome = new Map<string, string>();
  let play = '';
  for (const e of events) {
    if (e.event === 'play') play = String(e.name);
    if (e.event !== 'result') continue;
    const host = String(e.host);
    const route = typeof e.group === 'string' ? result.routes[e.group] : undefined;
    if (route && e.status === 'ok') {
      const set = ports.get(host) ?? new Set<string>();
      set.add(`${keys.get(route.node)}.${route.port}`);
      ports.set(host, set);
    }
    if (play.endsWith('] Outcome') && e.status === 'failed') outcome.set(host, String(e.task));
  }
  return { rc, events, ports, outcome };
}

describe.each(IMAGES)('engine on %s', (image) => {
  let dir = '';
  let results: GenerateResult[] = [];

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'afd-engine-'));
    results = stage(dir);
    execFileSync(
      'docker',
      [
        'run',
        '--rm',
        '-v',
        `${dir}:/work`,
        '-v',
        `${CALLBACKS}:/afd/callbacks:ro`,
        '-e',
        'ANSIBLE_CALLBACK_PLUGINS=/afd/callbacks',
        '-e',
        'ANSIBLE_CALLBACKS_ENABLED=afd_events',
        '-e',
        'ANSIBLE_COLLECTIONS_PATH=/work/content/collections:/usr/share/ansible/collections',
        '-e',
        'ANSIBLE_HOST_PATTERN_MISMATCH=ignore',
        '-e',
        'ANSIBLE_HOST_KEY_CHECKING=False',
        '-e',
        'ANSIBLE_LOCALHOST_WARNING=False',
        '-e',
        'ANSIBLE_DEPRECATION_WARNINGS=False',
        image,
        'sh',
        '/work/run-all.sh',
      ],
      { stdio: 'pipe', timeout: 600_000 },
    );
  }, 660_000);

  afterAll(() => {
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  SCENARIOS.forEach((s, i) => {
    it(s.name, () => {
      const run = readRun(join(dir, `s${i}`), results[i] as GenerateResult, s.flow);
      const out = () => readFileSync(join(dir, `s${i}`, 'out.txt'), 'utf8').slice(-3000);
      if (s.rc !== undefined) expect(run.rc, out()).toBe(s.rc);
      for (const [host, want] of Object.entries(s.expect ?? {})) {
        expect([...(run.ports.get(host) ?? [])].sort(), `${host} ports`).toEqual(
          [...want.ports].sort(),
        );
        expect(run.outcome.get(host), `${host} outcome`).toBe(want.outcome);
      }
      s.also?.(run);
    });
  });
});

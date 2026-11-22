// Step-by-step runs (AFD-346, ADR-0039): the afd_step strategy against real ansible-core. One
// container per image runs every scenario in turn, as a container run does (the run folder is a
// bind mount); this process is the driver: it reads the pause events from events.jsonl and answers
// in control.json, as the extension will. Opt-in (Docker): `just test-engine`.
import { execFileSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../src/core/engine/optionA';
import type { GenerateResult } from '../../src/core/engine/types';
import { buildModel } from '../../src/core/flow/model';
import type { FlowDocument } from '../../src/core/flow/types';
import { answer, type StepControl, startControl, stepState } from '../../src/core/run/step';
import { writeControl } from '../../src/node/run/stepChannel';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');
const REPO = resolve(__dirname, '../..');
const CONTENT = join(REPO, 'test/fixtures/engine/content');
const PROBE = join(REPO, 'probe');

const EDGE = 'examples/edge-baseline.flow.yaml';
const LEVELS = 'test/fixtures/engine/routing-levels.flow.yaml';
const SEG = 'test/fixtures/engine/approval-segments.flow.yaml';
const EDGE_HOSTS = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'];
const EDGE_VARS = {
  devices: EDGE_HOSTS,
  afd_simulate: { precheck: { failed: ['sw-edge-04'] }, validate: { failed: ['sw-edge-02'] } },
};
const LAB = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07'];

const docOf = (flow: string) => parse(readFileSync(join(REPO, flow), 'utf8')) as FlowDocument;
const keyOf = (flow: string) => {
  const keys = new Map(
    [...buildModel(docOf(flow)).nodes.values()].map((n) => [n.node.id, n.node.key]),
  );
  return (id: string) => keys.get(id) ?? id;
};
const idOf = (flow: string, key: string) =>
  [...buildModel(docOf(flow)).nodes.values()].find((n) => n.node.key === key)?.node.id as string;

type Pause = NonNullable<ReturnType<typeof stepState>['paused']>;
/** The driver's answer to the n-th pause (0-based); undefined: never answer. */
type Decide = (pause: Pause, n: number) => StepControl | undefined;

interface Scenario {
  name: string;
  flow: string;
  vars: Record<string, unknown>;
  /** The control file the run starts with; none: the strategy is on but nobody drives. */
  start?: StepControl;
  decide?: Decide;
  /** No step variables at all: the run as every run is today. */
  off?: boolean;
  env?: Record<string, string>;
  /** Approval segments run one after the other, each its own ansible-playbook process. */
  chain?: string[];
  /** The approval a later segment starts inside (its key). */
  inside?: string;
  check?: boolean;
}

interface Outcome {
  rc: number;
  events: Record<string, unknown>[];
  pauses: Pause[];
  /** Per answer: ms from writing control.json to seeing the run's resume event. */
  latency: number[];
  /** ms from the stop or timeout to the end of the run. */
  ms: number;
}

const stepAll: Decide = (p) => answer('step', [], p.id);

const SCENARIOS: Scenario[] = [
  { name: 'off: edge as every run', flow: EDGE, vars: EDGE_VARS, off: true, check: true },
  { name: 'on, nobody drives: edge as every run', flow: EDGE, vars: EDGE_VARS, check: true },
  {
    name: 'step: edge pauses before each step with its hosts',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: startControl(true),
    decide: stepAll,
  },
  {
    name: 'continue: from the first pause to the pause point',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: startControl(true),
    decide: (p) => answer('continue', [idOf(EDGE, 'validate')], p.id),
  },
  {
    name: 'stop: at the second pause, nothing more runs',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: startControl(true),
    decide: (p, n) => answer(n === 0 ? 'step' : 'stop', [], p.id),
  },
  {
    name: 'timeout: nobody answers, the run stops by itself',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: startControl(true),
    env: { AFD_STEP_TIMEOUT: '2' },
  },
  {
    name: 'subflow: inner steps pause one by one',
    flow: LEVELS,
    vars: {
      devices: LAB,
      afd_simulate: { 'stage/prepare': { failed: ['h02'] }, gate: { failed: ['h03', 'h04'] } },
    },
    start: startControl(true),
    decide: stepAll,
  },
  {
    name: 'segments: one control file across the processes of an approval',
    flow: SEG,
    chain: ['start', 'gate-approved'],
    inside: 'gate',
    vars: { devices: ['h01', 'h02', 'h03'], afd_simulate: { check: { failed: ['h03'] } } },
    start: startControl(true),
    decide: stepAll,
  },
];

function stage(dir: string): GenerateResult[] {
  cpSync(CONTENT, join(dir, 'content'), { recursive: true });
  const lines = ['#!/bin/sh', 'export ANSIBLE_ROLES_PATH=/work/content/roles'];
  const results = SCENARIOS.map((s, i) => {
    const doc = docOf(s.flow);
    const result = optionA.generate(doc, { source: basename(s.flow), simulate: true });
    if (!result.ok) throw new Error(JSON.stringify(result.findings));
    const sdir = join(dir, `s${i}`);
    mkdirSync(join(sdir, 'generated'), { recursive: true });
    for (const f of result.files) writeFileSync(join(sdir, 'generated', f.name), f.text);
    writeFileSync(join(sdir, 'vars.json'), JSON.stringify(s.vars));
    if (s.start) writeFileSync(join(sdir, 'control.json'), JSON.stringify(s.start));
    const env = Object.entries({
      ...(s.off
        ? {}
        : {
            ANSIBLE_STRATEGY: 'afd_step',
            ANSIBLE_STRATEGY_PLUGINS: '/afd/strategy_plugins',
            AFD_STEP_CONTROL: `/work/s${i}/control.json`,
          }),
      ...s.env,
    })
      .map(([k, v]) => `${k}=${v} `)
      .join('');
    const files = s.chain
      ? s.chain.map((name) => result.segments?.find((g) => g.name === name)?.file as string)
      : [result.files[0]?.name as string];
    const check = s.check ? '--check' : '';
    // Each segment: a process of its own, the segment before's carried data as extra vars.
    files.forEach((file, k) => {
      const vars = k === 0 ? 'vars.json' : `vars-${k}.json`;
      if (k > 0)
        lines.push(
          `cd /work/s${i} && python3 -I /work/carry.py events.jsonl vars.json vars-${k}.json`,
        );
      lines.push(
        `cd /work/s${i} && ${env}${k > 0 && s.inside ? `AFD_STEP_INSIDE=${idOf(s.flow, s.inside)} ` : ''}AFD_EVENTS=/work/s${i}/events.jsonl ansible-playbook -i /work/content/inventory.ini -e @${vars} ${check} generated/${file} >> out.txt 2>&1; echo $? > rc-${k}`,
      );
    });
    // Renamed into place: the driver reads rc as soon as it exists.
    lines.push(`cd /work/s${i} && cp rc-${files.length - 1} rc.tmp && mv rc.tmp rc`);
    return result;
  });
  writeFileSync(
    join(dir, 'carry.py'),
    'import json, sys\nevents, given, out = sys.argv[1:4]\ndata = json.load(open(given))\nfor line in open(events):\n    e = json.loads(line)\n    if e.get("event") == "stats" and e.get("custom"):\n        data.update(e["custom"])\njson.dump(data, open(out, "w"))\n',
  );
  writeFileSync(join(dir, 'run-all.sh'), `${lines.join('\n')}\n`);
  return results;
}

const readEvents = (sdir: string) => {
  try {
    return readFileSync(join(sdir, 'events.jsonl'), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Drives one scenario's run until its rc file is written. */
async function drive(sdir: string, s: Scenario): Promise<Outcome> {
  const pauses: Pause[] = [];
  const latency: number[] = [];
  const answered = new Map<string, number>();
  let endFrom = 0;
  const deadline = Date.now() + 240_000;
  while (!existsSync(join(sdir, 'rc'))) {
    if (Date.now() > deadline) throw new Error(`${s.name}: no end`);
    const events = readEvents(sdir);
    for (const e of events)
      if (
        e.event === 'resume' &&
        answered.has(String(e.id)) &&
        !latency[pauses.findIndex((p) => p.id === e.id)]
      )
        latency[pauses.findIndex((p) => p.id === e.id)] =
          Date.now() - (answered.get(String(e.id)) ?? 0);
    const paused = stepState(events).paused;
    if (paused && !pauses.some((p) => p.id === paused.id)) {
      pauses.push(paused);
      const control = s.decide?.(paused, pauses.length - 1);
      if (!endFrom && (!control || control.command === 'stop')) endFrom = Date.now();
      if (control) {
        answered.set(paused.id, Date.now());
        await writeControl(sdir, control);
      }
    }
    await sleep(20);
  }
  const ms = endFrom ? Date.now() - endFrom : 0;
  return {
    rc: Number(readFileSync(join(sdir, 'rc'), 'utf8').trim()),
    events: readEvents(sdir),
    pauses,
    latency,
    ms,
  };
}

/** What every host did, as a list: the run's results without the step events. */
const results = (o: Outcome) =>
  o.events
    .filter((e) => e.event === 'result')
    .map((e) => `${e.host} ${e.status} ${e.task}`)
    .sort();

describe.each(IMAGES)('step-by-step on %s', (image) => {
  let dir = '';
  const outcomes = new Map<string, Outcome>();

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'afd-step-'));
    stage(dir);
    const name = `afd-step-${process.pid}-${image.replace(/\W/g, '')}`;
    execFileSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-v',
      `${dir}:/work`,
      '-v',
      `${join(PROBE, 'callback_plugins')}:/afd/callbacks:ro`,
      '-v',
      `${join(PROBE, 'strategy_plugins')}:/afd/strategy_plugins:ro`,
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
    ]);
    // The scenarios run one after another in the container; their drivers all wait here.
    const done = await Promise.all(SCENARIOS.map((s, i) => drive(join(dir, `s${i}`), s)));
    SCENARIOS.forEach((s, i) => {
      outcomes.set(s.name, done[i] as Outcome);
    });
    const lat = done.flatMap((o) => o.latency.filter((x) => x !== undefined));
    lat.sort((a, b) => a - b);
    // Kept with AFD_KEEP=1, for the ADR's numbers.
    writeFileSync(
      join(dir, 'latency.txt'),
      `${image}: ${lat.length} answers, control.json to resume event: median ${lat[Math.floor(lat.length / 2)]} ms, max ${lat[lat.length - 1]} ms${'\n'}`,
    );
  }, 600_000);

  afterAll(() => {
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  const get = (name: string) => outcomes.get(name) as Outcome;
  const nodes = (o: Outcome, flow: string) => o.pauses.map((p) => keyOf(flow)(p.node));
  const step = (o: Outcome) =>
    o.events.filter((e) => ['pause', 'resume', 'stopped'].includes(String(e.event)));

  it('with the strategy off or undriven, the run is the same and has no step event', () => {
    const off = get('off: edge as every run');
    const on = get('on, nobody drives: edge as every run');
    expect(off.rc).toBe(2);
    expect(on.rc).toBe(off.rc);
    expect(results(on)).toEqual(results(off));
    expect(step(off)).toEqual([]);
    expect(step(on)).toEqual([]);
  });

  it('step pauses before each step once, with the hosts that run it, and ends as without', () => {
    const o = get('step: edge pauses before each step with its hosts');
    expect(nodes(o, EDGE)).toEqual(['precheck', 'backup-config', 'push-baseline', 'validate']);
    expect(o.pauses[0]?.hosts.sort()).toEqual(EDGE_HOSTS);
    expect(o.pauses[1]?.hosts.sort()).toEqual(['sw-edge-01', 'sw-edge-02', 'sw-edge-03']);
    expect(o.rc).toBe(get('off: edge as every run').rc);
    expect(results(o)).toEqual(results(get('off: edge as every run')));
    expect(o.latency.every((ms) => ms < 2000)).toBe(true);
  });

  it('continue runs to the pause point', () => {
    const o = get('continue: from the first pause to the pause point');
    expect(nodes(o, EDGE)).toEqual(['precheck', 'validate']);
    expect(results(o)).toEqual(results(get('off: edge as every run')));
  });

  it('stop ends the run before the step: its hosts stopped there, stats still written', () => {
    const o = get('stop: at the second pause, nothing more runs');
    const stopped = stepState(o.events).stopped;
    expect(stopped?.reason).toBe('driver');
    expect(keyOf(EDGE)(stopped?.node ?? '')).toBe('backup-config');
    expect(stopped?.hosts.sort()).toEqual(['sw-edge-01', 'sw-edge-02', 'sw-edge-03']);
    expect(
      o.events.some((e) => e.event === 'result' && String(e.task).startsWith('[backup-config]')),
    ).toBe(false);
    expect(o.events.some((e) => e.event === 'stats')).toBe(true);
    expect(o.rc).not.toBe(0);
  });

  it('a pause nobody answers stops the run after the timeout', () => {
    const o = get('timeout: nobody answers, the run stops by itself');
    expect(stepState(o.events).stopped?.reason).toBe('timeout');
    expect(o.pauses).toHaveLength(1);
    expect(o.ms).toBeLessThan(15_000);
  });

  it('subflow steps pause as steps of their own', () => {
    const o = get('subflow: inner steps pause one by one');
    const keys = nodes(o, LEVELS);
    expect(keys).toContain('prepare');
    expect(new Set(o.pauses.map((p) => p.node)).size).toBe(o.pauses.length);
  });

  it('segments: each process pauses, with ids of its own', () => {
    const o = get('segments: one control file across the processes of an approval');
    const tokens = new Set(o.pauses.map((p) => p.id.split('-')[0]));
    expect(tokens.size).toBe(2);
    // The approval paused once, before it; its later segment starts inside it.
    expect(nodes(o, SEG)).toEqual(['check', 'gate', 'notify', 'change']);
    expect(o.rc).not.toBe(undefined);
  });
});

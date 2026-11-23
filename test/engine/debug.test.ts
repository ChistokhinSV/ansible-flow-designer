// The flow debugger's engine (ADR-0040; AFD-361, AFD-370, AFD-371, AFD-372, AFS-223) against real
// ansible-core. One container per image runs every scenario in turn, as a container run does (the
// run folder is a bind mount); this process is the driver: it reads the pause events, sends
// requests the way StepDriver.inspect does (localInspector) and answers in control.json.
// Opt-in (Docker): `just test-engine`.
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
import { summarizeRun } from '../../src/core/run/events';
import {
  answer,
  type InspectAnswer,
  type InspectArgs,
  type InspectOp,
  inspectRequest,
  type PointSpec,
  type StepControl,
  startControl,
  stepState,
} from '../../src/core/run/step';
import { localInspector } from '../../src/node/run/inspect';
import { writeControl } from '../../src/node/run/stepChannel';

const IMAGES = (
  process.env.AFD_ENGINE_IMAGES ?? 'ps-probe-env:2.19,ps-probe-env:2.20,ps-probe-env:2.21'
).split(',');
const REPO = resolve(__dirname, '../..');
const CONTENT = join(REPO, 'test/fixtures/engine/content');
const DEBUG = join(REPO, 'test/fixtures/engine/debug');
const PROBE = join(REPO, 'probe');

const EDGE = 'examples/edge-baseline.flow.yaml';
const RETRY = 'test/fixtures/engine/debug-retry.flow.yaml';
const LEVELS = 'test/fixtures/engine/routing-levels.flow.yaml';
const LAB = ['h01', 'h02', 'h03', 'h04', 'h05', 'h06', 'h07'];
const EDGE_HOSTS = ['sw-edge-01', 'sw-edge-02', 'sw-edge-03', 'sw-edge-04'];
const EDGE_VARS = {
  devices: EDGE_HOSTS,
  afd_simulate: { precheck: { failed: ['sw-edge-04'] }, validate: { failed: ['sw-edge-02'] } },
};
// Secret values of the fixtures, each of which must never leave a run in any form.
const SECRETS = [
  'Fict-Vault-9Kq2',
  'Fict-Nested-4Lm8',
  'Fict-WholeFile-3Zp6',
  'Fict-Vault-Pass-0042',
  'Cred-Fict-11aa',
  'Cred-Api-33cc',
  'Ext-Fict-44dd',
  'Ext-Json-55ee',
  'Db-Plain-7Hx2',
];
const forms = (s: string) => [
  s,
  s.toUpperCase(),
  Buffer.from(s).toString('base64'),
  encodeURIComponent(s),
];

const docOf = (flow: string) => parse(readFileSync(join(REPO, flow), 'utf8')) as FlowDocument;
const idOf = (flow: string, key: string) =>
  [...buildModel(docOf(flow)).nodes.values()].find((n) => n.node.key === key)?.node.id as string;
const keyOf = (flow: string) => {
  const keys = new Map(
    [...buildModel(docOf(flow)).nodes.values()].map((n) => [n.node.id, n.node.key]),
  );
  return (id: string) => keys.get(id) ?? id;
};

type Pause = NonNullable<ReturnType<typeof stepState>['paused']>;
type Ask = (op: InspectOp, args?: InspectArgs, pause?: string) => Promise<InspectAnswer>;
/** The driver's answer to the n-th pause (0-based), after any requests it makes there. */
type Decide = (
  pause: Pause,
  n: number,
  ask: Ask,
  sdir: string,
) => Promise<StepControl | undefined> | StepControl | undefined;

interface Scenario {
  name: string;
  /** A flow (generated) or one of the debug fixture's playbooks. */
  flow?: string;
  playbook?: string;
  vars: Record<string, unknown>;
  start: StepControl;
  decide: Decide;
  /** Not a debug run (AFD_DEBUG unset). */
  plain?: boolean;
  check?: boolean;
}

interface Outcome {
  rc: number;
  events: Record<string, unknown>[];
  text: string;
  out: string;
  pauses: Pause[];
  answers: Record<string, InspectAnswer>;
  code?: GenerateResult;
}

const cont =
  (points: PointSpec[] = []): Decide =>
  (p) =>
    answer('continue', points, p.id);
const failures = { failed: true };

/** Requests at the mask playbook's second pause (before n-check), kept by name for the tests. */
const maskRequests: Record<string, [InspectOp, InspectArgs]> = {
  scopes: ['scopes', { host: 'h01' }],
  scopesFacts: ['scopes', { host: 'h01', facts: true }],
  host: ['vars', { host: 'h01', scope: 'host' }],
  flow: ['vars', { host: 'h01', scope: 'flow' }],
  inputs: ['vars', { host: 'h01', scope: 'inputs' }],
  big: ['vars', { host: 'h01', scope: 'host', path: ['big_value'] }],
  many: ['vars', { host: 'h01', scope: 'host', path: ['many'], start: 200, count: 100 }],
  dict: ['vars', { host: 'h01', scope: 'host', path: ['via_dict', 'lst'] }],
  facts: ['facts', { host: 'h01' }],
  evalVault: ['eval', { host: 'h01', expr: 'vault_secret' }],
  evalDerived: ['eval', { host: 'h01', expr: "vault_secret | b64encode ~ '|' ~ api_cred" }],
  evalDict: ['eval', { host: 'h01', expr: "{'a': 1, 'nested': nested_vault}" }],
  evalName: ['eval', { host: 'h01', expr: 'db_password | upper' }],
  evalPlain: ['eval', { host: 'h02', expr: "site_tier ~ '/' ~ (ntp_servers | length)" }],
  evalLookup: ['eval', { host: 'h01', expr: "lookup('pipe', 'id')" }],
  evalQuery: ['eval', { host: 'h01', expr: "query('file', '/etc/passwd')" }],
  evalUnvault: ['eval', { host: 'h01', expr: "'x' | unvault" }],
  evalLazy: ['eval', { host: 'h01', expr: 'lazy_pipe' }],
  evalSlow: ['eval', { host: 'h01', expr: 'range(10 ** 9) | sum', timeout: 1 }],
  evalBad: ['eval', { host: 'h01', expr: 'nope.missing' }],
  evalSetFact: ['eval', { host: 'h01', expr: 'via_cred' }],
  evalNoLog: ['eval', { host: 'h01', expr: 'reg_nolog.stdout' }],
  watch: ['watch', { exprs: ['site_tier', 'via_b64', 'inventory_hostname'] }],
  nobody: ['scopes', { host: 'h99' }],
};

const CONDITIONS: PointSpec[] = [
  { node: idOf(EDGE, 'backup-config'), condition: "inventory_hostname == 'sw-edge-02'" },
  { node: idOf(EDGE, 'push-baseline'), condition: "inventory_hostname == 'nobody'" },
  { node: idOf(EDGE, 'validate'), condition: 'undefined_thing.x > 1' },
];
const HITS: PointSpec[] = [
  {
    node: idOf(EDGE, 'precheck'),
    log: '{{ inventory_hostname }} of {{ devices | length }} cred={{ cred_password }}',
  },
  { node: idOf(EDGE, 'push-baseline'), log: "{{ lookup('pipe', 'id') }}" },
  { node: idOf(EDGE, 'backup-config'), hits: 2 },
  { node: idOf(EDGE, 'validate'), hits: 10, log: '{{ inventory_hostname }} {{ missing_var.x }}' },
];

const SCENARIOS: Scenario[] = [
  {
    name: 'mask: variables, facts, evaluate and watch at a pause, secrets masked',
    playbook: 'mask.yml',
    vars: { want_facts: true, ext_value: 'Ext-Fict-44dd', cred_password: 'Cred-Fict-11aa' },
    start: startControl(true),
    decide: async (p, n, ask) => {
      if (n === 1)
        for (const [name, [op, args]] of Object.entries(maskRequests))
          answers.set(name, await ask(op, args));
      return answer('step', [], p.id);
    },
  },
  {
    name: 'stale: a request for another pause is gone',
    playbook: 'mask.yml',
    vars: { ext_value: 'Ext-Fict-44dd', cred_password: 'Cred-Fict-11aa' },
    start: startControl(true),
    decide: async (p, n, ask) => {
      if (n === 1) answers.set('stale', await ask('scopes', { host: 'h01' }, 'someone-else-1'));
      return answer('step', [], p.id);
    },
  },
  {
    name: 'plain: no debug, the pause is as in 1.1',
    playbook: 'mask.yml',
    vars: { ext_value: 'Ext-Fict-44dd', cred_password: 'Cred-Fict-11aa' },
    plain: true,
    start: startControl(true),
    decide: (p) => answer('step', [], p.id),
  },
  {
    name: 'conditions: per host, all hosts pause, an error does not pause',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: { ...startControl(false, CONDITIONS), failures: { failed: false } },
    decide: async (p, _n, ask) => {
      answers.set(
        'conditionEval',
        await ask('eval', { host: 'sw-edge-02', expr: 'inventory_hostname' }),
      );
      return { ...answer('continue', CONDITIONS, p.id), failures: { failed: false } };
    },
  },
  {
    name: 'hits and log points: the Nth arrival pauses, a log point never does',
    flow: EDGE,
    vars: { ...EDGE_VARS, cred_password: 'Cred-Fict-11aa' },
    check: true,
    start: { ...startControl(false, HITS), failures: { failed: false } },
    decide: (p) => ({ ...answer('continue', HITS, p.id), failures: { failed: false } }),
  },
  {
    name: 'failure: continue at each failure pause routes as without',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: { ...startControl(false), failures },
    decide: async (p, n, ask) => {
      if (n === 0 && p.kind === 'failure')
        answers.set(
          'failedResult',
          await ask('eval', { host: 'sw-edge-04', expr: 'afd_failed_node' }),
        );
      return answer('continue', [], p.id);
    },
  },
  {
    name: 'failure: stop at the first failure pause',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: { ...startControl(false), failures },
    decide: (p) => answer('stop', [], p.id),
  },
  {
    name: 'retry: a second failure pauses again, then continue',
    flow: EDGE,
    vars: EDGE_VARS,
    check: true,
    start: { ...startControl(false), failures },
    decide: (p, n) =>
      n === 0
        ? { ...answer('retry', [], p.id), after: 'continue' as const, failures }
        : { ...answer('continue', [], p.id), failures },
  },
  {
    name: 'retry: the step succeeds the second time',
    flow: RETRY,
    vars: { devices: ['h01', 'h02', 'h03'], marker_dir: '' },
    start: { ...startControl(false), failures },
    decide: (p, _n, _ask, sdir) => {
      if (p.kind !== 'failure') return answer('continue', [], p.id);
      for (const f of p.failed ?? []) writeFileSync(join(sdir, `marker-${f.host}`), '');
      return { ...answer('retry', [], p.id), after: 'continue', failures };
    },
  },
  {
    name: 'retry: off without failure filter, as a plain run',
    flow: RETRY,
    vars: { devices: ['h01', 'h02', 'h03'], marker_dir: '' },
    start: { ...startControl(false), failures: { failed: false } },
    decide: cont(),
  },
  {
    name: 'unreachable: the filter pauses for a host routed unreachable',
    flow: LEVELS,
    vars: {
      devices: LAB,
      afd_simulate: { 'stage/prepare': { failed: ['h02'] }, gate: { failed: ['h03', 'h04'] } },
    },
    start: { ...startControl(false), failures: { failed: true, unreachable: true } },
    decide: (p) => ({
      ...answer('continue', [], p.id),
      failures: { failed: true, unreachable: true },
    }),
  },
];
// The marker flow's folders must match the scenario index.
const RETRY_OK = SCENARIOS.findIndex((s) => s.name === 'retry: the step succeeds the second time');
const RETRY_OFF = SCENARIOS.findIndex((s) => s.name.startsWith('retry: off'));
const answers = new Map<string, InspectAnswer>();

function stage(dir: string): (GenerateResult | undefined)[] {
  cpSync(CONTENT, join(dir, 'content'), { recursive: true });
  cpSync(DEBUG, join(dir, 'debug'), { recursive: true });
  // Markers already there for h01 and h03 in the marker flow: only h02 fails its check.
  for (const i of [RETRY_OK, RETRY_OFF]) {
    mkdirSync(join(dir, `s${i}`), { recursive: true });
    for (const h of ['h01', 'h03']) writeFileSync(join(dir, `s${i}`, `marker-${h}`), '');
  }
  const lines = [
    '#!/bin/sh',
    'export ANSIBLE_ROLES_PATH=/work/content/roles',
    'cp /work/debug/vault-pass.txt /tmp/vp && chmod 600 /tmp/vp',
  ];
  const results = SCENARIOS.map((s, i) => {
    const sdir = join(dir, `s${i}`);
    mkdirSync(sdir, { recursive: true });
    let result: GenerateResult | undefined;
    let playbook = `/work/debug/${s.playbook}`;
    let inventory = '/work/debug/inventory.ini';
    if (s.flow) {
      result = optionA.generate(docOf(s.flow), { source: basename(s.flow), simulate: true });
      if (!result.ok) throw new Error(JSON.stringify(result.findings));
      mkdirSync(join(sdir, 'generated'), { recursive: true });
      for (const f of result.files) writeFileSync(join(sdir, 'generated', f.name), f.text);
      playbook = `generated/${result.files[0]?.name}`;
      if (s.flow !== RETRY) inventory = '/work/content/inventory.ini';
    }
    const vars = 'marker_dir' in s.vars ? { ...s.vars, marker_dir: `/work/s${i}` } : s.vars;
    writeFileSync(join(sdir, 'vars.json'), JSON.stringify(vars));
    writeFileSync(join(sdir, 'control.json'), JSON.stringify(s.start));
    const env = Object.entries({
      ANSIBLE_STRATEGY: 'afd_step',
      ANSIBLE_STRATEGY_PLUGINS: '/afd/strategy_plugins',
      AFD_STEP_CONTROL: `/work/s${i}/control.json`,
      AFD_STEP_TIMEOUT: '120',
      AFD_EVENTS: `/work/s${i}/events.jsonl`,
      AFD_SECRETS_FILE: '/work/debug/secrets.json',
      AFD_EXTERNAL_SECRETS_FILE: '/work/debug/external.json',
      AFD_VAULT_FILE: '/tmp/vp',
      ...(s.plain ? {} : { AFD_DEBUG: '1' }),
    })
      .map(([k, v]) => `${k}=${v} `)
      .join('');
    const check = s.check ? '--check' : '';
    lines.push(
      `cd /work/s${i} && ${env}ansible-playbook -i ${inventory} -e @vars.json -e @/work/debug/secrets.json --vault-password-file /tmp/vp ${check} ${playbook} > out.txt 2>&1; echo $? > rc.tmp; mv rc.tmp rc`,
    );
    return result;
  });
  lines.push(
    'if [ -e /tmp/afd-side-effect-lazy ]; then echo ran; else echo none; fi > /work/side.tmp; mv /work/side.tmp /work/side.txt',
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

async function drive(sdir: string, s: Scenario): Promise<Omit<Outcome, 'code'>> {
  const pauses: Pause[] = [];
  const inspector = localInspector(sdir, 20_000);
  let asked = 0;
  const deadline = Date.now() + 300_000;
  while (!existsSync(join(sdir, 'rc'))) {
    if (Date.now() > deadline) throw new Error(`${s.name}: no end`);
    const paused = stepState(readEvents(sdir)).paused;
    if (paused && !pauses.some((p) => p.id === paused.id)) {
      pauses.push(paused);
      const ask = (op: InspectOp, args: InspectArgs = {}, pause = paused.id) => {
        asked += 1;
        return inspector.ask(asked, inspectRequest(asked, pause, op, args));
      };
      const control = await s.decide(paused, pauses.length - 1, ask, sdir);
      if (control) await writeControl(sdir, control);
    }
    await sleep(20);
  }
  const text = readFileSync(join(sdir, 'events.jsonl'), 'utf8');
  return {
    rc: Number(readFileSync(join(sdir, 'rc'), 'utf8').trim()),
    events: readEvents(sdir),
    text,
    out: readFileSync(join(sdir, 'out.txt'), 'utf8'),
    pauses,
    answers: {},
  };
}

const results = (o: Outcome) =>
  o.events
    .filter((e) => e.event === 'result')
    .map((e) => `${e.host} ${e.status} ${e.task}`)
    .sort();
const leaks = (text: string) =>
  SECRETS.flatMap((s) => forms(s).filter((f) => text.toLowerCase().includes(f.toLowerCase())));
const child = (a: InspectAnswer | undefined, name: string | number) =>
  a?.children?.find((c) => c.name === name);

describe.each(IMAGES)('debugger engine on %s', (image) => {
  let dir = '';
  const outcomes = new Map<string, Outcome>();
  let side = '';

  beforeAll(async () => {
    answers.clear();
    dir = mkdtempSync(join(tmpdir(), 'afd-debug-'));
    const codes = stage(dir);
    const name = `afd-debug-${process.pid}-${image.replace(/\W/g, '')}`;
    execFileSync('docker', [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-v',
      `${dir}:/work`,
      '-v',
      `${PROBE}:/afd:ro`,
      '-e',
      'ANSIBLE_CALLBACK_PLUGINS=/afd/callback_plugins',
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
      '-e',
      'PYTHONDONTWRITEBYTECODE=1',
      image,
      'sh',
      '/work/run-all.sh',
    ]);
    // One scenario at a time: the answers map is shared.
    for (const [i, s] of SCENARIOS.entries()) {
      const o = await drive(join(dir, `s${i}`), s);
      outcomes.set(s.name, { ...o, code: codes[i] });
    }
    const deadline = Date.now() + 60_000;
    while (!existsSync(join(dir, 'side.txt')) && Date.now() < deadline) await sleep(100);
    side = existsSync(join(dir, 'side.txt')) ? readFileSync(join(dir, 'side.txt'), 'utf8') : '';
  }, 900_000);

  afterAll(() => {
    if (dir && process.env.AFD_KEEP)
      writeFileSync(
        join(dir, 'answers.json'),
        JSON.stringify(Object.fromEntries(answers), null, 1),
      );
    if (dir && !process.env.AFD_KEEP) rmSync(dir, { recursive: true, force: true });
  });

  const get = (name: string) => outcomes.get(name) as Outcome;
  const a = (name: string) => answers.get(name);

  it('captures only at pauses: the events hold no variable values and no secret', () => {
    const o = get('mask: variables, facts, evaluate and watch at a pause, secrets masked');
    expect(o.rc).toBe(0);
    expect(o.pauses.map((p) => p.node)).toEqual(['n-prep', 'n-check']);
    expect(o.pauses[0]).toMatchObject({ kind: 'step', debug: true });
    expect(o.text).not.toContain('via_b64');
    expect(leaks(o.text)).toEqual([]);
    // Lazy lookups never ran: not while listing, nor while evaluating.
    expect(side.trim()).toBe('none');
  });

  it('lists scopes with names, types and sizes, no values; facts only when asked', () => {
    const scopes = a('scopes')?.scopes ?? [];
    expect(scopes.map((s) => s.id)).toEqual(['inputs', 'host', 'flow', 'facts']);
    const host = scopes.find((s) => s.id === 'host')?.vars ?? [];
    const names = host.map((v) => v.name);
    expect(names).toContain('via_b64');
    expect(names).toContain('reg_plain');
    expect(names).not.toContain('hostvars');
    expect(names).not.toContain('vars');
    expect(names).not.toContain('ansible_facts');
    expect(host.every((v) => v.value === undefined)).toBe(true);
    expect(host.find((v) => v.name === 'ntp_servers')).toMatchObject({ type: 'list', count: 2 });
    expect(scopes.find((s) => s.id === 'facts')).toEqual({
      id: 'facts',
      name: 'Facts',
      expensive: true,
    });
    const inputs = scopes.find((s) => s.id === 'inputs')?.vars ?? [];
    expect(inputs.map((v) => v.name).sort()).toEqual([
      'step_input_secret_password',
      'step_input_vlan',
    ]);
    const withFacts = a('scopesFacts')?.scopes?.find((s) => s.id === 'facts')?.vars ?? [];
    expect(withFacts.length).toBeGreaterThan(5);
    const facts = a('facts');
    expect(facts?.scope).toBe('facts');
    expect(child(facts, 'hostname') ?? child(facts, 'nodename')).toBeTruthy();
    expect(a('nobody')?.error).toMatch(/h99/);
  });

  it('masks each kind of secret, with its reason and never its size', () => {
    const host = a('host');
    const m = (n: string) => child(host, n);
    expect(m('vault_secret')).toEqual({ name: 'vault_secret', type: 'masked', masked: 'vault' });
    expect(m('via_set_fact')?.masked).toBe('vault');
    expect(m('wf_secret')?.masked).toBe('vault');
    expect(m('via_wholefile')?.masked).toBe('vault');
    expect(m('via_b64')?.masked).toBe('vault');
    expect(m('via_to_json')?.masked).toBe('vault');
    expect(m('via_concat')?.masked).toBe('vault');
    expect(m('via_upper')?.masked).toBe('vault');
    expect(m('reg_nolog')?.masked).toBe('no_log');
    expect(m('db_password')?.masked).toBe('name');
    expect(m('via_db_copy')?.masked).toBe('name');
    expect(m('via_cred')?.masked).toBe('credential');
    expect(m('via_cred_b64')?.masked).toBe('credential');
    expect(m('via_external')?.masked).toBe('external');
    // The one accepted leak: a plain secret under a harmless name no list knows.
    expect(m('via_snmp')?.value).toBe('Snmp-Comm-5Rt4');
    expect(m('templated_ref')).toMatchObject({ type: 'template' });
    expect(m('reg_plain')?.type).toBe('dict');
    for (const e of host?.children ?? []) if (e.masked) expect(e.size).toBeUndefined();
    // Inside containers: each leaf.
    const lst = a('dict');
    expect(lst?.children?.[0]).toMatchObject({ name: 0, type: 'masked', masked: 'vault' });
    expect(lst?.children?.[1]).toMatchObject({ name: 1, type: 'int', value: 1 });
    const flow = a('flow');
    expect(child(flow, 'ext_value')?.masked).toBe('external');
    expect(child(flow, 'cred_password')?.masked).toBe('name');
    expect(child(flow, 'want_facts')?.value).toBe(true);
    const inputs = a('inputs');
    expect(child(inputs, 'step_input_vlan')?.value).toBe(120);
    expect(child(inputs, 'step_input_secret_password')?.masked).toBe('name');
    expect(leaks(JSON.stringify([...answers.values()]))).toEqual([]);
  });

  it('cuts a large value and pages a long list', () => {
    const big = a('big');
    expect(big).toMatchObject({ name: 'big_value', type: 'str', cut: 70000 });
    expect(String(big?.value).length).toBe(64 * 1024);
    const many = a('many');
    expect(many).toMatchObject({ type: 'list', total: 250, start: 200 });
    expect(many?.children).toHaveLength(50);
    expect(many?.children?.[0]).toMatchObject({ name: 200, value: 200 });
    expect(many?.more).toBeUndefined();
  });

  it('evaluates with the masking, refuses lookups and vault filters, stops at the time limit', () => {
    expect(a('evalVault')).toMatchObject({ type: 'masked', masked: 'vault' });
    expect(a('evalDerived')?.type).toBe('masked');
    expect(a('evalSetFact')).toMatchObject({ masked: 'credential' });
    expect(a('evalName')).toMatchObject({ masked: 'name' });
    expect(a('evalNoLog')).toMatchObject({ type: 'masked', masked: 'no_log' });
    const dict = a('evalDict')?.value as Record<string, unknown>;
    expect(dict.a).toBe(1);
    expect((dict.nested as Record<string, unknown>).key).toEqual({
      __afd__: 'masked',
      masked: 'vault',
    });
    expect(a('evalPlain')).toMatchObject({ type: 'str', value: 'gold/2' });
    for (const k of ['evalLookup', 'evalQuery', 'evalUnvault'])
      expect(a(k)).toMatchObject({ refused: true });
    expect(a('evalLazy')?.error).toMatch(/not allowed while debugging/);
    expect(a('evalSlow')).toMatchObject({ timeout: true });
    expect(a('evalSlow')?.ms).toBeLessThan(3000);
    expect(a('evalBad')?.error).toMatch(/nope|undefined/i);
    const rows = a('watch')?.results ?? [];
    expect(rows).toHaveLength(9);
    const tier = rows.filter((r) => r.expr === 'site_tier').map((r) => `${r.host}=${r.value}`);
    expect(tier.sort()).toEqual(['h01=silver', 'h02=gold', 'h03=silver']);
    expect(rows.filter((r) => r.expr === 'via_b64').every((r) => r.masked === 'vault')).toBe(true);
  });

  it('answers a request for another pause as gone; a plain run pauses as in 1.1', () => {
    expect(a('stale')).toMatchObject({ gone: true });
    const plain = get('plain: no debug, the pause is as in 1.1');
    const pause = plain.events.find((e) => e.event === 'pause');
    expect(Object.keys(pause ?? {}).sort()).toEqual(
      ['event', 'hosts', 'id', 'node', 'play', 'timeout', 'ts'].sort(),
    );
    expect(plain.rc).toBe(0);
  });

  it('pauses where a condition matches any host, naming it; all hosts wait', () => {
    const o = get('conditions: per host, all hosts pause, an error does not pause');
    const key = keyOf(EDGE);
    expect(o.pauses.map((p) => key(p.node))).toEqual(['backup-config']);
    expect(o.pauses[0]).toMatchObject({ kind: 'condition', matched: ['sw-edge-02'] });
    expect(o.pauses[0]?.hosts.sort()).toEqual(['sw-edge-01', 'sw-edge-02', 'sw-edge-03']);
    const errors = (stepState(o.events).logs ?? []).filter((l) => l.source === 'condition');
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.every((l) => key(l.node) === 'validate' && l.error)).toBe(true);
    expect(a('conditionEval')?.value).toBe('sw-edge-02');
  });

  it('counts arrivals for hit counts and writes masked log lines without pausing', () => {
    const o = get('hits and log points: the Nth arrival pauses, a log point never does');
    const key = keyOf(EDGE);
    expect(o.pauses.map((p) => key(p.node))).toEqual(['backup-config']);
    expect(o.pauses[0]?.kind).toBe('condition');
    const state = stepState(o.events);
    expect(state.hits?.[idOf(EDGE, 'backup-config')]).toBe(3);
    expect(state.hits?.[idOf(EDGE, 'validate')]).toBeLessThan(10);
    const lines = (state.logs ?? []).filter((l) => key(l.node) === 'precheck');
    expect(lines.map((l) => l.host).sort()).toEqual(EDGE_HOSTS);
    const one = lines.find((l) => l.host === 'sw-edge-01');
    expect(one).toMatchObject({ message: 'sw-edge-01 of 4 cred=********', masked: ['credential'] });
    // A log template that holds a lookup: refused, and said so.
    const refused = (state.logs ?? []).filter((l) => key(l.node) === 'push-baseline');
    expect(refused.some((l) => l.source === 'log' && /lookup/.test(l.error ?? ''))).toBe(true);
    const errs = (state.logs ?? []).filter((l) => key(l.node) === 'validate');
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.every((l) => /missing_var/.test(l.error ?? ''))).toBe(true);
    expect(leaks(o.text)).toEqual([]);
  });

  it('pauses after a step hosts failed, with each host, task and message; continue routes as before', () => {
    const o = get('failure: continue at each failure pause routes as without');
    const key = keyOf(EDGE);
    const fails = o.pauses.filter((p) => p.kind === 'failure');
    expect(fails.map((p) => key(p.node))).toEqual(['precheck', 'validate']);
    expect(fails[0]?.failed?.map((f) => f.host)).toEqual(['sw-edge-04']);
    expect(fails[0]?.failed?.[0]?.task).toBeTruthy();
    expect(fails[0]?.attempt).toBe(1);
    expect(fails[0]?.hosts.sort()).toEqual(EDGE_HOSTS);
    expect(a('failedResult')?.value).toBe('precheck');
    const off = summarizeRun(o.text, o.code?.routes ?? {});
    expect(off.nodes[idOf(EDGE, 'precheck')]?.failed_hosts).toEqual(['sw-edge-04']);
    expect(o.rc).toBe(2);
  });

  it('stop at a failure pause ends the run there', () => {
    const o = get('failure: stop at the first failure pause');
    expect(o.pauses).toHaveLength(1);
    expect(stepState(o.events).stopped?.reason).toBe('driver');
    expect(o.events.some((e) => String(e.task ?? '').startsWith('[backup-config]'))).toBe(false);
    expect(o.rc).not.toBe(0);
  });

  it('retry runs the step again for the failed hosts; a second failure pauses again', () => {
    const o = get('retry: a second failure pauses again, then continue');
    const key = keyOf(EDGE);
    const fails = o.pauses.filter((p) => p.kind === 'failure');
    expect(fails.map((p) => `${key(p.node)}#${p.attempt}`)).toEqual([
      'precheck#1',
      'precheck#2',
      'validate#1',
    ]);
    const retry = o.events.find((e) => e.event === 'retry');
    expect(retry).toMatchObject({ hosts: ['sw-edge-04'], attempt: 2 });
    // The summary forgets the first attempt: the same routes as a run without Retry.
    const plain = get('failure: continue at each failure pause routes as without');
    const s = summarizeRun(o.text, o.code?.routes ?? {});
    expect(s.nodes).toEqual(summarizeRun(plain.text, plain.code?.routes ?? {}).nodes);
    expect(o.rc).toBe(plain.rc);
  });

  it('pauses for an unreachable host when the filter asks, beside failed ones', () => {
    const o = get('unreachable: the filter pauses for a host routed unreachable');
    const key = keyOf(LEVELS);
    const fails = o.pauses.filter((p) => p.kind === 'failure');
    expect(fails.map((p) => key(p.node))).toEqual(['prepare', 'connect', 'gate']);
    expect(fails[1]?.failed).toEqual([
      { host: 'h07', task: '', msg: 'Unreachable', unreachable: true },
    ]);
    expect(fails[2]?.failed?.map((f) => f.host)).toEqual(['h03', 'h04']);
  });

  it('retry: the step succeeds the second time and the host goes on by ok', () => {
    const o = get('retry: the step succeeds the second time');
    const fails = o.pauses.filter((p) => p.kind === 'failure');
    expect(fails).toHaveLength(1);
    expect(fails[0]?.failed?.map((f) => f.host)).toEqual(['h02']);
    expect(o.rc).toBe(0);
    const s = summarizeRun(o.text, o.code?.routes ?? {});
    const check = s.nodes[idOf(RETRY, 'check')] ?? {};
    expect(check.ok_hosts).toEqual(['h01', 'h02', 'h03']);
    expect(check.failed_hosts ?? []).toEqual([]);
    expect(s.nodes[idOf(RETRY, 'fix')]).toBeUndefined();
    expect(s.outcome).toEqual({});
    const off = get('retry: off without failure filter, as a plain run');
    expect(off.pauses).toHaveLength(0);
    expect(off.rc).toBe(2);
    expect(results(off).some((r) => r.startsWith('h02 ok [fix]'))).toBe(true);
  });
});

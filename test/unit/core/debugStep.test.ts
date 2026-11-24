// ADR-0040 (AFD-370, AFD-371, AFD-372): the debugger's channel as the driver sees it: points with
// settings, the pause kinds, log and hit events, Retry in the run summary, the SSH relay's
// commands, and runFlow's debug driver (AFD_DEBUG, failure filters, Retry, inspect requests).
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { Route } from '../../../src/core/engine/types';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { ProcessSpec } from '../../../src/core/run/command';
import type { Environment } from '../../../src/core/run/environment';
import { summarizeRun } from '../../../src/core/run/events';
import { askCommand, relayCommand } from '../../../src/core/run/ssh';
import {
  hasSettings,
  inspectRequest,
  normalPoints,
  type StepControl,
  stepEvent,
  stepState,
} from '../../../src/core/run/step';
import type { Execution } from '../../../src/node/run/exec';
import { localInspector } from '../../../src/node/run/inspect';
import { type RunFlowRequest, runFlow, type StepDriver } from '../../../src/node/run/runFlow';

const line = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`;

describe('ADR-0040: pause points with settings', () => {
  it('keeps a point without settings as its bare id, one point per node', () => {
    expect(
      normalPoints([
        'A',
        { node: 'B' },
        { node: 'C', condition: '  x > 1 ', hits: 0, log: '' },
        { node: 'D', hits: 3.5, log: 'at {{ inventory_hostname }}' },
        { node: 'A', hits: 2 },
      ]),
    ).toEqual([
      { node: 'A', hits: 2 },
      'B',
      { node: 'C', condition: 'x > 1' },
      { node: 'D', log: 'at {{ inventory_hostname }}' },
    ]);
    expect(hasSettings('A')).toBe(false);
    expect(hasSettings({ node: 'A', condition: ' ' })).toBe(false);
    expect(hasSettings({ node: 'A', hits: 1 })).toBe(true);
  });
});

describe('ADR-0040: what a debug run says', () => {
  const events = [
    {
      event: 'pause',
      id: 't-1',
      node: 'N1',
      play: '[a] A',
      hosts: ['h1', 'h2'],
      kind: 'condition',
      matched: ['h2'],
      debug: true,
      timeout: 60,
      ts: 1,
    },
    { event: 'resume', id: 't-1', node: 'N1', command: 'continue', ts: 2 },
    { event: 'log', node: 'N2', host: 'h1', message: 'x ********', masked: ['vault'], ts: 3 },
    { event: 'log', node: 'N2', source: 'condition', error: 'boom', ts: 3 },
    { event: 'hits', node: 'N2', count: 2, hits: 5, ts: 3 },
    {
      event: 'pause',
      id: 't-2',
      node: 'N3',
      play: '[c] C',
      hosts: ['h1', 'h2'],
      kind: 'failure',
      failed: [{ host: 'h2', task: '[c] do', msg: 'rc=1', hard: true }],
      attempt: 1,
      retry: { refused: 'not here' },
      debug: true,
      timeout: 60,
      ts: 4,
    },
    { event: 'refused', id: 't-2', node: 'N3', command: 'retry', why: 'not here', ts: 5 },
  ];

  it('reads the pause kind, matched and failed hosts, logs, hits and refusals', () => {
    const lines = events.map((e) => stepEvent(JSON.stringify(e)));
    expect(lines.every(Boolean)).toBe(true);
    const state = stepState(events);
    expect(state.paused).toMatchObject({
      id: 't-2',
      kind: 'failure',
      attempt: 1,
      retryRefused: 'not here',
      failed: [{ host: 'h2', task: '[c] do', msg: 'rc=1', hard: true }],
      debug: true,
    });
    expect(state.logs).toEqual([
      { node: 'N2', host: 'h1', message: 'x ********', masked: ['vault'], ts: 3 },
      { node: 'N2', source: 'condition', error: 'boom', ts: 3 },
    ]);
    expect(state.hits).toEqual({ N2: 2 });
    expect(state.refused).toEqual({ pause: 't-2', command: 'retry', why: 'not here' });
    expect(stepState(events.slice(0, 1)).paused).toMatchObject({
      kind: 'condition',
      matched: ['h2'],
    });
  });

  it('a retry event makes the summary forget the step for those hosts', () => {
    const routes: Record<string, Route> = {
      flow_check_ok_hosts: { node: 'CHECK', port: 'ok_hosts' },
      flow_check_failed_hosts: { node: 'CHECK', port: 'failed_hosts', fails: 'failed at check' },
    };
    const text = [
      { event: 'play', name: '[check] Check', node: 'CHECK' },
      {
        event: 'result',
        status: 'failed',
        host: 'h2',
        task: '[check] run',
        node: 'CHECK',
        msg: 'no',
      },
      {
        event: 'result',
        status: 'ok',
        host: 'h1',
        task: 'route',
        node: 'CHECK',
        group: 'flow_check_ok_hosts',
      },
      {
        event: 'result',
        status: 'ok',
        host: 'h2',
        task: 'route',
        node: 'CHECK',
        group: 'flow_check_failed_hosts',
      },
      { event: 'retry', node: 'CHECK', hosts: ['h2'], attempt: 2 },
      {
        event: 'result',
        status: 'ok',
        host: 'h2',
        task: 'route',
        node: 'CHECK',
        group: 'flow_check_ok_hosts',
      },
      { event: 'play', name: '[x] Outcome', node: null },
      { event: 'stats', hosts: {} },
    ]
      .map(line)
      .join('');
    const s = summarizeRun(text, routes);
    expect(s.nodes.CHECK).toEqual({ ok_hosts: ['h1', 'h2'] });
    expect(s.outcome).toEqual({});
    expect(s.problems?.CHECK ?? {}).toEqual({});
    expect(s.failures).toEqual([]);
  });
});

describe('ADR-0040: the SSH relay', () => {
  const target = { host: 'lab-runner', dir: '$HOME/.afd' };
  it('keeps one channel: request lines in, answer lines out, in the run folder', () => {
    const c = relayCommand(target, 'C:\\runs\\R1');
    expect(c.command).toBe('ssh');
    const script = c.args.at(-1) ?? '';
    expect(script).toContain('"$HOME"');
    expect(script).toContain('/runs/R1');
    expect(script).toContain('request-$n.json');
    expect(script).toContain('answer-$n.json');
  });
  it('falls back to one ssh per request', () => {
    const script = askCommand(target, '/x/runs/R2', 7).args.at(-1) ?? '';
    expect(script).toContain('cat > request-7.json.tmp');
    expect(script).toContain('answer-7.json');
  });
});

describe('ADR-0040: localInspector', () => {
  let dir = '';
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'afd-inspect-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('writes the request whole and reads the answer, then removes it', async () => {
    const serve = setInterval(() => {
      for (const f of readdirSync(dir).filter((n) => /^request-\d+\.json$/.test(n))) {
        const req = JSON.parse(readFileSync(join(dir, f), 'utf8'));
        rmSync(join(dir, f));
        writeFileSync(join(dir, `answer-${req.n}.json`), JSON.stringify({ n: req.n, op: req.op }));
      }
    }, 10);
    const a = await localInspector(dir).ask(3, inspectRequest(3, 'p-1', 'scopes', { host: 'h1' }));
    clearInterval(serve);
    expect(a).toEqual({ n: 3, op: 'scopes' });
    expect(readdirSync(dir)).toEqual([]);
  });

  it('says the run did not answer, and takes its request back', async () => {
    const a = await localInspector(dir, 120).ask(1, { op: 'scopes' });
    expect(a.error).toMatch(/did not answer/);
    expect(existsSync(join(dir, 'request-1.json'))).toBe(false);
  });
});

describe('ADR-0040: runFlow debug runs', () => {
  const fixtures = join(__dirname, '../../fixtures/engine');
  const doc = parse(
    readFileSync(join(fixtures, 'routing-ports.flow.yaml'), 'utf8'),
  ) as FlowDocument;
  const code = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
  const env: Environment = { kind: 'local', python: 'python3', source: 'default', label: 'local' };
  let storage = '';
  let root = '';
  beforeEach(() => {
    storage = mkdtempSync(join(tmpdir(), 'afd-debug-storage-'));
    root = mkdtempSync(join(tmpdir(), 'afd-debug-root-'));
  });
  afterEach(() => {
    rmSync(storage, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });
  const until = async (ok: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok()) {
      if (Date.now() > end) throw new Error('timed out');
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  const request = (step: RunFlowRequest['step']): RunFlowRequest => ({
    id: `R${Date.now()}`,
    startedAt: new Date().toISOString(),
    mode: 'check',
    doc,
    code,
    env,
    environment: 'local',
    root,
    probeDir: join(root, 'probe'),
    playbook: 'flows/generated/routing-ports.yml',
    storage,
    inputs: { devices: ['h1', 'h2'] },
    step,
  });

  /** A run that fails a step, pauses (kind failure), serves requests and follows control.json. */
  function failingRun(refused?: string) {
    const seen: { env?: Record<string, string>; atStart?: StepControl; controls: StepControl[] } = {
      controls: [],
    };
    const execute = (_s: ProcessSpec, e: Record<string, string>): Execution => {
      seen.env = e;
      const runDir = e.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
      const events = join(runDir, 'events.jsonl');
      const controlFile = join(runDir, 'control.json');
      seen.atStart = JSON.parse(readFileSync(controlFile, 'utf8'));
      writeFileSync(events, line({ event: 'hits', node: 'N0', count: 4, hits: 9, ts: 1 }));
      const exit = (async () => {
        await appendFile(
          events,
          line({
            event: 'pause',
            id: 'k-1',
            node: 'N1',
            play: '[n] N',
            hosts: ['h1', 'h2'],
            kind: 'failure',
            failed: [{ host: 'h2', task: 't', msg: 'm' }],
            attempt: 1,
            debug: true,
            ...(refused ? { retry: { refused } } : {}),
            timeout: 60,
            ts: 2,
          }),
        );
        let answered: StepControl | undefined;
        await until(() => {
          for (const f of readdirSync(runDir).filter((n) => /^request-\d+\.json$/.test(n))) {
            const req = JSON.parse(readFileSync(join(runDir, f), 'utf8'));
            rmSync(join(runDir, f));
            const body = JSON.stringify({ n: req.n, pause: req.pause, host: req.host, op: req.op });
            writeFileSync(join(runDir, `answer-${req.n}.json.t`), body);
            void rename(
              join(runDir, `answer-${req.n}.json.t`),
              join(runDir, `answer-${req.n}.json`),
            );
          }
          const c = JSON.parse(readFileSync(controlFile, 'utf8')) as StepControl;
          if (c.reply !== 'k-1') return false;
          answered = c;
          return true;
        }, 10_000);
        if (answered) seen.controls.push(answered);
        await appendFile(
          events,
          line({ event: 'resume', id: 'k-1', node: 'N1', command: answered?.command, ts: 3 }),
        );
        await appendFile(events, line({ event: 'stats', hosts: {}, ts: 4 }));
        return 0;
      })();
      return { exit, terminate: () => undefined };
    };
    return { execute, seen };
  }

  it('sets AFD_DEBUG, starts with pause on failure, answers requests and sends Retry', async () => {
    const run = failingRun();
    let driver: StepDriver | undefined;
    const pending = runFlow(
      request({ every: false, points: [{ node: 'N1', hits: 2 }], timeoutS: 60, debug: true }),
      {
        report: () => undefined,
        execute: run.execute,
        started: (_stop, step) => {
          driver = step;
          return undefined;
        },
      },
    );
    await until(() => !!driver?.paused());
    expect(run.seen.env?.AFD_DEBUG).toBe('1');
    expect(run.seen.atStart).toEqual({
      v: 1,
      command: 'continue',
      points: [{ node: 'N1', hits: 2 }],
      reply: null,
      failures: { failed: true },
    });
    const a = await driver?.inspect('vars', { host: 'h2', scope: 'host' });
    expect(a).toEqual({ n: 1, pause: 'k-1', host: 'h2', op: 'vars' });
    expect(driver?.control().hits).toEqual({ N0: 4 });
    expect(await driver?.send('retry')).toBeUndefined();
    const done = await pending;
    expect(run.seen.controls[0]).toMatchObject({
      command: 'retry',
      after: 'continue',
      reply: 'k-1',
      failures: { failed: true },
      hits: { N0: 4 },
    });
    expect(done.step).toMatchObject({
      debug: true,
      points: ['N1'],
      settings: [{ node: 'N1', hits: 2 }],
    });
    expect(await driver?.inspect('scopes', { host: 'h1' })).toEqual({ gone: true });
  });

  it('refuses Retry where the run does not offer it, with its words', async () => {
    const run = failingRun('Not in a rolling subflow');
    let driver: StepDriver | undefined;
    const pending = runFlow(request({ every: true, points: [], timeoutS: 60, debug: true }), {
      report: () => undefined,
      execute: run.execute,
      started: (_stop, step) => {
        driver = step;
        return undefined;
      },
    });
    await until(() => !!driver?.paused());
    expect(await driver?.send('retry')).toBe('Not in a rolling subflow');
    expect(await driver?.setFailures({ failed: true, unreachable: true })).toBeUndefined();
    expect(await driver?.send('stop')).toBeUndefined();
    await pending;
    expect(run.seen.controls[0]).toMatchObject({
      command: 'stop',
      failures: { failed: true, unreachable: true },
    });
  });

  it('a run that is not a debug run has no AFD_DEBUG, no failure filter and no inspect', async () => {
    const run = failingRun();
    let driver: StepDriver | undefined;
    const pending = runFlow(request({ every: true, points: ['N1'], timeoutS: 60 }), {
      report: () => undefined,
      execute: run.execute,
      started: (_stop, step) => {
        driver = step;
        return undefined;
      },
    });
    await until(() => !!driver?.paused());
    expect(run.seen.env?.AFD_DEBUG).toBeUndefined();
    expect(run.seen.atStart).toEqual({ v: 1, command: 'step', points: ['N1'], reply: null });
    expect((await driver?.inspect('scopes', { host: 'h1' }))?.error).toMatch(/debug run/);
    expect(await driver?.setFailures({ failed: true })).toMatch(/debug run/);
    await driver?.send('continue');
    await pending;
  });
});

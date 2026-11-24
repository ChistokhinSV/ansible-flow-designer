// AFD-369 (ADR-0040 §8): VS Code's debug adapter for flows, driven through the protocol with a
// fake StepDriver: threads per host, one stopped event per pause, frames on key lines, scopes and
// paged variables, evaluate with refusals as text, breakpoints (function, source, conditions,
// hit counts, log messages) as pause points, failure filters, Retry and its refusal, the end.
// Also the shared words and mappings of core/run/debug.ts. Fictional hosts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import {
  entryText,
  keyLines,
  pointDot,
  pointFromBreakpoint,
  readBreakpointName,
  readHitCondition,
  reasonLine,
  retryWarning,
  shortReason,
  stepByPath,
} from '../../../src/core/run/debug';
import type {
  FailureFilters,
  InspectAnswer,
  InspectArgs,
  InspectOp,
  PointSpec,
  StepCommand,
  StepPause,
} from '../../../src/core/run/step';
import {
  type DebugHost,
  type DebugRunHooks,
  FlowDebugAdapter,
} from '../../../src/node/debug/adapter';
import type { StepDriver } from '../../../src/node/run/runFlow';

const FLOW = join(__dirname, '../../fixtures/engine/debug-retry.flow.yaml');
const text = readFileSync(FLOW, 'utf8');
const doc = parse(text) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const model = buildModel(doc);

type Msg = Record<string, unknown> & { body: Record<string, unknown> };

class FakeDriver implements StepDriver {
  sent: StepCommand[] = [];
  points: PointSpec[][] = [];
  failures: FailureFilters[] = [];
  asked: { op: InspectOp; args: InspectArgs }[] = [];
  pause?: StepPause;
  answers: (op: InspectOp, args: InspectArgs) => InspectAnswer = () => ({});
  async send(command: StepCommand) {
    this.sent.push(command);
    if (command === 'retry' && this.pause?.retryRefused) return this.pause.retryRefused;
    return undefined;
  }
  async setPoints(p: PointSpec[]) {
    this.points.push(p);
    return undefined;
  }
  async setFailures(f: FailureFilters) {
    this.failures.push(f);
    return undefined;
  }
  paused() {
    return this.pause;
  }
  control() {
    return { v: 1 as const, command: 'continue' as const, points: [] };
  }
  async inspect(op: InspectOp, args: InspectArgs = {}) {
    this.asked.push({ op, args });
    return this.answers(op, args);
  }
}

function setup() {
  const out: Msg[] = [];
  const driver = new FakeDriver();
  let hooks: DebugRunHooks | undefined;
  let finish: (v: RunView) => void = () => undefined;
  let stopped = 0;
  const saved: PointSpec[] = [];
  const host: DebugHost = {
    load: async () => ({ path: FLOW, text, doc }),
    start: (_args, h) => {
      hooks = h;
      h.started(driver);
      return new Promise<RunView>((r) => {
        finish = r;
      });
    },
    stop: async () => {
      stopped += 1;
      finish({ ...view(), state: 'error', error: 'Stopped', rc: 2 });
    },
    samePath: (a, b) => a.toLowerCase() === b.toLowerCase(),
    savedPoints: () => saved,
  };
  const adapter = new FlowDebugAdapter(host, (m) => out.push(m as Msg));
  let seq = 1;
  const req = async (command: string, args: Record<string, unknown> = {}) => {
    const s = seq++;
    await adapter.handle({ seq: s, type: 'request', command, arguments: args });
    return out.find((m) => m.type === 'response' && m.request_seq === s) as Msg;
  };
  const events = (name: string) => out.filter((m) => m.type === 'event' && m.event === name);
  return {
    out,
    driver,
    req,
    events,
    adapter,
    hooks: () => hooks as DebugRunHooks,
    finish: (v: RunView) => finish(v),
    stopped: () => stopped,
    saved,
  };
}

const view = (paused?: StepPause, extra: Partial<RunView> = {}): RunView => ({
  id: 'r1',
  mode: 'check',
  state: 'running',
  startedAt: '2026-11-23T10:00:00Z',
  step: {
    every: false,
    points: [],
    pauses: paused ? 1 : 0,
    debug: true,
    ...(paused ? { paused } : {}),
  },
  ...extra,
});

const failure: StepPause = {
  id: 'p-1',
  node: id('check'),
  play: '[check] Check marker',
  hosts: ['h01', 'h02', 'h03'],
  since: Date.now() / 1000,
  timeout: 3600,
  kind: 'failure',
  attempt: 1,
  debug: true,
  failed: [{ host: 'h02', task: 'Check marker', msg: 'non-zero return code' }],
};

async function launched(stopOnEntry = false) {
  const t = setup();
  const init = await t.req('initialize', { adapterID: 'ansible-flow' });
  expect(init.body.supportsConditionalBreakpoints).toBe(true);
  expect(
    (init.body.exceptionBreakpointFilters as { filter: string; default: boolean }[]).map((f) => [
      f.filter,
      f.default,
    ]),
  ).toEqual([
    ['failed', true],
    ['unreachable', false],
  ]);
  expect((await t.req('launch', { flow: FLOW, stopOnEntry })).success).toBe(true);
  expect(t.events('initialized')).toHaveLength(1);
  return t;
}

describe('AFD-369: the debug adapter', () => {
  let t: Awaited<ReturnType<typeof launched>>;
  beforeEach(async () => {
    t = await launched();
  });

  it('breakpoints become pause points: function by key, source on key lines, settings', async () => {
    const lines = keyLines(text, model);
    const fn = await t.req('setFunctionBreakpoints', {
      breakpoints: [
        { name: 'debug-retry:apply', condition: "inventory_hostname == 'h01'" },
        { name: 'other-flow:apply' },
        { name: 'nope' },
        { name: 'start' },
        { name: 'fix', hitCondition: 'often' },
      ],
    });
    const bps = fn.body.breakpoints as { verified: boolean; line?: number; message?: string }[];
    expect(bps.map((b) => b.verified)).toEqual([true, false, false, false, false]);
    expect(bps[0]?.line).toBe(lines.get(id('apply')));
    expect(bps[1]?.message).toMatch(/flow other-flow/);
    expect(bps[4]?.message).toMatch(/whole number/);
    const src = await t.req('setBreakpoints', {
      source: { path: FLOW.toUpperCase() },
      breakpoints: [
        {
          line: lines.get(id('fix')),
          hitCondition: '>=2',
          logMessage: 'at {{ inventory_hostname }}',
        },
        { line: (lines.get(id('fix')) as number) + 1 },
        { line: lines.get(id('start')) },
      ],
    });
    const sb = src.body.breakpoints as { verified: boolean; message?: string }[];
    expect(sb.map((b) => b.verified)).toEqual([true, false, false]);
    expect(sb[1]?.message).toMatch(/key: line/);
    expect(sb[2]?.message).toMatch(/not at start/);
    const other = await t.req('setBreakpoints', {
      source: { path: 'C:/elsewhere/x.yaml' },
      breakpoints: [{ line: 3 }],
    });
    expect((other.body.breakpoints as { verified: boolean }[])[0]?.verified).toBe(false);
    await t.req('setExceptionBreakpoints', { filters: ['failed', 'unreachable'] });
    await t.req('configurationDone');
    expect(t.hooks().every).toBe(false);
    expect(t.hooks().failures).toEqual({ failed: true, unreachable: true });
    expect(t.hooks().points).toEqual([
      { node: id('apply'), condition: "inventory_hostname == 'h01'" },
      { node: id('fix'), hits: 2, log: 'at {{ inventory_hostname }}' },
    ]);
    // While the run goes, changed breakpoints reach its driver.
    await t.req('setFunctionBreakpoints', { breakpoints: [] });
    expect(t.driver.points.at(-1)).toEqual([
      { node: id('fix'), hits: 2, log: 'at {{ inventory_hostname }}' },
    ]);
    await t.req('setExceptionBreakpoints', { filters: [] });
    expect(t.driver.failures.at(-1)).toEqual({ failed: false, unreachable: false });
  });

  it('a failure pause: one stopped event on the failed host, threads host first, frames, info', async () => {
    await t.req('configurationDone');
    const threads0 = await t.req('threads');
    expect(threads0.body.threads).toEqual([{ id: 1, name: 'Debug retry' }]);
    t.driver.pause = failure;
    t.hooks().report(view(failure));
    t.hooks().report(view(failure));
    const stops = t.events('stopped');
    expect(stops).toHaveLength(1);
    const body = (stops[0]?.body ?? {}) as Record<string, unknown>;
    expect(body.reason).toBe('exception');
    expect(body.allThreadsStopped).toBe(true);
    expect(body.description).toBe('1 host failed Check marker');
    expect(String(body.text)).toContain('h02: Check marker: non-zero return code');
    const threads = (await t.req('threads')).body.threads as { id: number; name: string }[];
    expect(threads.map((x) => x.name)).toEqual(['h02 · failed', 'h01 · waiting', 'h03 · waiting']);
    expect(body.threadId).toBe(threads[0]?.id);
    const stack = await t.req('stackTrace', { threadId: threads[0]?.id, startFrame: 0, levels: 1 });
    const frames = stack.body.stackFrames as { id: number; name: string; line: number }[];
    expect(stack.body.totalFrames).toBe(2);
    expect(frames[0]?.name).toBe('Check marker  (failed)');
    expect(frames[0]?.line).toBe(keyLines(text, model).get(id('check')));
    expect((await t.req('afd/frame', { frameId: frames[0]?.id })).body).toEqual({
      node: id('check'),
    });
    const info = await t.req('exceptionInfo', { threadId: threads[0]?.id });
    expect(info.body.exceptionId).toBe('failed');
    expect(info.body.description).toBe(
      'Paused after Check marker: 1 of 3 hosts failed (attempt 1)',
    );
    expect(JSON.stringify(info.body.details)).toMatch(/Changes on hosts are not undone/);
    // Retry (a custom request: DAP has none), then the run goes on: continued.
    expect((await t.req('retry')).success).toBe(true);
    expect(t.driver.sent).toEqual(['retry']);
    t.driver.pause = undefined;
    t.hooks().report(view());
    expect(t.events('continued')).toHaveLength(1);
  });

  it('Retry refused says why; Step Into is Step, Step Out refused; Continue and Step go to the driver', async () => {
    await t.req('configurationDone');
    const refused = {
      ...failure,
      retryRefused: 'a rolling subflow runs as one play: rerun from this step as a new run',
    };
    t.driver.pause = refused;
    t.hooks().report(view(refused));
    const r = await t.req('retry');
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/rolling subflow/);
    expect((await t.req('stepIn', { threadId: 2 })).success).toBe(true);
    const out = await t.req('stepOut', { threadId: 2 });
    expect(out.success).toBe(false);
    expect(out.message).toMatch(/Step Out is not in this version/);
    expect((await t.req('next', { threadId: 2 })).success).toBe(true);
    expect((await t.req('continue', { threadId: 2 })).body).toEqual({ allThreadsContinued: true });
    expect(t.driver.sent).toEqual(['retry', 'step', 'step', 'continue']);
  });

  it('scopes and paged variables from inspect; masked values say why', async () => {
    await t.req('configurationDone');
    t.driver.pause = failure;
    t.hooks().report(view(failure));
    t.driver.answers = (op, args) => {
      if (op === 'scopes')
        return {
          host: args.host,
          scopes: [
            { id: 'inputs', name: 'Step inputs', vars: [] },
            { id: 'host', name: 'Host variables', vars: [{ name: 'a', type: 'int' }] },
            { id: 'flow', name: 'Flow data', vars: [] },
            { id: 'facts', name: 'Facts', expensive: true },
          ],
        };
      if (op === 'vars' && (args.path ?? []).length === 0)
        return {
          total: 3,
          start: 0,
          children: [
            { name: 'site', type: 'str', value: 'lab-east' },
            { name: 'admin_password', type: 'masked', masked: 'credential' },
            { name: 'ports', type: 'list', count: 250 },
          ],
        };
      if (op === 'vars')
        return {
          total: 250,
          start: args.start,
          children: Array.from({ length: args.count ?? 0 }, (_, i) => ({
            name: (args.start ?? 0) + i,
            type: 'str',
            value: `Gi0/${(args.start ?? 0) + i}`,
          })),
        };
      return {};
    };
    const thread = ((await t.req('threads')).body.threads as { id: number }[])[0]?.id;
    const frame = (
      (await t.req('stackTrace', { threadId: thread })).body.stackFrames as { id: number }[]
    )[0]?.id;
    const scopes = (await t.req('scopes', { frameId: frame })).body.scopes as {
      name: string;
      expensive: boolean;
      variablesReference: number;
    }[];
    expect(scopes.map((s) => [s.name, s.expensive])).toEqual([
      ['Step inputs (h02)', false],
      ['Host variables (h02)', false],
      ['Flow data', false],
      ['Facts', true],
    ]);
    const vars = (await t.req('variables', { variablesReference: scopes[1]?.variablesReference }))
      .body.variables as {
      name: string;
      value: string;
      variablesReference: number;
      indexedVariables?: number;
    }[];
    expect(vars.map((v) => [v.name, v.value])).toEqual([
      ['site', '"lab-east"'],
      ['admin_password', 'masked: credential'],
      ['ports', '[250 items]'],
    ]);
    expect(vars[2]?.indexedVariables).toBe(250);
    const page = (
      await t.req('variables', {
        variablesReference: vars[2]?.variablesReference,
        filter: 'indexed',
        start: 100,
        count: 100,
      })
    ).body.variables as { name: string }[];
    expect(page).toHaveLength(100);
    expect(page[0]?.name).toBe('100');
    expect(t.driver.asked.at(-1)?.args).toMatchObject({
      host: 'h02',
      scope: 'host',
      path: ['ports'],
      start: 100,
      count: 100,
    });
  });

  it('evaluate: a value, a container to expand, refusals as text, watch errors inline', async () => {
    await t.req('configurationDone');
    expect((await t.req('evaluate', { expression: 'x', context: 'repl' })).success).toBe(false);
    t.driver.pause = failure;
    t.hooks().report(view(failure));
    t.driver.answers = (_op, args) =>
      args.expr === 'peers'
        ? { type: 'list', count: 2, value: ['10.0.0.1', { __afd__: 'masked', masked: 'vault' }] }
        : args.expr?.startsWith('lookup')
          ? { error: 'lookup is not allowed while debugging', refused: true }
          : args.expr === 'bad'
            ? { error: "'bad' is undefined" }
            : { type: 'int', value: 210 };
    const one = await t.req('evaluate', { expression: '{{ vlan_id }}', context: 'repl' });
    expect(one.body.result).toBe('210');
    expect(t.driver.asked.at(-1)?.args).toEqual({ host: 'h02', expr: 'vlan_id' });
    const list = await t.req('evaluate', { expression: 'peers', context: 'watch' });
    expect(list.body.result).toBe('[2 items]');
    const items = (await t.req('variables', { variablesReference: list.body.variablesReference }))
      .body.variables as { value: string }[];
    expect(items.map((v) => v.value)).toEqual(['"10.0.0.1"', 'masked: vault']);
    const refused = await t.req('evaluate', {
      expression: "lookup('pipe', 'id')",
      context: 'repl',
    });
    expect(refused.success).toBe(true);
    expect(refused.body.result).toBe('Refused: lookup is not allowed while debugging');
    const watch = await t.req('evaluate', { expression: 'bad', context: 'watch' });
    expect(watch.success).toBe(false);
    expect(watch.message).toBe("Error: 'bad' is undefined");
  });

  it('log lines and refusals go to the Debug Console once; the run ending terminates', async () => {
    await t.req('configurationDone');
    const logs = [{ node: id('apply'), host: 'h01', message: 'vlan 210', ts: 1 }];
    t.hooks().report({
      ...view(),
      step: { ...(view().step as NonNullable<RunView['step']>), logs },
    });
    t.hooks().report({
      ...view(),
      step: { ...(view().step as NonNullable<RunView['step']>), logs },
    });
    const lines = t.events('output').map((e) => String((e.body as { output: string }).output));
    expect(lines.filter((l) => l.includes('vlan 210'))).toEqual(['Apply change · h01: vlan 210\n']);
    t.finish({ ...view(), state: 'done', rc: 0 });
    await new Promise((r) => setTimeout(r, 0));
    expect(t.events('exited')[0]?.body).toEqual({ exitCode: 0 });
    expect(t.events('terminated')).toHaveLength(1);
  });

  it('disconnect while paused stops the run at its step; while going, stops it', async () => {
    await t.req('configurationDone');
    t.driver.pause = failure;
    t.hooks().report(view(failure));
    const ending = t.req('disconnect');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.driver.sent).toEqual(['stop']);
    t.finish({ ...view(), state: 'error', rc: 2, error: 'Stopped before Check marker' });
    expect((await ending).success).toBe(true);
    const u = await launched();
    await u.req('configurationDone');
    await u.req('terminate');
    expect(u.stopped()).toBe(1);
  });

  it('a log point mirrored as a function breakpoint keeps its message (DAP sends none)', async () => {
    t.saved.push({ node: id('apply'), log: 'LP {{ inventory_hostname }}' }, id('fix'));
    await t.req('setFunctionBreakpoints', {
      breakpoints: [{ name: 'debug-retry:apply' }, { name: 'debug-retry:fix' }],
    });
    await t.req('configurationDone');
    expect(t.hooks().points).toEqual([
      { node: id('apply'), log: 'LP {{ inventory_hostname }}' },
      id('fix'),
    ]);
  });

  it('an empty Facts scope says why', async () => {
    await t.req('configurationDone');
    t.driver.pause = failure;
    t.hooks().report(view(failure));
    t.driver.answers = (op, args) =>
      op === 'scopes'
        ? { host: args.host, scopes: [{ id: 'facts', name: 'Facts', expensive: true }] }
        : { total: 0, start: 0, children: [] };
    const thread = ((await t.req('threads')).body.threads as { id: number }[])[0]?.id;
    const frame = (
      (await t.req('stackTrace', { threadId: thread })).body.stackFrames as { id: number }[]
    )[0]?.id;
    const scopes = (await t.req('scopes', { frameId: frame })).body.scopes as {
      variablesReference: number;
    }[];
    const vars = (await t.req('variables', { variablesReference: scopes[0]?.variablesReference }))
      .body.variables as { name: string; value: string }[];
    expect(vars).toHaveLength(1);
    expect(vars[0]?.value).toMatch(/No facts for this host yet/);
  });

  it('stopOnEntry: the first pause is an entry', async () => {
    const u = await launched(true);
    await u.req('configurationDone');
    expect(u.hooks().every).toBe(true);
    const p: StepPause = { ...failure, kind: 'step', failed: undefined };
    u.hooks().report(view(p));
    expect(((u.events('stopped')[0]?.body ?? {}) as { reason?: string }).reason).toBe('entry');
  });
});

describe('ADR-0040: the debugger words and mappings', () => {
  it('reason lines name the step, the hosts and why', () => {
    expect(reasonLine(failure, 'Apply config')).toBe(
      'Paused after Apply config: 1 of 3 hosts failed (attempt 1)',
    );
    // After a Retry every host still waits: the failed one is counted among all of them.
    expect(reasonLine({ ...failure, attempt: 2 }, 'Apply config')).toBe(
      'Paused after Apply config: 1 of 3 hosts failed (attempt 2)',
    );
    expect(reasonLine({ ...failure, kind: 'condition', reached: 2 }, 'X')).toBe(
      'Paused before X: reached 2 times · 3 hosts wait',
    );
    expect(
      shortReason(
        { ...failure, failed: [{ host: 'h7', task: '', msg: '', unreachable: true }] },
        'X',
      ),
    ).toBe('1 host unreachable at X');
    expect(reasonLine({ ...failure, kind: 'condition', matched: ['h1'] }, 'X')).toBe(
      'Paused before X: the condition matched h1 · 3 hosts wait',
    );
    expect(retryWarning(failure, 'Apply config')).toBe(
      'Retry runs Apply config again on h02. Changes on hosts are not undone.',
    );
  });

  it('breakpoint names, hit conditions and points', () => {
    expect(readBreakpointName('edge:push/apply')).toEqual({ flow: 'edge', path: 'push/apply' });
    expect(readBreakpointName('apply')).toEqual({ path: 'apply' });
    expect(readHitCondition('>= 3')).toBe(3);
    expect(readHitCondition('')).toBeUndefined();
    expect(readHitCondition('x')).toHaveProperty('error');
    expect(pointFromBreakpoint('N', {})).toEqual({ point: 'N' });
    expect(pointFromBreakpoint('N', { condition: 'a', hitCondition: '2' })).toEqual({
      point: { node: 'N', condition: 'a', hits: 2 },
    });
    expect(stepByPath(model, 'apply')).toBe(id('apply'));
    expect(stepByPath(model, 'start')).toBeUndefined();
    expect(pointDot({ node: 'N', log: 'x' })).toBe('log');
    expect(pointDot({ node: 'N', hits: 2 })).toBe('condition');
    expect(pointDot('N')).toBe('on');
    expect(entryText({ type: 'str', value: 'abc', cut: 70000 })).toBe(
      '(cut at 64 KB: 70000 characters in all) "abc" …',
    );
    expect(entryText({ type: 'list', count: 1 })).toBe('[1 item]');
    expect(entryText({ type: 'dict', count: 1 })).toBe('{1 key}');
    expect(entryText({ type: 'template', value: { __afd__: 'template', text: '{{ x }}' } })).toBe(
      '{{ x }}  (template, not rendered)',
    );
  });
});

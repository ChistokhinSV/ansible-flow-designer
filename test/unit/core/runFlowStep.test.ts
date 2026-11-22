// AFD-346 (ADR-0039): a step-by-step run as runFlow drives it: the start control is there before
// the process, the live view says where the run waits, Step answers that pause, a stop at a step
// boundary ends the run as stopped (not failed) though its exit code is 2, and approval segments
// carry the control and start inside the approval.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import type { ProcessSpec } from '../../../src/core/run/command';
import type { Environment } from '../../../src/core/run/environment';
import type { StepControl } from '../../../src/core/run/step';
import type { Execution } from '../../../src/node/run/exec';
import { type RunFlowRequest, runFlow, type StepDriver } from '../../../src/node/run/runFlow';
import { runSegments } from '../../../src/node/run/segments';

const fixtures = join(__dirname, '../../fixtures/engine');
const doc = parse(readFileSync(join(fixtures, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
const code = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
const PROBE = '01JCR1N0000000000000000002';
const env: Environment = { kind: 'local', python: 'python3', source: 'default', label: 'local' };

let storage: string;
let root: string;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'afd-step-storage-'));
  root = mkdtempSync(join(tmpdir(), 'afd-step-root-'));
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const line = (e: Record<string, unknown>) => `${JSON.stringify(e)}\n`;
const until = async (ok: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!ok()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
};

function request(extra: Partial<RunFlowRequest> = {}): RunFlowRequest {
  return {
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
    inputs: { devices: ['h01', 'h02'] },
    step: { every: true, points: ['01JPOINT'], timeoutS: 120 },
    ...extra,
  };
}

/**
 * A run that pauses before PROBE, waits for the driver's answer in control.json the way the
 * afd_step strategy does, then writes what that answer leads to.
 */
function pausingRun() {
  const seen: { env?: Record<string, string>; atStart?: StepControl; answered?: StepControl } = {};
  const execute = (_spec: ProcessSpec, processEnv: Record<string, string>): Execution => {
    seen.env = processEnv;
    const runDir = processEnv.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
    const events = join(runDir, 'events.jsonl');
    const controlFile = join(runDir, 'control.json');
    seen.atStart = JSON.parse(readFileSync(controlFile, 'utf8'));
    writeFileSync(events, line({ event: 'playbook_start', ts: 1 }));
    const exit = (async () => {
      await appendFile(
        events,
        line({
          event: 'pause',
          id: 'k-1',
          node: PROBE,
          play: '[probe] Probe',
          hosts: ['h01', 'h02'],
          timeout: 120,
          ts: 2,
        }),
      );
      await until(() => {
        const c = JSON.parse(readFileSync(controlFile, 'utf8')) as StepControl;
        if (c.reply !== 'k-1') return false;
        seen.answered = c;
        return true;
      });
      const command = seen.answered?.command;
      if (command === 'stop') {
        await appendFile(
          events,
          line({
            event: 'stopped',
            id: 'k-1',
            node: PROBE,
            play: '[probe] Probe',
            hosts: ['h01', 'h02'],
            reason: 'driver',
            ts: 3,
          }),
        );
        await appendFile(events, line({ event: 'stats', hosts: {}, ts: 4 }));
        return 2;
      }
      await appendFile(events, line({ event: 'resume', id: 'k-1', node: PROBE, command, ts: 3 }));
      await appendFile(events, line({ event: 'stats', hosts: {}, ts: 4 }));
      return 0;
    })();
    return { exit, terminate: () => undefined };
  };
  return { execute, seen };
}

describe('AFD-346: runFlow step by step', () => {
  it('starts paused before the first step, shows where it waits, and Step answers that pause', async () => {
    const run = pausingRun();
    const reports: RunView[] = [];
    let driver: StepDriver | undefined;
    const pending = runFlow(request(), {
      report: (r) => reports.push(r),
      execute: run.execute,
      started: (_stop, step) => {
        driver = step;
        return undefined;
      },
    });
    await until(() => !!driver?.paused());
    // The control was there before the process: Step, with the flow's pause points.
    expect(run.seen.atStart).toEqual({ v: 1, command: 'step', points: ['01JPOINT'], reply: null });
    expect(run.seen.env?.ANSIBLE_STRATEGY).toBe('afd_step');
    expect(run.seen.env?.AFD_STEP_TIMEOUT).toBe('120');
    // The live view says where the run waits, still running.
    await until(() => reports.some((r) => r.step?.paused));
    const live = reports.find((r) => r.step?.paused);
    expect(live).toMatchObject({ state: 'running', step: { every: true, points: ['01JPOINT'] } });
    expect(live?.step?.paused).toMatchObject({ id: 'k-1', node: PROBE, hosts: ['h01', 'h02'] });

    expect(await driver?.send('step')).toBeUndefined();
    const done = await pending;
    expect(run.seen.answered).toEqual({
      v: 1,
      command: 'step',
      points: ['01JPOINT'],
      reply: 'k-1',
    });
    expect(done).toMatchObject({ state: 'done', rc: 0, step: { pauses: 1 } });
    expect(done.step?.paused).toBeUndefined();
    expect(done.stoppedAt).toBeUndefined();
  });

  it('a stop at a step boundary ends the run as stopped there, not failed, though it exits 2', async () => {
    const run = pausingRun();
    let driver: StepDriver | undefined;
    const pending = runFlow(request(), {
      report: () => undefined,
      execute: run.execute,
      started: (_stop, step) => {
        driver = step;
        return undefined;
      },
    });
    await until(() => !!driver?.paused());
    // New pause points go with the next answer.
    await driver?.setPoints(['01JOTHER']);
    await driver?.send('stop');
    const done = await pending;
    expect(run.seen.answered).toMatchObject({
      command: 'stop',
      points: ['01JOTHER'],
      reply: 'k-1',
    });
    expect(done).toMatchObject({
      state: 'error',
      errorCode: 'cancelled',
      rc: 2,
      stoppedAt: PROBE,
      error: 'Stopped before Probe',
      step: {
        stopped: { node: PROBE, hosts: ['h01', 'h02'], reason: 'driver' },
        points: ['01JOTHER'],
      },
    });
  });

  it('a run without step writes no control and sets no step variable', async () => {
    const seen: Record<string, string>[] = [];
    let dir = '';
    await runFlow(request({ step: undefined }), {
      report: () => undefined,
      execute: (_s, e) => {
        seen.push(e);
        dir = e.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
        writeFileSync(join(dir, 'events.jsonl'), line({ event: 'stats', hosts: {} }));
        return { exit: Promise.resolve(0), terminate: () => undefined };
      },
    });
    expect(Object.keys(seen[0] ?? {}).filter((k) => /STRATEGY|AFD_STEP/.test(k))).toEqual([]);
    expect(existsSync(join(dir, 'control.json'))).toBe(false);
  });
});

describe('AFD-346: approval segments step by step', () => {
  const approval = parse(
    readFileSync(join(fixtures, 'approval-segments.flow.yaml'), 'utf8'),
  ) as FlowDocument;
  const approvalCode = optionA.generate(approval, { source: 'approval-segments.flow.yaml' });
  const GATE = '01JCRBN0000000000000000003';
  const carried = { afd_hostsets: { afd_gate_waiting: ['h01'] }, afd_gate_empty: false };

  it('the next segment reads the control the one before ended with, and starts inside the gate', async () => {
    const seen: { env: Record<string, string>; control: StepControl }[] = [];
    let k = 0;
    const done = await runSegments(
      request({
        doc: approval,
        code: approvalCode,
        playbook: `flows/generated/${approvalCode.files[0]?.name}`,
      }),
      approvalCode.segments ?? [],
      {
        report: () => undefined,
        decide: async () => ({ decision: 'approved' }),
        started: (_stop, step) => {
          // The first segment's driver says Continue: the next segment starts with it.
          if (k === 1) void step?.send('continue');
          return undefined;
        },
        execute: (_spec, processEnv) => {
          k += 1;
          const runDir = processEnv.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
          seen.push({
            env: processEnv,
            control: JSON.parse(readFileSync(join(runDir, 'control.json'), 'utf8')),
          });
          const exit = (async () => {
            if (k === 1)
              await until(
                () =>
                  seen.length === 1 &&
                  readFileSync(join(runDir, 'control.json'), 'utf8').includes('continue'),
              );
            writeFileSync(
              join(runDir, 'events.jsonl'),
              line({ event: 'stats', hosts: {}, custom: k === 1 ? carried : {} }),
            );
            return 0;
          })();
          return { exit, terminate: () => undefined };
        },
      },
    );
    expect(done.state).toBe('done');
    expect(seen).toHaveLength(2);
    expect(seen[0]?.control.command).toBe('step');
    expect(seen[0]?.env.AFD_STEP_INSIDE).toBeUndefined();
    expect(seen[1]?.control.command).toBe('continue');
    expect(seen[1]?.env.AFD_STEP_INSIDE).toBe(GATE);
  });
});

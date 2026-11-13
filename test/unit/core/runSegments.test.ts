// AFD-272: a flow with an approval gate runs segment by segment outside AWX: the start segment
// carries its host sets, a decision picks the next segment, a timeout takes the timeout port.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import type { ProcessSpec } from '../../../src/core/run/command';
import type { Environment } from '../../../src/core/run/environment';
import type { Execution } from '../../../src/node/run/exec';
import type { RunFlowRequest } from '../../../src/node/run/runFlow';
import {
  nextSegment,
  runSegments,
  segmentInputs,
  segmentOutcome,
} from '../../../src/node/run/segments';

const fixtures = join(__dirname, '../../fixtures/engine');
const doc = parse(
  readFileSync(join(fixtures, 'approval-segments.flow.yaml'), 'utf8'),
) as FlowDocument;
const code = optionA.generate(doc, { source: 'approval-segments.flow.yaml' });
const segments = code.segments ?? [];
const GATE = '01JCRBN0000000000000000003';
const env: Environment = { kind: 'local', python: 'python3', source: 'default', label: 'local' };

const stats = (custom: Record<string, unknown>) =>
  `${JSON.stringify({ event: 'stats', hosts: {}, custom })}\n`;
const carried = { afd_hostsets: { afd_gate_waiting: ['h01', 'h02'] }, afd_gate_empty: false };

let storage: string;
let root: string;
beforeEach(() => {
  storage = mkdtempSync(join(tmpdir(), 'afd-seg-storage-'));
  root = mkdtempSync(join(tmpdir(), 'afd-seg-root-'));
});
afterEach(() => {
  rmSync(storage, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const request = (): RunFlowRequest => ({
  id: 'R1',
  startedAt: new Date().toISOString(),
  mode: 'check',
  doc,
  code,
  env,
  environment: 'local',
  root,
  probeDir: join(root, 'probe'),
  playbook: `flows/generated/${code.files[0]?.name}`,
  storage,
  inputs: { devices: ['h01', 'h02', 'h03'] },
});

/** Runs each segment by writing the events `events(file)` gives; records what ran with what. */
function host(events: (file: string) => string) {
  const ran: { file: string; vars: Record<string, unknown> }[] = [];
  const execute = (spec: ProcessSpec, processEnv: Record<string, string>): Execution => {
    const runDir = processEnv.AFD_EVENTS?.replace(/[\\/]events\.jsonl$/, '') ?? '';
    const file = segments.find((s) => spec.args.some((a) => a.endsWith(s.file)))?.file ?? '?';
    ran.push({ file, vars: JSON.parse(readFileSync(join(runDir, 'vars.json'), 'utf8')) });
    writeFileSync(join(runDir, 'events.jsonl'), events(file));
    return { exit: Promise.resolve(0), terminate: () => undefined };
  };
  return { execute, ran };
}
const fileOf = (name: string) => segments.find((s) => s.name === name)?.file as string;

describe('AFD-272: segments outside AWX', () => {
  it('the generated rejected segment takes the timeout port when told to', () => {
    expect(code.ok).toBe(true);
    const rejected = code.files.find((f) => f.name === fileOf('gate-rejected'))?.text ?? '';
    expect(rejected).toContain("(afd_gate_outcome | default('rejected')) == 'timeout'");
    // AWX never sets it: its rejected segment routes as before.
    const approved = code.files.find((f) => f.name === fileOf('gate-approved'))?.text ?? '';
    expect(approved).not.toContain('afd_gate_outcome');
  });

  it('reads what a segment carried, and names the next segment', () => {
    const start = segments.find((s) => s.name === 'start');
    if (!start) throw new Error('no start segment');
    expect(segmentOutcome(start, stats(carried))).toEqual({
      carried,
      waiting: true,
      empty: false,
    });
    expect(segmentOutcome(start, stats({ ...carried, afd_gate_empty: 'True' }))).toMatchObject({
      waiting: false,
      empty: true,
    });
    expect(segmentOutcome(start, '')).toMatchObject({ waiting: false, empty: false });
    expect(nextSegment(segments, 'start', 'approved')?.name).toBe('gate-approved');
    expect(nextSegment(segments, 'start', 'rejected')?.name).toBe('gate-rejected');
    expect(nextSegment(segments, 'start', 'timeout')?.name).toBe('gate-rejected');
    expect(nextSegment(segments, 'start', 'empty')?.name).toBe('finish');
    expect(nextSegment(segments, 'gate-approved', 'approved')).toBeUndefined();
    expect(segmentInputs({ devices: ['h01'] }, carried, 'timeout')).toEqual({
      devices: ['h01'],
      ...carried,
      afd_gate_outcome: 'timeout',
    });
  });

  it('waits at the gate for a decision, then runs the segment it picks with the carried sets', async () => {
    const run = host((file) => (file === fileOf('start') ? stats(carried) : stats({})));
    const reports: RunView[] = [];
    const asked: { gate: string; run: RunView }[] = [];
    const done = await runSegments(request(), segments, {
      report: (r) => reports.push(r),
      execute: run.execute,
      decide: async (gate, waiting) => {
        asked.push({ gate, run: waiting });
        return { decision: 'timeout', by: 'dana', comment: 'Nobody on call' };
      },
    });
    expect(run.ran.map((r) => r.file)).toEqual([fileOf('start'), fileOf('gate-rejected')]);
    expect(run.ran[1]?.vars).toMatchObject({
      devices: ['h01', 'h02', 'h03'],
      afd_hostsets: carried.afd_hostsets,
      afd_gate_outcome: 'timeout',
    });
    expect(asked).toHaveLength(1);
    expect(asked[0]?.gate).toBe(GATE);
    expect(asked[0]?.run).toMatchObject({
      id: 'R1',
      state: 'running',
      approvals: { [GATE]: { status: 'waiting' } },
    });
    expect(done).toMatchObject({
      id: 'R1',
      state: 'done',
      approvals: { [GATE]: { status: 'timed out', by: 'dana', comment: 'Nobody on call' } },
    });
    expect(reports.every((r) => r.id === 'R1')).toBe(true);
  });

  it('with nobody at the gate, runs finish and asks for no decision', async () => {
    const run = host((file) =>
      file === fileOf('start') ? stats({ ...carried, afd_gate_empty: true }) : stats({}),
    );
    let asked = 0;
    const done = await runSegments(request(), segments, {
      report: () => undefined,
      execute: run.execute,
      decide: async () => {
        asked++;
        return { decision: 'approved' };
      },
    });
    expect(run.ran.map((r) => r.file)).toEqual([fileOf('start'), fileOf('finish')]);
    expect(asked).toBe(0);
    expect(done.approvals).toBeUndefined();
  });

  it('a decision that never comes stops the run', async () => {
    const run = host(() => stats(carried));
    const done = await runSegments(request(), segments, {
      report: () => undefined,
      execute: run.execute,
      decide: async () => {
        throw new Error('stopped');
      },
    });
    expect(run.ran).toHaveLength(1);
    expect(done).toMatchObject({
      state: 'error',
      errorCode: 'cancelled',
      approvals: { [GATE]: { status: 'waiting' } },
    });
  });
});

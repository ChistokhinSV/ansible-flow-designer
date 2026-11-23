// AFS-205: step-by-step runs in the server's pages: what a viewer may send and offer, the step
// that runs after Step, a pause inside a subflow by its path, step times without the pauses.
import { describe, expect, it } from 'vitest';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { createSummarizer } from '../../../src/core/run/events';
import { runningLine, stepPath, stepState, stopsIn } from '../../../src/core/run/step';
import { formatSeconds, nodeRun, stepTime } from '../../../src/core/run/view';
import { viewerAllows } from '../../../src/core/viewer';

const doc = {
  version: 1,
  flow: { id: 'F', name: 'f', version: 1 },
  nodes: [
    { id: 'S', key: 'start', type: 'start', title: 'Start' },
    {
      id: 'P',
      key: 'precheck',
      type: 'subflow',
      title: 'Pre-checks',
      subflow: {
        nodes: [{ id: 'R', key: 'read', type: 'task', title: 'Read device status' }],
        edges: [],
      },
    },
    { id: 'T', key: 'push', type: 'task', title: 'Push' },
    { id: 'E', key: 'done', type: 'end', title: 'Done' },
  ],
  edges: [],
} as unknown as FlowDocument;
const model = buildModel(doc);
const ctx = { mode: 'run' as const, level: ROOT, stale: false, openPorts: [], hasPlay: () => true };

describe('the canvas of a server page drives its run', () => {
  it('a viewer sends Step, Continue, Pause, Stop and pause points (the host checks who)', () => {
    expect(viewerAllows('stepRun')).toBe(true);
    expect(viewerAllows('togglePausePoint')).toBe(true);
  });

  it("a viewer's menu offers a step's pause point and nothing else", () => {
    const menu = canvasMenu(
      model,
      { kind: 'node', id: 'T' },
      { ...ctx, viewer: true, pausePoints: [] },
    );
    expect(menu.map((e) => (e.type === 'item' ? e.label : e.type))).toEqual(['Add Pause Point']);
    expect(
      canvasMenu(model, { kind: 'node', id: 'T' }, { ...ctx, viewer: true, pausePoints: ['T'] }),
    ).toMatchObject([{ label: 'Remove Pause Point', action: { do: 'togglePausePoint' } }]);
    // A subflow pauses at its own steps; the canvas offers nothing else to a viewer.
    expect(
      canvasMenu(model, { kind: 'node', id: 'P' }, { ...ctx, viewer: true, pausePoints: [] }),
    ).toEqual([]);
    expect(canvasMenu(model, { kind: 'pane' }, { ...ctx, viewer: true, pausePoints: [] })).toEqual(
      [],
    );
  });
});

describe('what the bar says', () => {
  it('after Step or Continue: the step that runs, until the next pause', () => {
    const pause = { event: 'pause', id: 't-1', node: 'T', play: '[push] Push', hosts: ['h1'] };
    const resumed = stepState([pause, { event: 'resume', id: 't-1', command: 'continue' }]);
    expect(resumed.running).toEqual({ node: 'T', play: '[push] Push' });
    expect(
      stepState([pause, { event: 'resume', id: 't-1' }, { ...pause, id: 't-2' }]).running,
    ).toBeUndefined();
    expect(runningLine('Push', true)).toBe('Running Push…');
    expect(runningLine(undefined, false)).toBe('Running on to the next pause point…');
  });

  it('a step inside a subflow by its path', () => {
    expect(stepPath(model, 'R')).toBe('Pre-checks › Read device status');
    expect(stepPath(model, 'T')).toBe('Push');
    expect(stepPath(model, 'X')).toBe('X');
  });

  it('never more time left than the timeout (the run clock a little ahead)', () => {
    expect(stopsIn({ since: 101, timeout: 60 }, 100_000)).toBe('60 s');
  });
});

describe('step times leave the pauses out', () => {
  it('a step that ran 1 s after a 31 s pause reads "ran 1 s, waited 31 s"', () => {
    const s = createSummarizer({ g_ok: { node: 'T', port: 'ok' } });
    for (const e of [
      { event: 'play', node: 'T', name: '[push] Push', ts: 100 },
      { event: 'pause', id: 't-1', node: 'T', hosts: ['h1'], ts: 100 },
      { event: 'resume', id: 't-1', node: 'T', command: 'step', ts: 131 },
      { event: 'result', host: 'h1', status: 'ok', group: 'g_ok', node: 'T', ts: 132 },
    ])
      s.push(JSON.stringify(e));
    const summary = s.summary();
    expect(summary.waited).toEqual({ T: 31 });
    const r = nodeRun(summary, 'T');
    expect(r.seconds).toBe(1);
    expect(stepTime(r)).toBe('ran 1.0 s, waited 31 s');
  });

  it('formats minutes without "60 s"', () => {
    expect(formatSeconds(419.6)).toBe('7 min 00 s');
    expect(formatSeconds(59.6)).toBe('1 min 00 s');
    expect(formatSeconds(885)).toBe('14 min 45 s');
    expect(formatSeconds(9.96)).toBe('10.0 s');
  });
});

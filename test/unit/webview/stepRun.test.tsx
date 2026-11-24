// AFD-346 (ADR-0039): a step-by-step run on the canvas: the paused step's ring and badge with the
// hosts waiting there, the Run panel's line and Step/Continue/Pause/Stop, "stopped before" per
// host, pause point markers and menu items, the launch dialog's choice; nothing of it where the
// host does not run step by step (a server's pages, AFS-177).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import type { LaunchPlan } from '../../../src/core/run/launch';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { LaunchDialog } from '../../../src/webview/panels/LaunchDialog';
import { NodeRunPanel, RunPanel } from '../../../src/webview/panels/RunPanel';
import { stepKeyCommand, stepKeys } from '../../../src/webview/panels/StepBar';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const first = doc.nodes.find((n) => n.type === 'task') as { id: string; title: string };

const paused: RunView = {
  id: 'r1',
  mode: 'check',
  state: 'running',
  startedAt: new Date().toISOString(),
  source: 'local',
  environment: 'local',
  summary: { hosts: [], nodes: {}, failures: [], outcome: {}, unreachable: [] } as never,
  step: {
    every: true,
    points: [],
    pauses: 1,
    paused: {
      id: 'k-1',
      node: first.id,
      play: `[x] ${first.title}`,
      hosts: ['web-01', 'web-02'],
      since: Date.now() / 1000,
      timeout: 3600,
    },
  },
};
const stopped: RunView = {
  ...paused,
  state: 'error',
  errorCode: 'cancelled',
  rc: 2,
  error: `Stopped before ${first.title}`,
  stoppedAt: first.id,
  finishedAt: new Date().toISOString(),
  step: {
    every: true,
    points: [],
    pauses: 1,
    stopped: { node: first.id, hosts: ['web-01', 'web-02'], reason: 'driver' },
  },
};
const sent = (type: string) => posted.filter((m) => (m as { type: string }).type === type);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'run',
    run: null,
    stepRuns: true,
    pausePoints: [],
  });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: Object.fromEntries(doc.nodes.map((n, i) => [n.id, { x: i * 260, y: 0 }])),
    });
  });
});
afterEach(cleanup);

function canvas() {
  render(
    <ReactFlowProvider>
      <div style={{ width: 1600, height: 600 }}>
        <FlowCanvas cull={false} />
      </div>
    </ReactFlowProvider>,
  );
}
const node = (nid: string) => document.querySelector<HTMLElement>(`[data-node-id="${nid}"]`);

describe('step-by-step run on the canvas', () => {
  it('the step the run waits before has a ring and a badge with the hosts waiting', () => {
    act(() => useUi.getState().setRun(paused));
    canvas();
    const n = node(first.id);
    expect(n?.className).toContain('step-paused');
    expect(n?.dataset.stepPaused).toBe('2');
    expect(n?.querySelector('.afd-step-badge')?.textContent).toBe('2');
    expect(n?.querySelector('.afd-node-run')?.textContent).toBe('paused here · 2 hosts waiting');
    // Only there.
    expect(document.querySelectorAll('.step-paused')).toHaveLength(1);
  });

  it('a pause point is marked on its step', () => {
    act(() => useUi.setState({ pausePoints: [first.id] }));
    canvas();
    expect(node(first.id)?.dataset.pausePoint).toBe('true');
    expect(node(first.id)?.querySelector('.afd-pause-point')).not.toBeNull();
    // A host that does not run step by step shows none.
    cleanup();
    act(() => useUi.setState({ stepRuns: false }));
    canvas();
    expect(node(first.id)?.querySelector('.afd-pause-point')).toBeNull();
  });

  it("AFS-205: a step's dot sets or takes away its pause point; none on start", () => {
    canvas();
    const dot = node(first.id)?.querySelector('[data-pause-dot]') as HTMLElement;
    expect(dot.dataset.pauseDot).toBe('off');
    fireEvent.click(dot);
    expect(sent('togglePausePoint')).toEqual([{ type: 'togglePausePoint', node: first.id }]);
    const start = doc.nodes.find((n) => n.type === 'start')?.id as string;
    expect(node(start)?.querySelector('[data-pause-dot]')).toBeNull();
  });

  it("AFS-205: the paused step's Run tab lists the hosts waiting there, not 0 hosts", () => {
    act(() => useUi.getState().setRun(paused));
    render(<NodeRunPanel id={first.id} />);
    const body = document.querySelector(`[data-node-run="${first.id}"]`) as HTMLElement;
    expect(body.textContent).toContain('2 hosts · paused before this step');
    expect(body.querySelectorAll('[data-host]')).toHaveLength(2);
    expect(body.textContent).toContain('waiting for Step or Continue');
  });

  it('a stopped run: the step reads stopped before, the panel lists each host', () => {
    act(() => useUi.getState().setRun(stopped));
    canvas();
    expect(node(first.id)?.querySelector('.afd-node-run')?.textContent).toBe(
      'stopped before · 2 hosts',
    );
    cleanup();
    render(<RunPanel />);
    const hosts = document.querySelector('[data-step-stopped-hosts]');
    expect(hosts?.getAttribute('data-step-stopped-hosts')).toBe('2');
    expect(hosts?.textContent).toContain(`web-01 stopped before ${first.title}`);
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('stopped');
    // The run has ended: no buttons.
    expect(document.querySelector('[data-step-command]')).toBeNull();
  });
});

describe('Run panel and top bar', () => {
  it('say where the run waits; Step, Continue and Stop go to the host', () => {
    act(() => useUi.getState().setRun(paused));
    render(<RunPanel />);
    const line = document.querySelector('[data-step-paused]');
    expect(line?.textContent).toMatch(
      new RegExp(`Paused before ${first.title} · 2 hosts · stops by itself in (59|60) min`),
    );
    expect(screen.getByText(/Waiting there: web-01, web-02/)).toBeTruthy();
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('paused, step by step');
    const panel = document.querySelector('.afd-step-section') as HTMLElement;
    // Pause is for a run that goes; this one waits.
    expect(panel.querySelector('[data-step-command="pause"]')).toBeNull();
    for (const command of ['step', 'continue', 'stop'])
      fireEvent.click(panel.querySelector(`[data-step-command="${command}"]`) as HTMLElement);
    expect(sent('stepRun').map((m) => (m as { command: string }).command)).toEqual([
      'step',
      'continue',
      'stop',
    ]);
  });

  it('a step going: Pause, and Step and Continue wait for the next pause', () => {
    act(() => useUi.getState().setRun({ ...paused, step: { every: true, points: [], pauses: 1 } }));
    render(<RunPanel />);
    const panel = document.querySelector('.afd-step-section') as HTMLElement;
    fireEvent.click(panel.querySelector('[data-step-command="step"]') as HTMLElement);
    expect(sent('stepRun')).toHaveLength(0);
    fireEvent.click(panel.querySelector('[data-step-command="pause"]') as HTMLElement);
    expect(sent('stepRun')).toEqual([{ type: 'stepRun', command: 'pause' }]);
  });

  it('AFD-378: at a failure pause the top bar names the failure, not "Paused before"', () => {
    const step = paused.step as NonNullable<RunView['step']>;
    act(() =>
      useUi.getState().setRun({
        ...paused,
        step: {
          ...step,
          paused: {
            ...(step.paused as NonNullable<typeof step.paused>),
            kind: 'failure',
            attempt: 2,
            failed: [
              { host: 'web-01', task: 'ping', msg: 'no python' },
              { host: 'web-02', task: 'ping', msg: 'no python' },
            ],
          },
        },
      }),
    );
    render(<TopBar />);
    const status = document.querySelector('[data-run-state="paused"]') as HTMLElement;
    expect(status.dataset.pauseKind).toBe('failure');
    expect(status.textContent).toContain(
      `Paused after ${first.title}: 2 of 2 hosts failed (attempt 2)`,
    );
    expect(status.textContent).not.toContain('Paused before');
  });

  it('AFD-378: stopped at a failure pause, the step and its hosts read failed, not stopped before', () => {
    act(() =>
      useUi.getState().setRun({
        ...stopped,
        summary: {
          hosts: ['web-01', 'web-02'],
          nodes: { [first.id]: { failed_hosts: ['web-01', 'web-02'] } },
          failures: [],
          outcome: {},
          unreachable: [],
        } as never,
      }),
    );
    canvas();
    expect(node(first.id)?.querySelector('.afd-node-run')?.textContent).toBe(
      '2 hosts failed · stopped',
    );
    cleanup();
    render(<RunPanel />);
    expect(document.querySelector('[data-step-stopped]')?.textContent).toBe(
      `Stopped at ${first.title}`,
    );
    expect(document.querySelector('[data-step-stopped-hosts]')?.textContent).toContain(
      `web-01 failed ${first.title}, then stopped`,
    );
  });

  it('AFD-379: Stop at a failure pause of a debug run: stopped after the step, as the engine says', () => {
    // The engine's `stopped` event at a failure pause (afd_step.py): the hosts that ran the step,
    // the failed ones apart, and `after`.
    act(() =>
      useUi.getState().setRun({
        ...stopped,
        step: {
          every: false,
          points: [],
          pauses: 1,
          debug: true,
          stopped: {
            node: first.id,
            hosts: ['web-01', 'web-03'],
            failed: ['web-02'],
            reason: 'driver',
            after: true,
          },
        },
      }),
    );
    render(<RunPanel />);
    const section = document.querySelector('.afd-step-section') as HTMLElement;
    expect(section.querySelector('h3')?.textContent).toBe('Debug');
    expect(section.querySelector('[data-step-stopped]')?.textContent).toBe(
      `Stopped after ${first.title}`,
    );
    const hosts = section.querySelector('[data-step-stopped-hosts]') as HTMLElement;
    expect(hosts.dataset.stepStoppedHosts).toBe('3');
    expect(hosts.textContent).toContain(`web-01 stopped after ${first.title}`);
    expect(hosts.textContent).toContain(`web-02 failed ${first.title}, then stopped`);
    expect(hosts.textContent).not.toContain('before');
    // A finished run says nothing of what Continue would do.
    expect(section.querySelector('[data-pause-points]')).toBeNull();
  });

  it('AFD-379: a debug run is named as one; the live run is the run shown', () => {
    act(() => {
      useUi.setState({
        pastRuns: [{ id: 'older', startedAt: '2026-11-01T10:00:00Z', mode: 'check' } as never],
      });
      useUi.getState().setRun({
        ...paused,
        step: { ...(paused.step as NonNullable<RunView['step']>), debug: true },
      });
    });
    render(<RunPanel />);
    const panel = document.body;
    expect(panel.textContent).toContain('Local debug run (check mode)');
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('paused, debugging');
    expect(panel.textContent).toContain('This run, in progress');
    expect(panel.textContent).not.toContain('not among the kept runs');
  });

  it('AFD-379: a designer that learns of a paused run shows it in Run mode, with the ring', () => {
    act(() => useUi.setState({ mode: 'design', run: null }));
    act(() => useUi.getState().setRun(paused));
    expect(useUi.getState().mode).toBe('run');
    // The same run again does not take the person out of Design.
    act(() => useUi.setState({ mode: 'design' }));
    act(() => useUi.getState().setRun({ ...paused }));
    expect(useUi.getState().mode).toBe('design');
  });

  it('AFD-378: paused before any play ended, Hosts counts the hosts waiting, not 0', () => {
    act(() => useUi.getState().setRun(paused));
    render(<RunPanel />);
    const hosts = document.querySelector('[data-run-hosts-count]') as HTMLElement;
    expect(hosts.dataset.runHostsCount).toBe('2');
    expect(hosts.textContent).toContain('2 hosts: web-01, web-02');
  });

  it('the top bar says where the run waits and has the step buttons beside Stop', () => {
    act(() => useUi.getState().setRun(paused));
    render(<TopBar />);
    expect(document.querySelector('[data-run-state="paused"]')?.textContent).toContain(
      `Paused before ${first.title} · 2 hosts`,
    );
    const bar = document.querySelector('.afd-step-buttons') as HTMLElement;
    expect(within(bar).getByLabelText('Step (F10)')).toBeTruthy();
    expect(within(bar).getByLabelText('Continue (F5)')).toBeTruthy();
    // Stop is the Run button itself while a run goes.
    expect(bar.querySelector('[data-step-command="stop"]')).toBeNull();
  });

  it("nothing new where the host does not run step by step (a server's pages)", () => {
    act(() => {
      useUi.setState({ stepRuns: false });
      useUi.getState().setRun(paused);
    });
    render(
      <>
        <TopBar />
        <RunPanel />
      </>,
    );
    expect(document.querySelector('[data-step-command]')).toBeNull();
  });
});

describe('pause points and the launch dialog', () => {
  it("a step's menu adds or removes its pause point; not a subflow, start or end", () => {
    const model = buildModel(doc);
    const ctx = {
      mode: 'run' as const,
      level: ROOT,
      stale: false,
      openPorts: [],
      hasPlay: () => true,
    };
    const labels = (nid: string, points?: string[]) =>
      canvasMenu(
        model,
        { kind: 'node', id: nid },
        { ...ctx, ...(points ? { pausePoints: points } : {}) },
      )
        .flatMap((e) => (e.type === 'item' ? [e] : []))
        .filter((e) => e.action.do === 'togglePausePoint')
        .map((e) => e.label);
    expect(labels(first.id, [])).toEqual(['Add Pause Point']);
    expect(labels(first.id, [first.id])).toEqual(['Remove Pause Point']);
    expect(labels(first.id)).toEqual([]);
    expect(labels(id('start'), [])).toEqual([]);
  });

  it('the dialog offers step by step where the host runs it, chosen by Run Step by Step', () => {
    const plan: LaunchPlan = {
      token: 't-9',
      mode: 'check',
      flow: 'Hello',
      fields: [],
      groups: [],
      facts: {
        sources: ['inventory.ini'],
        count: 1,
        hosts: ['localhost'],
        unknown: [],
        uses: [],
        prod: [],
        vault: false,
        environment: 'local',
      },
      vault: false,
      environment: 'local',
    };
    act(() => useUi.getState().setLaunch({ ...plan, steps: { on: true } }));
    render(<LaunchDialog />);
    const box = document.querySelector('[data-launch-step]') as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(document.querySelector('[data-launch-run]') as HTMLElement);
    expect(sent('launchRun').at(-1)).toMatchObject({ token: 't-9', step: true });
    cleanup();
    // Without `steps` (a server's launch form) there is no choice and no step.
    posted.length = 0;
    act(() => useUi.getState().setLaunch({ ...plan, token: 't-10' }));
    render(<LaunchDialog />);
    expect(document.querySelector('[data-launch-step]')).toBeNull();
    fireEvent.click(document.querySelector('[data-launch-run]') as HTMLElement);
    expect(sent('launchRun').at(-1)).not.toHaveProperty('step');
  });
});

describe('AFS-205: keys', () => {
  it('keys in a web page (AFS-205): F10 steps, F8 goes on or pauses; F5 is left to the browser', () => {
    const key = (k: string, more = {}) => ({
      key: k,
      ctrlKey: false,
      metaKey: false,
      altKey: false,
      shiftKey: false,
      ...more,
    });
    expect(stepKeyCommand(key('F10'), true, true)).toBe('step');
    expect(stepKeyCommand(key('F8'), true, true)).toBe('continue');
    expect(stepKeyCommand(key('F8'), false, true)).toBe('pause');
    expect(stepKeyCommand(key('F10'), false, true)).toBeUndefined();
    expect(stepKeyCommand(key('F5'), true, true)).toBeUndefined();
    expect(stepKeyCommand(key('F8', { shiftKey: true }), true, true)).toBeUndefined();
    // VS Code runs its own key bindings for them.
    expect(stepKeyCommand(key('F10'), true, false)).toBeUndefined();
    expect(stepKeys(true)).toEqual({ step: 'F10', continue: 'F8', pause: 'F8' });
    expect(stepKeys(false).continue).toBe('F5');
  });
});

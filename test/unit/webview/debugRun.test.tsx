// ADR-0040 on the canvas (AFD-371, AFD-372), the same in VS Code and a server's pages: Edit Pause
// Point… (always, when a condition holds, after N, log only; the failure filters) through
// setPausePoint and setFailureFilters; the dots of points with settings; a failure pause's bar
// and Run panel lines with Retry (its warning), Continue and Stop, and the refusal where Retry is
// not offered; Run ▾ › Debug and the launch dialog's Debug. Fictional hosts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import type { LaunchPlan } from '../../../src/core/run/launch';
import type { StepPause } from '../../../src/core/run/step';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { LaunchDialog } from '../../../src/webview/panels/LaunchDialog';
import { PausePointDialog } from '../../../src/webview/panels/PausePointDialog';
import { RunPanel } from '../../../src/webview/panels/RunPanel';
import { FailureBar } from '../../../src/webview/panels/StepBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8'),
) as FlowDocument;
const steps = doc.nodes.filter((n) => n.type === 'task') as { id: string; title: string }[];
const first = steps[0] as { id: string; title: string };
const second = steps[1] as { id: string; title: string };
const sent = (type: string) => posted.filter((m) => (m as { type: string }).type === type);

const failurePause: StepPause = {
  id: 'k-3',
  node: first.id,
  play: `[x] ${first.title}`,
  hosts: ['web-01', 'web-02', 'web-03'],
  since: Date.now() / 1000,
  timeout: 3600,
  kind: 'failure',
  attempt: 1,
  debug: true,
  failed: [{ host: 'web-02', task: 'ping', msg: 'host answered nothing' }],
};
const failed = (pause: StepPause = failurePause): RunView => ({
  id: 'r1',
  mode: 'check',
  state: 'running',
  startedAt: new Date().toISOString(),
  source: 'local',
  summary: { hosts: [], nodes: {}, failures: [], outcome: {}, unreachable: [] } as never,
  step: { every: false, points: [], pauses: 1, debug: true, paused: pause },
});

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'run',
    run: null,
    stepRuns: true,
    debugRuns: true,
    pausePoints: [],
    pointSettings: {},
    failureFilters: {},
    pointEdit: null,
    launch: null,
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

describe('AFD-371: Edit Pause Point…', () => {
  it("is in a step's menu where the host runs debug runs", () => {
    const model = buildModel(doc);
    const ctx = {
      mode: 'run' as const,
      level: ROOT,
      stale: false,
      openPorts: [],
      hasPlay: () => true,
    };
    const items = (extra: object) =>
      canvasMenu(model, { kind: 'node', id: first.id }, { ...ctx, pausePoints: [], ...extra })
        .flatMap((e) => (e.type === 'item' ? [e] : []))
        .map((e) => e.action.do);
    expect(items({ pointSettings: true })).toContain('editPausePoint');
    expect(items({})).not.toContain('editPausePoint');
  });

  it('saves a condition with a count, and the failure filters, through the host', () => {
    act(() => useUi.getState().setPointEdit(first.id));
    render(<PausePointDialog />);
    const dialog = document.querySelector('[data-point-dialog]') as HTMLElement;
    expect(dialog.textContent).toContain(`Pause point · ${first.title}`);
    fireEvent.click(dialog.querySelector('[data-point-how="when"]') as HTMLElement);
    // An empty condition is not saved.
    fireEvent.click(dialog.querySelector('[data-point-save]') as HTMLElement);
    expect(dialog.querySelector('[data-point-problem]')?.textContent).toMatch(/condition/);
    fireEvent.change(dialog.querySelector('[data-point-condition]') as HTMLElement, {
      target: { value: "{{ inventory_hostname is match('core') }}" },
    });
    fireEvent.click(dialog.querySelector('[data-point-counted]') as HTMLElement);
    fireEvent.change(dialog.querySelector('[data-point-hits]') as HTMLElement, {
      target: { value: '3' },
    });
    fireEvent.click(dialog.querySelector('[data-filter-unreachable]') as HTMLElement);
    fireEvent.click(dialog.querySelector('[data-point-save]') as HTMLElement);
    expect(sent('setPausePoint')).toEqual([
      {
        type: 'setPausePoint',
        node: first.id,
        point: { node: first.id, condition: "inventory_hostname is match('core')", hits: 3 },
      },
    ]);
    expect(sent('setFailureFilters')).toEqual([
      { type: 'setFailureFilters', failures: { failed: true, unreachable: true } },
    ]);
    expect(useUi.getState().pointEdit).toBeNull();
  });

  it('opens with the point as kept; log only; Remove takes the point away', () => {
    act(() => {
      useUi
        .getState()
        .setPausePoints([first.id], [{ node: first.id, log: 'peers {{ peers | length }}' }], {
          failed: false,
        });
      useUi.getState().setPointEdit(first.id);
    });
    render(<PausePointDialog />);
    const dialog = document.querySelector('[data-point-dialog]') as HTMLElement;
    expect((dialog.querySelector('[data-point-how="log"]') as HTMLInputElement).checked).toBe(true);
    expect((dialog.querySelector('[data-point-log]') as HTMLInputElement).value).toBe(
      'peers {{ peers | length }}',
    );
    expect((dialog.querySelector('[data-filter-failed]') as HTMLInputElement).checked).toBe(false);
    fireEvent.click(dialog.querySelector('[data-point-remove]') as HTMLElement);
    expect(sent('setPausePoint')).toEqual([{ type: 'setPausePoint', node: first.id, point: null }]);
  });

  it('a point with a condition or log only has a dot of its own', () => {
    act(() =>
      useUi.getState().setPausePoints(
        [first.id, second.id],
        [
          { node: first.id, condition: 'x > 1' },
          { node: second.id, log: 'hi' },
        ],
      ),
    );
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const dot = (nid: string) =>
      document.querySelector<HTMLElement>(`[data-node-id="${nid}"] [data-pause-dot]`);
    expect(dot(first.id)?.dataset.pauseDot).toBe('condition');
    expect(dot(first.id)?.title).toMatch(/pauses when x > 1/);
    expect(dot(second.id)?.dataset.pauseDot).toBe('log');
    expect(dot(second.id)?.className).toContain(' log');
  });
});

describe('AFD-372: a failure pause', () => {
  it('the bar says the reason, the hosts, the warning; Retry, Continue and Stop go to the host', () => {
    act(() => useUi.getState().setRun(failed()));
    render(<FailureBar />);
    const bar = document.querySelector('[data-failure-bar]') as HTMLElement;
    expect(bar.textContent).toContain(
      `Paused after ${first.title}: 1 of 3 hosts failed (attempt 1)`,
    );
    expect(bar.textContent).toContain('web-02: ping: host answered nothing');
    expect(bar.textContent).toContain(
      `Retry runs ${first.title} again on web-02. Changes on hosts are not undone.`,
    );
    const retry = bar.querySelector('[data-step-command="retry"]') as HTMLElement;
    expect(retry.title).toMatch(/Changes on hosts are not undone/);
    for (const c of ['retry', 'continue', 'stop'])
      fireEvent.click(bar.querySelector(`[data-step-command="${c}"]`) as HTMLElement);
    expect(sent('stepRun').map((m) => (m as { command: string }).command)).toEqual([
      'retry',
      'continue',
      'stop',
    ]);
  });

  it('where Retry is not offered, it says why and sends nothing', () => {
    act(() =>
      useUi
        .getState()
        .setRun(failed({ ...failurePause, retryRefused: 'a rolling subflow runs as one play' })),
    );
    render(<RunPanel />);
    const panel = document.querySelector('.afd-step-section') as HTMLElement;
    expect(panel.querySelector('[data-step-paused]')?.textContent).toContain(
      `Paused after ${first.title}: 1 of 3 hosts failed (attempt 1)`,
    );
    expect(panel.querySelector('[data-retry-note]')?.textContent).toContain(
      'Retry is not offered here: a rolling subflow runs as one play',
    );
    const retry = panel.querySelector('[data-step-command="retry"]') as HTMLElement;
    expect(retry.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(retry);
    expect(sent('stepRun')).toEqual([]);
  });

  it('a reader of the pages sees the reason line without buttons; no bar for a plain pause', () => {
    act(() => {
      useUi.setState({ stepRuns: false });
      useUi.getState().setRun(failed());
    });
    render(<FailureBar />);
    expect(document.querySelector('[data-failure-bar]')?.textContent).toContain(
      '1 of 3 hosts failed',
    );
    expect(document.querySelector('[data-step-command]')).toBeNull();
    cleanup();
    act(() =>
      useUi.getState().setRun(failed({ ...failurePause, kind: 'step', failed: undefined })),
    );
    render(<FailureBar />);
    expect(document.querySelector('[data-failure-bar]')).toBeNull();
  });

  it('the paused step reads failed on the canvas', () => {
    act(() => useUi.getState().setRun(failed()));
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const n = document.querySelector<HTMLElement>(`[data-node-id="${first.id}"]`);
    expect(n?.className).toContain('step-failure-paused');
    expect(n?.querySelector('.afd-node-run')?.textContent).toBe(
      '1 host failed · paused · 3 waiting',
    );
  });

  it('log point lines show in the Run panel', () => {
    const run = failed({ ...failurePause, kind: 'point', failed: undefined });
    act(() =>
      useUi.getState().setRun({
        ...run,
        step: {
          ...(run.step as NonNullable<RunView['step']>),
          logs: [
            { node: second.id, host: 'web-01', message: 'peers 2', ts: 1 },
            {
              node: second.id,
              host: 'web-02',
              error: "'peers' is undefined",
              source: 'log',
              ts: 2,
            },
          ],
        },
      }),
    );
    render(<RunPanel />);
    const logs = document.querySelector('[data-point-logs]') as HTMLElement;
    expect(logs.textContent).toContain('web-01: peers 2');
    expect(logs.textContent).toContain("message failed: 'peers' is undefined");
  });
});

describe('ADR-0040: Debug in the launch dialog', () => {
  it('Run says Debug and the run is a debug run', () => {
    const plan: LaunchPlan = {
      token: 't-1',
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
      steps: { on: false, debug: true },
    };
    act(() => useUi.getState().setLaunch(plan));
    render(<LaunchDialog />);
    const run = document.querySelector('[data-launch-run]') as HTMLButtonElement;
    expect(run.textContent).toBe('Debug');
    fireEvent.click(run);
    expect(sent('launchRun')[0]).toMatchObject({ step: true, debug: true });
  });
});

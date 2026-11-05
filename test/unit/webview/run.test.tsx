// M7 (AFD-10): Run mode (04 §10) on a real AWX job of the awx-e2e flow: node status and host
// counts, a node's per-host results, a wire's hosts, the run panel and the tested proposal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { awxEventsToLines, playNodes } from '../../../src/core/awx/events';
import type { AwxJobEvent } from '../../../src/core/awx/types';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { summarizeRun } from '../../../src/core/run/events';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { NodeRunPanel, RunPanel, WireRunPanel } from '../../../src/webview/panels/RunPanel';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const DIR = join(__dirname, '../../fixtures/awx');
const doc = parse(
  readFileSync(join(DIR, 'repo/flows/awx-e2e/awx-e2e.flow.yaml'), 'utf8'),
) as FlowDocument;
const { events } = JSON.parse(readFileSync(join(DIR, 'job-events.json'), 'utf8')) as {
  events: AwxJobEvent[];
};
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const summary = summarizeRun(
  awxEventsToLines(events, playNodes(doc)),
  optionA.generate(doc, { source: 'awx-e2e.flow.yaml' }).routes,
);
const job: RunView = {
  id: 'r1',
  mode: 'real',
  state: 'done',
  rc: 2,
  startedAt: '2026-10-29T08:00:00Z',
  finishedAt: '2026-10-29T08:01:00Z',
  source: 'awx',
  flowVersion: doc.flow.version,
  environment: 'AWX: AFD · awx-e2e',
  awx: {
    jobId: 31,
    url: 'http://awx.example.net/#/jobs/playbook/31/output',
    template: 'AFD · awx-e2e',
    status: 'failed',
    revision: '53e0448a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5e',
    revisionMismatch: true,
  },
  summary,
};
const commands = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'command')
    .map((m) => (m as { command: FlowCommand }).command);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, optimistic: {}, mode: 'run', run: null });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: Object.fromEntries(doc.nodes.map((n, i) => [n.id, { x: i * 260, y: 0 }])),
    });
    useUi.getState().setRun(job);
  });
});
afterEach(cleanup);

describe('Run mode', () => {
  it('nodes show hosts, failures and time; nodes the run did not reach are marked', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const line = (key: string) =>
      document.querySelector<HTMLElement>(`[data-node-id="${id(key)}"] .afd-node-run`);
    expect(line('probe')?.dataset.runState).toBe('warn');
    expect(line('probe')?.textContent).toMatch(/^3 hosts · 1 failed · /);
    expect(line('exclude')?.dataset.runState).toBe('ok');
    expect(line('notify')?.textContent).toMatch(/^1 host · /);
    const state = (key: string) =>
      document.querySelector<HTMLElement>(`[data-node-id="${id(key)}"]`)?.dataset.runState;
    expect(state('start')).toBe('ok');
    expect(state('done')).toBe('ok');
    expect(state('failed')).toBe('failed');
    expect(document.querySelector(`[data-node-id="${id('probe')}"]`)?.className).toContain(
      'run-warn',
    );
    // Run mode is read-only: no wiring from ports.
    expect(document.querySelector('.react-flow__nodes .connectable')).toBeNull();
  });

  it('a node lists its hosts, the port each took and why it failed', () => {
    render(<NodeRunPanel id={id('work')} />);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-host]')];
    expect(rows.map((r) => [r.dataset.host, r.dataset.port])).toEqual([
      ['h01', 'ok_hosts'],
      ['h02', 'failed_hosts'],
    ]);
    expect(rows[1]?.textContent).toContain('failed in [work]');
    fireEvent.click(screen.getByRole('button', { name: /Open in AWX/ }));
    expect(posted).toContainEqual({ type: 'showRunOutput' });
  });

  it('a wire lists the hosts that took it', () => {
    const edge = doc.edges.find(
      (e) => e.from.node === id('probe') && e.from.port === 'unreachable',
    );
    render(<WireRunPanel edge={edge?.id ?? ''} />);
    expect(document.querySelector<HTMLElement>('[data-wire-hosts]')?.dataset.wireHosts).toBe('h07');
  });

  it('the run panel shows the AWX job, the revision warning and failed outcomes', () => {
    render(<RunPanel />);
    expect(screen.getByText('AWX job #31 · AFD · awx-e2e')).toBeTruthy();
    expect(document.querySelector('[data-revision-mismatch]')).not.toBeNull();
    expect(document.querySelector<HTMLElement>('[data-run-outcome]')?.textContent).toContain('h02');
    // A failed job proposes nothing.
    expect(document.querySelector('[data-tested-proposal]')).toBeNull();
  });

  it('a passing run proposes the implemented nodes it ran as tested, in one command', () => {
    act(() =>
      useUi.getState().setRun({
        ...job,
        rc: 0,
        awx: { ...job.awx, status: 'successful', revisionMismatch: false } as RunView['awx'],
        summary: { ...summary, outcome: {} },
      }),
    );
    render(<RunPanel />);
    expect(
      document.querySelector<HTMLElement>('[data-tested-proposal]')?.dataset.testedProposal,
    ).toBe('2');
    fireEvent.click(screen.getByRole('button', { name: /Mark 2 Nodes Tested/ }));
    // The run goes with it: format 2 keeps it on each node (AFD-50).
    expect(commands()).toEqual([
      {
        kind: 'setStatuses',
        statuses: { [id('probe')]: 'tested', [id('work')]: 'tested' },
        run: { id: 'r1', flowVersion: 1, commit: job.awx?.revision },
      },
    ]);
  });

  it('the top bar enables Run mode and launches in AWX', () => {
    render(<TopBar />);
    expect(screen.getByRole('button', { name: 'Run' })).toHaveProperty('disabled', false);
    // AFD-45: AWX is in the Run menu, the same in every mode.
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Launch in AWX' }));
    expect(posted).toContainEqual({ type: 'launchAwx' });
    expect(screen.getByRole('button', { name: /AWX #31/ })).toBeTruthy();
  });
});

describe('a live local run (AFD-81)', () => {
  const live: RunView = {
    id: 'r2',
    mode: 'check',
    state: 'running',
    startedAt: '2026-11-04T08:00:00Z',
    source: 'local',
    summary: { ...summary, failures: [], outcome: {}, running: id('exclude') },
  };

  it('the running step pulses and says so; the top bar names it and shows the terminal', () => {
    act(() => useUi.getState().setRun(live));
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 600 }}>
          <TopBar />
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const card = document.querySelector<HTMLElement>(`[data-node-id="${id('exclude')}"]`);
    expect(card?.dataset.runState).toBe('running');
    expect(card?.className).toContain('run-running');
    expect(card?.querySelector('.afd-node-run')?.textContent).toMatch(/^running…/);
    const status = document.querySelector<HTMLElement>('.afd-run-status');
    expect(status?.textContent).toContain('Running:');
    fireEvent.click(status as HTMLElement);
    expect(posted).toContainEqual({ type: 'showRunOutput' });
    // Gone quiet: the top bar says so, in words.
    act(() => useUi.getState().setRun({ ...live, quiet: true }));
    expect(document.querySelector('.afd-run-status')?.textContent).toContain('No new events');
  });

  it('a run the designer asked for switches the canvas to Run mode when it starts', () => {
    act(() => {
      useUi.setState({ mode: 'design', run: null, runAsked: false, pendingBinding: null });
      useUi.getState().setRunAsked(true);
    });
    act(() => useUi.getState().setRun({ ...live, summary: undefined }));
    expect(useUi.getState().mode).toBe('run');
    expect(useUi.getState().runAsked).toBe(false);
    // A run started elsewhere (the Command Palette) leaves the mode as it is.
    act(() => useUi.setState({ mode: 'design' }));
    act(() => useUi.getState().setRun({ ...live, id: 'r3' }));
    expect(useUi.getState().mode).toBe('design');
  });

  it('a host opens its output, asked of the host once the local run has ended', async () => {
    act(() => useUi.getState().setRun({ ...live, state: 'done', rc: 0, summary }));
    render(<NodeRunPanel id={id('probe')} />);
    const toggle = document.querySelector<HTMLButtonElement>('[data-output-toggle]');
    expect(toggle).toBeTruthy();
    fireEvent.click(toggle as HTMLButtonElement);
    const ask = posted.find((m) => (m as { type: string }).type === 'runOutput') as {
      reqId: number;
      node: string;
      host: string;
    };
    expect(ask).toMatchObject({ node: id('probe'), host: toggle?.dataset.outputToggle });
    await act(async () => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'runOutputReply',
            reqId: ask.reqId,
            entries: [{ task: 'Check the host answers', status: 'ok', out: { stdout: 'pong' } }],
          },
        }),
      );
    });
    expect(screen.getByText('pong')).toBeTruthy();
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  });
});

describe('scenarios on the canvas (AFD-84)', () => {
  const results = [
    { name: 'all pass', passed: true, hosts: [], summary },
    {
      name: 'probe failure is reported',
      passed: false,
      hosts: [{ host: 'sw-edge-02', expected: 'done', actual: 'failed' }],
      summary,
    },
  ];

  it('the run panel lists the scenarios; one shows on the canvas, and Back to Last Run restores it', () => {
    act(() => useUi.getState().setScenarios(results));
    render(<RunPanel />);
    const list = document.querySelector('[data-run-scenarios]') as HTMLElement;
    expect(list.textContent).toContain('1 of 2 failed');
    expect(list.textContent).toContain('sw-edge-02 ended at Failed; the scenario expected Done');
    fireEvent.click(screen.getByRole('button', { name: /probe failure is reported/ }));
    const state = useUi.getState();
    expect(state.run?.source).toBe('scenario');
    expect(state.mode).toBe('run');
    expect(state.runNodes).not.toBeNull();
    expect(screen.getByText(/On the canvas: scenario/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Back to Last Run' }));
    expect(useUi.getState().run).toBe(job);
    expect(useUi.getState().scenarioShown).toBeNull();
  });

  it('the host can show one at once (Show on Canvas); a new run replaces it', () => {
    act(() => useUi.getState().setScenarios(results, 'all pass'));
    expect(useUi.getState().run?.scenario?.name).toBe('all pass');
    act(() => useUi.getState().setRun(job));
    expect(useUi.getState().scenarioShown).toBeNull();
    expect(useUi.getState().run).toBe(job);
  });
});

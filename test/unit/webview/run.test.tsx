// M7 (AFD-10): Run mode (04 §10) on a real AWX job of the awx-e2e flow: node status and host
// counts, a node's per-host results, a wire's hosts, the run panel and the tested proposal.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { type Edge, ReactFlowProvider, useStore } from '@xyflow/react';
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
// jsdom draws no wires: what the canvas hands React Flow is read instead.
let edges: Edge[] = [];
function EdgeProbe() {
  edges = useStore((s) => s.edges);
  return null;
}
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
    // AFD-379: the job's one problem at probe is an unreachable host: counted as such, not failed.
    expect(line('probe')?.textContent).toMatch(/^3 hosts · 1 unreachable · /);
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

  it('a step not reached has no status mark, a wire no host took no label (AFS-148 a4.13)', () => {
    // The fixture's run reached every step: one is marked not reached here.
    const runNodes = useUi.getState().runNodes ?? {};
    const work = runNodes[id('work')];
    if (!work) throw new Error('no run line for work');
    // AFS-232: and the step without code, which still says TODO (as on a paused run's canvas).
    const exclude = runNodes[id('exclude')];
    if (!exclude) throw new Error('no run line for exclude');
    act(() =>
      useUi.setState({
        runNodes: {
          ...runNodes,
          [id('work')]: { ...work, state: 'idle' },
          [id('exclude')]: { ...exclude, state: 'idle' },
        },
      }),
    );
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
        <EdgeProbe />
      </ReactFlowProvider>,
    );
    const node = (key: string) => document.querySelector(`[data-node-id="${id(key)}"]`);
    expect(node('work')?.querySelector('.afd-node-run')?.textContent).toBe('not reached');
    expect(node('work')?.querySelector('.afd-status-icon')).toBeNull();
    // AFS-208: in a run no step shows its authoring status as a mark; one without code says TODO.
    expect(node('probe')?.querySelector('.afd-status-icon')).toBeNull();
    expect(node('exclude')?.querySelector('.afd-status-icon')).toBeNull();
    expect(node('exclude')?.querySelector('[data-run-todo]')?.textContent).toBe('TODO');
    expect(node('probe')?.querySelector('[data-run-todo]')).toBeNull();
    const idle = edges.filter((e) => String(e.className).includes('run-idle'));
    expect(idle.length).toBeGreaterThan(0);
    for (const e of idle) expect(e.label).toBeUndefined();
    expect(edges.some((e) => typeof e.label === 'string' && /^\d+ hosts?$/.test(e.label))).toBe(
      true,
    );
  });

  it('a node lists its hosts, the port each took and why it failed', () => {
    render(<NodeRunPanel id={id('work')} />);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-host]')];
    expect(rows.map((r) => [r.dataset.host, r.dataset.port])).toEqual([
      ['h01', 'ok_hosts'],
      ['h02', 'failed_hosts'],
    ]);
    // AFD-379: the task and message in the row below, across the table.
    expect(rows[1]?.textContent).toContain('failed');
    expect(document.querySelector('[data-host-detail="h02"]')?.textContent).toContain(
      'failed in [work]',
    );
    fireEvent.click(screen.getByRole('button', { name: /Open in AWX/ }));
    expect(posted).toContainEqual({ type: 'showRunOutput' });
  });

  it('a host that failed with no route reads as stopped here (AFD-337)', () => {
    const ports = { ...summary.nodes[id('work')] };
    delete ports.failed_hosts;
    act(() =>
      useUi.getState().setRun({
        ...job,
        summary: { ...summary, nodes: { ...summary.nodes, [id('work')]: ports } },
      }),
    );
    render(<NodeRunPanel id={id('work')} />);
    expect(screen.getByRole('columnheader', { name: 'Went to' })).toBeTruthy();
    const stopped = document.querySelector('[data-host="h02"] [data-stopped]');
    expect(stopped?.textContent).toBe('stopped here (failed, no route)');
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

  it('a run on Ansible Flow Server says so, with its number, not "Local" (AFS-139)', () => {
    act(() =>
      useUi.getState().setRun({
        ...job,
        mode: 'check',
        source: 'runner',
        awx: undefined,
        runner: {
          runId: 'r5',
          number: 5,
          url: '/runs/r5',
          state: 'succeeded',
          commit: 'a'.repeat(40),
          config: 'Edge switches',
        },
      }),
    );
    render(<RunPanel />);
    expect(screen.getByText('Skeleton run #5 on Ansible Flow Server · Edge switches')).toBeTruthy();
    expect(screen.queryByText(/^Local/)).toBeNull();
  });

  it("a server's page tells the run in its own words: check run, went well, stopped (AFS-153)", () => {
    const server = {
      ...job,
      mode: 'check' as const,
      rc: 0,
      source: 'runner' as const,
      awx: undefined,
      summary: {
        hosts: ['sw1'],
        nodes: {},
        outcome: {},
        failures: [],
        unreachable: [],
        stoppedEarly: false,
      },
      runner: {
        runId: 'r5',
        number: 5,
        url: '/runs/r5',
        state: 'succeeded',
        commit: 'a'.repeat(40),
        config: 'Edge switches',
      },
    } as RunView;
    act(() => {
      useUi.getState().setEmbed({ words: 'server' });
      useUi.getState().setRun(server);
    });
    const { unmount } = render(
      <>
        <TopBar />
        <RunPanel />
      </>,
    );
    expect(screen.getByText('Check run #5 on Ansible Flow Server · Edge switches')).toBeTruthy();
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('went well');
    const chip = document.querySelector<HTMLElement>('.afd-run-status')?.textContent ?? '';
    expect(chip).toContain('1 host · went well');
    expect(document.body.textContent).not.toMatch(/exit 0|Skeleton|1 hosts/);
    act(() =>
      useUi.getState().setRun({
        ...server,
        state: 'error',
        errorCode: 'cancelled',
        error: 'Stopped by Dana Whitfield before it went on',
      }),
    );
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('stopped');
    expect(document.querySelector('[data-run-why]')?.textContent).toBe(
      'Stopped by Dana Whitfield before it went on',
    );
    expect(document.body.textContent).not.toMatch(/Run interrupted/);
    // AFD-359: a run whose host a rejection sent to a failed end reads rejected, without keys.
    act(() =>
      useUi.getState().setRun({
        ...server,
        rc: 2,
        summary: {
          ...(server.summary as NonNullable<RunView['summary']>),
          outcome: {
            sw1: 'Rejected at [approve] Change approval. Ended at [no] Not approved (outcome: failed)',
          },
        },
      }),
    );
    expect(document.querySelector('[data-run-status]')?.textContent).toBe('rejected');
    expect(document.querySelector('.afd-run-status')?.textContent).toContain('1 host · rejected');
    expect(document.querySelector('[data-run-outcome]')?.textContent).toContain(
      'Rejected at Change approval. Ended at Not approved (outcome: rejected)',
    );
    unmount();
    act(() => useUi.getState().setEmbed(undefined));
  });

  it('VS Code keeps its words: a skeleton run and its exit code, "1 host" (AFS-153)', () => {
    act(() =>
      useUi.getState().setRun({
        ...job,
        mode: 'check',
        rc: 0,
        source: 'local',
        awx: undefined,
        summary: {
          hosts: ['sw1'],
          nodes: {},
          outcome: {},
          failures: [],
          unreachable: [],
          stoppedEarly: false,
        },
      } as RunView),
    );
    render(<TopBar />);
    const chip = document.querySelector<HTMLElement>('.afd-run-status')?.textContent ?? '';
    expect(chip).toContain('1 host · 0 failed · exit 0');
    expect(screen.getByText('Run as Skeleton')).toBeTruthy();
  });

  it('a host that runs only saved flows names neither AWX nor the local environment (AFD-332)', () => {
    act(() => {
      useUi.getState().setRun(null);
      useUi.getState().setEmbed({ mayRun: false });
    });
    render(<RunPanel />);
    const none = document.querySelector('[data-run-none]') as HTMLElement;
    expect(none.dataset.runNone).toBe('saved-only');
    expect(none.textContent).toMatch(/runs use the saved flow/);
    expect(none.textContent).not.toMatch(/AWX|local environment/);
    act(() => useUi.getState().setEmbed(undefined));
  });

  it('a viewer of a flow with no run says so, not to open one of its runs (AFD-335)', () => {
    act(() => {
      useUi.getState().setRun(null);
      useUi.setState({ viewer: true, pastRuns: [], pastRunsKnown: false });
      useUi.getState().setEmbed({ mayRun: false });
    });
    const { unmount } = render(<RunPanel />);
    // Before the host said which runs there are, it does not claim there are none.
    expect(document.querySelector('[data-run-none]')?.textContent).toMatch(/open one of its runs/i);
    act(() => useUi.getState().setPastRuns([]));
    const none = document.querySelector('[data-run-none]') as HTMLElement;
    expect(none.textContent).toBe('No run of this flow yet.');
    act(() => useUi.getState().setEmbed({ mayRun: true }));
    expect(none.textContent).toMatch(/^No run of this flow yet\. Run it from the bar above/);
    unmount();
    act(() => {
      useUi.setState({ viewer: false, pastRunsKnown: false });
      useUi.getState().setEmbed(undefined);
    });
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

  it('a viewer is not offered Mark Tested, which it could not save (AFS-188)', () => {
    act(() => {
      useUi.getState().setRun({
        ...job,
        rc: 0,
        awx: { ...job.awx, status: 'successful', revisionMismatch: false } as RunView['awx'],
        summary: { ...summary, outcome: {} },
      });
      useUi.setState({ viewer: true });
    });
    render(<RunPanel />);
    expect(document.querySelector('[data-tested-proposal]')).toBeNull();
    act(() => useUi.setState({ viewer: false }));
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

  // AFD-105 (round 3: R8): "the scenario fails it here" did not say the scenario planted it.
  it('a failure the scenario planted says so: in the list, the failures and the step', () => {
    const work = doc.nodes.find((n) => n.key === 'work');
    expect(work).toBeTruthy();
    const forced = [
      { host: 'h02', step: 'work', outcome: 'failed' as const, port: 'failed_hosts' },
    ];
    const planted = {
      name: 'h02 is forced',
      passed: false,
      hosts: [{ host: 'h02', expected: 'done', actual: 'failed' }],
      summary: {
        ...summary,
        failures: [{ host: 'h02', node: work?.id, task: '[work] TODO', msg: 'TODO: work' }],
      },
      forced,
    };
    act(() => useUi.getState().setScenarios([planted]));
    render(<RunPanel />);
    const why = `the scenario forces ${work?.title} to fail for it (force: failed), so it leaves by failed_hosts`;
    expect(document.querySelector('[data-scenario-misses]')?.textContent).toBe(
      `h02 ended at Failed; the scenario expected Done, because ${why}`,
    );
    fireEvent.click(screen.getByRole('button', { name: /h02 is forced/ }));
    expect(document.querySelector('[data-run-failures] [data-forced]')?.textContent).toBe(
      `h02: ${why}`,
    );
    cleanup();
    render(<NodeRunPanel id={work?.id as string} />);
    expect(document.querySelector('tr[data-host="h02"] [data-forced]')?.textContent).toBe(
      'Forced by the scenario (failed)',
    );
    // AFD-111 (round 4: Q5): the row also says where the host ended and where it was expected.
    expect(document.querySelector('tr[data-host="h02"] [data-forced-miss]')?.textContent).toBe(
      ' · ended at Failed; the scenario expected Done',
    );
  });

  it('the host can show one at once (Show on Canvas); a new run replaces it', () => {
    act(() => useUi.getState().setScenarios(results, 'all pass'));
    expect(useUi.getState().run?.scenario?.name).toBe('all pass');
    act(() => useUi.getState().setRun(job));
    expect(useUi.getState().scenarioShown).toBeNull();
    expect(useUi.getState().run).toBe(job);
  });
});

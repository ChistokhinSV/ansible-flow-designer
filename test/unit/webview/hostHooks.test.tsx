// AFD-381: the canvas inside a page with its own debug toolbar (Ansible Flow Server's debug
// workbench): config.hostToolbar hides the canvas's Step, Continue, Retry and Stop buttons and
// (AFD-382) the run text the page shows itself: the failure bar, the top bar's pause pill, the Run
// panel's step bar and the paused step's waiting hosts; node badges stay. nodeSelected goes to the host; revealNode opens the level and
// selects the node; highlightHost marks the steps a host ran and the one it waits at. Without the
// flag (VS Code) nothing changes. Fictional hosts.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { hostMarks, hostTrail } from '../../../src/core/run/hostTrail';
import type { StepPause } from '../../../src/core/run/step';
import { viewerAllows } from '../../../src/core/viewer';
import { App } from '../../../src/webview/App';
import { reportSelection } from '../../../src/webview/hostHooks';
import { NodeRunPanel, RunPanel } from '../../../src/webview/panels/RunPanel';
import { FailureBar } from '../../../src/webview/panels/StepBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const id = (key: string) =>
  [...model.nodes.values()].find((e) => e.node.key === key)?.node.id as string;
const sent = (type: string) => posted.filter((m) => (m as { type: string }).type === type);
const fromHost = (data: unknown) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data }));
  });
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));

const pause = (over: Partial<StepPause> = {}): StepPause => ({
  id: 'k-2',
  node: id('normalize'),
  play: '[normalize] Normalize',
  hosts: ['fw-01', 'fw-02'],
  since: Date.now() / 1000,
  timeout: 3600,
  kind: 'failure',
  attempt: 1,
  debug: true,
  failed: [{ host: 'fw-02', task: 'parse', msg: 'no version in the answer' }],
  ...over,
});
// fw-01 and fw-02 read their status; only fw-01 got past normalize; both wait at normalize.
const run = (paused: StepPause = pause()): RunView => ({
  id: 'r1',
  mode: 'check',
  state: 'running',
  startedAt: new Date().toISOString(),
  source: 'local',
  summary: {
    hosts: ['fw-01', 'fw-02', 'fw-03'],
    nodes: {
      [id('read-status')]: { ok: ['fw-01', 'fw-02'] },
      [id('normalize')]: { ok: ['fw-01'], failed: ['fw-02'] },
    },
    failures: [],
    outcome: {},
    unreachable: [],
  } as never,
  step: { every: false, points: [], pauses: 1, debug: true, paused },
});

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'run',
    level: ROOT,
    run: null,
    stepRuns: true,
    debugRuns: true,
    hostToolbar: false,
    hostMark: null,
    pausePoints: [],
    launch: null,
  });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(model),
      autoPositions: {},
    });
  });
});
afterEach(cleanup);

describe('AFD-381: config.hostToolbar', () => {
  it('the failure bar keeps its buttons in VS Code, and is not shown at all for the host', () => {
    act(() => useUi.getState().setRun(run()));
    const { unmount } = render(<FailureBar />);
    const bar = document.querySelector('[data-failure-bar]') as HTMLElement;
    expect(bar.querySelectorAll('[data-step-command]').length).toBe(4);
    expect(bar.textContent).toContain('Paused after');
    unmount();
    act(() => useUi.getState().setHostToolbar(true));
    render(<FailureBar />);
    // AFD-382: the reason is the host's status line; the failed hosts its own views.
    expect(document.querySelector('[data-failure-bar]')).toBeNull();
  });

  it("the Run panel's step bar is left to the host while the run goes", () => {
    act(() => useUi.getState().setRun(run(pause({ kind: undefined, failed: undefined }))));
    const { unmount } = render(<RunPanel />);
    expect(document.querySelector('[data-step-run="going"] [data-step-paused]')).not.toBeNull();
    expect(document.body.textContent).toContain('Waiting there: fw-01, fw-02');
    unmount();
    act(() => useUi.getState().setHostToolbar(true));
    render(<RunPanel />);
    expect(document.querySelector('[data-step-run]')).toBeNull();
    expect(document.body.textContent).not.toContain('Waiting there');
    expect(document.querySelector('[data-step-command]')).toBeNull();
  });

  it("an ended run's step section stays for the host", () => {
    act(() => {
      useUi.getState().setHostToolbar(true);
      useUi.getState().setRun({
        ...run(),
        state: 'done',
        step: { every: false, points: [], pauses: 2, debug: true },
      } as RunView);
    });
    render(<RunPanel />);
    expect(document.querySelector('[data-step-run="ended"]')?.textContent).toContain(
      'paused 2 times',
    );
  });

  it("the paused step's waiting hosts are left to the host; results of steps that ran stay", () => {
    // Paused before backup: nobody ran it yet, both wait there.
    const before = pause({ kind: undefined, failed: undefined, node: id('backup') });
    act(() => useUi.getState().setRun(run(before)));
    const { unmount } = render(<NodeRunPanel id={id('backup')} />);
    expect(document.body.textContent).toContain('waiting for Step or Continue');
    unmount();
    act(() => useUi.getState().setHostToolbar(true));
    const { unmount: off } = render(<NodeRunPanel id={id('backup')} />);
    expect(document.body.textContent).not.toContain('waiting for Step or Continue');
    expect(document.body.textContent).not.toContain('paused before');
    expect(document.querySelector('[data-waits-left-to-host]')).not.toBeNull();
    off();
    // A step that ran keeps its hosts and results.
    render(<NodeRunPanel id={id('read-status')} />);
    expect(document.querySelector('[data-run-hosts]')?.getAttribute('data-run-hosts')).toBe('2');
  });

  it('a pause does not switch the canvas to Run mode by itself for the host', () => {
    act(() => useUi.getState().setMode('design'));
    act(() => useUi.getState().setRun(run()));
    expect(useUi.getState().mode).toBe('run');
    act(() => {
      useUi.getState().setRun(null);
      useUi.getState().setMode('design');
      useUi.getState().setHostToolbar(true);
      useUi.getState().setRun(run());
    });
    expect(useUi.getState().mode).toBe('design');
  });

  it('the top bar shows no "Paused after" pill for the host; node badges stay', async () => {
    render(<App />);
    fromHost({ type: 'config', testMode: false, stepRuns: true });
    act(() => useUi.getState().setRun(run()));
    await settle();
    const pill = () => document.querySelector('.afd-run-status[data-run-state="paused"]');
    expect(pill()?.textContent).toContain('Paused after');
    fromHost({ type: 'config', testMode: false, stepRuns: true, hostToolbar: true });
    await settle();
    expect(pill()).toBeNull();
    expect(document.querySelector('[data-failure-bar]')).toBeNull();
    // The badge on the subflow that holds the failure pause stays: the in-context mark.
    expect(
      document.querySelector(`[data-node-id="${id('precheck')}"][data-step-paused]`),
    ).not.toBeNull();
  });

  it("the top bar's Stop is left to the host during a step-by-step run", async () => {
    render(<App />);
    fromHost({ type: 'config', testMode: false, stepRuns: true });
    act(() => useUi.getState().setRun(run()));
    await settle();
    const stops = () =>
      [...document.querySelectorAll('button')].filter((b) => b.textContent?.trim() === 'Stop');
    expect(stops().length).toBeGreaterThan(0);
    fromHost({ type: 'config', testMode: false, stepRuns: true, hostToolbar: true });
    await settle();
    expect(stops().length).toBe(0);
  });

  it('comes from config and is off by default', async () => {
    render(<App />);
    fromHost({ type: 'config', testMode: false, stepRuns: true });
    expect(useUi.getState().hostToolbar).toBe(false);
    fromHost({ type: 'config', testMode: false, stepRuns: true, hostToolbar: true });
    expect(useUi.getState().hostToolbar).toBe(true);
    await settle();
  });
});

describe('AFD-381: nodeSelected', () => {
  it('tells a host with its own toolbar the node selected, once per change', () => {
    const off = reportSelection();
    act(() => useUi.getState().select({ node: id('precheck') }));
    expect(sent('nodeSelected')).toEqual([]);
    act(() => useUi.getState().setHostToolbar(true));
    act(() => useUi.getState().select({ node: id('backup') }));
    act(() => useUi.getState().select({ node: id('backup') }));
    act(() => useUi.getState().select({}));
    off();
    expect(sent('nodeSelected')).toEqual([
      { type: 'nodeSelected', node: id('precheck') },
      { type: 'nodeSelected', node: id('backup') },
      { type: 'nodeSelected', node: null },
    ]);
  });

  it('is a message a viewer may send', () => {
    expect(viewerAllows('nodeSelected')).toBe(true);
  });
});

describe('AFD-381: revealNode', () => {
  it('opens the subflow that holds the node and selects it', async () => {
    render(<App />);
    fromHost({ type: 'revealNode', node: id('normalize') });
    expect(useUi.getState().level).toBe(id('precheck'));
    expect(useUi.getState().selection.node).toBe(id('normalize'));
    // The canvas scrolled to it: it took the node to centre on.
    expect(useUi.getState().centerOn).toBeNull();
    await settle();
  });
});

describe('AFD-381: highlightHost', () => {
  it("a host's trail: the steps it ran and where it waits", () => {
    const fw02 = hostTrail(doc, run(), 'fw-02');
    expect(fw02.ran).toEqual(
      expect.arrayContaining([id('start'), id('read-status'), id('normalize')]),
    );
    expect(fw02.at).toBe(id('normalize'));
    // fw-03 never got past start, and does not wait at the pause.
    const fw03 = hostTrail(doc, run(), 'fw-03');
    expect(fw03).toEqual({ ran: [id('start')] });
    // Lifted to the level shown: the subflow holds both.
    expect(hostMarks(model, fw02, ROOT)).toEqual({ [id('start')]: 'ran', [id('precheck')]: 'at' });
    expect(hostMarks(model, fw02, id('precheck'))).toEqual({
      [id('read-status')]: 'ran',
      [id('normalize')]: 'at',
    });
  });

  it('marks the nodes on the canvas, and clears with null', async () => {
    render(<App />);
    act(() => useUi.getState().setRun(run()));
    fromHost({ type: 'highlightHost', host: 'fw-02' });
    await settle();
    const mark = (key: string) =>
      document.querySelector<HTMLElement>(`[data-node-id="${id(key)}"]`)?.dataset.hostMark;
    expect(mark('start')).toBe('ran');
    expect(mark('precheck')).toBe('at');
    expect(mark('backup')).toBe('off');
    fromHost({ type: 'highlightHost', host: null });
    await settle();
    expect(mark('precheck')).toBeUndefined();
    expect(useUi.getState().hostMark).toBeNull();
  });
});

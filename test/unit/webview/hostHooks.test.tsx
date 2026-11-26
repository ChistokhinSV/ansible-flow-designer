// AFD-381: the canvas inside a page with its own debug toolbar (Ansible Flow Server's debug
// workbench): config.hostToolbar hides the canvas's Step, Continue, Retry and Stop buttons and
// keeps the reason and host lines; nodeSelected goes to the host; revealNode opens the level and
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
import { RunPanel } from '../../../src/webview/panels/RunPanel';
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
  it('the failure bar keeps its reason and hosts, without the step buttons', () => {
    act(() => useUi.getState().setRun(run()));
    const { unmount } = render(<FailureBar />);
    expect(document.querySelectorAll('[data-failure-bar] [data-step-command]').length).toBe(4);
    unmount();
    act(() => useUi.getState().setHostToolbar(true));
    render(<FailureBar />);
    const bar = document.querySelector('[data-failure-bar]') as HTMLElement;
    expect(bar.textContent).toContain('Paused after');
    expect(bar.textContent).toContain('fw-02: parse: no version in the answer');
    expect(bar.querySelector('[data-step-command]')).toBeNull();
  });

  it("the Run panel's step bar keeps where it waits and who, without the step buttons", () => {
    act(() => {
      useUi.getState().setHostToolbar(true);
      useUi.getState().setRun(run(pause({ kind: undefined, failed: undefined })));
    });
    render(<RunPanel />);
    const bar = document.querySelector('[data-step-run]') as HTMLElement;
    expect(bar.querySelector('[data-step-paused]')).not.toBeNull();
    expect(bar.textContent).toContain('Waiting there: fw-01, fw-02');
    expect(document.querySelector('[data-step-command]')).toBeNull();
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

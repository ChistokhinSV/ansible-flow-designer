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
    expect(commands()).toEqual([
      { kind: 'setStatuses', statuses: { [id('probe')]: 'tested', [id('work')]: 'tested' } },
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

// AFD-11: Run mode for an AWX workflow split at an approval: the approval node shows its AWX
// decision, its panel links to the approval in AWX, and the run panel lists the segment jobs.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { NodeRunPanel, RunPanel } from '../../../src/webview/panels/RunPanel';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../fixtures/engine/approval-segments.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const run = (status: 'waiting' | 'denied'): RunView => ({
  id: 'r1',
  mode: 'real',
  state: status === 'waiting' ? 'running' : 'done',
  rc: status === 'waiting' ? undefined : 2,
  startedAt: '2026-10-30T08:00:00Z',
  source: 'awx',
  flowVersion: 1,
  environment: 'AWX workflow: AFD · approval-segments',
  awx: {
    jobId: 40,
    url: 'http://awx.example.net/#/jobs/workflow/40/output',
    template: 'AFD · approval-segments',
    status: status === 'waiting' ? 'running' : 'successful',
    workflow: true,
    approvals: {
      [id('gate')]: { status, url: 'http://awx.example.net/#/workflow_approvals/42/details' },
    },
    segments: [
      { name: 'start', job: 41, status: 'successful' },
      ...(status === 'denied' ? [{ name: 'gate-rejected', job: 43, status: 'successful' }] : []),
    ],
  },
  summary: {
    hosts: ['h01', 'h02'],
    nodes: { [id('check')]: { ok_hosts: ['h01', 'h02'] } },
    outcome: {},
    failures: [],
    stoppedEarly: false,
  } as unknown as RunView['summary'],
});

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
    useUi.getState().setRun(run('waiting'));
  });
});
afterEach(cleanup);

describe('AWX approvals in Run mode', () => {
  it('the approval node waits for its AWX decision; the top bar says so', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 2400, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const line = document.querySelector<HTMLElement>(
      `[data-node-id="${id('gate')}"] .afd-node-run`,
    );
    expect(line?.dataset.approval).toBe('waiting');
    expect(line?.textContent).toBe('waiting for approval');
    cleanup();
    render(<TopBar />);
    expect(screen.getByText(/AWX workflow #40 · waiting for approval/)).toBeTruthy();
  });

  it('its panel opens the approval in AWX (the host resolves the URL)', () => {
    render(<NodeRunPanel id={id('gate')} />);
    fireEvent.click(screen.getByRole('button', { name: /Open approval in AWX/ }));
    expect(posted).toContainEqual({ type: 'showRunOutput', approval: id('gate') });
  });

  it('the run panel names the workflow and lists its segment jobs', () => {
    act(() => useUi.getState().setRun(run('denied')));
    render(<RunPanel />);
    expect(screen.getByText('AWX workflow #40 · AFD · approval-segments')).toBeTruthy();
    expect(document.querySelector<HTMLElement>('[data-run-segments]')?.textContent).toContain(
      'gate-rejected',
    );
    cleanup();
    render(<NodeRunPanel id={id('gate')} />);
    expect(document.querySelector<HTMLElement>('[data-approval]')?.dataset.approval).toBe('denied');
  });
});

// AFD-273: approvals of a run that is not AWX's (a server that runs segments): the run's own
// approvals, decided in the panel where the host allows it.
describe('approvals a host decides', () => {
  const served = (approval: RunView['approvals']): RunView => ({
    ...run('waiting'),
    awx: undefined,
    source: 'local',
    approvals: approval,
  });

  it('the node and the top bar wait; who may decide approves with a comment', () => {
    act(() =>
      useUi.getState().setRun(served({ [id('gate')]: { status: 'waiting', mayDecide: true } })),
    );
    render(<TopBar />);
    expect(screen.getByText('Waiting for approval')).toBeTruthy();
    cleanup();
    render(<NodeRunPanel id={id('gate')} />);
    fireEvent.change(screen.getByLabelText('Comment'), {
      target: { value: 'Window confirmed with the NOC' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(posted).toContainEqual({
      type: 'approve',
      node: id('gate'),
      decision: 'approved',
      comment: 'Window confirmed with the NOC',
    });
    expect(screen.getByRole('status').textContent).toMatch(/Sent: approved/);
  });

  it('someone who may not decide sees it wait, with no buttons', () => {
    act(() => useUi.getState().setRun(served({ [id('gate')]: { status: 'waiting' } })));
    render(<NodeRunPanel id={id('gate')} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText(/Someone allowed to approve decides it/)).toBeTruthy();
  });

  it('a decided one says who, and why', () => {
    act(() =>
      useUi.getState().setRun({
        ...served({
          [id('gate')]: {
            status: 'timed out',
            by: 'the server',
            at: '2026-11-13T10:30:00Z',
            comment: 'Nobody decided in 30m',
          },
        }),
        state: 'done',
      }),
    );
    render(<NodeRunPanel id={id('gate')} />);
    const section = document.querySelector<HTMLElement>('[data-approval]');
    expect(section?.dataset.approval).toBe('timed out');
    expect(section?.textContent).toMatch(/timed out by the server/);
    expect(screen.getByText('Nobody decided in 30m')).toBeTruthy();
  });
});

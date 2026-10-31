// M6 (AFD-9): Implementation mode's "Design vs code" panel (mockup 04) on the drift fixture's real
// scan: matched count, items with both directions, Ignore with a reason, host actions.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CodeScan } from '../../../src/core/drift/types';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { ago } from '../../../src/webview/constants';
import { DriftPanel, IgnoreDialog, NodeCodePanel } from '../../../src/webview/panels/DriftPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const DIR = join(__dirname, '../../fixtures/drift');
const doc = parse(
  readFileSync(join(DIR, 'flows/edge-drift/edge-drift.flow.yaml'), 'utf8'),
) as FlowDocument;
const scan: CodeScan = {
  at: new Date().toISOString(),
  environment: 'docker: ps-probe-env:2.19',
  git: {
    branch: 'main',
    commit: '4f2c1a9',
    when: new Date(Date.now() - 5 * 60_000).toISOString(),
    dirty: ['roles/netops_validate/tasks/main.yml'],
  },
  ...JSON.parse(readFileSync(join(DIR, 'scan.json'), 'utf8')),
};
const idOf = (key: string) =>
  [...buildModel(doc).nodes.values()].find((e) => e.node.key === key)?.node.id as string;
const commands = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'command')
    .map((m) => (m as { command: FlowCommand }).command);

/** The host's answer to every command posted so far (buttons wait for it). */
async function ackAll() {
  await act(async () => {
    for (const m of posted as { type: string; reqId?: number }[])
      if (m.type === 'command' || m.type === 'driftAction')
        window.dispatchEvent(
          new MessageEvent('message', { data: { type: 'ack', reqId: m.reqId, ok: true } }),
        );
  });
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    sync: { state: 'idle' },
    drift: null,
    ignore: null,
    properties: null,
    mode: 'implementation',
    run: null,
  });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    });
    useUi.getState().setSync({ state: 'done', scan });
  });
});
afterEach(cleanup);

describe('Design vs code panel', () => {
  it('shows the sync source, matches by ID and the drift items of mockup 04', () => {
    render(<DriftPanel />);
    expect(screen.getByText('4f2c1a9')).toBeTruthy();
    expect(screen.getByText('5 min ago', { exact: false })).toBeTruthy();
    expect(screen.getByText('1 uncommitted')).toBeTruthy();
    expect(document.querySelector('[data-matched]')?.getAttribute('data-matched')).toBe('7/7');
    const items = [
      ...document.querySelectorAll('[data-drift-panel] > .afd-drift-list [data-drift]'),
    ].map((e) => e.getAttribute('data-drift'));
    expect(items).toEqual([
      'task-file:wait_for_convergence',
      'output:validation_result',
      'input-required:site',
      `unbound:${idOf('rollback')}`,
    ]);
    // Notes (roles without specs) are listed apart and do not count as drift.
    expect(document.querySelector('[data-drift-notes]')?.getAttribute('data-drift-notes')).toBe(
      '3',
    );
  });

  it('design-side actions are flow commands; code-side ones go to the host', async () => {
    render(<DriftPanel />);
    const card = (id: string) => document.querySelector(`[data-drift="${id}"]`) as HTMLElement;
    fireEvent.click(within(card('output:validation_result')).getByText('Update design'));
    await ackAll();
    expect(commands().at(-1)).toMatchObject({
      kind: 'setContractField',
      target: idOf('validate'),
      side: 'outputs',
      name: 'validation_result',
      rename: 'diff_report',
    });
    fireEvent.click(within(card('output:validation_result')).getByText('Open code'));
    expect(posted.at(-1)).toEqual({
      type: 'openCode',
      path: 'roles/netops_validate/tasks/main.yml',
      line: 2,
    });
    fireEvent.click(within(card(`unbound:${idOf('rollback')}`)).getByText('Generate stub'));
    expect(posted.at(-1)).toMatchObject({
      type: 'driftAction',
      action: { kind: 'generateStub', node: idOf('rollback'), role: 'rollback' },
    });
    await ackAll();
    fireEvent.click(within(card(`unbound:${idOf('rollback')}`)).getByText('Bind role'));
    expect(useUi.getState().properties).toEqual({
      node: idOf('rollback'),
      tab: 'implementation',
      bindKind: 'role',
    });
  });

  it('Ignore asks for a reason and records a drift_ignored decision', () => {
    render(
      <>
        <DriftPanel />
        <IgnoreDialog />
      </>,
    );
    const card = document.querySelector(
      '[data-drift="task-file:wait_for_convergence"]',
    ) as HTMLElement;
    fireEvent.click(within(card).getByText('Ignore…'));
    const dialog = screen.getByRole('dialog', { name: 'Ignore this drift' });
    const submit = within(dialog).getByText('Ignore', { selector: 'button' }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), {
      target: { value: 'Runs from the role main' },
    });
    fireEvent.click(submit);
    expect(commands().at(-1)).toEqual({
      kind: 'ignoreDrift',
      node: idOf('push-baseline'),
      item: 'task-file:wait_for_convergence',
      reason: 'Runs from the role main',
    });
  });

  it('a selected node lists the tasks it runs, with file and line', () => {
    render(<NodeCodePanel id={idOf('precheck')} />);
    expect(screen.getByText('playbook: precheck.yml')).toBeTruthy();
    expect(screen.getByText('2 tasks')).toBeTruthy();
    fireEvent.click(screen.getByText('playbooks/precheck.yml:6'));
    expect(posted.at(-1)).toEqual({ type: 'openCode', path: 'playbooks/precheck.yml', line: 6 });
  });

  it('relative times', () => {
    const now = Date.parse('2026-10-29T12:00:00Z');
    expect(ago('2026-10-29T11:59:30Z', now)).toBe('just now');
    expect(ago('2026-10-29T11:55:00Z', now)).toBe('5 min ago');
    expect(ago('2026-10-28T12:00:00Z', now)).toBe('1 d ago');
  });
});

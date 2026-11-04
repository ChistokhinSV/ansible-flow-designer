// AFD-82: the launch dialog. Every input with what it reads as, the inventory's groups for host
// lists, the facts of the run, Run with one message; secrets never leave the dialog's own state.
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LaunchPlan } from '../../../src/core/run/launch';
import { LaunchDialog } from '../../../src/webview/panels/LaunchDialog';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const plan: LaunchPlan = {
  token: 't-1',
  mode: 'real',
  flow: 'NTP rollout',
  fields: [
    { name: 'devices', type: 'host_list', required: true, secret: false, text: '', targets: true },
    { name: 'ntp_servers', type: 'list', required: true, secret: false, text: '' },
    { name: 'enable_secret', type: 'string', required: true, secret: true, text: '' },
    { name: 'change_ticket', type: 'string', required: false, secret: false, text: 'CHG-0000' },
  ],
  groups: ['lab', 'core'],
  facts: {
    sources: ['inventory/lab.ini'],
    count: 4,
    hosts: ['lab-sw-01', 'lab-sw-02', 'lab-sw-03', 'lab-sw-04'],
    unknown: [],
    uses: [],
    prod: [],
    vault: true,
    environment: 'docker: afd-ee:2.19',
  },
  vault: true,
  environment: 'docker: afd-ee:2.19',
};

const sent = (type: string) => posted.filter((m) => (m as { type: string }).type === type);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ launch: null, launchNotice: undefined, runAsked: false });
});
afterEach(cleanup);

function open(p: LaunchPlan = plan) {
  act(() => useUi.getState().setLaunch(p));
  render(<LaunchDialog />);
  return screen.getByRole('dialog');
}

describe('launch dialog', () => {
  it('names every input with its type, shows what a list reads as and offers the groups', async () => {
    const dialog = open();
    expect(within(dialog).getByRole('heading').textContent).toBe('Run for Real: NTP rollout');
    const servers = within(dialog).getByLabelText(/ntp_servers/) as HTMLInputElement;
    fireEvent.change(servers, { target: { value: '10.20.0.10, 10.20.0.11' } });
    expect(within(dialog).getByText('2 items: "10.20.0.10", "10.20.0.11"')).toBeTruthy();
    // A group chip adds the group to the host list; again, it takes it out.
    fireEvent.click(within(dialog).getByRole('button', { name: 'lab' }));
    const devices = within(dialog).getByLabelText(/devices/) as HTMLInputElement;
    expect(devices.value).toBe('lab');
    // The targets changed: the host counts them again for this dialog.
    await act(() => new Promise((r) => setTimeout(r, 450)));
    expect(sent('launchCheck').at(-1)).toMatchObject({
      token: 't-1',
      inputs: { devices: ['lab'], ntp_servers: ['10.20.0.10', '10.20.0.11'] },
    });
    expect(JSON.stringify(sent('launchCheck'))).not.toContain('enable_secret');
    // A real run's confirmation, in the dialog.
    expect(within(dialog).getByText('Run "NTP rollout" for real on 4 host(s)?')).toBeTruthy();
    expect(
      within(dialog).getByText('Hosts: 4 (lab-sw-01, lab-sw-02, lab-sw-03, lab-sw-04)'),
    ).toBeTruthy();
  });

  it('Run sends the inputs, the secret and the vault password once; the store never holds them', () => {
    const dialog = open();
    const type = (label: RegExp, value: string) =>
      fireEvent.change(within(dialog).getByLabelText(label), { target: { value } });
    // A missing input is named, and nothing is sent.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run for Real' }));
    expect(within(dialog).getByText('devices is required')).toBeTruthy();
    expect(sent('launchRun')).toHaveLength(0);
    type(/devices/, 'lab');
    type(/ntp_servers/, '10.20.0.10');
    type(/enable_secret/, 'S3cr3t!');
    type(/Vault password/, 'v4ult');
    expect(JSON.stringify(useUi.getState())).not.toMatch(/S3cr3t!|v4ult/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run for Real' }));
    expect(sent('launchRun')).toEqual([
      {
        type: 'launchRun',
        token: 't-1',
        inputs: {
          devices: ['lab'],
          ntp_servers: ['10.20.0.10'],
          enable_secret: 'S3cr3t!',
          change_ticket: 'CHG-0000',
        },
        vaultPassword: 'v4ult',
      },
    ]);
    expect(useUi.getState().launch).toBeNull();
    expect(useUi.getState().runAsked).toBe(true);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Escape cancels, and the host drops the token; no facts, no Run', () => {
    const dialog = open({
      ...plan,
      mode: 'check',
      facts: undefined,
      factsError: 'None of the targets (x) is in the inventory',
    });
    expect(within(dialog).getByText(/None of the targets/)).toBeTruthy();
    expect(
      (within(dialog).getByRole('button', { name: 'Run as Skeleton' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.keyDown(dialog, { key: 'Escape' });
    expect(sent('launchCancel')).toEqual([{ type: 'launchCancel', token: 't-1' }]);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('facts for another dialog are dropped; a notice says why the dialog opened again', () => {
    act(() =>
      useUi
        .getState()
        .setLaunch(plan, 'The targets match other hosts now: check them, then Run again.'),
    );
    render(<LaunchDialog />);
    expect(screen.getByRole('alert').textContent).toMatch(/other hosts now/);
    act(() => useUi.getState().setLaunchFacts('old-token', undefined, 'nope'));
    expect(useUi.getState().launch?.facts?.count).toBe(4);
    act(() => useUi.getState().setLaunchFacts('t-1', undefined, 'No answer'));
    expect(screen.getByText('No answer')).toBeTruthy();
  });
});

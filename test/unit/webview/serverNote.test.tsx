// AFD-284: the flow changed on Ansible Flow Server's branch: the note says so, Show changes and
// Update ask the host to pull, Dismiss puts it away; a removed flow offers no pull.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ServerNote } from '../../../src/webview/panels/ServerNote';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ serverChange: null });
});
afterEach(cleanup);

describe('the server note (AFD-284)', () => {
  it('says who changed the flow; Show changes, Update and Dismiss', () => {
    act(() =>
      useUi.getState().setServerChange({
        commit: 'b'.repeat(40),
        text: 'Mia Ortega changed this flow on the server: 1 step.',
      }),
    );
    render(<ServerNote />);
    expect(screen.getByRole('status').textContent).toContain(
      'Mia Ortega changed this flow on the server: 1 step.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Update' }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(posted).toEqual([
      { type: 'serverUpdate', show: true },
      { type: 'serverUpdate', show: false },
      { type: 'serverDismiss' },
    ]);
  });

  it('a flow removed on the server offers no pull', () => {
    act(() =>
      useUi.getState().setServerChange({
        commit: 'b'.repeat(40),
        removed: true,
        text: 'Omar Haddad removed this flow on the server.',
      }),
    );
    render(<ServerNote />);
    expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });
});

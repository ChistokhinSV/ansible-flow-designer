// AFD-16: a *.flow.yaml that is not a flow names the Ansible Flow Designer and why the file opened
// here; an empty one offers to create a flow, one with content never does.
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Snapshot } from '../../../src/core/protocol';
import { NotAFlow } from '../../../src/webview/panels/NotAFlow';
import { posted } from './setup';

const base: Snapshot = {
  docVersion: 1,
  doc: null,
  stale: true,
  parseError: 'A flow document must be a YAML mapping',
  file: 'test.flow.yaml',
  findings: [],
  openPorts: [],
  autoPositions: {},
};

beforeEach(() => {
  posted.length = 0;
});
afterEach(cleanup);

describe('a file that is not a flow', () => {
  it('empty: names the designer and creates a flow in one click', () => {
    render(<NotAFlow snapshot={{ ...base, empty: true }} />);
    expect(screen.getByRole('heading', { name: /Ansible Flow Designer/ })).toBeTruthy();
    expect(document.body.textContent).toContain('*.flow.yaml');
    expect(document.body.textContent).toContain('test.flow.yaml is empty');
    fireEvent.click(screen.getByRole('button', { name: /Create a flow here/ }));
    expect(posted).toEqual([{ type: 'initFlow' }]);
  });

  it('with content: shows why it does not parse and only offers the text editor', () => {
    render(
      <NotAFlow
        snapshot={{ ...base, parseError: 'Flow sequence in block collection must end with a ]' }}
      />,
    );
    expect(screen.getByRole('heading', { name: /Ansible Flow Designer/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Create a flow here/ })).toBeNull();
    expect(document.querySelector('.afd-not-a-flow-error')?.textContent).toContain('end with a ]');
    fireEvent.click(screen.getByRole('button', { name: /Open in Text Editor/ }));
    expect(posted).toEqual([{ type: 'openText' }]);
  });
});

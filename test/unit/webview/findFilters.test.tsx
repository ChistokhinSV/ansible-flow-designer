// AFD-86: the Readiness counts list their steps with Find, and Find offers its filters.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FindBar } from '../../../src/webview/panels/FindBar';
import { FlowDescription } from '../../../src/webview/panels/FlowDescription';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/firewall-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;

beforeEach(() => {
  useUi.setState({ snapshot: null, find: false, findQuery: '' });
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
});
afterEach(cleanup);

describe('Find filters (AFD-86)', () => {
  it('a Readiness count opens Find with its filter, which lists those steps on every level', () => {
    render(<FlowDescription />);
    fireEvent.click(document.querySelector('[data-find-filter="status:specified"]') as HTMLElement);
    expect(useUi.getState().find).toBe(true);
    expect(useUi.getState().findQuery).toBe('status:specified');
    cleanup();
    render(<FindBar />);
    const found = Number(document.querySelector('[data-find]')?.getAttribute('data-find'));
    expect(found).toBeGreaterThan(3);
  });

  it('an empty Find offers the filters; typing one completes its values', () => {
    act(() => useUi.getState().openFind(true));
    render(<FindBar />);
    fireEvent.click(screen.getByRole('button', { name: 'type:approval' }));
    expect(useUi.getState().findQuery).toBe('type:approval ');
    act(() => useUi.getState().setFindQuery('stat'));
    expect(screen.getByRole('button', { name: 'status:' })).toBeTruthy();
  });

  it('the first offer is has:no-binding; the flow panel leads to the Flows view (AFD-89)', () => {
    act(() => useUi.getState().openFind(true));
    render(<FindBar />);
    const offers = [...document.querySelectorAll('.afd-find-hints button')].map(
      (b) => b.textContent,
    );
    expect(offers[0]).toBe('has:no-binding');
    // The syntax alone says little: each offer says what it lists.
    expect(screen.getByRole('button', { name: 'has:no-binding' }).getAttribute('title')).toBe(
      'Steps not implemented yet: no module, role or playbook',
    );
    cleanup();
    posted.length = 0;
    render(<FlowDescription />);
    fireEvent.click(screen.getByRole('button', { name: 'Flows View' }));
    expect(posted).toContainEqual({ type: 'showFlows' });
  });
});

describe("the workspace's flows in the flow panel; what a filter lists (AFD-93)", () => {
  it('Readiness says what the other flows need; a flow that needs a look is said at the top too', () => {
    act(() => useUi.getState().setRepo({ flows: 7, withErrors: 0, editedByHand: 0, outOfDate: 0 }));
    const { unmount } = render(<FlowDescription />);
    expect(document.querySelector('[data-flows-link]')?.textContent).toMatch(
      /^Other flows of this workspace have no problems: Flows View$/,
    );
    expect(document.querySelector('[data-repo-line]')).toBeNull();
    unmount();
    act(() => useUi.getState().setRepo({ flows: 7, withErrors: 1, editedByHand: 1, outOfDate: 0 }));
    render(<FlowDescription />);
    const top = document.querySelector('[data-repo-line]');
    expect(top?.textContent).toMatch(
      /^In this workspace: 1 flow with errors, 1 with code edited by hand: Flows View$/,
    );
    posted.length = 0;
    fireEvent.click(top?.querySelector('button') as HTMLElement);
    expect(posted).toContainEqual({ type: 'showFlows' });
    act(() => useUi.getState().setRepo(null));
  });

  it('a query of one filter says what its results are', () => {
    act(() => useUi.getState().openFind(true));
    act(() => useUi.getState().setFindQuery('type:approval'));
    render(<FindBar />);
    const n = Number(document.querySelector('[data-find]')?.getAttribute('data-find'));
    expect(document.querySelector('[data-find-summary]')?.textContent).toBe(
      `${n} approval${n === 1 ? '' : 's'}`,
    );
    act(() => useUi.getState().setFindQuery('type:approval backup'));
    expect(document.querySelector('[data-find-summary]')).toBeNull();
  });
});

describe('input descriptions in the flow panel (AFD-95)', () => {
  it('an input other than the targets list takes a description; the targets list does not', () => {
    render(<FlowDescription />);
    const boxes = [...document.querySelectorAll<HTMLInputElement>('[data-input-description]')];
    const names = boxes.map((b) => b.dataset.inputDescription);
    const targets = Object.entries(doc.flow.inputs ?? {}).find(([, f]) => f?.targets)?.[0];
    expect(names).not.toContain(targets);
    expect(names.length).toBeGreaterThan(0);
    posted.length = 0;
    const box = boxes[0] as HTMLInputElement;
    fireEvent.change(box, { target: { value: 'The release to install' } });
    fireEvent.blur(box);
    const sent = posted.find((m) => (m as { type: string }).type === 'command') as
      | { command: { kind: string; field: { description?: string } } }
      | undefined;
    expect(sent?.command).toMatchObject({
      kind: 'setContractField',
      field: { description: 'The release to install' },
    });
  });
});

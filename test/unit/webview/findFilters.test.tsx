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
});

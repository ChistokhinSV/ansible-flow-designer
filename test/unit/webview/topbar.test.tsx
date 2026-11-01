// AFD-18: a calmer top bar. Rarer actions live in the "…" menu, Run for real under Run as skeleton;
// every action is still one click away from the bar.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const items = () =>
  screen.getAllByRole('menuitem').map((b) => b.getAttribute('aria-label') ?? b.textContent);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, mode: 'design', level: 'root', cheatSheet: false, run: null });
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

describe('top bar', () => {
  it('Design: Run as Skeleton up front, Run for real in its menu, the rest under "…"', () => {
    render(<TopBar />);
    for (const gone of ['Tidy Up', 'Text', 'Check Flow', 'Run for real'])
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run as Skeleton/ }));
    expect(posted).toEqual([{ type: 'run', mode: 'check' }]);
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run for Real…' }));
    expect(posted.at(-1)).toEqual({ type: 'run', mode: 'real' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(items()).toEqual([
      'Tidy Up',
      'Open in Text Editor',
      'Export as draw.io Diagram…',
      'Export as Image…',
      'Check Flow',
      'Keyboard Shortcuts',
      'User Guide',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tidy Up' }));
    expect(posted.at(-1)).toEqual({ type: 'tidyUp', level: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard Shortcuts' }));
    expect(useUi.getState().cheatSheet).toBe(true);
    // AFD-22: the user guide opens on the host, in the Markdown preview.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'User Guide' }));
    expect(posted.at(-1)).toEqual({ type: 'openGuide' });
    // AFD-25: exports run on the host; images cover the open level.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as Image…' }));
    expect(posted.at(-1)).toEqual({ type: 'export', format: 'image', level: 'root' });
  });

  it('Code: Check Flow in "…" too (AFD-41); the menu button toggles', () => {
    act(() => useUi.getState().setMode('code'));
    render(<TopBar />);
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(items()).toEqual([
      'Tidy Up',
      'Open in Text Editor',
      'Export as draw.io Diagram…',
      'Export as Image…',
      'Check Flow',
      'Keyboard Shortcuts',
      'User Guide',
    ]);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('AFD-31: level chips say which subflow settings the steps inside really get', () => {
    const changed = parse(
      readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
    ) as FlowDocument;
    const sub = [...buildModel(changed).nodes.values()].find(
      (e) => e.node.type === 'subflow' && e.node.subflow?.nodes?.length,
    )?.node;
    if (!sub) throw new Error('no subflow');
    sub.settings = { inventory_target: 'controllers', become: true, serial: 2 };
    act(() =>
      useUi.getState().setSnapshot({
        docVersion: 2,
        doc: changed,
        stale: false,
        findings: [],
        openPorts: openFailPorts(buildModel(changed)),
        autoPositions: {},
      }),
    );
    act(() => useUi.getState().setLevel(sub.id));
    render(<TopBar />);
    const chips = [...document.querySelectorAll<HTMLElement>('.afd-context')].map((c) => [
      c.textContent,
      c.dataset.applied,
    ]);
    expect(chips).toEqual([
      ['inherits controllers', 'true'],
      ['become · not applied', 'false'],
      ['serial 2 · not applied', 'false'],
    ]);
  });
});

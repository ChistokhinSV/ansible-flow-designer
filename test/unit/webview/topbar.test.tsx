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
  it('Design: Run as skeleton up front, Run for real in its menu, the rest under "…"', () => {
    render(<TopBar />);
    for (const gone of ['Tidy up', 'Text', 'Validate design', 'Run for real'])
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /Run as skeleton/ }));
    expect(posted).toEqual([{ type: 'run', mode: 'check' }]);
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run for real…' }));
    expect(posted.at(-1)).toEqual({ type: 'run', mode: 'real' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(items()).toEqual([
      'Tidy up',
      'Show as text',
      'Export as draw.io…',
      'Export as image…',
      'Validate design',
      'Keyboard shortcuts',
      'User guide',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Tidy up' }));
    expect(posted.at(-1)).toEqual({ type: 'tidyUp', level: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Keyboard shortcuts' }));
    expect(useUi.getState().cheatSheet).toBe(true);
    // AFD-22: the user guide opens on the host, in the Markdown preview.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'User guide' }));
    expect(posted.at(-1)).toEqual({ type: 'openGuide' });
    // AFD-25: exports run on the host; images cover the open level.
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as image…' }));
    expect(posted.at(-1)).toEqual({ type: 'export', format: 'image', level: 'root' });
  });

  it('Implementation: no Validate design in "…"; the menu button toggles', () => {
    act(() => useUi.getState().setMode('implementation'));
    render(<TopBar />);
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(items()).toEqual([
      'Tidy up',
      'Show as text',
      'Export as draw.io…',
      'Export as image…',
      'Keyboard shortcuts',
      'User guide',
    ]);
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });
});

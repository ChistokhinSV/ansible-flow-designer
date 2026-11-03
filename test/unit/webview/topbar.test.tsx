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
  it('one toolbar in every mode: Run, Generate Code, "…" (AFD-45, AFD-72)', () => {
    const bar = () =>
      [...document.querySelectorAll('.afd-actions > button, .afd-actions > .afd-split > button')]
        .map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim())
        .filter(Boolean);
    const seen: string[][] = [];
    for (const mode of ['design', 'code', 'run'] as const) {
      act(() => useUi.getState().setMode(mode));
      render(<TopBar />);
      seen.push(bar() as string[]);
      cleanup();
    }
    // AFD-72: Stop is the Run button while a run goes; Export is in "…".
    expect(seen[0]).toEqual([
      'Run as Skeleton',
      'More run options',
      'Generate Code',
      'More actions',
    ]);
    expect(seen[1]).toEqual(seen[0]);
    expect(seen[2]).toEqual(seen[0]);
  });

  it('modes and lenses say what they are for (AFD-71)', () => {
    render(<TopBar />);
    const mode = (name: string) => screen.getByRole('button', { name }).getAttribute('title');
    expect(mode('Design')).toMatch(/^Draw the flow: .* \((Alt\+|⌥)1\)$/);
    expect(mode('Code')).toMatch(/^What each step runs/);
    expect(mode('Run')).toMatch(/^The last run on the canvas/);
    fireEvent.click(screen.getByRole('button', { name: /^Lens/ }));
    const lens = (name: string) =>
      screen.getByRole('menuitemradio', { name }).getAttribute('title') ??
      screen.getByRole('menuitemradio', { name }).closest('[title]')?.getAttribute('title');
    expect(lens('Inventory')).toBe('Which hosts each step runs on, counted in your inventory');
    expect(lens('Changes')).toMatch(/^What changed since another version/);
  });

  it('runs, exports and the "…" menu; what cannot run says why', () => {
    act(() => useUi.getState().setMode('design'));
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: /Run as Skeleton/ }));
    expect(posted).toEqual([{ type: 'run', mode: 'check' }]);
    fireEvent.click(screen.getByRole('button', { name: 'More run options' }));
    expect(items()).toEqual(['Run for Real…', 'Run Scenarios', 'Launch in AWX']);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Run for Real…' }));
    expect(posted.at(-1)).toEqual({ type: 'run', mode: 'real' });
    // No Stop with no run going (AFD-72: the Run button becomes Stop while one goes).
    expect(screen.queryByRole('button', { name: /^Stop$/ })).toBeNull();
    posted.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Generate Code/ }));
    expect(posted).toEqual([{ type: 'generate' }]);
    // AFD-25: exports run on the host; images cover the open level. AFD-72: in "…".
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Export as Image…' }));
    expect(posted.at(-1)).toEqual({ type: 'export', format: 'image', level: 'root' });
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(items()).toEqual([
      'Tidy Up',
      'Open in Text Editor',
      'Check Flow',
      'Find Node…',
      'Export as draw.io Diagram…',
      'Export as Image…',
      // The palette and the side panel fold away for room (AFD-48).
      'Collapse Palette',
      'Hide Side Panel',
      'Hide Annotations',
      // AFD-73: the first-flow checklist comes back from here once hidden.
      'Hide First-Flow Checklist',
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
  });

  it('Code mode: Tidy Up says the graph is read-only; the menu button toggles', () => {
    act(() => useUi.getState().setMode('code'));
    render(<TopBar />);
    const more = screen.getByRole('button', { name: 'More actions' });
    fireEvent.click(more);
    expect(more.getAttribute('aria-expanded')).toBe('true');
    const tidy = screen.getByRole('menuitem', { name: /Tidy Up/ });
    expect(tidy.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(more);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('AFD-31, AFD-52: level chips say which subflow settings the steps inside really get', () => {
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
    // Format 1: become stays on the subflow's own play; serial is per node, so no chip (AFD-52).
    expect(chips).toEqual([
      ['inherits controllers', 'true'],
      ['become · not applied', 'false'],
    ]);
    // Format 2: become (and whom) reaches the steps inside.
    sub.settings = { become: true, become_user: 'netops' };
    act(() =>
      useUi.getState().setSnapshot({
        docVersion: 3,
        doc: { ...changed, schema_version: 2 },
        stale: false,
        findings: [],
        openPorts: openFailPorts(buildModel(changed)),
        autoPositions: {},
      }),
    );
    expect(
      [...document.querySelectorAll<HTMLElement>('.afd-context')].map((c) => [
        c.textContent,
        c.dataset.applied,
      ]),
    ).toEqual([['become netops', 'true']]);
  });
});

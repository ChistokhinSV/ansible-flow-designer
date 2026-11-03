// AFD-48: navigation and onboarding. Ctrl+F finds a node on any level and shows it, the box
// staying open; the run panel's failed steps open where they are; the palette folds to icons, the
// legend opens from "?", the side panel folds to a strip; a level with only Start and End offers a
// way to begin.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { App } from '../../../src/webview/App';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const os = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(os);
const inner = [...model.nodes.values()].find((e) => e.level !== ROOT && e.node.type === 'task');
if (!inner) throw new Error('the sample has no step inside a subflow');
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(el, { key: k, ...init });
  });

function show(doc: FlowDocument) {
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: Date.now(),
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    contextMenu: null,
    portMenu: null,
    quickAdd: null,
    pick: null,
    find: false,
    findQuery: '',
    centerOn: null,
    paletteCollapsed: false,
    panelCollapsed: false,
    pendingBinding: null,
    leave: null,
    run: null,
    runNodes: null,
    mode: 'design',
    level: ROOT,
    testMode: true,
  });
  show(os);
});
afterEach(cleanup);

describe('find', () => {
  it('Ctrl+F finds a step inside a subflow and shows it there; the box stays open', async () => {
    render(<App />);
    key(document.body, 'f', { ctrlKey: true });
    await settle();
    const box = screen.getByRole('combobox', { name: 'Find a node' });
    expect(document.activeElement).toBe(box);
    fireEvent.change(box, { target: { value: inner.node.title } });
    const option = document.querySelector(`[data-found="${inner.node.id}"]`) as HTMLElement;
    expect(option.textContent).toContain(model.nodes.get(inner.level)?.node.title);
    // The first result is the active one; arrows move, Enter shows it, opening its level.
    const index = [...document.querySelectorAll('[data-found]')].indexOf(option);
    for (let i = 0; i < index; i++) key(box, 'ArrowDown');
    // The canvas brings the node to the middle once its level is drawn (and clears the request).
    const centered: (string | null)[] = [];
    const off = useUi.subscribe((st) => centered.push(st.centerOn));
    key(box, 'Enter');
    off();
    expect(useUi.getState().level).toBe(inner.level);
    expect(useUi.getState().selection).toEqual({ node: inner.node.id });
    expect(centered).toContain(inner.node.id);
    await settle();
    // The canvas is new on that level; the box came back with what was typed, focused.
    const again = screen.getByRole('combobox', { name: 'Find a node' }) as HTMLInputElement;
    expect(again.value).toBe(inner.node.title);
    expect(document.activeElement).toBe(again);
    key(again, 'Escape');
    expect(useUi.getState().find).toBe(false);
  });

  it('Ctrl+F works from a field, and Find Node… is in the canvas menu', async () => {
    render(<App />);
    const field = screen.getByLabelText('Name');
    act(() => field.focus());
    key(field, 'f', { ctrlKey: true });
    expect(useUi.getState().find).toBe(true);
    act(() => useUi.getState().openFind(false));
    act(() => useUi.getState().openContextMenu({ target: { kind: 'pane' }, x: 10, y: 10 }));
    fireEvent.click(screen.getByRole('menuitem', { name: /Find Node/ }));
    expect(useUi.getState().find).toBe(true);
  });
});

describe('failed steps in the run panel', () => {
  it('lists the steps where hosts failed, on any level, and shows one where it is', () => {
    const run: RunView = {
      id: 'r1',
      mode: 'check',
      state: 'done',
      rc: 2,
      startedAt: '2026-10-31T08:00:00Z',
      finishedAt: '2026-10-31T08:01:00Z',
      source: 'local',
      flowVersion: os.flow.version,
    };
    render(<App />);
    act(() =>
      useUi.setState({
        mode: 'run',
        run,
        runNodes: { [inner.node.id]: { state: 'failed', hosts: 3, failed: 1 } },
      }),
    );
    const list = document.querySelector('[data-failed-steps]') as HTMLElement;
    expect(list.textContent).toContain('1 of 3 hosts failed');
    fireEvent.click(within(list).getByRole('button', { name: inner.node.title }));
    expect(useUi.getState().level).toBe(inner.level);
    expect(useUi.getState().selection).toEqual({ node: inner.node.id });
  });
});

describe('side panels', () => {
  it('the palette folds to named icons; the legend opens from "?" and Escape closes it', () => {
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Collapse Palette' }));
    expect(useUi.getState().paletteCollapsed).toBe(true);
    const palette = screen.getByRole('complementary', { name: 'Palette' });
    expect(within(palette).getByRole('button', { name: 'Task' }).textContent).toBe('');
    const legend = within(palette).getByRole('button', { name: 'Legend' });
    act(() => legend.focus());
    fireEvent.click(legend);
    expect(screen.getByRole('dialog', { name: 'Legend' }).textContent).toContain('Problem path');
    key(screen.getByRole('dialog', { name: 'Legend' }), 'Escape');
    expect(screen.queryByRole('dialog', { name: 'Legend' })).toBeNull();
    expect(document.activeElement).toBe(legend);
    fireEvent.click(within(palette).getByRole('button', { name: 'Expand Palette' }));
    expect(useUi.getState().paletteCollapsed).toBe(false);
  });

  it('the side panel folds to a strip (Enter on its edge or the "…" menu) and comes back', () => {
    render(<App />);
    const edge = screen.getByRole('separator', { name: 'Resize the side panel' });
    key(edge, 'Enter');
    expect(useUi.getState().panelCollapsed).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Show Side Panel' }));
    expect(useUi.getState().panelCollapsed).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide Side Panel' }));
    expect(useUi.getState().panelCollapsed).toBe(true);
  });
});

describe('a level with only Start and End', () => {
  const empty = parse(newFlowText('Edge checks', 'edge-checks', createIdFactory())) as FlowDocument;

  it('offers the first step on the Start to End wire, or an import or a sample', () => {
    show(empty);
    render(<App />);
    const card = screen.getByRole('region', { name: 'Start this level' });
    fireEvent.click(within(card).getByRole('button', { name: /Add a Step/ }));
    const wire = empty.edges?.[0];
    expect(useUi.getState().quickAdd).toMatchObject({ type: 'task', insertOn: wire?.id });
    act(() => useUi.getState().openQuickAdd(null));
    fireEvent.click(within(card).getByRole('button', { name: 'Import Ansible Playbooks…' }));
    fireEvent.click(within(card).getByRole('button', { name: /Import AWX Workflow/ }));
    fireEvent.click(within(card).getByRole('button', { name: 'Open Sample Flow…' }));
    expect(posted.filter((m) => (m as { type: string }).type === 'startFrom')).toEqual([
      { type: 'startFrom', what: 'playbooks' },
      { type: 'startFrom', what: 'awx' },
      { type: 'startFrom', what: 'sample' },
    ]);
  });

  it('a calmer first screen: the basics, the rest folded, nothing about failures yet (AFD-72)', () => {
    show(empty);
    render(<App />);
    const palette = screen.getByRole('complementary', { name: 'Palette' });
    const first = within(palette)
      .getAllByRole('button')
      .map((b) => b.textContent?.trim())
      .filter(Boolean);
    expect(first.slice(0, 4)).toEqual(['Task', 'Subflow', 'Decision', 'Approval']);
    const more = palette.querySelector('details[data-fold="palette-more"]') as HTMLDetailsElement;
    expect(more.open).toBe(false);
    expect(more.textContent).toMatch(/^More node types.*Parallel.*Join.*Start.*End/);
    // No step can fail yet: no patterns, no readiness, no lens.
    expect(within(palette).queryByText('Failure patterns')).toBeNull();
    expect(screen.queryByText('Readiness')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Lens/ })).toBeNull();
    // The flow's details are folded, with what they hold in the summary.
    const details = document.querySelector(
      'details[data-fold="flow-details"]',
    ) as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(details.querySelector('summary')?.textContent).toBe(
      'More details: edge-checks · version 1',
    );
    expect(screen.getByText(/What the flow asks for when it runs/)).toBeTruthy();
  });

  it('is not there in Code mode, nor once the level has a step', () => {
    show(empty);
    render(<App />);
    act(() => useUi.getState().setMode('code'));
    expect(screen.queryByRole('region', { name: 'Start this level' })).toBeNull();
    act(() => useUi.getState().setMode('design'));
    show(os);
    expect(screen.queryByRole('region', { name: 'Start this level' })).toBeNull();
  });
});

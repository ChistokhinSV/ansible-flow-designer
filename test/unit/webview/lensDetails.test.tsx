// AFD-87 (wave 8 group F): lens findings in a step's Details, a finding that names its subflow, the
// lens tab moving on after a fix, and its scroll kept while a step is checked (round 1: P19, W14).
// AFD-91: the place lines no longer come and go with the level, and a nested step lights its subflow.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { InventoryFacts } from '../../../src/core/lens/types';
import { namesPlaces, placeOf, shownOn } from '../../../src/core/view/find';
import { App } from '../../../src/webview/App';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { Details } from '../../../src/webview/details/Details';
import { domSummary } from '../../../src/webview/inspect';
import { LensBrowser, LensPanel } from '../../../src/webview/panels/LensPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../fixtures/lens/flows/lens-e2e/lens-e2e.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const facts: InventoryFacts = {
  sources: ['test/fixtures/lens/inventory/hosts.yml'],
  dynamic: [],
  total: 9,
  targets: 'edge_switches',
  patterns: {
    edge_switches: { count: 6, outside: 0, sample: [] },
    'edge_switches,core_spines': { count: 8, outside: 2, sample: ['core-sp-01'] },
    core_spines: { count: 2, outside: 2, sample: ['core-sp-01'] },
    all: { count: 9, outside: 3, sample: ['mgmt-01'] },
  },
  scope: { count: 9, groups: { core_spines: 2, dc_prod: 2, edge_switches: 6 } },
  prod_groups: ['dc_prod'],
  access: {},
  vaulted: {},
};
const commands = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'command')
    .map((m) => (m as { command: FlowCommand }).command);
const inventory = () =>
  act(() => {
    useUi.getState().setLens('inventory');
    useUi
      .getState()
      .setLensFacts({ inventory: { state: 'ready', facts, targets: 'edge_switches' } });
  });

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    mode: 'design',
    run: null,
    lens: null,
    lensFacts: {},
    lensView: null,
    lensTab: false,
    lensScroll: 0,
    highlight: null,
    accept: null,
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
  });
});
afterEach(cleanup);

describe('Lens findings in Details (AFD-87)', () => {
  it("a step's Details list its lens findings in an open fold, under their own hook", () => {
    inventory();
    render(<Details id={id('rollback')} />);
    const fold = document.querySelector<HTMLDetailsElement>('[data-fold="lens-inventory"]');
    expect(fold?.open).toBe(true);
    expect(fold?.querySelector('summary')?.textContent).toBe('Lens: Inventory · 1 on this step');
    const row = fold?.querySelector(
      `[data-node-finding="inventory:broad-target:${id('rollback')}"]`,
    );
    expect(row).toBeTruthy();
    // inspect counts the lens tab's findings only: a step's copy is not a second finding.
    expect(domSummary(1).lens?.findings).toEqual([]);
    fireEvent.click(row?.querySelector('button') as HTMLElement);
    expect(commands().at(-1)).toEqual({
      kind: 'updateNode',
      id: id('rollback'),
      patch: { settings: { inventory_target: null } },
    });
  });

  it('a step with no lens finding shows no fold', () => {
    inventory();
    render(<Details id={id('upgrade')} />);
    expect(document.querySelector('[data-fold^="lens-"]')).toBeNull();
  });

  it('after a fix the lens tab moves on: the next open finding has the focus and the light', async () => {
    inventory();
    render(<LensPanel />);
    const rows = [...document.querySelectorAll<HTMLElement>('[data-finding]')];
    const [first, second] = rows;
    expect(rows.length).toBeGreaterThan(1);
    fireEvent.focus(first as HTMLElement);
    fireEvent.click(first?.querySelector('button') as HTMLElement);
    expect(first?.dataset.finding).toBe(`inventory:broad-target:${id('rollback')}`);
    // The host's answer: the button waits for it before moving on.
    await act(async () => {
      for (const m of posted as { type: string; reqId?: number }[])
        if (m.type === 'command')
          window.dispatchEvent(
            new MessageEvent('message', { data: { type: 'ack', reqId: m.reqId, ok: true } }),
          );
    });
    expect(second?.contains(document.activeElement)).toBe(true);
    expect(useUi.getState().highlight).not.toContain(id('rollback'));
  });

  it("the lens tab keeps its scroll while a step's Details are checked", () => {
    inventory();
    act(() => useUi.getState().showLensTab(true));
    render(<App />);
    const aside = document.querySelector<HTMLElement>('.afd-right') as HTMLElement;
    aside.scrollTop = 240;
    fireEvent.scroll(aside);
    act(() => useUi.getState().select({ node: id('upgrade') }));
    expect(useUi.getState().lensTab).toBe(false);
    aside.scrollTop = 0;
    act(() => useUi.getState().showLensTab(true));
    expect(aside.scrollTop).toBe(240);
    expect(screen.getByRole('tab', { name: /Lens: Inventory/ }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });
});

describe('places that stay put (AFD-87, AFD-91)', () => {
  const SUB = '01JD00000000000000000000AB';
  const INNER = '01JD00000000000000000000CD';
  const nested = {
    ...doc,
    nodes: [
      ...doc.nodes.filter((n) => n.key !== 'drain'),
      {
        id: SUB,
        key: 'drain',
        type: 'subflow',
        title: 'Drain the switch',
        subflow: {
          nodes: [
            {
              id: INNER,
              key: 'inner',
              type: 'task',
              title: 'Check BGP',
              settings: { become: true },
            },
          ],
        },
      },
    ],
  } as unknown as FlowDocument;
  const model = buildModel(nested);
  const show = () =>
    act(() => {
      useUi.getState().setSnapshot({
        docVersion: 2,
        doc: nested,
        stale: false,
        findings: [],
        openPorts: openFailPorts(model),
        autoPositions: {},
      });
      useUi.getState().setLens('access');
    });

  it("a step's place reads the same on every level; a list of top-level rows names none", () => {
    expect(placeOf(model, INNER)).toBe('in Drain the switch');
    expect(placeOf(model, id('rollback'))).toBe('on the top level');
    expect(namesPlaces(model, [[id('rollback')], [id('upgrade')]])).toBe(false);
    expect(namesPlaces(model, [[id('rollback')], [INNER]])).toBe(true);
    // A row about several steps has no place of its own.
    expect(namesPlaces(model, [[id('rollback'), INNER]])).toBe(false);
  });

  it('a step inside a subflow stands for that subflow above it, for nothing beside it', () => {
    expect(shownOn(model, [INNER], 'root')).toEqual([SUB]);
    expect(shownOn(model, [INNER], SUB)).toEqual([INNER]);
    expect(shownOn(model, [id('rollback')], SUB)).toEqual([]);
  });

  it("a row's click opens its step's level without moving the rows (round 2: S10)", () => {
    show();
    render(<LensBrowser />);
    const lines = () =>
      [...document.querySelectorAll('[data-lens-item^="become:"]')].map(
        (li) => li.querySelector('[data-finding-place]')?.textContent ?? null,
      );
    const before = lines();
    expect(before).toEqual(['on the top level', 'in Drain the switch']);
    fireEvent.click(
      document.querySelector(`[data-lens-item="become:${INNER}"] button`) as HTMLElement,
    );
    expect(useUi.getState().level).toBe(SUB);
    expect(lines()).toEqual(before);
  });

  it('hovering a row for a step inside a subflow lights the subflow (round 2: S11)', () => {
    show();
    render(
      <ReactFlowProvider>
        <div style={{ width: 1600, height: 900 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    render(<LensBrowser />);
    fireEvent.mouseEnter(
      document.querySelector(`[data-lens-item="become:${INNER}"]`) as HTMLElement,
    );
    const lit = [...document.querySelectorAll<HTMLElement>('.afd-node.lens-hit')].map(
      (n) => n.dataset.nodeId,
    );
    expect(lit).toEqual([SUB]);
    expect(document.querySelectorAll('.afd-node.lens-dim').length).toBeGreaterThan(0);
  });
});

// AFD-106 (round 3: R10): keeping a step the Access lens flags never asked for a reason.
describe('keeping a flagged become asks for a reason (AFD-106)', () => {
  it("the step's Privilege fold says so with the lens off, and opens Accept with Reason", () => {
    act(() => useUi.getState().openDetails(id('upgrade'), 'execution'));
    render(<Details id={id('upgrade')} />);
    const note = document.querySelector('[data-become-flagged]');
    expect(note?.textContent).toMatch(/^The Access lens flags this step's Become/);
    fireEvent.click(
      within(note as HTMLElement).getByRole('button', { name: 'Accept with Reason…' }),
    );
    expect(useUi.getState().accept).toEqual({
      id: `access:become:${id('upgrade')}`,
      node: id('upgrade'),
      title: 'Upgrade OS escalates privileges, unlike its neighbours',
    });
  });

  it('the finding puts Accept with Reason before its fix, and says why', () => {
    act(() => useUi.getState().setLens('access'));
    render(<Details id={id('upgrade')} />);
    const row = document.querySelector(`[data-node-finding="access:become:${id('upgrade')}"]`);
    expect(row?.textContent).toMatch(/Needs root\? Accept it with a reason, so others know why\./);
    const buttons = [...(row?.querySelectorAll('.afd-finding-actions button') ?? [])].map(
      (b) => b.textContent,
    );
    expect(buttons).toEqual(['Accept with Reason…', 'Remove Become']);
  });
});

// AFD-87 (wave 8 group F): lens findings in a step's Details, a finding that names its subflow, the
// lens tab moving on after a fix, and its scroll kept while a step is checked (round 1: P19, W14).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { InventoryFacts } from '../../../src/core/lens/types';
import { placeOf } from '../../../src/core/view/find';
import { App } from '../../../src/webview/App';
import { Details } from '../../../src/webview/details/Details';
import { domSummary } from '../../../src/webview/inspect';
import { LensPanel } from '../../../src/webview/panels/LensPanel';
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

describe('placeOf (AFD-87)', () => {
  const nested = {
    ...doc,
    nodes: [
      ...doc.nodes.filter((n) => n.key !== 'drain'),
      {
        id: '01JD00000000000000000000AB',
        key: 'drain',
        type: 'subflow',
        title: 'Drain the switch',
        subflow: {
          nodes: [
            { id: '01JD00000000000000000000CD', key: 'inner', type: 'task', title: 'Check BGP' },
          ],
        },
      },
    ],
  } as unknown as FlowDocument;
  const model = buildModel(nested);
  it('names the subflows around a step that is not on the level on screen', () => {
    expect(placeOf(model, '01JD00000000000000000000CD', 'root')).toBe('in Drain the switch');
    expect(placeOf(model, '01JD00000000000000000000CD', '01JD00000000000000000000AB')).toBe(
      undefined,
    );
    expect(placeOf(model, id('rollback'), '01JD00000000000000000000AB')).toBe('on the top level');
    expect(placeOf(model, id('rollback'), 'root')).toBe(undefined);
  });
});

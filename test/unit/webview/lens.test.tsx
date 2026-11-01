// M8 (AFD-13): lenses on the canvas and in the side panels (mockups 08, 09): the toggle asks the
// host for facts, chips swap without moving nodes, hovering a panel row highlights its nodes,
// findings fix or accept in one command, data wires appear, and a selected node opens its card.
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
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { AcceptDialog, LensBrowser, LensPanel } from '../../../src/webview/panels/LensPanel';
import { TopBar } from '../../../src/webview/panels/TopBar';
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
const messages = (type: string) => posted.filter((m) => (m as { type: string }).type === type);
const commands = () => messages('command').map((m) => (m as { command: FlowCommand }).command);
const canvas = () =>
  render(
    <ReactFlowProvider>
      <div style={{ width: 1600, height: 900 }}>
        <FlowCanvas cull={false} />
      </div>
    </ReactFlowProvider>,
  );
const chips = (key: string) =>
  document
    .querySelector<HTMLElement>(`[data-node-id="${id(key)}"] [data-lens-chips]`)
    ?.dataset.lensChips?.split('|');
const positions = () =>
  [...document.querySelectorAll<HTMLElement>('.react-flow__node')].map((n) => n.style.transform);

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'design',
    run: null,
    lens: null,
    lensFacts: {},
    lensView: null,
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

describe('Lenses (M8)', () => {
  it('the lens dropdown picks a lens and asks the host for its facts; ✕ clears it', () => {
    render(<TopBar />);
    fireEvent.click(screen.getByRole('button', { name: 'Lens: none' }));
    expect(
      screen
        .getAllByRole('menuitemradio')
        .map((b) => [b.textContent, b.getAttribute('aria-checked')]),
    ).toEqual([
      ['None', 'true'],
      ['Inventory', 'false'],
      ['Data', 'false'],
      ['Code', 'false'],
      ['Access', 'false'],
      ['Timing', 'false'],
    ]);
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Inventory' }));
    expect(useUi.getState().lens).toBe('inventory');
    expect(messages('lens').at(-1)).toEqual({ type: 'lens', lens: 'inventory' });
    expect(screen.queryByRole('menu')).toBeNull();
    expect(screen.getByRole('button', { name: 'Lens: Inventory' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Clear lens' }));
    expect(useUi.getState().lens).toBeNull();
  });

  it('chips swap per lens, nodes stay where they are, None restores the design chips', () => {
    canvas();
    const before = positions();
    expect(chips('drain')).toBeUndefined();
    act(() => {
      useUi.getState().setLens('inventory');
      useUi
        .getState()
        .setLensFacts({ inventory: { state: 'ready', facts, targets: 'edge_switches' } });
    });
    expect(chips('drain')).toEqual(['edge_switches · 6', '+ core_spines · 2']);
    expect(chips('start')).toEqual(['edge_switches · 6']);
    act(() => useUi.getState().setLens('data'));
    expect(chips('precheck')).toEqual(['in: devices', 'out: report']);
    // jsdom does not measure handles, so React Flow draws no edges here (integration counts them).
    expect(document.querySelectorAll('.afd-data-handle').length).toBe(2 * doc.nodes.length);
    expect(useUi.getState().lensView?.dataWires?.map((w) => w.label)).toEqual([
      'devices',
      'devices',
    ]);
    act(() => useUi.getState().setLens('timing'));
    expect(chips('upgrade')).toEqual(['timeout 20m']);
    expect(positions()).toEqual(before);
    act(() => useUi.getState().setLens(null));
    expect(chips('drain')).toBeUndefined();
    expect(document.querySelectorAll('.afd-data-handle').length).toBe(0);
  });

  it('hovering a group highlights exactly its nodes and dims the rest', () => {
    act(() => {
      useUi.getState().setLens('inventory');
      useUi
        .getState()
        .setLensFacts({ inventory: { state: 'ready', facts, targets: 'edge_switches' } });
    });
    canvas();
    render(<LensBrowser />);
    const row = document.querySelector('[data-lens-item="group:core_spines"]') as HTMLElement;
    fireEvent.mouseEnter(row);
    const lit = [...document.querySelectorAll<HTMLElement>('.afd-node.lens-hit')].map(
      (n) => n.dataset.nodeId,
    );
    expect(lit).toEqual([id('drain')]);
    expect(document.querySelectorAll('.afd-node.lens-dim').length).toBe(doc.nodes.length - 1);
    fireEvent.mouseLeave(row);
    expect(document.querySelectorAll('.afd-node.lens-dim').length).toBe(0);
  });

  it('a fix is one command; Accept with Reason… asks for a reason, then sends acceptFinding', () => {
    act(() => {
      useUi.getState().setLens('inventory');
      useUi
        .getState()
        .setLensFacts({ inventory: { state: 'ready', facts, targets: 'edge_switches' } });
    });
    render(
      <>
        <LensPanel />
        <AcceptDialog />
      </>,
    );
    const broad = document.querySelector(
      `[data-finding="inventory:broad-target:${id('rollback')}"]`,
    ) as HTMLElement;
    fireEvent.click(broad.querySelector('button') as HTMLElement);
    expect(commands().at(-1)).toEqual({
      kind: 'updateNode',
      id: id('rollback'),
      patch: { settings: { inventory_target: null } },
    });
    const spines = document.querySelector(
      '[data-finding="inventory:group-not-input:core_spines"]',
    ) as HTMLElement;
    fireEvent.click(
      [...spines.querySelectorAll('button')].find(
        (b) => b.textContent === 'Accept with Reason…',
      ) as HTMLElement,
    );
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), {
      target: { value: 'Spines drain by design' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));
    expect(commands().at(-1)).toEqual({
      kind: 'acceptFinding',
      finding: 'inventory:group-not-input:core_spines',
      reason: 'Spines drain by design',
    });
  });

  it('a selected node opens its summary card (D-19)', () => {
    act(() => {
      useUi
        .getState()
        .setLensFacts({ inventory: { state: 'ready', facts, targets: 'edge_switches' } });
      useUi.getState().select({ node: id('upgrade') });
    });
    canvas();
    const card = document.querySelector(`[data-summary-card="${id('upgrade')}"]`) as HTMLElement;
    expect(card).toBeTruthy();
    const rows = [...card.querySelectorAll('dt')].map(
      (dt) => `${dt.textContent}: ${dt.nextElementSibling?.textContent}`,
    );
    expect(rows).toContain('hosts: edge_switches · 6');
    expect(rows).toContain('credential: netops-admin');
    expect(card.textContent).toContain('Details');
  });
});

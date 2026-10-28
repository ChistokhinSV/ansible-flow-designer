import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { codePreview } from '../../../src/core/engine/preview';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { defaultPortNames, legalPorts } from '../../../src/core/flow/ports';
import { type FlowDocument, NODE_TYPES } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { Banner } from '../../../src/webview/panels/Banner';
import { DecisionDialog } from '../../../src/webview/panels/DecisionDialog';
import { Inspector } from '../../../src/webview/panels/Inspector';
import { PortMenu } from '../../../src/webview/panels/PortMenu';
import { TopBar } from '../../../src/webview/panels/TopBar';
import { useUi } from '../../../src/webview/store';
import { levelView } from '../../../src/webview/viewModel';
import { posted } from './setup';

const example = (name: string) =>
  parse(readFileSync(join(__dirname, '../../../examples', name), 'utf8')) as FlowDocument;

function snapshotOf(doc: FlowDocument, version = 1): Snapshot {
  return {
    docVersion: version,
    doc,
    stale: false,
    findings: [],
    openPorts: openFailPorts(buildModel(doc)),
    autoPositions: {},
  };
}

function show(snapshot: Snapshot) {
  act(() => useUi.getState().setSnapshot(snapshot));
}

beforeEach(() => {
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    quickAdd: null,
    bannerDismissedAt: null,
  });
});
afterEach(cleanup);

describe('canvas renders the port catalog (check 3)', () => {
  it('a node of each type has exactly its default ports enabled; all legal ports are rendered', () => {
    const ids = NODE_TYPES.map((_, i) => `01JC0000000000000000000${String(i).padStart(3, '0')}`);
    const doc: FlowDocument = {
      schema_version: 1,
      flow: { id: '01JC000000000000000000FLOW', key: 'all-types', name: 'All types', version: 1 },
      nodes: NODE_TYPES.map((type, i) => ({
        id: ids[i] as string,
        key: `n-${i}`,
        type,
        title: type,
      })),
      edges: [],
      layout: Object.fromEntries(
        ids.map((id, i) => [id, { x: (i % 4) * 260, y: Math.floor(i / 4) * 140 }]),
      ),
    };
    render(
      <ReactFlowProvider>
        <div style={{ width: 1200, height: 800 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    show(snapshotOf(doc));
    NODE_TYPES.forEach((type, i) => {
      const el = document.querySelector(`[data-node-id="${ids[i]}"]`);
      expect(el, type).not.toBeNull();
      const handles = [...(el?.querySelectorAll<HTMLElement>('[data-port]') ?? [])];
      const enabled = handles.filter((p) => p.dataset.portState !== 'available');
      expect(enabled.map((p) => p.dataset.port).sort(), type).toEqual(
        defaultPortNames({ type }).sort(),
      );
      expect(
        handles.map((p) => p.dataset.port),
        type,
      ).toEqual(legalPorts({ type }).map((p) => p.name));
      // D-14 at rest: with no wires, only open fail ports show.
      const rest = handles.filter((p) => p.dataset.rest === 'true').map((p) => p.dataset.port);
      expect(rest, type).toEqual(
        legalPorts({ type })
          .filter((p) => p.enabled && p.fail && p.direction === 'out')
          .map((p) => p.name),
      );
    });
  });

  it('renders the edge-baseline example: 8 nodes, 7 edges, open-port states', () => {
    render(
      <ReactFlowProvider>
        <FlowCanvas cull={false} />
      </ReactFlowProvider>,
    );
    show(snapshotOf(example('edge-baseline.flow.yaml')));
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(8);
    const precheck = document.querySelector('[data-node-id="01JBQKFBF5KZNWJ47TAN9ZT24M"]');
    expect(precheck?.querySelector('[data-port="failed_hosts"]')?.className).toContain(
      'state-open-fail',
    );
    const backup = document.querySelector('[data-node-id="01JBNPZX45HY43KWJRP1XPA7Z3"]');
    expect(backup?.querySelector('[data-port="failed_hosts"]')?.className).toContain(
      'state-open-purpose',
    );
    const push = document.querySelector('[data-node-id="01JBDJ8FSSZ5AWSH8VHTPRE95B"]');
    expect(push?.querySelector('[data-port="failed_hosts"]')?.className).toContain(
      'state-connected',
    );
  });
});

describe('view model', () => {
  it('projects edges with tone and problem styling', () => {
    const view = levelView(snapshotOf(example('edge-baseline.flow.yaml')));
    expect(view.nodes).toHaveLength(8);
    expect(view.edges).toHaveLength(7);
    const failed = view.edges.find((e) => e.sourcePort === 'failed_hosts');
    expect(failed).toMatchObject({ tone: 'failed', problem: true });
    expect(view.edges.find((e) => e.sourcePort === 'ok_hosts')).toMatchObject({
      tone: 'ok',
      problem: false,
    });
  });

  it('places ports by slot over every legal port, so they never shift (mockup 07)', () => {
    const doc = example('os-upgrade.flow.yaml');
    const view = levelView(snapshotOf(doc));
    const upgrade = view.nodes.find((n) => n.node.key === 'upgrade-os');
    const right = upgrade?.ports.filter((p) => p.side === 'right');
    expect(right?.map((p) => [p.name, p.offset])).toEqual([
      ['failed_hosts', 0.2],
      ['unreachable', 0.4],
      ['timeout', 0.6],
      ['cancelled', 0.8],
    ]);
    const bottom = upgrade?.ports.filter((p) => p.side === 'bottom').map((p) => p.name);
    expect(bottom).toEqual(['always', 'ok_hosts', 'unchanged']);
    expect(upgrade?.ports.find((p) => p.name === 'timeout')?.state).toBe('available');
  });

  it('at rest shows connected, open-fail and open-on-purpose ports only (D-14)', () => {
    const view = levelView(snapshotOf(example('edge-baseline.flow.yaml')));
    const rest = (key: string) =>
      view.nodes
        .find((n) => n.node.key === key)
        ?.ports.filter((p) => p.rest)
        .map((p) => `${p.name}:${p.state}`);
    expect(rest('precheck')).toEqual([
      'in:connected',
      'ok_hosts:connected',
      'failed_hosts:open-fail',
    ]);
    expect(rest('backup-config')).toEqual([
      'in:connected',
      'ok_hosts:connected',
      'failed_hosts:open-purpose',
    ]);
    expect(rest('done')).toEqual(['in:connected']);
  });

  it('prefers optimistic, then stored, then auto positions', () => {
    const doc = example('edge-baseline.flow.yaml');
    const snap = {
      ...snapshotOf(doc),
      autoPositions: { '01JB3E28JT97KB6CQ643DZVMXX': { x: 1, y: 1 } },
    };
    const start = (v: ReturnType<typeof levelView>) =>
      v.nodes.find((n) => n.node.key === 'start')?.position;
    expect(start(levelView(snap))).toEqual({ x: 140, y: 64 });
    expect(start(levelView(snap, { '01JB3E28JT97KB6CQ643DZVMXX': { x: 9, y: 9 } }))).toEqual({
      x: 9,
      y: 9,
    });
  });
});

describe('open-port banner (check 4)', () => {
  it.each([
    ['edge-baseline.flow.yaml', 3],
    ['os-upgrade.flow.yaml', 3],
  ])('%s shows %i', (name, count) => {
    render(
      <ReactFlowProvider>
        <Banner />
      </ReactFlowProvider>,
    );
    show(snapshotOf(example(name)));
    expect(screen.getByRole('status').dataset.bannerCount).toBe(String(count));
    expect(screen.getByRole('status').textContent).toContain(`${count} open fail ports`);
  });
});

describe('port menu and open on purpose (M2)', () => {
  const EDGE = example('edge-baseline.flow.yaml');
  const PRECHECK = '01JBQKFBF5KZNWJ47TAN9ZT24M';

  function mount() {
    render(
      <ReactFlowProvider>
        <div style={{ width: 1200, height: 800 }}>
          <FlowCanvas cull={false} />
        </div>
        <PortMenu />
        <DecisionDialog />
      </ReactFlowProvider>,
    );
    show(snapshotOf(EDGE));
  }
  const commands = () =>
    posted.flatMap((m) =>
      (m as { type: string }).type === 'command' ? [(m as { command: FlowCommand }).command] : [],
    );

  beforeEach(() => {
    posted.length = 0;
    useUi.setState({ portMenu: null, decide: null, pick: null });
  });

  it('clicking an open fail port opens its suggestions; a pattern becomes one command', () => {
    mount();
    const port = document.querySelector<HTMLElement>(
      `[data-node-id="${PRECHECK}"] [data-port="failed_hosts"]`,
    );
    act(() => port?.click());
    const menu = screen.getByRole('menu');
    expect(menu.dataset.portMenu).toBe(`${PRECHECK}|failed_hosts`);
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toContain(
      'Notify on-call and stop',
    );
    act(() => screen.getByRole('menuitem', { name: 'Notify on-call and stop' }).click());
    expect(commands()).toEqual([
      expect.objectContaining({
        kind: 'applyPattern',
        pattern: 'notify-stop',
        from: { node: PRECHECK, port: 'failed_hosts' },
        position: expect.objectContaining({ x: expect.any(Number) }),
      }),
    ]);
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('"Leave open on purpose" needs a reason, then sends setDecision without an author', () => {
    mount();
    act(() =>
      useUi.getState().openPortMenu({ ref: { node: PRECHECK, port: 'failed_hosts' }, x: 0, y: 0 }),
    );
    act(() => screen.getByRole('menuitem', { name: 'Leave open on purpose…' }).click());
    const dialog = screen.getByRole('dialog');
    const submit = within(dialog).getByRole('button', { name: 'Leave open' });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(within(dialog).getByLabelText('Reason (required)'), {
      target: { value: 'Read-only checks' },
    });
    act(() => submit.click());
    expect(commands()).toEqual([
      { kind: 'setDecision', node: PRECHECK, port: 'failed_hosts', reason: 'Read-only checks' },
    ]);
  });

  it('a connected port offers insert, rewire and disconnect', () => {
    mount();
    act(() =>
      useUi.getState().openPortMenu({
        ref: { node: '01JBDJ8FSSZ5AWSH8VHTPRE95B', port: 'failed_hosts' },
        x: 0,
        y: 0,
      }),
    );
    expect(screen.getAllByRole('menuitem').map((b) => b.textContent)).toEqual([
      'Insert node on this wire',
      'Rewire to another node…',
      'Disconnect',
    ]);
  });
});

describe('generated code and runs (M3)', () => {
  it('the inspector shows the node play and what the last run sent through each port', () => {
    const doc = example('edge-baseline.flow.yaml');
    const node = doc.nodes.find((n) => n.key === 'precheck');
    const preview = codePreview(doc, 'edge-baseline.flow.yaml');
    show({ ...snapshotOf(doc), plays: preview.plays });
    act(() =>
      useUi.getState().setRun({
        id: 'r1',
        mode: 'check',
        state: 'done',
        startedAt: '2026-10-29T08:00:00Z',
        rc: 2,
        summary: {
          nodes: { [node?.id ?? '']: { ok_hosts: ['sw-edge-01'], failed_hosts: ['sw-edge-04'] } },
          outcome: { 'sw-edge-04': 'Stopped at [precheck] Pre-checks: failed_hosts is not wired' },
          failures: [],
          unreachable: [],
          hosts: ['sw-edge-01', 'sw-edge-04'],
          stoppedEarly: false,
        },
      }),
    );
    const { container } = render(<Inspector id={node?.id ?? ''} />);
    const play = container.querySelector(`[data-generated-play="${node?.id}"]`)?.textContent ?? '';
    expect(play.startsWith('- name: "[precheck] Pre-checks"')).toBe(true);
    expect(play).toContain('key: flow_precheck_failed_hosts');
    const last = container.querySelector(`[data-last-run="${node?.id}"]`);
    expect(last?.textContent).toContain('ok_hosts');
    expect(last?.textContent).toContain('sw-edge-04');
  });

  it('the top bar runs as skeleton and reports the outcome', () => {
    show(snapshotOf(example('edge-baseline.flow.yaml')));
    act(() => useUi.getState().setRun(null));
    render(<TopBar />);
    posted.length = 0;
    fireEvent.click(screen.getByRole('button', { name: /Run as skeleton/ }));
    expect(posted).toContainEqual({ type: 'run', mode: 'check' });
    act(() =>
      useUi.getState().setRun({
        id: 'r2',
        mode: 'check',
        state: 'running',
        startedAt: '2026-10-29T08:00:00Z',
      }),
    );
    expect(screen.getByRole('button', { name: /Running/ })).toHaveProperty('disabled', true);
    act(() =>
      useUi.getState().setRun({
        id: 'r2',
        mode: 'check',
        state: 'done',
        startedAt: '2026-10-29T08:00:00Z',
        rc: 0,
        summary: {
          nodes: {},
          outcome: {},
          failures: [],
          unreachable: [],
          hosts: ['a', 'b'],
          stoppedEarly: false,
        },
      }),
    );
    expect(screen.getByText(/2 hosts · 0 failed · exit 0/)).toBeTruthy();
  });
});

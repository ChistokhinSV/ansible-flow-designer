import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { defaultPortNames } from '../../../src/core/flow/ports';
import { type FlowDocument, NODE_TYPES } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { Banner } from '../../../src/webview/panels/Banner';
import { useUi } from '../../../src/webview/store';
import { levelView } from '../../../src/webview/viewModel';

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
  it('shows exactly the default ports for a node of each type', () => {
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
      const ports = [...(el?.querySelectorAll<HTMLElement>('[data-port]') ?? [])].map(
        (p) => p.dataset.port,
      );
      expect(ports, type).toEqual(defaultPortNames({ type }));
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

  it('spreads several ports on one side evenly', () => {
    const doc = example('os-upgrade.flow.yaml');
    const view = levelView(snapshotOf(doc));
    const upgrade = view.nodes.find((n) => n.node.key === 'upgrade-os');
    const right = upgrade?.ports.filter((p) => p.side === 'right').map((p) => p.offset);
    expect(right).toEqual([1 / 3, 2 / 3]);
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

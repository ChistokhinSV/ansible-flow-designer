// AFD-328 (AFS-137): the canvas in the server's pages: wires read out by step and port and kept out
// of the Tab order, Tidy Up fitted, the open fail port question on one line, a narrow designer
// folding its palette, the hover card inside the canvas, a step missing a required parameter.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, render, screen } from '@testing-library/react';
import { type Edge, ReactFlowProvider, useStore } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { CatalogRequest, HostMessage, Snapshot } from '../../../src/core/protocol';
import { App } from '../../../src/webview/App';
import { setTransport } from '../../../src/webview/bus';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { Lifecycle } from '../../../src/webview/details/sections';
import { Banner } from '../../../src/webview/panels/Banner';
import { cardPlace } from '../../../src/webview/panels/PreviewCard';
import { useUi } from '../../../src/webview/store';
import { vscodeTransport } from '../../../src/webview/transport';
import { posted } from './setup';

const example = (name: string) =>
  parse(readFileSync(join(__dirname, '../../../examples', name), 'utf8')) as FlowDocument;

function snapshotOf(doc: FlowDocument): Snapshot {
  return {
    docVersion: 1,
    doc,
    stale: false,
    findings: [],
    openPorts: openFailPorts(buildModel(doc)),
    autoPositions: {},
  };
}

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

// jsdom draws no wires (nothing is measured): what the canvas hands React Flow is read instead.
let probed: Edge[] = [];
function Probe() {
  probed = useStore((s) => s.edges);
  return null;
}

beforeEach(() => {
  setTransport(vscodeTransport());
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'design',
    level: 'root',
    bannerDismissedAt: null,
  });
});
afterEach(cleanup);

describe('wires on the canvas (AFS-142 a9.10, a10.20)', () => {
  it('are named by the steps and ports they join, and only the selected step’s take the focus', () => {
    const doc = example('edge-baseline.flow.yaml');
    render(
      <ReactFlowProvider>
        <FlowCanvas cull={false} />
        <Probe />
      </ReactFlowProvider>,
    );
    act(() => useUi.getState().setSnapshot(snapshotOf(doc)));
    expect(probed.length).toBeGreaterThan(3);
    for (const e of probed) {
      expect(e.ariaLabel).toBeTruthy();
      expect(e.ariaLabel).not.toMatch(ULID);
      expect(e.focusable).toBe(false);
    }
    expect(probed.map((e) => e.ariaLabel)).toContain(
      'Wire from Backup config ok_hosts to Push baseline',
    );

    const backup = doc.nodes.find((n) => n.key === 'backup-config') as FlowNode;
    act(() => useUi.getState().select({ node: backup.id }));
    const focusable = probed.filter((e) => e.focusable);
    expect(focusable.length).toBeGreaterThan(0);
    for (const e of focusable) expect(e.ariaLabel).toContain('Backup config');
  });

  it('Tidy Up asks for the layout and for all of the level in view after it', () => {
    render(
      <ReactFlowProvider>
        <FlowCanvas cull={false} />
      </ReactFlowProvider>,
    );
    act(() => useUi.getState().setSnapshot(snapshotOf(example('edge-baseline.flow.yaml'))));
    const before = useUi.getState().tidyNonce;
    posted.length = 0;
    act(() => screen.getByRole('button', { name: 'Tidy Up' }).click());
    expect(posted).toEqual([{ type: 'tidyUp', level: 'root' }]);
    expect(useUi.getState().tidyNonce).toBe(before + 1);
  });
});

describe('the open fail port question (AFS-137 a2.13)', () => {
  it('names the step, the question in full in its title, quick answers that can fold away', () => {
    act(() => useUi.getState().setSnapshot(snapshotOf(example('edge-baseline.flow.yaml'))));
    render(<Banner />);
    const banner = screen.getByRole('status');
    expect(banner.classList.contains('afd-open-ports')).toBe(true);
    const question = banner.querySelector('.afd-open-ports-question');
    expect(question?.getAttribute('title')).toMatch(/^What should happen when ".+"/);
    // AFS-148 a2.n3: the step's name is in the text, not only in the title.
    expect(question?.textContent).toMatch(/What should happen when "Pre-checks" fails\?/);
    expect(banner.querySelectorAll('.afd-open-ports-quick').length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Other Choices' })).toBeTruthy();
  });
});

describe('the hover card (AFS-137 a2.11, a3.11)', () => {
  const area = { left: 200, top: 50, right: 1000, bottom: 700 };
  const card = { width: 340, height: 200 };

  it('opens right of a node past its port labels when there is room', () => {
    const at = cardPlace({ left: 300, right: 436, top: 100, bottom: 160 }, card, area);
    expect(at.left).toBeGreaterThanOrEqual(436 + 90);
    expect(at.top).toBe(100);
  });

  it('else left of it, and never outside the canvas (the side panel, the page)', () => {
    const left = cardPlace({ left: 700, right: 836, top: 100, bottom: 160 }, card, area);
    expect(left.left + card.width).toBeLessThanOrEqual(700);
    const under = cardPlace({ left: 420, right: 556, top: 600, bottom: 660 }, card, area);
    expect(under.left).toBeGreaterThanOrEqual(area.left);
    expect(under.left + card.width).toBeLessThanOrEqual(area.right);
    expect(under.top + card.height).toBeLessThanOrEqual(area.bottom);
  });
});

describe('a step missing a required parameter (AFS-137 a2.8)', () => {
  it('its Lifecycle says the step does not run until the parameter is set', async () => {
    const node: FlowNode = {
      id: '01JC0000000000000000000BAN',
      key: 'set-banner',
      type: 'task',
      title: 'Set login banner',
      status: 'implemented',
      impl: { kind: 'module', ref: 'cisco.ios.ios_banner', params: { state: 'present' } },
    };
    act(() => {
      useUi.getState().setSnapshot(
        snapshotOf({
          schema_version: 2,
          flow: { id: '01JC000000000000000000FLOW', key: 'b', name: 'B', version: 1 },
          nodes: [node],
          edges: [],
        } as FlowDocument),
      );
      useUi.getState().setCatalog({ state: 'ready' });
    });
    posted.length = 0;
    render(<Lifecycle node={node} onSet={() => undefined} />);
    await act(async () => {});
    const asked = posted.find(
      (m): m is { type: 'catalog'; reqId: number; request: CatalogRequest } =>
        (m as { type: string }).type === 'catalog',
    );
    expect(asked?.request).toEqual({ op: 'doc', fqcn: 'cisco.ios.ios_banner' });
    const reply: HostMessage = {
      type: 'catalogReply',
      reqId: asked?.reqId ?? 0,
      ok: true,
      result: {
        fqcn: 'cisco.ios.ios_banner',
        options: {
          banner: { type: 'str', required: true, description: 'Which banner' },
          text: { type: 'str', description: 'The text' },
          state: { type: 'str', default: 'present', description: 'present or absent' },
        },
      },
    };
    await act(async () => {
      window.dispatchEvent(new MessageEvent('message', { data: reply }));
    });
    await act(async () => {});
    expect(screen.getByText(/Required parameter missing: banner/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Mark Tested/ })).toBeNull();
  });
});

describe('a narrow designer (AFS-137 a9.3)', () => {
  it('opens with the palette folded, without keeping that as the user’s choice', async () => {
    const width = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    const kept: unknown[] = [];
    const listeners = new Set<(m: HostMessage) => void>();
    setTransport({
      post: () => undefined,
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getState: () => undefined,
      setState: (s) => kept.push(s),
    });
    useUi.setState({ paletteCollapsed: false, panelCollapsed: false, panelWidth: 340 });
    try {
      render(<App />);
      await act(async () => {
        for (const l of listeners) l({ type: 'config', testMode: false });
        for (const l of listeners)
          l({ type: 'snapshot', snapshot: snapshotOf(example('edge-baseline.flow.yaml')) });
      });
      expect(useUi.getState().paletteCollapsed).toBe(true);
      act(() => useUi.getState().setPanelWidth(400));
      expect(kept.at(-1)).toMatchObject({ panelWidth: 400, paletteCollapsed: false });
    } finally {
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});

describe('a narrow designer in a web page (AFS-148 a9.n1, a2.n1)', () => {
  it('opens with the side panel folded, and unfolds it when a step is selected', async () => {
    const width = window.innerWidth;
    const g = globalThis as { acquireVsCodeApi?: unknown };
    const vscode = g.acquireVsCodeApi;
    delete g.acquireVsCodeApi;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    const kept: unknown[] = [];
    const listeners = new Set<(m: HostMessage) => void>();
    setTransport({
      post: () => undefined,
      subscribe(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      getState: () => undefined,
      setState: (s) => kept.push(s),
    });
    useUi.setState({ paletteCollapsed: false, panelCollapsed: false, panelWidth: 340 });
    try {
      render(<App />);
      const doc = example('edge-baseline.flow.yaml');
      await act(async () => {
        for (const l of listeners) l({ type: 'config', testMode: false });
        for (const l of listeners) l({ type: 'snapshot', snapshot: snapshotOf(doc) });
      });
      expect(useUi.getState().panelCollapsed).toBe(true);
      expect(screen.getByRole('button', { name: 'Show Side Panel' })).toBeTruthy();
      act(() => useUi.getState().select({ node: doc.nodes[1]?.id }));
      expect(useUi.getState().panelCollapsed).toBe(false);
      // Folded for the width, not by the user: not kept as the user's choice.
      expect(kept.every((k) => !(k as { panelCollapsed?: boolean }).panelCollapsed)).toBe(true);
    } finally {
      g.acquireVsCodeApi = vscode;
      Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    }
  });
});

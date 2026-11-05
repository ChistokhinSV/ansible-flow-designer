// AFD-96 (wave 9): what round 2 and the walkthroughs left. The way back to the run's results (S3),
// no step card over a port's label (S1), Stop Flow in the failure banner (W5), a palette click that
// adds its step where the flow goes on (W1), the multi-select hint in a step's Details (X3), and the
// lens fold under the Details tabs (X4).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { Details } from '../../../src/webview/details/Details';
import { Banner } from '../../../src/webview/panels/Banner';
import { addFromPalette } from '../../../src/webview/portActions';
import { useUi } from '../../../src/webview/store';

const example = (name: string) =>
  parse(readFileSync(join(__dirname, '../../../examples', name), 'utf8')) as FlowDocument;
const OS = example('os-upgrade.flow.yaml');
const idOf = (doc: FlowDocument, key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

function show(doc: FlowDocument) {
  const snapshot: Snapshot = {
    docVersion: 1,
    doc,
    stale: false,
    findings: [],
    openPorts: openFailPorts(buildModel(doc)),
    autoPositions: {},
  };
  act(() => useUi.getState().setSnapshot(snapshot));
}

beforeEach(() => {
  useUi.setState({
    snapshot: null,
    selection: {},
    level: 'root',
    mode: 'design',
    run: null,
    quickAdd: null,
    preview: null,
  });
});
afterEach(cleanup);

describe('round 2 leftovers (AFD-96)', () => {
  it("a step's Details in Run mode lead back to the run's results (S3)", () => {
    show(OS);
    act(() => {
      useUi.setState({
        mode: 'run',
        run: {
          id: 'r1',
          mode: 'check',
          state: 'done',
          startedAt: '2026-11-05T10:00:00Z',
          source: 'local',
        },
      });
      useUi.getState().select({ node: idOf(OS, 'upgrade-os') });
    });
    render(<Details id={idOf(OS, 'upgrade-os')} />);
    fireEvent.click(screen.getByRole('button', { name: /Run Results/ }));
    expect(useUi.getState().selection.node).toBeUndefined();
  });

  it('no step card while the pointer is on a port; it may open again once it leaves (S1)', () => {
    vi.useFakeTimers();
    try {
      show(OS);
      const up = idOf(OS, 'upgrade-os');
      act(() => useUi.getState().portHover(true));
      act(() => useUi.getState().hoverNode(up, { left: 10, right: 200, top: 40 }));
      act(() => vi.advanceTimersByTime(600));
      expect(useUi.getState().preview).toBeNull();
      act(() => useUi.getState().portHover(false));
      act(() => useUi.getState().hoverNode(up, { left: 10, right: 200, top: 40 }));
      act(() => vi.advanceTimersByTime(600));
      expect(useUi.getState().preview?.node).toBe(up);
    } finally {
      act(() => useUi.getState().portHover(false));
      vi.useRealTimers();
    }
  });

  it('the failure banner offers Stop Flow among its buttons, not only under Other Choices (W5)', () => {
    render(
      <ReactFlowProvider>
        <Banner />
      </ReactFlowProvider>,
    );
    show(example('edge-baseline.flow.yaml'));
    expect(screen.getByRole('button', { name: 'Stop Flow' })).toBeTruthy();
  });

  it('a palette click adds after the selected step, wired; on Start → Done, onto that wire (W1)', () => {
    show(OS);
    const step = idOf(OS, 'upgrade-os');
    act(() => useUi.getState().select({ node: step }));
    expect(addFromPalette('approval')).toBe(true);
    const q = useUi.getState().quickAdd;
    expect(q?.type).toBe('approval');
    expect(q?.connectFrom?.node === step || q?.insertOn !== undefined).toBe(true);
    // A new flow: only Start and Done. The step goes onto their wire.
    const fresh = parse(
      newFlowText('Edge checks', 'edge-checks', createIdFactory()),
    ) as FlowDocument;
    act(() => useUi.setState({ quickAdd: null, selection: {} }));
    show(fresh);
    expect(fresh.edges?.length).toBe(1);
    expect(addFromPalette('task')).toBe(true);
    expect(useUi.getState().quickAdd?.insertOn).toBe(fresh.edges[0]?.id);
    // Nothing selected on a level with steps: the palette places it as before.
    act(() => useUi.setState({ quickAdd: null, selection: {} }));
    show(OS);
    expect(addFromPalette('task')).toBe(false);
  });

  it("a step's Details say how to select several; the lens fold sits under the tabs (X3, X4)", () => {
    show(OS);
    const step = idOf(OS, 'upgrade-os');
    render(<Details id={step} />);
    expect(document.querySelector('[data-select-hint]')).toBeTruthy();
    const tabs = document.querySelector('[role="tablist"]') as HTMLElement;
    const panel = document.querySelector('[role="tabpanel"]') as HTMLElement;
    expect(tabs.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

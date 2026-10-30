// AFD-7: several selected nodes show the selection panel; Extract into subflow sends one command
// with the group's top-left position, shows a refusal where it was asked, and selects the result.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { SelectionPanel } from '../../../src/webview/panels/SelectionPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const commands = () =>
  (posted as { type: string; reqId?: number; command?: FlowCommand }[]).filter(
    (m) => m.type === 'command',
  );

async function answer(ok: boolean, extra: Record<string, unknown> = {}) {
  await act(async () => {
    for (const m of commands())
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'ack', reqId: m.reqId, ok, ...extra } }),
      );
  });
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, optimistic: {}, mode: 'design', run: null });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: Object.fromEntries(doc.nodes.map((n, i) => [n.id, { x: i * 260, y: i * 40 }])),
    });
  });
});
afterEach(cleanup);

describe('Extract into subflow', () => {
  it('a group selection marks every node on the canvas', () => {
    act(() => useUi.getState().select({ nodes: [id('backup-config'), id('drain-traffic')] }));
    render(
      <ReactFlowProvider>
        <div style={{ width: 3000, height: 600 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const selected = [...document.querySelectorAll<HTMLElement>('.react-flow__node.selected')].map(
      (n) => n.dataset.id,
    );
    expect(selected.sort()).toEqual([id('backup-config'), id('drain-traffic')].sort());
  });

  it('sends one command with the title and the top-left position, then selects the subflow', async () => {
    const ids = [id('backup-config'), id('drain-traffic')];
    render(<SelectionPanel ids={ids} />);
    expect(screen.getByText('2 nodes selected')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('Subflow'), { target: { value: 'Prepare' } });
    expect(screen.getByText('prepare')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Extract into subflow/ }));
    // os-upgrade has no layout block: the panel uses the auto positions the canvas shows, and
    // writes them for every node of the level so the rest does not get stacked (product owner).
    const auto = useUi.getState().snapshot?.autoPositions ?? {};
    const xs = ids.map((n) => auto[n]?.x as number);
    const ys = ids.map((n) => auto[n]?.y as number);
    expect(commands().map((m) => m.command)).toEqual([
      {
        kind: 'extractSubflow',
        nodes: ids,
        title: 'Prepare',
        position: { x: Math.min(...xs), y: Math.min(...ys) },
        freeze: Object.fromEntries(doc.nodes.map((n) => [n.id, auto[n.id]])),
      },
    ]);
    await answer(true, { created: 'NEW' });
    expect(useUi.getState().selection).toEqual({ node: 'NEW' });
  });

  it('a refusal stays in the panel', async () => {
    render(<SelectionPanel ids={[id('pre-checks'), id('rollback')]} />);
    fireEvent.click(screen.getByRole('button', { name: /Extract into subflow/ }));
    await answer(false, {
      error: 'The selection is not connected: Rollback is apart from the rest',
    });
    expect(document.querySelector('[data-extract-error]')?.textContent).toContain('not connected');
  });
});

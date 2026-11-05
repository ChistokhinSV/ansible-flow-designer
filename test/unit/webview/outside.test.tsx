// AFD-85: steps and wires changed outside the designer: the note over the canvas, Show and Clear,
// and the dashed mark on the step.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { OutsideNote, whenText } from '../../../src/webview/panels/OutsideNote';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../samples/hello.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    outside: null,
    outsideAround: [],
    highlight: null,
    mode: 'design',
  });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: Object.fromEntries(doc.nodes.map((n, i) => [n.id, { x: 0, y: i * 140 }])),
    });
    useUi.getState().setOutside({
      nodes: [id('say-hello')],
      edges: [],
      removed: 1,
      since: '2026-11-04T10:00:00Z',
    });
  });
});
afterEach(cleanup);

describe('changed outside the designer', () => {
  it('the note says what changed; Show lights the steps, Clear asks the host to drop them', () => {
    render(<OutsideNote />);
    const note = screen.getByRole('status');
    expect(note.textContent).toMatch(
      /1 step changed outside the designer, 1 step removed since you opened it/,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(useUi.getState().highlight).toEqual([id('say-hello')]);
    expect(useUi.getState().selection.node).toBe(id('say-hello'));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(posted).toContainEqual({ type: 'clearOutside' });
    expect(useUi.getState().highlight).toBeNull();
  });

  it('the marked step is dashed on the canvas; the others are not', () => {
    render(
      <ReactFlowProvider>
        <div style={{ width: 1200, height: 800 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
    const card = (key: string) =>
      document.querySelector<HTMLElement>(`[data-node-id="${id(key)}"]`);
    expect(card('say-hello')?.dataset.outside).toBe('outside-mark');
    expect(card('ping')?.dataset.outside).toBeUndefined();
    act(() => useUi.getState().setOutside(null));
    expect(card('say-hello')?.dataset.outside).toBeUndefined();
  });
});

describe('changed while the flow was closed (AFD-92)', () => {
  it('the note says since when you last had the flow open, with the day when not today', () => {
    act(() =>
      useUi.getState().setOutside({
        nodes: [id('say-hello')],
        edges: [],
        removed: 0,
        since: '2026-11-04T19:49:00Z',
        closed: true,
      }),
    );
    render(<OutsideNote />);
    const note = screen.getByRole('status');
    expect(note.dataset.outsideClosed).toBe('true');
    expect(note.textContent).toMatch(
      /1 step changed outside the designer since you last had this flow open \(.+, .+\)\./,
    );
    expect(whenText('2026-11-04T19:49:00Z', new Date('2026-11-04T21:00:00Z'))).not.toMatch(/,/);
    expect(whenText('2026-11-04T19:49:00Z', new Date('2026-11-06T09:00:00Z'))).toMatch(/,/);
  });
});

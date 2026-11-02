// AFD-65: Notes, Sections and Text on the canvas: drawn without ports, a tied Note with its tie,
// edited in place (Ctrl+Enter saves one edit, Escape cancels), their own panel and menu, Delete
// with the selection, links through the host, hidden on request, read-only outside Design.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { canvasMenu } from '../../../src/core/flow/canvasMenu';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { Snapshot } from '../../../src/core/protocol';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { installKeyboard } from '../../../src/webview/keyboard';
import { AnnotationPanel } from '../../../src/webview/panels/AnnotationPanel';
import { rightPanelFor } from '../../../src/webview/rightPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const DOC = parse(
  readFileSync(join(__dirname, '../../fixtures/flows/annotated.flow.yaml'), 'utf8'),
) as FlowDocument;
const byKey = (key: string) => DOC.annotations?.find((a) => a.key === key)?.id as string;
const snapshot = (): Snapshot => ({
  docVersion: 1,
  doc: DOC,
  stale: false,
  findings: [],
  openPorts: openFailPorts(buildModel(DOC)),
  autoPositions: {},
});
const commands = () =>
  posted.flatMap((m) =>
    (m as { type: string }).type === 'command' ? [(m as { command: FlowCommand }).command] : [],
  );

function canvas() {
  render(
    <ReactFlowProvider>
      <div style={{ width: 1200, height: 800 }}>
        <FlowCanvas cull={false} />
      </div>
    </ReactFlowProvider>,
  );
  act(() => useUi.getState().setSnapshot(snapshot()));
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    mode: 'design',
    level: 'root',
    annotationsHidden: false,
    editingAnnotation: null,
  });
});
afterEach(cleanup);

describe('annotations on the canvas (AFD-65)', () => {
  it('draws notes, the section and text without ports; a tied note draws its tie', () => {
    canvas();
    const all = document.querySelectorAll('[data-annotation-id]');
    expect([...all].map((e) => e.getAttribute('data-annotation-kind')).sort()).toEqual([
      'note',
      'note',
      'note',
      'section',
      'text',
    ]);
    // Node counts stay node-only.
    expect(document.querySelectorAll('[data-node-id]')).toHaveLength(DOC.nodes.length);
    const tied = document.querySelector(`[data-annotation-id="${byKey('note-1')}"]`);
    expect(tied?.querySelector('.react-flow__handle')).toBeNull();
    expect(tied?.textContent).toContain('Read-only checks: safe to rerun.');
    expect(tied?.querySelector('strong')?.textContent).toBe('safe');
    // The tied note is the node's child.
    expect(tied?.closest('.react-flow__node')?.getAttribute('aria-label')).toBe(
      'Note: Read-only checks: safe to rerun.',
    );
  });

  it('double-click edits in place: Escape cancels, Ctrl+Enter saves one edit', () => {
    canvas();
    const id = byKey('note-3');
    const wrapper = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
    fireEvent.doubleClick(wrapper);
    let field = screen.getByLabelText(/Annotation text/) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'changed' } });
    fireEvent.keyDown(field, { key: 'Escape' });
    expect(commands()).toEqual([]);
    expect(screen.queryByLabelText(/Annotation text/)).toBeNull();
    fireEvent.doubleClick(wrapper);
    field = screen.getByLabelText(/Annotation text/) as HTMLTextAreaElement;
    fireEvent.change(field, { target: { value: 'Runbook moved' } });
    fireEvent.keyDown(field, { key: 'Enter', ctrlKey: true });
    expect(commands()).toEqual([
      { kind: 'updateAnnotation', id, patch: { text: 'Runbook moved' } },
    ]);
  });

  it('a link asks the host to open it; the panel and the menu belong to the annotation', () => {
    canvas();
    const link = document.querySelector(
      `[data-annotation-id="${byKey('note-3')}"] a`,
    ) as HTMLAnchorElement;
    fireEvent.click(link);
    expect(posted).toContainEqual({
      type: 'openLink',
      url: 'https://wiki.example.net/edge-baseline',
    });
    const id = byKey('note-1');
    expect(
      rightPanelFor({
        lens: null,
        mode: 'design',
        selection: { annotations: [id] },
        level: 'root',
      }),
    ).toEqual({ kind: 'annotation', id });
    act(() => useUi.getState().setSnapshot(snapshot()));
    const panel = within(render(<AnnotationPanel id={id} />).container);
    expect(panel.getByText('Pre-checks')).toBeTruthy();
    fireEvent.change(panel.getByLabelText('Color'), { target: { value: 'pink' } });
    expect(commands()).toContainEqual({
      kind: 'updateAnnotation',
      id,
      patch: { color: 'pink' },
    });
    const menu = canvasMenu(
      buildModel(DOC),
      { kind: 'annotation', id },
      {
        mode: 'design',
        level: 'root',
        stale: false,
        openPorts: [],
        hasPlay: () => false,
      },
    );
    const labels = menu.flatMap((e) => (e.type === 'separator' ? [] : [e.label]));
    expect(labels).toEqual([
      'Edit Text',
      'Color',
      'Detach from Node',
      'Cut',
      'Copy',
      'Duplicate',
      'Delete',
    ]);
    const pane = canvasMenu(
      buildModel(DOC),
      { kind: 'pane' },
      {
        mode: 'design',
        level: 'root',
        stale: false,
        openPorts: [],
        hasPlay: () => false,
      },
    );
    expect(pane.flatMap((e) => (e.type === 'item' ? [e.label] : []))).toContain('Add Note Here');
  });

  it('Delete removes the selected annotations with the nodes, in one command', () => {
    canvas();
    const off = installKeyboard();
    const ids = [byKey('note-3'), byKey('text-1')];
    act(() => useUi.getState().select({ annotations: ids }));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    off();
    expect(commands()).toEqual([{ kind: 'deleteNodes', ids: [], edges: [], annotations: ids }]);
  });

  it('hidden on request; read-only (no resize, no editing) outside Design mode', () => {
    canvas();
    act(() => useUi.getState().setAnnotationsHidden(true));
    expect(document.querySelectorAll('[data-annotation-id]')).toHaveLength(0);
    act(() => {
      useUi.getState().setAnnotationsHidden(false);
      useUi.setState({ mode: 'run' });
    });
    const id = byKey('note-3');
    act(() => useUi.getState().select({ annotations: [id] }));
    const wrapper = document.querySelector(`.react-flow__node[data-id="${id}"]`) as HTMLElement;
    fireEvent.doubleClick(wrapper);
    expect(screen.queryByLabelText(/Annotation text/)).toBeNull();
    expect(document.querySelector('.react-flow__resize-control')).toBeNull();
  });
});

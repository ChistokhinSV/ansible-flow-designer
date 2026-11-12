// AFD-231..235 on the canvas: the + on an open output, a wire's end let go on another port, the
// title field of Quick Add that finds a module, Detach, and Shift+Delete that leaves the gap.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { deleteSelection, detachNodes, selectFlow } from '../../../src/webview/editActions';
import { installKeyboard } from '../../../src/webview/keyboard';
import { QuickAdd } from '../../../src/webview/panels/QuickAdd';
import { dropWireEnd, insertOnWire } from '../../../src/webview/portActions';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const TEXT = readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8');
const EDGE = parse(TEXT) as FlowDocument;
const idIn = (doc: FlowDocument, key: string) =>
  [...buildModel(doc).nodes.values()].find((n) => n.node.key === key)?.node.id as string;
const id = (key: string) => idIn(EDGE, key);
const wire = (doc: FlowDocument, from: string, to: string) =>
  doc.edges?.find((e) => e.from.node === idIn(doc, from) && e.to.node === idIn(doc, to))
    ?.id as string;
type Posted = { type: string; command?: FlowCommand; request?: unknown; reqId?: number };
const commands = () =>
  (posted as Posted[]).filter((m) => m.type === 'command').map((m) => m.command);

function show(doc: FlowDocument) {
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: Date.now(),
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
}

function canvas() {
  render(
    <ReactFlowProvider>
      <div style={{ width: 3000, height: 800 }}>
        <FlowCanvas cull={false} />
      </div>
      <QuickAdd />
    </ReactFlowProvider>,
  );
}

/** The example with `validate` cut off from `done`: its ok_hosts is open. */
const OPEN = parse(
  planCommand(
    TEXT,
    { kind: 'disconnect', edge: wire(EDGE, 'validate', 'done') },
    { newId: createIdFactory() },
  ).text,
) as FlowDocument;

let off: (() => void)[] = [];
beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    contextMenu: null,
    portMenu: null,
    quickAdd: null,
    pick: null,
    mode: 'design',
    level: 'root',
    toasts: [],
  });
  show(EDGE);
  off = [installKeyboard()];
});
afterEach(() => {
  for (const f of off) f();
  cleanup();
});

describe('+ on an open output (AFD-231)', () => {
  it('shows on the main output still open, at rest, and opens Quick Add wired from it', () => {
    show(OPEN);
    canvas();
    const all = document.querySelectorAll('[data-port-plus]');
    expect(all).toHaveLength(1);
    const plus = all[0] as HTMLElement;
    expect(plus.closest('[data-node-id]')?.getAttribute('data-node-id')).toBe(id('validate'));
    expect(plus.getAttribute('aria-label')).toBe('Add Next Node from ok_hosts');
    fireEvent.click(plus);
    expect(useUi.getState().quickAdd).toMatchObject({
      type: 'task',
      connectFrom: { node: id('validate'), port: 'ok_hosts' },
    });
    // The port keeps its own menu: the + did not open it.
    expect(useUi.getState().portMenu).toBeNull();
  });

  it('a wired path has none; Code and Run modes have none', () => {
    canvas();
    expect(document.querySelectorAll('[data-port-plus]')).toHaveLength(0);
    cleanup();
    show(OPEN);
    act(() => useUi.getState().setMode('run'));
    canvas();
    expect(document.querySelectorAll('[data-port-plus]')).toHaveLength(0);
  });

  it('the + of a wire inserts on that wire', () => {
    const edge = wire(EDGE, 'precheck', 'backup-config');
    act(() => insertOnWire(edge));
    expect(useUi.getState().quickAdd).toMatchObject({ type: 'task', insertOn: edge });
  });
});

describe("a wire's end let go (AFD-233)", () => {
  const edge = wire(EDGE, 'validate', 'done');

  it('the target end on another node: rewire; on its own node: nothing', async () => {
    void dropWireEnd(edge, 'target', { node: id('failed') });
    void dropWireEnd(edge, 'target', { node: id('done'), port: 'in' });
    expect(commands()).toEqual([{ kind: 'rewire', edge, to: { node: id('failed'), port: 'in' } }]);
  });

  it('either end on empty canvas: disconnect', async () => {
    void dropWireEnd(edge, 'source', null);
    expect(commands()).toEqual([{ kind: 'disconnect', edge }]);
  });

  it('the source end on a port, or on a node with an open main output', async () => {
    show(OPEN);
    const other = wire(OPEN, 'rollback', 'failed');
    void dropWireEnd(other, 'source', { node: id('precheck'), port: 'unchanged' });
    void dropWireEnd(other, 'source', { node: id('validate') });
    expect(commands()).toEqual([
      { kind: 'rewireFrom', edge: other, from: { node: id('precheck'), port: 'unchanged' } },
      { kind: 'rewireFrom', edge: other, from: { node: id('validate'), port: 'ok_hosts' } },
    ]);
  });

  it('the source end on a node with no open output is refused with a message', async () => {
    void dropWireEnd(edge, 'source', { node: id('precheck') });
    expect(commands()).toEqual([]);
    expect(useUi.getState().toasts.at(-1)?.text).toMatch(/no open output/);
  });
});

describe('Delete and Detach (AFD-235)', () => {
  it('Delete closes the path; Shift+Delete leaves the gap', () => {
    canvas();
    act(() => useUi.getState().select({ node: id('validate') }));
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.keyDown(document.body, { key: 'Delete', shiftKey: true });
    expect(commands()).toEqual([
      { kind: 'deleteNodes', ids: [id('validate')], edges: [], heal: true },
      { kind: 'deleteNodes', ids: [id('validate')], edges: [] },
    ]);
  });

  it('Detach is one command; a wire alone is deleted without heal', async () => {
    void detachNodes([id('backup-config')]);
    void deleteSelection([], [wire(EDGE, 'validate', 'done')]);
    expect(commands()).toEqual([
      { kind: 'detachNodes', ids: [id('backup-config')] },
      { kind: 'deleteNodes', ids: [], edges: [wire(EDGE, 'validate', 'done')] },
    ]);
  });
});

describe('Quick Add finds what the step runs (AFD-232)', () => {
  const answer = (hits: unknown[]) => {
    const asked = (posted as Posted[]).filter((m) => m.type === 'catalog').at(-1);
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'catalogReply', reqId: asked?.reqId, ok: true, result: hits },
        }),
      );
    });
  };

  it('Enter alone adds a step with the title typed, as before', async () => {
    canvas();
    act(() => useUi.getState().openQuickAdd({ type: 'task' }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'Check NTP' } });
    await act(async () => {
      fireEvent.submit(title.closest('form') as HTMLFormElement);
    });
    expect(commands().at(-1)).toMatchObject({ kind: 'addNode', type: 'task', title: 'Check NTP' });
    expect(commands().at(-1)).not.toHaveProperty('impl');
  });

  it('a step type by name: the arrow and Enter pick it, the title is free again', () => {
    canvas();
    act(() => useUi.getState().openQuickAdd({ type: 'task' }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'dec' } });
    expect(screen.getByRole('option', { name: /Decision/ })).toBeTruthy();
    fireEvent.keyDown(title, { key: 'ArrowDown' });
    expect(title.getAttribute('aria-activedescendant')).toBeTruthy();
    fireEvent.keyDown(title, { key: 'Enter' });
    expect(screen.getByRole('button', { name: 'Decision' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(title.value).toBe('');
    expect(commands()).toEqual([]);
  });

  it('a module from the catalog: picked, the step is added bound to it', async () => {
    canvas();
    act(() => useUi.getState().openQuickAdd({ type: 'task' }));
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    fireEvent.change(title, { target: { value: 'ios_config' } });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 250));
    });
    answer([
      {
        fqcn: 'cisco.ios.ios_config',
        type: 'module',
        collection: 'cisco.ios',
        short_description: 'Manage IOS configuration sections',
        score: 1,
        match: '',
        badges: [],
        dimmed: false,
      },
    ]);
    await act(async () => {});
    fireEvent.click(screen.getByRole('option', { name: /cisco\.ios\.ios_config/ }));
    expect(title.value).toBe('Ios config');
    expect(document.querySelector('[data-bound]')?.getAttribute('data-bound')).toBe(
      'cisco.ios.ios_config',
    );
    await act(async () => {
      fireEvent.submit(title.closest('form') as HTMLFormElement);
    });
    expect(commands().at(-1)).toMatchObject({
      kind: 'addNode',
      type: 'task',
      title: 'Ios config',
      impl: { kind: 'module', ref: 'cisco.ios.ios_config' },
    });
  });
});

describe('wave 2 on the canvas (AFD-236, 237, 238, 241)', () => {
  it('a node with a problem shows a badge; a click opens its Details tab', () => {
    const node = id('validate');
    act(() =>
      useUi.getState().setSnapshot({
        docVersion: Date.now(),
        doc: EDGE,
        stale: false,
        findings: [
          {
            code: 'from-unresolved',
            severity: 'warning',
            message: 'backup_ref reads a step that is gone',
            path: ['nodes', 4, 'inputs', 'backup_ref'],
            node,
          },
        ],
        openPorts: openFailPorts(buildModel(EDGE)),
        autoPositions: {},
      }),
    );
    canvas();
    const marks = document.querySelectorAll('[data-node-problem]');
    expect(marks).toHaveLength(1);
    const mark = marks[0] as HTMLElement;
    expect(mark.getAttribute('data-node-problem')).toBe('warning');
    expect(mark.closest('[data-node-id]')?.getAttribute('data-node-id')).toBe(node);
    expect(mark.getAttribute('title')).toContain('backup_ref reads a step that is gone');
    fireEvent.click(mark);
    expect(useUi.getState().selection.node).toBe(node);
  });

  it('Select Upstream and Downstream take the steps on the path, on this level', () => {
    act(() => selectFlow(id('backup-config'), 'up'));
    expect(new Set(useUi.getState().selection.nodes)).toEqual(
      new Set(['backup-config', 'precheck', 'start'].map(id)),
    );
    act(() => selectFlow(id('validate'), 'down'));
    expect(new Set(useUi.getState().selection.nodes)).toEqual(
      new Set(['validate', 'done'].map(id)),
    );
  });

  it('Ctrl+arrows follow the wire: the main output down, the incoming wire up', () => {
    canvas();
    act(() => useUi.getState().select({ node: id('push-baseline') }));
    fireEvent.keyDown(document.body, { key: 'ArrowDown', ctrlKey: true });
    expect(useUi.getState().selection.node).toBe(id('validate'));
    fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true });
    fireEvent.keyDown(document.body, { key: 'ArrowUp', ctrlKey: true });
    expect(useUi.getState().selection.node).toBe(id('backup-config'));
    // Nothing was edited on the way.
    expect(commands()).toEqual([]);
  });

  it('a double-click on a title renames in place; Shift+2 asks for the selection in view', () => {
    canvas();
    const title = document.querySelector(
      `[data-node-id="${id('validate')}"] .afd-node-title`,
    ) as HTMLElement;
    fireEvent.doubleClick(title);
    expect(useUi.getState().renaming).toBe(id('validate'));
    const field = screen.getByLabelText('Node title') as HTMLInputElement;
    fireEvent.keyDown(field, { key: 'Escape' });
    const before = useUi.getState().zoomNonce;
    fireEvent.keyDown(document.body, { key: '@', code: 'Digit2', shiftKey: true });
    expect(useUi.getState().zoomNonce).toBe(before + 1);
  });
});

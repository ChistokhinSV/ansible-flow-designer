// AFD-18: right-clicks on the canvas open our menu instead of VS Code's; on a port, the port menu.
// Items run one command each; the menu is driven by the keyboard and keeps keys to itself.
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
import { pasteText } from '../../../src/webview/clipboard';
import { installKeyboard } from '../../../src/webview/keyboard';
import { CanvasContextMenu } from '../../../src/webview/menu/CanvasContextMenu';
import { PortMenu } from '../../../src/webview/panels/PortMenu';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
type Posted = { type: string; command?: FlowCommand; at?: { x: number; y: number } };
const sent = (type: string) => (posted as Posted[]).filter((m) => m.type === type);
const items = () =>
  [...document.querySelectorAll<HTMLElement>('[data-canvas-menu] > [role^="menuitem"]')].map(
    (b) => b.getAttribute('aria-label') ?? b.textContent,
  );

function mount() {
  render(
    <ReactFlowProvider>
      <div style={{ width: 3000, height: 800 }}>
        <FlowCanvas cull={false} />
      </div>
      <CanvasContextMenu />
      <PortMenu />
    </ReactFlowProvider>,
  );
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    selection: {},
    optimistic: {},
    contextMenu: null,
    portMenu: null,
    mode: 'design',
    level: 'root',
  });
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
      plays: { [id('precheck')]: '- name: precheck' },
    }),
  );
});
let offKeys = () => {};
beforeEach(() => {
  offKeys = installKeyboard();
});
afterEach(() => {
  offKeys();
  cleanup();
});

const node = (key: string) =>
  document.querySelector(`.react-flow__node[data-id="${id(key)}"]`) as HTMLElement;

describe('canvas context menu', () => {
  it('a node: our menu (VS Code gets none), the node selected, its items with shortcuts', () => {
    mount();
    let shown = true;
    act(() => {
      shown = fireEvent.contextMenu(node('precheck'), { clientX: 200, clientY: 150 });
    });
    expect(shown).toBe(false);
    expect(useUi.getState().selection).toEqual({ node: id('precheck') });
    expect(items()).toEqual([
      'Details…',
      'Binding…',
      'Rename',
      'Status',
      'Open Port failed_hosts',
      'Add Next Node…',
      'Detach from Path',
      'Reset Position',
      'Cut',
      'Copy',
      'Duplicate',
      'Open in Text Editor',
      'Peek Code',
      'Delete',
    ]);
    const del = screen.getByRole('menuitem', { name: 'Delete' });
    expect(del.getAttribute('aria-keyshortcuts')).toBe('Delete');
    expect(del.textContent).toContain('Delete');
  });

  it('a right-click on a port opens the port menu instead', () => {
    mount();
    const port = node('precheck').querySelector('[data-port="failed_hosts"]') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(port, { clientX: 200, clientY: 150 });
    });
    expect(document.querySelector('[data-canvas-menu]')).toBeNull();
    expect(screen.getByRole('menu').dataset.portMenu).toBe(`${id('precheck')}|failed_hosts`);
  });

  it('Status ▸ specified is one updateNode; Delete is one deleteNodes', () => {
    mount();
    act(() => {
      fireEvent.contextMenu(node('precheck'), { clientX: 200, clientY: 150 });
    });
    act(() => screen.getByRole('menuitem', { name: 'Status' }).click());
    act(() => screen.getByRole('menuitemradio', { name: 'specified' }).click());
    expect(sent('command').map((m) => m.command)).toEqual([
      { kind: 'updateNode', id: id('precheck'), patch: { status: 'specified' } },
    ]);
    expect(screen.queryByRole('menu')).toBeNull();
    posted.length = 0;
    act(() => {
      fireEvent.contextMenu(node('validate'), { clientX: 200, clientY: 150 });
    });
    act(() => screen.getByRole('menuitem', { name: 'Delete' }).click());
    expect(sent('command').map((m) => m.command)).toEqual([
      { kind: 'deleteNodes', ids: [id('validate')], edges: [], heal: true },
    ]);
  });

  it('a group and a wire get their own menus', () => {
    mount();
    const group = [id('backup-config'), id('push-baseline')];
    act(() => useUi.getState().select({ nodes: group }));
    act(() => {
      fireEvent.contextMenu(node('push-baseline'), { clientX: 200, clientY: 150 });
    });
    expect(useUi.getState().selection).toEqual({ nodes: group });
    expect(items()).toEqual([
      'Cut',
      'Copy',
      'Duplicate',
      'Extract into Subflow…',
      'Detach from Path',
      'Arrange',
      'Delete',
    ]);
    const wire = doc.edges.find((e) => e.from.node === id('precheck'))?.id as string;
    act(() =>
      useUi.getState().openContextMenu({ target: { kind: 'edge', id: wire }, x: 10, y: 10 }),
    );
    expect(items()).toEqual(['Insert Node on This Wire', 'Rewire to Another Node…', 'Disconnect']);
  });

  it('empty canvas: Paste Here asks the host for the clipboard with the spot; the paste lands there', async () => {
    mount();
    const pane = document.querySelector('.react-flow__pane') as HTMLElement;
    act(() => {
      fireEvent.contextMenu(pane, { clientX: 300, clientY: 200 });
    });
    const at = useUi.getState().contextMenu?.at as { x: number; y: number };
    expect(items()).toEqual([
      'Paste Here',
      'Add Node Here…',
      'Insert Shared Subflow…',
      'Select All',
      'Tidy Up',
      'Fit View',
      'Find Node…',
    ]);
    act(() => screen.getByRole('menuitem', { name: 'Paste Here' }).click());
    expect(sent('requestPaste')).toEqual([{ type: 'requestPaste', at }]);
    // The host answers with the text and the same spot (App passes both to pasteText).
    await act(async () => {
      void pasteText('key: x\ntype: task\n', at);
    });
    expect(sent('command')[0]?.command).toMatchObject({ kind: 'pasteNodes', position: at });
  });

  it('keys: arrows and Home/End move, Right opens a submenu, Escape closes one level; Delete stays in the menu', () => {
    mount();
    act(() => useUi.getState().select({ node: id('validate') }));
    act(() => {
      fireEvent.contextMenu(node('validate'), { clientX: 200, clientY: 150 });
    });
    const menu = document.querySelector('[data-canvas-menu]') as HTMLElement;
    const focused = () =>
      (document.activeElement as HTMLElement).getAttribute('aria-label') ??
      document.activeElement?.textContent;
    expect(focused()).toBe('Details…');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'End' });
    expect(focused()).toBe('Delete');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'ArrowDown' });
    expect(focused()).toBe('Details…');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Delete' });
    expect(sent('command')).toEqual([]);
    const status = screen.getByRole('menuitem', { name: 'Status' });
    act(() => status.focus());
    act(() => {
      fireEvent.keyDown(status, { key: 'ArrowRight' });
    });
    expect(screen.getAllByRole('menu')).toHaveLength(2);
    act(() => {
      fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    });
    expect(screen.getAllByRole('menu')).toHaveLength(1);
    expect(document.activeElement).toBe(status);
    act(() => {
      fireEvent.keyDown(status, { key: 'Escape' });
    });
    expect(menu.isConnected).toBe(false);
    expect(useUi.getState().selection).toEqual({ node: id('validate') });
    // Outside the menu, the same key deletes the selection.
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Delete' });
    });
    expect(sent('command').map((m) => m.command)).toEqual([
      { kind: 'deleteNodes', ids: [id('validate')], edges: [], heal: true },
    ]);
  });

  it('Run mode: a read-only menu', () => {
    mount();
    act(() => useUi.getState().setMode('run'));
    act(() => {
      fireEvent.contextMenu(node('precheck'), { clientX: 200, clientY: 150 });
    });
    expect(items()).toEqual(['Details…', 'Copy', 'Open in Text Editor', 'Peek Code']);
  });
});

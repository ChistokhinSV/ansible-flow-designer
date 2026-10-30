// AFD-18: keyboard shortcuts. Delete takes the whole selection in one command, cut is copy plus
// that delete, Ctrl+D duplicates without the clipboard, F2 renames in the inspector, Escape closes
// only the innermost thing, Alt+Up leaves a subflow, `?` opens the sheet, and arrow nudges are
// saved. Fields keep their keys; Run mode edits nothing.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { installClipboard } from '../../../src/webview/clipboard';
import { deleteSelection } from '../../../src/webview/editActions';
import { installKeyboard } from '../../../src/webview/keyboard';
import { CheatSheet } from '../../../src/webview/panels/CheatSheet';
import { Inspector } from '../../../src/webview/panels/Inspector';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const read = (name: string) =>
  parse(readFileSync(join(__dirname, '../../../examples', name), 'utf8')) as FlowDocument;
const EDGE = read('edge-baseline.flow.yaml');
const OS = read('os-upgrade.flow.yaml');
const idIn = (doc: FlowDocument, key: string) =>
  [...buildModel(doc).nodes.values()].find((n) => n.node.key === key)?.node.id as string;
const id = (key: string) => idIn(EDGE, key);
type Posted = { type: string; command?: FlowCommand };
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
      <CheatSheet />
    </ReactFlowProvider>,
  );
}

/** jsdom has no ClipboardEvent: a plain event with clipboardData does the same for listeners. */
function clipboard(type: 'cut', target: EventTarget = document) {
  const data = new Map<string, string>();
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (t: string) => data.get(t) ?? '',
      setData: (t: string, v: string) => data.set(t, v),
    },
  });
  target.dispatchEvent(event);
  return data.get('text/plain') ?? '';
}

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
    properties: null,
    cheatSheet: false,
    focusRequest: null,
    mode: 'design',
    level: 'root',
  });
  show(EDGE);
  off = [installKeyboard(), installClipboard((nodes) => void deleteSelection(nodes))];
});
afterEach(() => {
  for (const f of off) f();
  vi.useRealTimers();
  cleanup();
});

describe('keyboard', () => {
  it('Delete takes three selected nodes in one command; Run mode deletes nothing', () => {
    canvas();
    const three = [id('validate'), id('rollback'), id('backup-config')];
    act(() => useUi.getState().select({ nodes: three }));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Delete' });
    });
    expect(commands()).toHaveLength(1);
    const cmd = commands()[0] as Extract<FlowCommand, { kind: 'deleteNodes' }>;
    expect(cmd.kind).toBe('deleteNodes');
    expect([...cmd.ids].sort()).toEqual([...three].sort());
    posted.length = 0;
    act(() => useUi.getState().setMode('run'));
    act(() => useUi.getState().select({ nodes: three }));
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Delete' });
    });
    expect(commands()).toEqual([]);
  });

  it('cut: the YAML on the clipboard and one deleteNodes', () => {
    act(() => useUi.getState().select({ node: id('validate') }));
    expect(clipboard('cut')).toContain('key: validate');
    expect(commands()).toEqual([{ kind: 'deleteNodes', ids: [id('validate')], edges: [] }]);
  });

  it('Ctrl+D duplicates without a position (+40, +40) and without the clipboard', () => {
    act(() => useUi.getState().select({ node: id('validate') }));
    fireEvent.keyDown(document.body, { key: 'd', ctrlKey: true });
    const cmd = commands()[0] as Extract<FlowCommand, { kind: 'pasteNodes' }>;
    expect(cmd.kind).toBe('pasteNodes');
    expect(cmd.text).toContain('key: validate');
    expect(cmd).not.toHaveProperty('position');
  });

  it('F2 puts the cursor in the inspector Title, text selected', () => {
    act(() => useUi.getState().select({ node: id('validate') }));
    render(<Inspector id={id('validate')} />);
    act(() => {
      fireEvent.keyDown(document.body, { key: 'F2' });
    });
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    expect([title.selectionStart, title.selectionEnd]).toEqual([0, title.value.length]);
  });

  it('Escape closes the innermost thing only, then clears the selection; in a field it keeps it', () => {
    act(() => {
      useUi.getState().select({ node: id('validate') });
      useUi.getState().openContextMenu({ target: { kind: 'pane' }, x: 0, y: 0 });
    });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUi.getState().contextMenu).toBeNull();
    expect(useUi.getState().selection).toEqual({ node: id('validate') });
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(useUi.getState().selection).toEqual({ node: id('validate') });
    input.remove();
    // The properties page closes itself; the selection behind it stays.
    act(() => useUi.getState().openProperties(id('validate')));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUi.getState().selection).toEqual({ node: id('validate') });
    act(() => useUi.getState().closeProperties());
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(useUi.getState().selection).toEqual({});
  });

  it('Alt+Up leaves a subflow and selects it; ? opens the sheet, not from a field', () => {
    show(OS);
    const sub = idIn(OS, 'upgrade-os');
    act(() => useUi.getState().setLevel(sub));
    fireEvent.keyDown(document.body, { key: 'ArrowUp', altKey: true });
    expect(useUi.getState().level).toBe('root');
    expect(useUi.getState().selection).toEqual({ node: sub });
    canvas();
    const input = document.body.appendChild(document.createElement('input'));
    fireEvent.keyDown(input, { key: '?' });
    expect(useUi.getState().cheatSheet).toBe(false);
    input.remove();
    act(() => {
      fireEvent.keyDown(document.body, { key: '?' });
    });
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(document.querySelector('[data-shortcut="duplicate"]')?.textContent).toContain('Ctrl+D');
    act(() => {
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(useUi.getState().cheatSheet).toBe(false);
  });

  it('Shift+F10 or the Menu key with the focus on the page: our menu for the selection', () => {
    canvas();
    act(() => useUi.getState().select({ node: id('validate') }));
    let shown = true;
    act(() => {
      shown = fireEvent.contextMenu(document.body);
    });
    expect(shown).toBe(false);
    expect(useUi.getState().contextMenu?.target).toEqual({ kind: 'node', id: id('validate') });
    act(() => useUi.getState().openContextMenu(null));
    act(() => useUi.getState().select({}));
    act(() => {
      fireEvent.contextMenu(document.body);
    });
    expect(useUi.getState().contextMenu?.target).toEqual({ kind: 'pane' });
    // In a field the native menu stays (copy, paste of text).
    act(() => useUi.getState().openContextMenu(null));
    const input = document.body.appendChild(document.createElement('input'));
    expect(fireEvent.contextMenu(input)).toBe(true);
    input.remove();
  });

  it('arrow keys nudge the focused node; the move is saved once, after the keys rest', () => {
    vi.useFakeTimers();
    canvas();
    act(() => useUi.getState().select({ node: id('validate') }));
    const el = document.querySelector(
      `.react-flow__node[data-id="${id('validate')}"]`,
    ) as HTMLElement;
    act(() => el.focus());
    for (let i = 0; i < 3; i++)
      act(() => {
        fireEvent.keyDown(el, { key: 'ArrowRight' });
      });
    expect(commands()).toEqual([]);
    act(() => vi.advanceTimersByTime(600));
    const moves = commands().filter((c) => c?.kind === 'moveNodes');
    expect(moves).toHaveLength(1);
    const was = EDGE.layout?.[id('validate')] as { x: number; y: number };
    const now = (moves[0] as Extract<FlowCommand, { kind: 'moveNodes' }>).positions[id('validate')];
    expect(now?.y).toBe(was.y);
    expect(now?.x).toBeGreaterThan(was.x);
  });
});

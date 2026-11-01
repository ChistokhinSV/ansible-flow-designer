// AFD-17: Ctrl+C / Ctrl+V on the canvas arrive as the page's copy and paste events. Copy puts the
// selected nodes on the clipboard as flow YAML; paste sends one command for the open level at the
// pointer and selects what was pasted. Fields and selected text keep the browser's own behaviour.
// A right-click selects the node under it (product-owner feedback); the menu it opens (AFD-18) is
// tested in contextMenu.test.tsx.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ReactFlowProvider } from '@xyflow/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { CLIP_HEADER, parseClip } from '../../../src/core/flow/clipboard';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { FlowCanvas } from '../../../src/webview/canvas/FlowCanvas';
import { installClipboard, setPastePlace } from '../../../src/webview/clipboard';
import { Details } from '../../../src/webview/details/Details';
import { SelectionPanel } from '../../../src/webview/panels/SelectionPanel';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
type Posted = {
  type: string;
  reqId?: number;
  command?: FlowCommand;
  text?: string;
  count?: number;
};
const sent = (type: string) => (posted as Posted[]).filter((m) => m.type === type);

/** jsdom has no ClipboardEvent: a plain event with clipboardData does the same for listeners. */
function clipboard(type: 'copy' | 'paste', text = '', target: EventTarget = document) {
  const data = new Map([['text/plain', text]]);
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', {
    value: {
      getData: (t: string) => data.get(t) ?? '',
      setData: (t: string, v: string) => data.set(t, v),
    },
  });
  target.dispatchEvent(event);
  return { prevented: event.defaultPrevented, text: data.get('text/plain') ?? '' };
}

async function ack(pasted: string[] | null, error?: string) {
  await act(async () => {
    for (const m of sent('command'))
      window.dispatchEvent(
        new MessageEvent('message', {
          data: pasted
            ? { type: 'ack', reqId: m.reqId, ok: true, created: pasted[0], pasted }
            : { type: 'ack', reqId: m.reqId, ok: false, error },
        }),
      );
  });
}

let uninstall: () => void;
beforeEach(() => {
  posted.length = 0;
  useUi.setState({ snapshot: null, selection: {}, toasts: [], mode: 'design', level: 'root' });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    });
  });
  uninstall = installClipboard(() => undefined);
  setPastePlace(() => ({ x: 400, y: 300 }));
});
afterEach(() => {
  uninstall();
  document.getSelection()?.removeAllRanges();
  cleanup();
});

describe('copy', () => {
  it('Ctrl+C: the selected nodes as flow YAML with their wires', () => {
    act(() => useUi.getState().select({ nodes: [id('push-baseline'), id('backup-config')] }));
    const { prevented, text } = clipboard('copy');
    expect(prevented).toBe(true);
    expect(text.startsWith(CLIP_HEADER)).toBe(true);
    const clip = parseClip(text);
    if (typeof clip === 'string') throw new Error(clip);
    expect(clip.nodes.map((n) => n.key)).toEqual(['backup-config', 'push-baseline']);
    expect(clip.edges).toHaveLength(1);
  });

  it('nothing selected, a focused field or selected text: the browser copies as usual', () => {
    expect(clipboard('copy').prevented).toBe(false);
    act(() => useUi.getState().select({ node: id('validate') }));
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    expect(clipboard('copy', '', input).prevented).toBe(false);
    input.remove();
    const p = document.body.appendChild(document.createElement('p'));
    p.textContent = 'Fails before any change';
    document.getSelection()?.selectAllChildren(p);
    expect(clipboard('copy').prevented).toBe(false);
    p.remove();
  });

  it('the Copy buttons send the text to the host, which writes the clipboard', () => {
    act(() => useUi.getState().select({ node: id('validate') }));
    render(<Details id={id('validate')} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy node' }));
    cleanup();
    render(<SelectionPanel ids={[id('precheck'), id('validate')]} />);
    act(() => useUi.getState().select({ nodes: [id('precheck'), id('validate')] }));
    fireEvent.click(screen.getByRole('button', { name: /Copy nodes/ }));
    expect(sent('copyText').map((m) => m.count)).toEqual([1, 2]);
    expect(sent('copyText').every((m) => m.text?.startsWith(CLIP_HEADER))).toBe(true);
  });
});

describe('paste', () => {
  it('Ctrl+V: one command for the open level at the pointer; the pasted nodes are selected', async () => {
    const text = '- type: task\n  title: Check NTP\n- type: task\n  title: Check AAA\n';
    expect(clipboard('paste', text).prevented).toBe(true);
    expect(sent('command').map((m) => m.command)).toEqual([
      { kind: 'pasteNodes', text, level: 'root', position: { x: 400, y: 300 } },
    ]);
    await ack(['01JC0000000000000000000001', '01JC0000000000000000000002']);
    expect(useUi.getState().selection).toEqual({
      nodes: ['01JC0000000000000000000001', '01JC0000000000000000000002'],
    });
    // The same spot again: the copy steps aside instead of covering the first.
    posted.length = 0;
    clipboard('paste', text);
    expect(sent('command')[0]?.command).toMatchObject({ position: { x: 432, y: 332 } });
  });

  it('inside a subflow the paste goes to that level; a refusal is shown', async () => {
    act(() => useUi.getState().setLevel(id('push-baseline')));
    clipboard('paste', 'hello');
    expect(sent('command')[0]?.command).toMatchObject({ level: id('push-baseline') });
    await ack(null, 'The clipboard does not hold flow nodes');
    expect(useUi.getState().toasts.at(-1)?.text).toBe('The clipboard does not hold flow nodes');
  });

  it('a flow shown by auto layout: the paste writes what the canvas shows for every node', () => {
    const os = parse(
      readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
    ) as FlowDocument;
    const auto = Object.fromEntries(os.nodes.map((n, i) => [n.id, { x: i * 10, y: i * 100 }]));
    act(() => {
      useUi.getState().setSnapshot({
        docVersion: 2,
        doc: os,
        stale: false,
        findings: [],
        openPorts: [],
        autoPositions: auto,
      });
    });
    clipboard('paste', 'key: x\ntype: task\n');
    expect(sent('command')[0]?.command).toMatchObject({ kind: 'pasteNodes', freeze: auto });
  });

  it('a focused field keeps its paste; run mode is read-only', () => {
    const input = document.body.appendChild(document.createElement('input'));
    input.focus();
    expect(clipboard('paste', 'key: x\ntype: task\n', input).prevented).toBe(false);
    input.remove();
    act(() => useUi.getState().setMode('run'));
    clipboard('paste', 'key: x\ntype: task\n');
    expect(sent('command')).toEqual([]);
    expect(useUi.getState().toasts.at(-1)?.text).toMatch(/read-only/);
  });
});

describe('right-click', () => {
  const canvas = () =>
    render(
      <ReactFlowProvider>
        <div style={{ width: 3000, height: 800 }}>
          <FlowCanvas cull={false} />
        </div>
      </ReactFlowProvider>,
    );
  const nodeEl = (key: string) =>
    document.querySelector(`.react-flow__node[data-id="${id(key)}"]`) as HTMLElement;

  it('selects the node under it, unless that node is in the selected group', () => {
    act(() => useUi.getState().select({ node: id('precheck') }));
    canvas();
    let shown = true;
    act(() => {
      shown = fireEvent.contextMenu(nodeEl('validate'), { clientX: 10, clientY: 10 });
    });
    // Our menu, not VS Code's: the event's default is prevented.
    expect(shown).toBe(false);
    expect(useUi.getState().selection).toEqual({ node: id('validate') });
    expect(clipboard('copy').text).toContain('key: validate');

    const group = [id('backup-config'), id('push-baseline')];
    act(() => useUi.getState().select({ nodes: group }));
    act(() => {
      fireEvent.contextMenu(nodeEl('push-baseline'), { clientX: 10, clientY: 10 });
    });
    expect(useUi.getState().selection).toEqual({ nodes: group });
  });
});

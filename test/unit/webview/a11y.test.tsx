// AFD-47: keyboard and accessibility, with our own checks (decision 13: no axe-core). Every control
// has a name and every field a label; the selected node's ports are tab stops that open their menu
// with Enter; a pick finishes from the keyboard; dialogs take, keep and give back the focus; the
// new shortcuts; and the core tasks done with keys only.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { App } from '../../../src/webview/App';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/edge-baseline.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id as string;
const keyOf = (i: string | null | undefined) => doc.nodes.find((n) => n.id === i)?.key;
type Posted = { type: string; command?: FlowCommand };
const commands = () =>
  (posted as Posted[]).filter((m) => m.type === 'command').map((m) => m.command as FlowCommand);
const settle = () => act(() => new Promise((r) => setTimeout(r, 10)));
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    fireEvent.keyDown(el, { key: k, ...init });
  });
/** Enter on a focused button: the key, then the click a browser makes of it (jsdom makes none). */
const press = (el: HTMLElement) => {
  act(() => el.focus());
  let go = true;
  act(() => {
    go = fireEvent.keyDown(el, { key: 'Enter' });
  });
  if (go && el.tagName === 'BUTTON')
    act(() => {
      fireEvent.click(el);
    });
};
const nodeEl = (key: string) =>
  document.querySelector(`.react-flow__node[data-id="${id(key)}"]`) as HTMLElement;
const portEl = (key: string, port: string) =>
  nodeEl(key).querySelector(`[data-port="${port}"]`) as HTMLElement;

/** The accessible name, as far as these controls need it: label, labelled-by, text, title. */
function nameOf(el: Element): string {
  const by = el.getAttribute('aria-labelledby');
  return (
    (
      el.getAttribute('aria-label') ??
      (by
        ? by
            .split(' ')
            .map((i) => document.getElementById(i)?.textContent ?? '')
            .join(' ')
        : '') ??
      ''
    ).trim() ||
    (el.textContent ?? '').trim() ||
    (el.getAttribute('title') ?? '').trim()
  );
}

function labelOf(el: HTMLElement): string {
  const own = nameOf(el);
  if (el.getAttribute('aria-label') || el.getAttribute('aria-labelledby')) return own;
  const byFor = el.id ? document.querySelector(`label[for="${el.id}"]`)?.textContent : undefined;
  return (byFor ?? el.closest('label')?.textContent ?? el.getAttribute('title') ?? '').trim();
}

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
    pickAt: null,
    decide: null,
    detailsTab: 'general',
    pendingBinding: null,
    leave: null,
    cheatSheet: false,
    focusRequest: null,
    toasts: [],
    mode: 'design',
    level: ROOT,
    testMode: true,
  });
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(model),
      autoPositions: {},
    }),
  );
});
afterEach(cleanup);

describe('names and labels', () => {
  it('every control has a name and every field a label, in each mode', async () => {
    render(<App />);
    act(() => useUi.getState().select({ node: id('validate') }));
    await settle();
    for (const mode of ['design', 'code', 'run'] as const) {
      act(() => useUi.getState().setMode(mode));
      const controls = document.querySelectorAll(
        'button, [role="button"], [role="tab"], [role="menuitem"], a[href]',
      );
      const nameless = [...controls].filter((c) => !nameOf(c)).map((c) => c.outerHTML.slice(0, 90));
      expect(nameless, mode).toEqual([]);
      const fields = document.querySelectorAll<HTMLElement>(
        'input:not([type="hidden"]), select, textarea, [contenteditable="true"]',
      );
      const unlabelled = [...fields]
        .filter((f) => !labelOf(f))
        .map((f) => f.outerHTML.slice(0, 90));
      expect(unlabelled, mode).toEqual([]);
    }
  });

  it('a node says its type, title, status and open fail ports', () => {
    render(<App />);
    const label = nodeEl('precheck').getAttribute('aria-label') ?? '';
    expect(label).toMatch(/^Task Pre-checks, \w+/);
    const open = openFailPorts(model).filter((p) => p.node === id('precheck')).length;
    if (open) expect(label).toContain(`${open} open fail port`);
    expect(nodeEl('start').getAttribute('aria-label')).toBe('Start Start');
  });
});

describe('ports', () => {
  it("the selected node's ports are tab stops; Enter opens the port's menu", () => {
    render(<App />);
    act(() => useUi.getState().select({ node: id('validate') }));
    const ports = [...nodeEl('validate').querySelectorAll<HTMLElement>('[data-port]')];
    expect(ports.length).toBeGreaterThan(1);
    for (const p of ports) {
      expect(p.getAttribute('role')).toBe('button');
      expect(p.tabIndex).toBe(0);
    }
    for (const p of nodeEl('precheck').querySelectorAll<HTMLElement>('[data-port]'))
      expect(p.tabIndex).toBe(-1);
    const failed = portEl('validate', 'failed_hosts');
    act(() => failed.focus());
    key(failed, 'Enter');
    expect(useUi.getState().portMenu?.ref).toEqual({ node: id('validate'), port: 'failed_hosts' });
    expect(screen.getByRole('menu')).toBeTruthy();
  });

  it('Code and Run modes read the graph: ports are no tab stops there', () => {
    render(<App />);
    act(() => {
      useUi.getState().select({ node: id('validate') });
      useUi.getState().setMode('run');
    });
    for (const p of nodeEl('validate').querySelectorAll<HTMLElement>('[data-port]')) {
      expect(p.tabIndex).toBe(-1);
      expect(p.getAttribute('aria-disabled')).toBe('true');
    }
  });
});

describe('picking a node with the keyboard', () => {
  it('Tab and the arrow keys walk the nodes, the bar names the one shown, Enter wires it', () => {
    render(<App />);
    const ref = { node: id('rollback'), port: 'ok_hosts' };
    act(() => useUi.getState().setPick({ mode: 'to', ref }));
    expect(document.querySelector('[data-pick]')?.textContent).toContain('Tab or the arrow keys');
    key(document.body, 'Tab');
    const first = useUi.getState().pickAt;
    expect(first).toBeTruthy();
    expect(first).not.toBe(ref.node);
    expect(nodeEl(keyOf(first) as string).firstElementChild?.classList).toContain('afd-pick-at');
    key(document.body, 'ArrowDown');
    const second = useUi.getState().pickAt;
    expect(second).not.toBe(first);
    expect(document.querySelector('[data-pick-at]')?.textContent).toContain(
      doc.nodes.find((n) => n.id === second)?.title,
    );
    key(document.body, 'Tab', { shiftKey: true });
    expect(useUi.getState().pickAt).toBe(first);
    key(document.body, 'Enter');
    expect(commands()).toContainEqual({
      kind: 'connect',
      from: ref,
      to: { node: first, port: 'in' },
    });
    expect(useUi.getState().pick).toBeNull();
  });
});

describe('dialogs', () => {
  it('Accept with Reason from a port: focus in, Tab stays inside, Escape gives it back to the port', async () => {
    render(<App />);
    act(() => useUi.getState().select({ node: id('precheck') }));
    const open = openFailPorts(model).find((p) => p.node === id('precheck'));
    if (!open) throw new Error('the sample has no open fail port');
    const port = portEl('precheck', open.port);
    act(() => port.focus());
    key(port, 'Enter');
    press(screen.getByRole('menuitem', { name: /Accept with Reason/ }));
    await settle();
    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Reported by hand' },
    });
    const buttons = within(dialog).getAllByRole('button');
    const last = buttons.at(-1) as HTMLElement;
    act(() => last.focus());
    key(last, 'Tab');
    expect(document.activeElement).toBe(within(dialog).getByRole('textbox'));
    key(document.activeElement as Element, 'Tab', { shiftKey: true });
    expect(document.activeElement).toBe(last);
    key(document.activeElement as Element, 'Escape');
    await settle();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(port);
  });
});

describe('shortcuts', () => {
  it('Ctrl+A selects the level; a field keeps its own Select All', () => {
    render(<App />);
    key(document.body, 'a', { ctrlKey: true });
    expect(useUi.getState().selection.nodes).toHaveLength(
      model.levels.get(ROOT)?.nodes.length ?? 0,
    );
    act(() => useUi.getState().select({}));
    const input = document.body.appendChild(document.createElement('input'));
    key(input, 'a', { ctrlKey: true });
    expect(useUi.getState().selection).toEqual({});
    input.remove();
  });

  it('Shift+1 fits the level, but types ! in a chip field (AFD-222)', () => {
    render(<App />);
    const bang = { key: '!', code: 'Digit1', shiftKey: true };
    // fireEvent returns false when a handler called preventDefault.
    expect(fireEvent.keyDown(document.body, bang)).toBe(false);
    const field = document.body.appendChild(document.createElement('div'));
    field.setAttribute('contenteditable', 'true');
    expect(fireEvent.keyDown(field, bang)).toBe(true);
    field.remove();
  });

  it('Alt+1, Alt+2, Alt+3 switch the mode; the first visit to Code compiles the code', () => {
    render(<App />);
    key(document.body, '2', { altKey: true, code: 'Digit2' });
    expect(useUi.getState().mode).toBe('code');
    expect(posted).toContainEqual({ type: 'sync' });
    key(document.body, '3', { altKey: true, code: 'Digit3' });
    expect(useUi.getState().mode).toBe('run');
    key(document.body, '1', { altKey: true, code: 'Digit1' });
    expect(useUi.getState().mode).toBe('design');
  });

  it('Enter opens a selected subflow, or moves into the Details of another node', async () => {
    render(<App />);
    act(() => useUi.getState().select({ node: id('validate') }));
    key(document.body, 'Enter');
    await settle();
    expect(document.activeElement?.getAttribute('role')).toBe('tab');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    // The arrow keys move between the Details tabs and open them.
    key(document.activeElement as Element, 'ArrowRight');
    expect(useUi.getState().detailsTab).not.toBe('general');
    expect(document.activeElement?.getAttribute('aria-selected')).toBe('true');
    act(() => useUi.getState().select({ node: id('push-baseline') }));
    key(document.body, 'Enter');
    expect(useUi.getState().level).toBe(id('push-baseline'));
  });

  it('N in Run mode does nothing', () => {
    render(<App />);
    act(() => useUi.getState().setMode('run'));
    key(document.body, 'n');
    expect(useUi.getState().quickAdd).toBeNull();
  });
});

describe('core tasks with the keyboard only', () => {
  it('1. add a step after another: select, N, type the title, Enter (lands on its wire, AFD-71)', async () => {
    render(<App />);
    act(() => useUi.getState().select({ node: id('validate') }));
    key(document.body, 'n');
    await settle();
    const title = within(screen.getByRole('dialog')).getByLabelText('Title') as HTMLInputElement;
    expect(document.activeElement).toBe(title);
    fireEvent.change(title, { target: { value: 'Notify the owner' } });
    act(() => {
      fireEvent.submit(title.form as HTMLFormElement);
    });
    const add = commands().find((c) => c.kind === 'addNode') as Extract<
      FlowCommand,
      { kind: 'addNode' }
    >;
    expect(add.title).toBe('Notify the owner');
    // Validate already continues to Done: the new step goes between them, not off `always`.
    const onward = model.levels
      .get(model.nodes.get(id('validate'))?.level as string)
      ?.edges.find((e) => e.from.node === id('validate') && e.from.port === 'ok_hosts');
    expect(add.insertOn).toBe(onward?.id);
    expect(add.connectFrom).toBeUndefined();
  });

  it('2. wire a failure path: Tab to the open port, Enter, a pattern, Enter', () => {
    render(<App />);
    const open = openFailPorts(model)[0];
    if (!open) throw new Error('the sample has no open fail port');
    act(() => useUi.getState().select({ node: open.node }));
    const port = document.querySelector(
      `.react-flow__node[data-id="${open.node}"] [data-port="${open.port}"]`,
    ) as HTMLElement;
    act(() => port.focus());
    key(port, 'Enter');
    press(screen.getByRole('menuitem', { name: /Notify On-Call and Stop/ }));
    expect(commands().map((c) => c.kind)).toContain('applyPattern');
  });
});

// AFD-30: panel bugs found in the improvement review. Escape never drops a staged binding or
// commits what it reverted, panels go read-only on a broken file, inner steps show their titles,
// and an open subflow level describes that subflow.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CollectionFile } from '../../../src/core/catalog/types';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel, ROOT } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { CatalogRequest, RunView, Snapshot } from '../../../src/core/protocol';
import { runVerdict } from '../../../src/core/run/view';
import { App } from '../../../src/webview/App';
import { DecisionDialog } from '../../../src/webview/panels/DecisionDialog';
import { Inspector } from '../../../src/webview/panels/Inspector';
import { PickBar } from '../../../src/webview/panels/PickBar';
import { Properties } from '../../../src/webview/properties/Properties';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
/** A subflow and one of its inner steps. */
const subflow = [...model.nodes.values()].find(
  (e) => e.level === ROOT && e.node.type === 'subflow' && e.node.subflow?.nodes?.length,
)?.node as FlowNode;
const inner = [...model.nodes.values()].find(
  (e) => e.level === subflow.id && e.node.type === 'task',
)?.node as FlowNode;
const task = [...model.nodes.values()].find((e) => e.node.key === 'set-boot-variable')
  ?.node as FlowNode;

function snapshotOf(over: Partial<Snapshot> = {}): Snapshot {
  return {
    docVersion: 1,
    doc,
    stale: false,
    findings: [],
    openPorts: openFailPorts(model),
    autoPositions: {},
    ...over,
  };
}

const commands = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'command')
    .map((m) => (m as { command: FlowCommand }).command);

const ios = JSON.parse(
  readFileSync(join(__dirname, '../../fixtures/catalog/files/cisco.ios@9.0.3.json'), 'utf8'),
) as CollectionFile;

/** Answers the properties page's catalog requests: the bound module's docs, no search hits. */
async function answerCatalog() {
  await act(() => new Promise((r) => setTimeout(r, 5)));
  for (const m of posted as { type: string; reqId: number; request: CatalogRequest }[]) {
    if (m.type !== 'catalog') continue;
    const r = m.request;
    const result =
      r.op === 'doc'
        ? { ...ios.plugins.find((p) => p.fqcn === r.fqcn), collection_version: '9.0.3' }
        : [];
    act(() => {
      window.dispatchEvent(
        new MessageEvent('message', {
          data: { type: 'catalogReply', reqId: m.reqId, ok: true, result },
        }),
      );
    });
  }
  await act(async () => {});
}

beforeEach(() => {
  posted.length = 0;
  useUi.setState({
    snapshot: null,
    properties: null,
    pick: null,
    decide: null,
    level: ROOT,
    mode: 'design',
    selection: {},
    catalog: { state: 'ready', environment: 'docker: afd-ee:2.19', platforms: ['cisco.ios'] },
  });
  act(() => useUi.getState().setSnapshot(snapshotOf()));
});
afterEach(cleanup);

describe('Escape (AFD-30)', () => {
  it('asks before a staged binding is dropped; Keep editing and Discard do what they say', async () => {
    act(() => useUi.getState().openProperties(task.id, 'implementation'));
    render(<Properties node={task.id} />);
    // Stage a change on the Implementation tab, once the module's docs arrived: a register name.
    await answerCatalog();
    const register = screen.getByLabelText(/Register result as/) as HTMLInputElement;
    fireEvent.change(register, { target: { value: 'changed_result' } });
    expect(screen.getByText('Save binding').hasAttribute('disabled')).toBe(false);

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.getByRole('alertdialog', { name: 'Discard the binding change?' })).toBeTruthy();
    expect(useUi.getState().properties).not.toBeNull();
    // Escape again (or Keep editing) goes back to the page, with the change kept.
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect((screen.getByLabelText(/Register result as/) as HTMLInputElement).value).toBe(
      'changed_result',
    );
    fireEvent.keyDown(window, { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(useUi.getState().properties).toBeNull();
    expect(commands()).toEqual([]);
  });

  it('closes a page without changes at once', () => {
    act(() => useUi.getState().openProperties(task.id, 'general'));
    render(<Properties node={task.id} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(useUi.getState().properties).toBeNull();
  });

  it('reverts a field without committing it, and leaves the page open', () => {
    act(() => useUi.getState().openProperties(task.id, 'general'));
    render(<Properties node={task.id} />);
    const title = screen.getByLabelText('Title') as HTMLInputElement;
    title.focus();
    fireEvent.change(title, { target: { value: 'Something else' } });
    fireEvent.keyDown(title, { key: 'Escape' });
    expect(title.value).toBe(task.title);
    expect(commands()).toEqual([]);
    expect(useUi.getState().properties).not.toBeNull();
  });
});

describe('read-only panels (AFD-30)', () => {
  it('disables the fields while the text does not parse, and enables them again', () => {
    act(() => useUi.getState().setSnapshot(snapshotOf({ stale: true })));
    render(<Inspector id={task.id} />);
    // A field is disabled through its fieldset.
    const locked = () => !!screen.getByLabelText('Title').closest('fieldset')?.disabled;
    expect(locked()).toBe(true);
    // Leaving the panel through the text stays possible.
    const text = screen.getByRole('button', { name: 'Show in text' });
    expect(text.closest('fieldset')).toBeNull();
    act(() => useUi.getState().setSnapshot(snapshotOf({ docVersion: 2 })));
    expect(locked()).toBe(false);
  });

  it('deletes from the inspector through the selection delete (one deleteNodes)', () => {
    render(<Inspector id={task.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Delete node' }));
    expect(commands()).toEqual([{ kind: 'deleteNodes', ids: [task.id], edges: [] }]);
  });
});

describe('inner steps and levels (AFD-30)', () => {
  it('names an inner step by its title in the pick bar and the decision dialog', () => {
    act(() => useUi.getState().setPick({ mode: 'to', ref: { node: inner.id, port: 'ok_hosts' } }));
    act(() => useUi.getState().setDecide({ node: inner.id, port: 'failed_hosts' }));
    render(
      <>
        <PickBar />
        <DecisionDialog />
      </>,
    );
    expect(screen.getAllByText(inner.title).length).toBe(2);
    expect(screen.queryByText(inner.id)).toBeNull();
  });

  it('describes the open subflow when nothing is selected', () => {
    render(<App />);
    expect(screen.getByRole('complementary', { name: 'Flow description' })).toBeTruthy();
    act(() => useUi.getState().setLevel(subflow.id));
    const panel = screen.getByRole('complementary', { name: 'Subflow description' });
    expect(panel.querySelector(`[data-level-context="${subflow.id}"]`)).toBeTruthy();
    expect((screen.getByLabelText('Title') as HTMLInputElement).value).toBe(subflow.title);
  });
});

describe('run verdict (AFD-30)', () => {
  it('is the same for the top bar and the run panel: routed failures are not ok', () => {
    const base = { id: 'r', mode: 'check', state: 'done', startedAt: '', rc: 0 } as RunView;
    const summary = { hosts: ['a'], outcome: {}, failures: [], stoppedEarly: false };
    expect(runVerdict({ ...base, summary } as unknown as RunView)).toEqual({ ok: true, failed: 0 });
    expect(
      runVerdict({
        ...base,
        summary: { ...summary, failures: [{ host: 'a', node: 'n', port: 'failed_hosts' }] },
      } as unknown as RunView),
    ).toEqual({ ok: false, failed: 1 });
  });
});

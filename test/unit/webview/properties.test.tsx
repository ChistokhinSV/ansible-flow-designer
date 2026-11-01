// M5 (AFD-8): node properties page (mockup 11): find a module, read its docs, configure it with
// input chips, and save the binding as one setBinding command.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import type { CatalogPlugin, CollectionFile, SearchHit } from '../../../src/core/catalog/types';
import type { FlowCommand } from '../../../src/core/flow/commands';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import type { CatalogRequest, HostMessage, Snapshot } from '../../../src/core/protocol';
import { Details } from '../../../src/webview/details/Details';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const FIXTURES = join(__dirname, '../../fixtures/catalog/files');
const ios = JSON.parse(
  readFileSync(join(FIXTURES, 'cisco.ios@9.0.3.json'), 'utf8'),
) as CollectionFile;
const pluginOf = (fqcn: string) => ios.plugins.find((p) => p.fqcn === fqcn) as CatalogPlugin;

const doc = parse(
  readFileSync(join(__dirname, '../../../examples/os-upgrade.flow.yaml'), 'utf8'),
) as FlowDocument;
const nodeOf = (key: string): FlowNode => {
  for (const { node } of buildModel(doc).nodes.values()) if (node.key === key) return node;
  throw new Error(key);
};

function snapshotOf(d: FlowDocument): Snapshot {
  return {
    docVersion: 1,
    doc: d,
    stale: false,
    findings: [],
    openPorts: openFailPorts(buildModel(d)),
    autoPositions: {},
  };
}

const host = (m: HostMessage) =>
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data: m }));
  });

/** Answers every catalog request posted so far that has not been answered yet. */
let answered = 0;
async function answer(reply: (r: CatalogRequest) => unknown) {
  // Requests go out on a timer (typing debounce).
  await act(() => new Promise((r) => setTimeout(r, 5)));
  const requests = posted
    .slice(answered)
    .filter(
      (m): m is { type: 'catalog'; reqId: number; request: CatalogRequest } =>
        (m as { type: string }).type === 'catalog',
    );
  answered = posted.length;
  for (const m of requests)
    host({ type: 'catalogReply', reqId: m.reqId, ok: true, result: reply(m.request) });
  await act(async () => {});
}

const catalog = (r: CatalogRequest): unknown => {
  if (r.op === 'doc') return { ...pluginOf(r.fqcn), collection_version: '9.0.3' };
  if (r.op === 'search')
    return ios.plugins.map(
      (p): SearchHit => ({
        fqcn: p.fqcn,
        type: 'module',
        collection: p.collection,
        short_description: p.short_description,
        score: 1,
        match: '',
        badges: ['check-mode'],
        dimmed: false,
      }),
    );
  return [];
};

const commands = () =>
  posted
    .filter((m) => (m as { type: string }).type === 'command')
    .map((m) => (m as { command: FlowCommand }).command);

beforeEach(() => {
  posted.length = 0;
  answered = 0;
  useUi.setState({
    snapshot: null,
    detailsTab: 'general',
    pendingBinding: null,
    leave: null,
    catalog: { state: 'ready', environment: 'docker: afd-ee:2.19', platforms: ['cisco.ios'] },
  });
  act(() => useUi.getState().setSnapshot(snapshotOf(doc)));
});
afterEach(cleanup);

function open(key: string) {
  const id = nodeOf(key).id;
  act(() => useUi.getState().openDetails(id, 'binding'));
  render(<Details id={id} />);
  return id;
}

describe('Details: Binding (AFD-43)', () => {
  it('shows the bound module, its docs and the configured parameters with input chips', async () => {
    open('set-boot-variable');
    await answer(catalog);
    // AFD-43: the Details panel, docked, on the Binding tab.
    expect(screen.getByRole('heading', { name: 'Set boot variable' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Binding' }).getAttribute('aria-selected')).toBe('true');
    const understand = screen.getByRole('region', { name: 'Understand' });
    expect(within(understand).getByText('cisco.ios.ios_config', { selector: 'h3' })).toBeTruthy();
    expect(within(understand).getByText(/cisco.ios 9.0.3/)).toBeTruthy();
    const configure = screen.getByRole('region', { name: 'Configure' });
    const lines = configure.querySelector('[data-param="lines"]') as HTMLElement;
    expect(lines.querySelector('[data-ref="target_image"]')?.textContent).toBe('target_image');
    expect(within(configure).getByText('target_image comes from flow inputs')).toBeTruthy();
    expect(configure.querySelector('[data-binding-preview]')?.textContent).toContain(
      'save_when: modified',
    );
    // Nothing changed yet: nothing to save, no pending bar.
    expect(screen.queryByText('Save Binding')).toBeNull();
  });

  it('stages edits and saves them as one setBinding command', async () => {
    const id = open('set-boot-variable');
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    const select = within(configure).getByLabelText(/save_when/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'always' } });
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Understand' })).getByRole('button', {
        name: 'backup_path',
      }),
    );
    fireEvent.click(screen.getByText('Save Binding'));
    const sent = commands();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'setBinding',
      id,
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_config',
        params: { save_when: 'always' },
        register: 'boot_result',
      },
      outputs: { backup_path: { type: 'string', from: 'impl.register.backup_path' } },
    });
  });

  it('finds a module from the intent and binds an unbound node, with @ adding a flow input', async () => {
    const id = open('post-checks');
    await answer(catalog);
    // The intent or title is the first query; results come from the catalog.
    const search = posted.find(
      (m) => (m as { request?: CatalogRequest }).request?.op === 'search',
    ) as {
      request: { query: string };
    };
    expect(search.request.query.length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('cisco.ios.ios_command', { selector: '.afd-result-name' }));
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    expect(within(configure).getByText('Required parameters missing: commands')).toBeTruthy();
    // @ on the first commands line offers the flow input target_image (not yet a node input).
    fireEvent.click(
      within(configure).getByRole('button', { name: /Insert an input into commands 1/ }),
    );
    fireEvent.mouseDown(within(configure).getByRole('option', { name: /flow.target_image/ }));
    expect(within(configure).getByText('Required parameters set')).toBeTruthy();
    fireEvent.click(screen.getByText('Save Binding'));
    expect(commands()[0]).toMatchObject({
      kind: 'setBinding',
      id,
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_command',
        params: { commands: ['{{ target_image }}'] },
      },
      inputs: { target_image: { type: 'string', from: 'flow.target_image' } },
    });
  });
});

describe('Details: Execution (AFD-26)', () => {
  function openExecution(key: string) {
    const id = nodeOf(key).id;
    act(() => useUi.getState().openDetails(id, 'execution'));
    render(<Details id={id} />);
    return id;
  }

  it('edits task keywords as YAML and refuses what the flow models itself', () => {
    const id = openExecution('set-boot-variable');
    const box = screen.getByLabelText(/Task keywords/) as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: 'tags: [x]' } });
    fireEvent.blur(box);
    expect(screen.getByText('tags is modelled by the flow: use settings.tags')).toBeTruthy();
    expect(commands()).toEqual([]);
    fireEvent.change(box, {
      target: { value: 'when: ansible_network_os == "ios"\nrun_once: true' },
    });
    fireEvent.blur(box);
    expect(commands()).toEqual([
      {
        kind: 'updateNode',
        id,
        patch: { keywords: { when: 'ansible_network_os == "ios"', run_once: true } },
      },
    ]);
  });

  it('says a playbook binding takes no keywords, and shows nothing for an unbound node', () => {
    const bound = doc.nodes.find((n) => n.impl?.kind === 'playbook');
    if (bound) {
      openExecution(bound.key);
      expect(screen.getByText(/do not apply to a playbook binding/)).toBeTruthy();
      cleanup();
    }
    const unbound = [...buildModel(doc).nodes.values()].find(
      (n) => n.node.type === 'task' && !n.node.impl,
    )?.node;
    if (unbound) {
      openExecution(unbound.key);
      expect(screen.queryByLabelText(/Task keywords/)).toBeNull();
    }
  });
});

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

/** Puts `text` in a chip field with the caret at its end, as typing its last character would. */
function typeInto(el: HTMLElement, text: string) {
  el.focus();
  el.textContent = text;
  const range = document.createRange();
  range.setStart(el.firstChild as Text, text.length);
  range.collapse(true);
  const sel = window.getSelection() as Selection;
  sel.removeAllRanges();
  sel.addRange(range);
  fireEvent.input(el, { data: text.slice(-1), inputType: 'insertText' });
}

/** Opens a fold of the Binding tab by its summary (AFD-80) and waits for its toggle event. */
async function unfold(region: string): Promise<HTMLElement> {
  const section = screen.getByRole('region', { name: region });
  const details = section.querySelector('details') as HTMLDetailsElement;
  if (!details.open) {
    fireEvent.click(details.querySelector('summary') as HTMLElement);
    await act(() => new Promise((r) => setTimeout(r, 0)));
  }
  expect(details.open).toBe(true);
  return section;
}

describe('Details: Binding (AFD-43)', () => {
  it('shows the bound module, its docs and the configured parameters with input chips', async () => {
    open('set-boot-variable');
    await answer(catalog);
    // AFD-43: the Details panel, docked, on the Binding tab.
    expect(screen.getByRole('heading', { name: 'Set boot variable' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Binding' }).getAttribute('aria-selected')).toBe('true');
    // AFD-80: bound, the tab starts at Configure; Change Module and About are closed folds.
    const regions = [...document.querySelectorAll('.afd-impl > section')].map((r) =>
      r.getAttribute('aria-label'),
    );
    expect(regions).toEqual(['Configure', 'Change module', 'About']);
    const change = screen.getByRole('region', { name: 'Change module' });
    expect(change.querySelector('details')?.open).toBe(false);
    // Closed, Change Module renders no search box and asks the catalog nothing.
    expect(change.querySelector('[data-catalog-search]')).toBeNull();
    expect(posted.some((m) => (m as { request?: CatalogRequest }).request?.op === 'search')).toBe(
      false,
    );
    const understand = await unfold('About');
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
    // AFD-44: "+" on a docs row adds that parameter to Configure.
    const add = understand.querySelector<HTMLButtonElement>('[data-add-param]:not([disabled])');
    const name = add?.dataset.addParam as string;
    expect(configure.querySelector(`[data-param="${name}"]`)).toBeNull();
    fireEvent.click(add as HTMLButtonElement);
    expect(configure.querySelector(`[data-param="${name}"]`)).toBeTruthy();
    expect(add?.disabled).toBe(true);
  });

  it('stages edits and saves them as one setBinding command', async () => {
    const id = open('set-boot-variable');
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    const select = within(configure).getByLabelText(/save_when/) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'always' } });
    fireEvent.click(within(await unfold('About')).getByRole('button', { name: 'backup_path' }));
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
    // AFD-80: unbound, the tab is Find alone.
    expect(screen.queryByRole('region', { name: 'Configure' })).toBeNull();
    fireEvent.click(screen.getByText('cisco.ios.ios_command', { selector: '.afd-result-name' }));
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    // Chosen, Configure comes first; Change Module stays open while nothing is saved.
    expect(document.querySelector('.afd-impl > section')?.getAttribute('aria-label')).toBe(
      'Configure',
    );
    expect(
      screen.getByRole('region', { name: 'Change module' }).querySelector('details')?.open,
    ).toBe(true);
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

  it('groups Required and Optional; the picker adds a parameter by what it does (AFD-80)', async () => {
    open('set-boot-variable');
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    const optional = configure.querySelector('[data-param-group="optional"]') as HTMLElement;
    expect(optional.querySelector('[data-param="save_when"]')).toBeTruthy();
    const box = within(configure).getByRole('combobox', { name: 'Add a parameter' });
    expect(box.getAttribute('aria-expanded')).toBe('false');
    fireEvent.change(box, { target: { value: 'backup' } });
    const list = within(configure).getByRole('listbox', { name: 'Parameters' });
    const first = within(list).getAllByRole('option')[0] as HTMLElement;
    expect(first.getAttribute('aria-selected')).toBe('true');
    expect(box.getAttribute('aria-activedescendant')).toBe(first.id);
    const name = first.dataset.paramOption as string;
    expect(name).toMatch(/backup/);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(optional.querySelector(`[data-param="${name}"]`)).toBeTruthy();
    expect(box.getAttribute('aria-expanded')).toBe('false');
    // Escape closes the list without adding anything.
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(within(configure).getByText(/No parameter matches/)).toBeTruthy();
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(within(configure).queryByRole('listbox')).toBeNull();
  });

  it('expanded, both folds are open side by side (AFD-80)', async () => {
    act(() => useUi.getState().setExpanded(true));
    open('set-boot-variable');
    await answer(catalog);
    for (const name of ['Change module', 'About'])
      expect(screen.getByRole('region', { name }).querySelector('details')?.open).toBe(true);
    act(() => useUi.getState().setExpanded(false));
  });
});

describe('a staged binding is never dropped without a word (AFD-80)', () => {
  beforeEach(() => {
    useUi.setState({ pendingBinding: nodeOf('set-boot-variable').id, panelCollapsed: false });
  });
  afterEach(() =>
    useUi.setState({ pendingBinding: null, leave: null, lens: null, lensTab: false }),
  );

  it('hiding the side panel asks first, and hides it once the user chooses', () => {
    act(() => useUi.getState().setPanelCollapsed(true));
    expect(useUi.getState().panelCollapsed).toBe(false);
    expect(useUi.getState().leave).toEqual({ kind: 'collapse' });
    act(() => useUi.getState().resolveLeave('go'));
    expect(useUi.getState().panelCollapsed).toBe(true);
    useUi.setState({ panelCollapsed: false });
  });

  it('the lens tab asks first; turning a lens on keeps the Details', () => {
    act(() => useUi.getState().setLens('access'));
    expect(useUi.getState().lens).toBe('access');
    expect(useUi.getState().lensTab).toBe(false);
    act(() => useUi.getState().showLensTab(true));
    expect(useUi.getState().leave).toEqual({ kind: 'lensTab' });
    act(() => useUi.getState().resolveLeave('stay'));
    expect(useUi.getState().lensTab).toBe(false);
    act(() => useUi.getState().showLensTab(true));
    act(() => useUi.getState().resolveLeave('go'));
    expect(useUi.getState().lensTab).toBe(true);
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

  it('shows task keywords disabled, with why, for a playbook binding or an unbound node (AFD-44)', () => {
    const bound = doc.nodes.find((n) => n.impl?.kind === 'playbook');
    if (bound) {
      openExecution(bound.key);
      expect(screen.getByText(/takes no task keywords/)).toBeTruthy();
      cleanup();
    }
    const unbound = [...buildModel(doc).nodes.values()].find(
      (n) => n.node.type === 'task' && !n.node.impl,
    )?.node;
    expect(unbound).toBeTruthy();
    openExecution(unbound?.key as string);
    const box = screen.getByLabelText('Task keywords') as HTMLTextAreaElement;
    expect(box.disabled).toBe(true);
    expect(box.getAttribute('aria-describedby')).toBeTruthy();
    expect(screen.getByText(/Bind a module or role first/)).toBeTruthy();
    // Grouped as an operator reads a play.
    expect(
      [...document.querySelectorAll('[data-setting-group]')].map((g) =>
        g.getAttribute('data-setting-group'),
      ),
    ).toEqual(['Targeting', 'Privilege', 'Timing', 'Tags']);
  });
});

describe('Details: Execution per node kind (AFD-71)', () => {
  it('a decision shows only what its play uses, no task keywords, and flags a set field it ignores', () => {
    const decision = nodeOf('upgrade-needed');
    const withRetries = {
      ...doc,
      nodes: doc.nodes.map((n) =>
        n.id === decision.id ? { ...n, settings: { ...n.settings, retries: 3 } } : n,
      ),
    };
    act(() => useUi.getState().setSnapshot({ ...snapshotOf(withRetries), docVersion: 2 }));
    act(() => useUi.getState().openDetails(decision.id, 'execution'));
    render(<Details id={decision.id} />);
    expect(
      [...document.querySelectorAll('[data-setting-group]')].map((g) =>
        g.getAttribute('data-setting-group'),
      ),
    ).toEqual(['Targeting', 'Privilege', 'Timing', 'Tags']);
    expect(screen.getByLabelText(/^Serial/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Max fail percentage/)).toBeNull();
    expect(screen.queryByLabelText(/^Until/)).toBeNull();
    // Timing has only the retries set by hand, with how to fix it.
    expect(screen.getByLabelText(/^Retries/)).toBeTruthy();
    expect(screen.getByText('Not used on a decision node: clear it.')).toBeTruthy();
    expect(screen.queryByText(/Task keywords/)).toBeNull();
    // AFD-72: a group is a fold, open while something in it is set, and says how much.
    const fold = (group: string) =>
      document.querySelector(`[data-setting-group="${group}"] > details`) as HTMLDetailsElement;
    expect([fold('Timing').open, fold('Timing').querySelector('summary')?.textContent]).toEqual([
      true,
      // AFD-103 (round 3: R1): a fold says what it holds.
      'Timing: retries · 1 set',
    ]);
    expect([fold('Tags').open, fold('Tags').querySelector('summary')?.textContent]).toEqual([
      false,
      'Tags',
    ]);
  });

  it('an approval keeps its timeout, as the AWX approval timeout', () => {
    const approval = nodeOf('change-approval');
    act(() => useUi.getState().openDetails(approval.id, 'execution'));
    render(<Details id={approval.id} />);
    expect(screen.getByLabelText(/How long the AWX approval waits/)).toBeTruthy();
    expect(screen.queryByLabelText(/^Retries/)).toBeNull();
  });
});

describe('Details: a step selected before it arrives (AFD-71)', () => {
  it('fills in once the snapshot with the step comes, instead of staying blank', () => {
    // Quick Add selects the new step on the ack; the snapshot that has it can come after.
    const added: FlowNode = {
      id: '01JDGKS00000000000000000NW',
      key: 'check-ntp',
      type: 'task',
      title: 'Check NTP',
    };
    act(() => useUi.getState().openDetails(added.id, 'general'));
    render(<Details id={added.id} />);
    expect(screen.queryByRole('heading', { name: 'Check NTP' })).toBeNull();
    act(() =>
      useUi
        .getState()
        .setSnapshot({ ...snapshotOf({ ...doc, nodes: [...doc.nodes, added] }), docVersion: 2 }),
    );
    expect(screen.getByRole('heading', { name: 'Check NTP' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'General' })).toBeTruthy();
  });
});

// AFD-103 (round 3: R1-R4): the Execution tab says what it holds and how its fields combine.
describe('Details: Execution explains itself (AFD-103)', () => {
  const KEY = 'set-boot-variable';
  function withSettings(
    settings: FlowNode['settings'],
    tweak?: (copy: FlowDocument, node: FlowNode) => void,
  ) {
    const copy = JSON.parse(JSON.stringify(doc)) as FlowDocument;
    const walk = (nodes: FlowNode[] = []) => {
      for (const n of nodes) {
        if (n.key === KEY) {
          n.settings = settings;
          tweak?.(copy, n);
        }
        walk(n.subflow?.nodes);
      }
    };
    walk(copy.nodes);
    act(() => useUi.getState().setSnapshot({ ...snapshotOf(copy), docVersion: 2 }));
  }
  async function openExecution() {
    const id = nodeOf(KEY).id;
    act(() => useUi.getState().openDetails(id, 'execution'));
    render(<Details id={id} />);
    await answer(catalog);
    return id;
  }
  const fold = (group: string) =>
    document.querySelector(`[data-setting-group="${group}"] > details`) as HTMLDetailsElement;

  it('names what each fold holds; Timing opens on a module step and can be closed', async () => {
    await openExecution();
    expect(fold('Timing').querySelector('summary')?.textContent).toBe(
      'Timing: timeout, retries, until, delay',
    );
    expect(fold('Targeting').querySelector('summary')?.textContent).toBe(
      'Targeting: serial, max fail percentage, inventory target',
    );
    expect([fold('Timing').open, fold('Targeting').open]).toEqual([true, false]);
    const keywords = document.querySelector('[data-keywords] > details') as HTMLDetailsElement;
    expect(keywords.querySelector('summary')?.textContent).toBe(
      'Task keywords: when, loop, no_log…',
    );
    // Open by default, not held open: the person can close it.
    act(() => {
      fold('Timing').open = false;
      fireEvent(fold('Timing'), new Event('toggle'));
    });
    expect(fold('Timing').open).toBe(false);
  });

  it('says how the Timing fields combine and offers the result fields to Until', async () => {
    withSettings({
      retries: 10,
      delay: 15,
      until: "'x' in set_boot_variable_result.updates",
      timeout: '15s',
    });
    await openExecution();
    expect(document.querySelector('[data-timing-text]')?.textContent).toBe(
      "Tries up to 11 times (once, then 10 retries), 15 s apart, until 'x' in set_boot_variable_result.updates; each try at most 15s, and a try that runs over ends the step; the step takes at most 5 min 15 s in all.",
    );
    // AFD-227: Until is an expression field; the result's fields come after `boot_result.`.
    const until = screen.getByRole('textbox', { name: /^Until/ });
    expect(until.textContent).toBe("'x' in set_boot_variable_result.updates");
    typeInto(until, 'boot_result.');
    const fields = screen.getByRole('listbox', { name: 'Members' });
    expect(
      within(fields)
        .getAllByRole('option')
        .map((o) => o.querySelector('.afd-jinja-label')?.textContent),
    ).toEqual(['commands', 'updates', 'backup_path']);
    fireEvent.keyDown(until, { key: 'Escape' });
    // A timeout the generated code cannot read is refused in the field.
    const timeout = screen.getByRole('textbox', { name: /^Timeout/ });
    timeout.textContent = '15 sec';
    fireEvent.input(timeout);
    expect(screen.getByText('A duration: 30s, 15m, 1h30m, or an input with @')).toBeTruthy();
  });

  // AFD-111 (round 4: Q2): `10s` was refused with "A whole number"; Timeout beside it takes `30s`.
  it('takes Delay as a duration, saved as seconds', async () => {
    withSettings({ retries: 10, delay: 15 });
    const id = await openExecution();
    const delay = screen.getByRole('textbox', { name: /^Delay/ });
    expect(delay.textContent).toBe('15s');
    delay.textContent = '1m';
    fireEvent.input(delay);
    fireEvent.blur(delay);
    expect(commands()).toEqual([{ kind: 'updateNode', id, patch: { settings: { delay: 60 } } }]);
  });

  // AFD-112 (round 4: Q4): the participant asked to let the operator set a drain wait wrote it
  // into the flow's goal; the Timing fields took only numbers.
  const boot = (copy: FlowDocument) => {
    copy.flow.inputs = { ...copy.flow.inputs, boot_tries: { type: 'integer', default: 4 } };
  };

  it('a Timing field takes a flow input with @: the setting and the step input, one edit', async () => {
    withSettings({ retries: 3 }, boot);
    const id = await openExecution();
    const retries = screen.getByRole('textbox', { name: /^Retries/ });
    retries.textContent = '';
    fireEvent.input(retries);
    const at = screen.getByRole('button', { name: /^Insert an input into Retries/ });
    fireEvent.mouseDown(at);
    fireEvent.click(at);
    // Inputs that can hold a number (strings too): the step's, the flow's and an upstream output;
    // no step's whole result (a dict), and not the host list.
    expect(
      screen.getAllByRole('option').map((o) => o.querySelector('.afd-ref-chip')?.textContent),
    ).toEqual(['target_image', 'site', 'target_version', 'boot_tries', 'backup_ref']);
    fireEvent.mouseDown(screen.getByRole('option', { name: /boot_tries/ }));
    fireEvent.blur(retries);
    expect(commands()).toEqual([
      {
        kind: 'updateNode',
        id,
        patch: {
          settings: { retries: '{{ boot_tries }}' },
          inputs: { boot_tries: { type: 'integer', from: 'flow.boot_tries' } },
        },
      },
    ]);
  });

  it('a Timing field asked at run time reads with its default and says where it comes from', async () => {
    withSettings(
      { retries: '{{ boot_tries }}', until: "'x' in boot_result.updates" },
      (copy, n) => {
        boot(copy);
        n.inputs = { ...n.inputs, boot_tries: { type: 'integer', from: 'flow.boot_tries' } };
      },
    );
    await openExecution();
    expect(document.querySelector('[data-timing-text]')?.textContent).toBe(
      "Tries up to boot_tries + 1 times (5 with its default 4), 5 s apart, until 'x' in boot_result.updates.",
    );
    expect(document.querySelector('[data-timing-asked="retries"]')?.textContent).toBe(
      'Asked at run time: the flow input boot_tries, default 4.',
    );
    const retries = screen.getByRole('textbox', { name: /^Retries/ });
    expect(retries.querySelector('[data-ref]')?.textContent).toBe('boot_tries');
    expect(document.querySelector('[data-timing-ask="retries"]')).toBeNull();
  });

  it('Ask at Run Time makes the flow input from the field: one askAtRunTime', async () => {
    withSettings({ retries: 10, delay: 15 });
    const id = await openExecution();
    fireEvent.click(document.querySelector('[data-timing-ask="delay"]') as HTMLElement);
    const form = document.querySelector('[data-timing-askform="delay"]') as HTMLElement;
    const name = within(form).getByLabelText('Input name') as HTMLInputElement;
    expect(name.value).toBe('set_boot_variable_delay');
    fireEvent.change(name, { target: { value: 'boot_delay' } });
    expect((within(form).getByLabelText(/^Default/) as HTMLInputElement).value).toBe('15');
    fireEvent.click(within(form).getByRole('button', { name: 'Ask at Run Time' }));
    expect(commands()).toEqual([
      {
        kind: 'askAtRunTime',
        id,
        setting: 'delay',
        name: 'boot_delay',
        description: `Seconds between the tries of ${nodeOf(KEY).title}`,
        default: 15,
      },
    ]);
    expect(document.querySelector('[data-timing-askform="delay"]')).toBeNull();
  });

  it('adds a common keyword in one click; the YAML box marks a wrong line and indents', async () => {
    const id = await openExecution();
    fireEvent.click(document.querySelector('[data-keyword-chip="no_log"]') as HTMLElement);
    expect(commands()).toEqual([{ kind: 'updateNode', id, patch: { keywords: { no_log: true } } }]);
    // A keyword that needs a value puts the caret where it goes.
    fireEvent.click(document.querySelector('[data-keyword-chip="when"]') as HTMLElement);
    const box = screen.getByLabelText(/Task keywords/) as HTMLTextAreaElement;
    // (No host here to echo the saved no_log back: the box keeps it and adds the new line.)
    expect([box.value, document.activeElement === box]).toEqual(['no_log: true\nwhen: ', true]);
    // Enter after `loop:` indents the list's first item.
    fireEvent.change(box, { target: { value: 'loop:' } });
    box.setSelectionRange(5, 5);
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(box.value).toBe('loop:\n  ');
    // A wrong line is marked as the person types, before anything is saved.
    fireEvent.change(box, { target: { value: 'when: [x' } });
    await act(() => new Promise((r) => setTimeout(r, 350)));
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(document.querySelector('.afd-yaml-line.error')?.textContent?.trim()).toBe('when: [x');
  });
});

// AFD-106 (round 3: R7): the @ list offers an upstream step's result; picking it makes it an
// output there, so the input has a source (the participant typed the register name instead).
describe('the @ list offers upstream results (AFD-106)', () => {
  it('picking a result adds the input here and the output on the step that registers it', async () => {
    const copy = JSON.parse(JSON.stringify(doc)) as FlowDocument;
    const walk = (nodes: FlowNode[] = []) => {
      for (const n of nodes) {
        if (n.key === 'verify-version') n.impl = undefined;
        walk(n.subflow?.nodes);
      }
    };
    walk(copy.nodes);
    act(() => useUi.getState().setSnapshot({ ...snapshotOf(copy), docVersion: 3 }));
    open('verify-version');
    await answer(catalog);
    fireEvent.click(screen.getByText('cisco.ios.ios_command', { selector: '.afd-result-name' }));
    await answer(catalog);
    const configure = screen.getByRole('region', { name: 'Configure' });
    fireEvent.click(
      within(configure).getByRole('button', { name: /Insert an input into commands 1/ }),
    );
    const option = within(configure).getByRole('option', {
      name: /wait-for-ssh\.wait_for_ssh_result/,
    });
    expect(option.textContent).toMatch(/makes it an output there/);
    fireEvent.mouseDown(option);
    expect(commands()).toContainEqual({
      kind: 'setContractField',
      target: nodeOf('wait-for-ssh').id,
      side: 'outputs',
      name: 'wait_for_ssh_result',
      field: { type: 'dict', from: 'impl.register' },
    });
  });

  // AFD-108 (wave 10: Z1): the result's fields come from the upstream module's docs.
  it('then offers the fields of the result, and a field is one chip', async () => {
    const copy = JSON.parse(JSON.stringify(doc)) as FlowDocument;
    const walk = (nodes: FlowNode[] = []) => {
      for (const n of nodes) {
        if (n.key === 'verify-version') n.impl = undefined;
        walk(n.subflow?.nodes);
      }
    };
    walk(copy.nodes);
    const withReturns = (r: CatalogRequest): unknown =>
      r.op === 'doc' && r.fqcn === 'ansible.builtin.wait_for_connection'
        ? {
            fqcn: r.fqcn,
            returns: {
              elapsed: {
                type: 'float',
                description: 'The number of seconds that elapsed waiting for the connection.',
              },
            },
          }
        : catalog(r);
    act(() => useUi.getState().setSnapshot({ ...snapshotOf(copy), docVersion: 3 }));
    open('verify-version');
    await answer(withReturns);
    fireEvent.click(screen.getByText('cisco.ios.ios_command', { selector: '.afd-result-name' }));
    await answer(withReturns);
    const configure = screen.getByRole('region', { name: 'Configure' });
    fireEvent.click(
      within(configure).getByRole('button', { name: /Insert an input into commands 1/ }),
    );
    fireEvent.mouseDown(
      within(configure).getByRole('option', { name: /wait-for-ssh\.wait_for_ssh_result/ }),
    );
    const list = within(configure).getByRole('listbox', { name: 'Fields of wait_for_ssh_result' });
    fireEvent.mouseDown(
      within(list).getByRole('option', { name: /^wait_for_ssh_result\.elapsed / }),
    );
    expect(
      configure.querySelector('[data-param="commands"] [data-ref="wait_for_ssh_result.elapsed"]'),
    ).toBeTruthy();
    expect(configure.querySelector('[data-binding-preview]')?.textContent).toContain(
      '{{ wait_for_ssh_result.elapsed }}',
    );
  });
});

describe('Configure: set_fact (AFD-222)', () => {
  it('shows the facts, a list as YAML, and asks for no key_value', async () => {
    const copy = JSON.parse(JSON.stringify(doc)) as FlowDocument;
    const walk = (nodes: FlowNode[] = []) => {
      for (const n of nodes) {
        if (n.key === 'set-boot-variable')
          n.impl = {
            kind: 'module',
            ref: 'ansible.builtin.set_fact',
            params: { _ts: "{{ now(utc=true).strftime('%Y%m%d') }}", _dirs: ['a', 'b'] },
          };
        walk(n.subflow?.nodes);
      }
    };
    walk(copy.nodes);
    const setFact = (r: CatalogRequest): unknown =>
      r.op === 'doc' && /set_fact$/.test(r.fqcn)
        ? {
            fqcn: 'ansible.builtin.set_fact',
            name: 'set_fact',
            type: 'module',
            collection: 'ansible.builtin',
            collection_version: '2.19.14',
            short_description: 'Set host variable(s) and fact(s).',
            description: 'Sets facts.',
            options: {
              key_value: { type: 'str', required: true, description: 'The facts to set.' },
              cacheable: { type: 'bool', description: 'Whether facts go to the fact cache.' },
            },
          }
        : catalog(r);
    act(() => useUi.getState().setSnapshot({ ...snapshotOf(copy), docVersion: 4 }));
    open('set-boot-variable');
    await answer(setFact);
    const configure = screen.getByRole('region', { name: 'Configure' });
    expect(configure.querySelector('[data-param="key_value"]')).toBeNull();
    expect(within(configure).getByRole('group', { name: 'Facts' })).toBeTruthy();
    expect(
      configure.querySelector('[data-param="_ts"] [contenteditable="true"]')?.textContent,
    ).toBe("{{ now(utc=true).strftime('%Y%m%d') }}");
    expect(
      (configure.querySelector('[data-param="_dirs"] textarea') as HTMLTextAreaElement).value,
    ).toBe('- a\n- b');
    expect(configure.textContent).toContain('Required parameters set');
  });
});

describe('Expression fields (AFD-227)', () => {
  it('a decision condition is coloured and completed as a bare expression, and saves on Enter', async () => {
    const id = nodeOf('upgrade-needed').id;
    act(() => useUi.getState().openDetails(id, 'general'));
    render(<Details id={id} />);
    await answer(catalog);
    const condition = screen.getByRole('textbox', { name: /^Condition/ });
    expect(condition.className).toContain('mono');
    expect(document.querySelector('[data-expr-field] [data-ref]')).toBeNull();
    typeInto(condition, "ansible_net_version is version(target_version, '<') and inv");
    const list = screen.getByRole('listbox', { name: 'Variables and functions' });
    expect(within(list).getAllByRole('option')[0]?.textContent).toContain('inventory_hostname');
    fireEvent.keyDown(condition, { key: 'Enter' });
    fireEvent.keyDown(condition, { key: 'Enter' });
    expect(commands().at(-1)).toMatchObject({
      kind: 'updateNode',
      id,
      patch: {
        condition: "ansible_net_version is version(target_version, '<') and inventory_hostname",
      },
    });
  });
});

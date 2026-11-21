// AFD-341: Run mode shows the value each host had for a step's input, next to where it comes from:
// under each input in Details (every host, or the host picked, with "differs"), in a variable's
// tooltip for one host, and per host in the step's Run tab.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { inputOrigin } from '../../../src/core/flow/origin';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { summarizeRun } from '../../../src/core/run/events';
import { Details } from '../../../src/webview/details/Details';
import { ContractEditor } from '../../../src/webview/panels/ContractEditor';
import { NodeRunPanel } from '../../../src/webview/panels/RunPanel';
import { JinjaTip } from '../../../src/webview/properties/JinjaAssist';
import { OriginScope } from '../../../src/webview/properties/OriginView';
import { RunHostPicker } from '../../../src/webview/properties/RunValues';
import { useUi } from '../../../src/webview/store';

const doc = parse(
  readFileSync(join(__dirname, '../../fixtures/engine/record-inputs.flow.yaml'), 'utf8'),
) as FlowDocument;
const model = buildModel(doc);
const show = doc.nodes.find((n) => n.key === 'show');
const quiet = doc.nodes.find((n) => n.key === 'quiet');
if (!show || !quiet) throw new Error('fixture');
const line = (e: Record<string, unknown>) => JSON.stringify(e);
const inputsOf = (host: string, user: string) =>
  line({
    event: 'inputs',
    host,
    node: show.id,
    inputs: {
      word: { value: 'hello' },
      creds: { value: { user, password: '********' } },
      access: { missing: 'secret' },
    },
  });
const run = (events: string[]): RunView => ({
  id: 'r1',
  mode: 'real',
  state: 'done',
  rc: 0,
  startedAt: '2026-11-20T08:00:00Z',
  finishedAt: '2026-11-20T08:01:00Z',
  source: 'local',
  flowVersion: 1,
  summary: {
    ...summarizeRun(events.join('\n'), {}),
    // The hosts left by ok_hosts, as the routing events would say.
    nodes: { [show.id]: { ok_hosts: ['h01', 'h02', 'h03'] } },
    hosts: ['h01', 'h02', 'h03'],
  },
});
const recorded = run([
  line({ event: 'start', record_inputs: true }),
  inputsOf('h01', 'bob'),
  inputsOf('h02', 'bob'),
  inputsOf('h03', 'eve'),
]);

beforeEach(() => {
  useUi.setState({ snapshot: null, selection: {}, mode: 'run', run: null, originHost: null });
  act(() => {
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: [],
      autoPositions: {},
    });
    useUi.getState().setRun(recorded);
  });
});
afterEach(cleanup);

const inputs = () =>
  render(
    <ContractEditor
      title="Inputs"
      target={show.id}
      side="inputs"
      contract={show.inputs}
      withFrom
    />,
  );
const row = (name: string) =>
  document.querySelector(`[data-contract-field="${name}"] [data-run-values]`) as HTMLElement;

describe('Details in Run mode', () => {
  it('each input shows the values of the run, hosts with the same value together', () => {
    inputs();
    expect(row('word').textContent).toContain('hello (h01, h02, h03)');
    expect(row('creds').textContent).toContain('{user: bob, password: "********"} (h01, h02)');
    // Another value than the flow's default for the same input: said so.
    expect(row('creds').textContent).toContain('{user: eve, password: "********"} (h03)');
    expect(row('creds').textContent).toMatch(/differs from what the flow predicted/);
    expect(row('access').textContent).toContain('secret: not recorded');
  });

  it('with a host picked, that host’s value; nothing in Design mode', () => {
    act(() => useUi.getState().setOriginHost('h03'));
    const { unmount } = inputs();
    expect(row('creds').dataset.runValues).toBe('h03');
    expect(row('creds').textContent).toContain('{user: eve, password: "********"} (h03)');
    expect(row('word').textContent).not.toMatch(/differs/);
    unmount();
    act(() => useUi.setState({ mode: 'design' }));
    inputs();
    expect(document.querySelector('[data-run-values]')).toBeNull();
  });

  it('the run’s host picker lists the hosts the step recorded, and picks one', () => {
    render(<RunHostPicker node={show.id} />);
    const select = screen.getByLabelText('For host') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'h01', 'h02', 'h03']);
    fireEvent.change(select, { target: { value: 'h02' } });
    expect(useUi.getState().originHost).toBe('h02');
  });

  it('AFD-342: with no values of a run (a viewer before any run), the repository’s hosts', () => {
    act(() => {
      useUi.getState().setRun(null);
      useUi.getState().setVarIndex({ defs: {}, groups: {}, hosts: ['sw-01', 'sw-02'] }, true);
    });
    render(<RunHostPicker node={show.id} />);
    const select = screen.getByLabelText('For host') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'sw-01', 'sw-02']);
    fireEvent.change(select, { target: { value: 'sw-02' } });
    expect(useUi.getState().originHost).toBe('sw-02');
  });

  it('says why there are no values: a step without any, a run that turned recording off', () => {
    render(
      <ContractEditor
        title="Inputs"
        target={quiet.id}
        side="inputs"
        contract={quiet.inputs}
        withFrom
      />,
    );
    expect(row('word').textContent).toBe('No input values of this step in this run.');
    cleanup();
    act(() => useUi.getState().setRun(run([line({ event: 'start', record_inputs: false })])));
    inputs();
    expect(row('word').textContent).toBe(
      'Input values were not recorded: the run turned recording off.',
    );
    cleanup();
    act(() => useUi.getState().setRun(run([])));
    inputs();
    expect(row('word').textContent).toBe('This run did not record input values.');
  });
});

describe('a variable’s tooltip in Run mode', () => {
  const tip = () =>
    render(
      <OriginScope.Provider value={show.id}>
        <JinjaTip tip={{ label: 'creds', origin: inputOrigin(model, show, 'creds') }} />
      </OriginScope.Provider>,
    );

  it('adds the value of the run for the host picked, and whether it differs', () => {
    act(() => useUi.getState().setOriginHost('h03'));
    tip();
    const line = document.querySelector('[data-run-value="h03"]');
    expect(line?.textContent).toMatch(
      /^In this run: \{user: eve, password: "\*\*\*\*\*\*\*\*"\} \(h03\)/,
    );
    expect(line?.textContent).toMatch(/differs from what the flow predicted/);
  });

  it('says nothing without one host, or outside Run mode', () => {
    tip();
    expect(document.querySelector('[data-run-value]')).toBeNull();
    cleanup();
    act(() => {
      useUi.getState().setOriginHost('h01');
      useUi.setState({ mode: 'design' });
    });
    tip();
    expect(document.querySelector('[data-run-value]')).toBeNull();
  });
});

describe('the Run tab', () => {
  it('a host row opens the values its inputs had', () => {
    render(<NodeRunPanel id={show.id} />);
    fireEvent.click(screen.getByRole('button', { name: 'Inputs of h03' }));
    const values = document.querySelector('[data-host-inputs="h03"]');
    expect(values?.textContent).toContain('accesssecret: not recorded');
    expect(values?.textContent).toContain('creds{user: eve, password: "********"}');
    expect(values?.textContent).toContain('wordhello');
  });
});

describe('a read-only Details, Data tab (AFS-188)', () => {
  it('opens an input row to say where it comes from, and offers nothing to change', () => {
    act(() => useUi.setState({ viewer: true, detailsTab: 'io' }));
    render(<Details id={show.id} />);
    // The rows are not in a disabled fieldset: they open, at full strength.
    const word = screen.getByRole('button', { name: /^word:/ }) as HTMLButtonElement;
    expect(word.closest('fieldset:disabled')).toBeNull();
    expect(screen.queryByRole('button', { name: /^Add (input|output)$/ })).toBeNull();
    fireEvent.click(word);
    expect(word.getAttribute('aria-expanded')).toBe('true');
    const form = document.querySelector('[data-contract-field="word"] .afd-contract-form');
    expect(form?.matches(':disabled')).toBe(true);
    expect(
      form?.querySelector('[data-comes-from], .afd-value')?.closest('.afd-field'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Remove word' })).toBeNull();
    // The run's host picker sits in the Inputs section, in the panel's padding.
    expect(document.querySelector('.afd-contract-section [data-run-host-picker]')).not.toBeNull();
    act(() => useUi.setState({ viewer: false }));
  });
});

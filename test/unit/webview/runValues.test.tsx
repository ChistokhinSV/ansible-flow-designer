// AFD-341: Run mode shows the value each host had for a step's input, next to where it comes from:
// under each input in Details (every host, or the host picked, with "differs"), in a variable's
// tooltip for one host, and per host in the step's Run tab.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { buildModel } from '../../../src/core/flow/model';
import { inputOrigin, nameOrigin } from '../../../src/core/flow/origin';
import type { FlowDocument } from '../../../src/core/flow/types';
import type { RunView } from '../../../src/core/protocol';
import { type RunSummary, summarizeRun } from '../../../src/core/run/events';
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
    expect(row('creds').textContent).toContain('{ user: bob, password: "********" } (h01, h02)');
    // Another value than the flow's default for the same input: said so.
    expect(row('creds').textContent).toContain('{ user: eve, password: "********" } (h03)');
    expect(row('creds').textContent).toMatch(/differs from what the flow predicted/);
    expect(row('access').textContent).toContain('secret: not recorded');
  });

  it('with a host picked, that host’s value; nothing in Design mode', () => {
    act(() => useUi.getState().setOriginHost('h03'));
    const { unmount } = inputs();
    expect(row('creds').dataset.runValues).toBe('h03');
    expect(row('creds').textContent).toContain('{ user: eve, password: "********" } (h03)');
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

  it('AFS-189: lists the run’s hosts only, never the inventory’s others', () => {
    act(() => {
      useUi.getState().setVarIndex({ defs: {}, groups: {}, hosts: ['h01', 'localhost'] }, true);
      useUi.getState().setRun({
        ...recorded,
        summary: { ...(recorded.summary as RunSummary), hosts: ['h01', 'h02', 'h03', 'h04'] },
      });
    });
    render(<RunHostPicker node={show.id} />);
    const select = screen.getByLabelText('For host') as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['', 'h01', 'h02', 'h03', 'h04']);
    expect([...select.querySelectorAll('optgroup')].map((g) => g.label)).toEqual([
      'At this step',
      'Did not reach this step',
    ]);
    cleanup();
    act(() => useUi.getState().setOriginHost('h04'));
    inputs();
    expect(row('word').textContent).toContain('this host did not reach this step (h04)');
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
      /^In this run: \{ user: eve, password: "\*\*\*\*\*\*\*\*" \} \(h03\)/,
    );
    expect(line?.textContent).toMatch(/differs from what the flow predicted/);
  });

  it('AFS-189: without a host picked, every host’s values, as Details shows them', () => {
    tip();
    const line = document.querySelector('[data-run-value="all"]');
    expect(line?.textContent).toContain('{ user: bob, password: "********" } (h01, h02)');
    expect(line?.textContent).toContain('{ user: eve, password: "********" } (h03)');
  });

  it('AFS-189: inventory_hostname is each host’s own name; a flow input read directly, its value', () => {
    const named = (name: string) =>
      render(
        <OriginScope.Provider value={show.id}>
          <JinjaTip tip={{ label: name, origin: nameOrigin(model, show, name) }} />
        </OriginScope.Provider>,
      );
    named('inventory_hostname');
    expect(document.querySelector('[data-run-value]')?.textContent).toBe(
      "In this run: each host's own name (h01, h02, h03)",
    );
    cleanup();
    // A run that does not say its inputs: nothing for the flow input.
    named('greeting');
    expect(document.querySelector('[data-run-value]')).toBeNull();
    cleanup();
    act(() =>
      useUi
        .getState()
        .setRun({ ...recorded, flowInputs: { greeting: 'hi there', api_token: '***' } }),
    );
    named('greeting');
    expect(document.querySelector('[data-run-value="flow"]')?.textContent).toBe(
      'In this run: hi there (the flow input, the same for every host)',
    );
    cleanup();
    named('api_token');
    expect(document.querySelector('[data-run-value="flow"]')?.textContent).toContain(
      'secret: not shown',
    );
    cleanup();
    act(() => useUi.getState().setOriginHost('h02'));
    named('inventory_hostname');
    expect(document.querySelector('[data-run-value]')?.textContent).toBe('In this run: h02');
  });

  it('says nothing outside Run mode', () => {
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
    expect(values?.textContent).toContain('creds{ user: eve, password: "********" }');
    expect(values?.textContent).toContain('wordhello');
  });
});

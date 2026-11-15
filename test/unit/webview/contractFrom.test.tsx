// AFD-287: a step's Inputs offer "Add from…": what reaches the step, a fact an earlier step sets
// included; picking the fact declares it on both steps (useFact).
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildModel } from '../../../src/core/flow/model';
import { openFailPorts } from '../../../src/core/flow/openPorts';
import type { FlowDocument } from '../../../src/core/flow/types';
import { ContractEditor } from '../../../src/webview/panels/ContractEditor';
import { useUi } from '../../../src/webview/store';
import { posted } from './setup';

const ids = {
  start: '01M7EBXJE1AAPH3JC9N9DFQNZR',
  save: '01M7EBXZ53GR37Y183S60BEQW8',
  show: '01M7EBY77C4ZK1956FTF8HC09Q',
};
const doc: FlowDocument = {
  schema_version: 2,
  flow: { id: '01M7EBXJE1AAPH3JC9N9DFQNZQ', key: 'var-test', name: 'Var test', version: 1 },
  nodes: [
    { id: ids.start, key: 'start', type: 'start', title: 'Start' },
    {
      id: ids.save,
      key: 'save-var',
      type: 'task',
      title: 'Save var',
      impl: { kind: 'module', ref: 'ansible.builtin.set_fact', params: { test_message: 'hello' } },
    },
    {
      id: ids.show,
      key: 'debug',
      type: 'task',
      title: 'Show var',
      impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ test_message }}' } },
    },
  ],
  edges: [
    {
      id: '01M7EBXJE1AAPH3JC9N9DFQNZT',
      from: { node: ids.start, port: 'ok_hosts' },
      to: { node: ids.save, port: 'in' },
    },
    {
      id: '01M7EBXZ553ZN9RA76XVVPPT6T',
      from: { node: ids.save, port: 'ok_hosts' },
      to: { node: ids.show, port: 'in' },
    },
  ],
};

beforeEach(() => {
  posted.length = 0;
  act(() =>
    useUi.getState().setSnapshot({
      docVersion: 1,
      doc,
      stale: false,
      findings: [],
      openPorts: openFailPorts(buildModel(doc)),
      autoPositions: {},
    }),
  );
});
afterEach(cleanup);

describe('Inputs: Add from… (AFD-287)', () => {
  it('offers the fact Save var sets; picking it declares it on both steps', () => {
    render(
      <ContractEditor title="Inputs" target={ids.show} side="inputs" contract={{}} withFrom />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add input/ }));
    const pick = screen.getByLabelText('Add an input from') as HTMLSelectElement;
    const option = [...pick.options].find((o) => o.value === 'save-var.test_message');
    expect(option?.textContent).toBe('save-var.test_message · fact set by "Save var"');
    fireEvent.change(pick, { target: { value: 'save-var.test_message' } });
    expect(posted).toContainEqual(
      expect.objectContaining({
        type: 'command',
        command: { kind: 'useFact', reader: ids.show, setter: ids.save, name: 'test_message' },
      }),
    );
  });

  it('outputs and flow contracts have no such list', () => {
    render(
      <ContractEditor title="Outputs" target={ids.show} side="outputs" contract={{}} withFrom />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Add output/ }));
    expect(screen.queryByLabelText('Add an input from')).toBeNull();
  });
});

// AFD-298: rows that open a form; everything is saved as it changes.
describe('the inputs editor: rows with a form', () => {
  const commands = () =>
    (posted as { type: string; command?: Record<string, unknown> }[])
      .filter((m) => m.type === 'command')
      .map((m) => m.command);
  const contract = {
    devices: { type: 'host_list' as const, required: true, targets: true },
    release: { type: 'string' as const, required: true },
  };

  it('a row says the type, targets and required; its form changes and removes it', () => {
    render(<ContractEditor title="Run inputs" target="flow" side="inputs" contract={contract} />);
    const row = screen.getByRole('button', { name: 'release: text, required' });
    expect(
      screen.getByRole('button', { name: 'devices: host list, required' }).textContent,
    ).toContain('targets');
    expect(screen.queryByLabelText('Type of release')).toBeNull();
    fireEvent.click(row);
    expect(row.getAttribute('aria-expanded')).toBe('true');
    fireEvent.change(screen.getByLabelText('Type of release'), { target: { value: 'integer' } });
    expect(commands().at(-1)).toMatchObject({
      kind: 'setContractField',
      name: 'release',
      field: { type: 'integer', required: true },
    });
    const name = screen.getByLabelText('Name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'target release' } });
    fireEvent.blur(name);
    expect(screen.getByText(/Letters, digits and _/)).toBeTruthy();
    fireEvent.change(name, { target: { value: 'target_release' } });
    fireEvent.blur(name);
    expect(commands().at(-1)).toMatchObject({ name: 'release', rename: 'target_release' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove release' }));
    expect(commands().at(-1)).toMatchObject({ name: 'release', field: null });
  });

  it('Add opens the form with the name focused; a taken name is said', () => {
    render(<ContractEditor title="Run inputs" target="flow" side="inputs" contract={contract} />);
    fireEvent.click(screen.getByRole('button', { name: /Add input/ }));
    const name = screen.getByRole('textbox', { name: 'New input name' });
    expect(document.activeElement).toBe(name);
    fireEvent.change(name, { target: { value: 'release' } });
    expect(screen.getByText('There is a release already')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: 'window' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(commands().at(-1)).toMatchObject({
      name: 'window',
      field: { type: 'string', required: true },
    });
  });
});

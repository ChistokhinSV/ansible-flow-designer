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
    expect(screen.queryByLabelText('Add an input from')).toBeNull();
  });
});

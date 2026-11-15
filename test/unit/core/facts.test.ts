// AFD-287: a fact an earlier step sets with set_fact is a value like an output: the @ list offers
// it, the unknown-variable warning names the step and the Data lens shows the read; useFact
// declares it on both steps in one edit, and then the read is a plain data wire.
import { describe, expect, it } from 'vitest';
import { refChoices } from '../../../src/core/catalog/draft';
import { planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { dataLens } from '../../../src/core/lens/data';

const FLOW = `schema_version: 2
flow:
  id: 01M7EBXJE1AAPH3JC9N9DFQNZQ
  key: var-test
  name: Var test
  version: 2
  inputs:
    devices: {type: host_list, required: true, targets: true}
nodes:
- {id: 01M7EBXJE1AAPH3JC9N9DFQNZR, key: start, type: start, title: Start}
- {id: 01M7EBXJE1AAPH3JC9N9DFQNZS, key: done, type: end, title: Done, outcome: success}
- id: 01M7EBXZ53GR37Y183S60BEQW8
  key: save-var
  type: task
  title: Save var
  impl:
    kind: module
    ref: ansible.builtin.set_fact
    params:
      test_message: hello
- id: 01M7EBY77C4ZK1956FTF8HC09Q
  key: debug
  type: task
  title: Show var
  impl:
    kind: module
    ref: ansible.builtin.debug
    params:
      msg: '{{ test_message }}'
edges:
- {id: 01M7EBXJE1AAPH3JC9N9DFQNZT, from: {node: 01M7EBXJE1AAPH3JC9N9DFQNZR, port: ok_hosts}, to: {node: 01M7EBXZ53GR37Y183S60BEQW8, port: in}}
- {id: 01M7EBXZ553ZN9RA76XVVPPT6T, from: {node: 01M7EBXZ53GR37Y183S60BEQW8, port: ok_hosts}, to: {node: 01M7EBY77C4ZK1956FTF8HC09Q, port: in}}
- {id: 01M7EBY77EDCYNY64BM5V1SKSN, from: {node: 01M7EBY77C4ZK1956FTF8HC09Q, port: ok_hosts}, to: {node: 01M7EBXJE1AAPH3JC9N9DFQNZS, port: in}}
`;
const SAVE = '01M7EBXZ53GR37Y183S60BEQW8';
const SHOW = '01M7EBY77C4ZK1956FTF8HC09Q';
const doc = (text: string) => parseFlow(text).doc as FlowDocument;
const unknown = (d: FlowDocument) =>
  validateFlow(d).findings.filter((f) => f.code === 'binding-unknown-var');

describe('facts as data (AFD-287)', () => {
  it('the @ list offers the fact, and choosing it makes it an output there', () => {
    const d = doc(FLOW);
    const show = d.nodes.find((n) => n.id === SHOW) as FlowDocument['nodes'][number];
    const fact = refChoices(buildModel(d), show).find((c) => c.name === 'test_message');
    expect(fact).toMatchObject({
      label: 'save-var.test_message',
      detail: 'fact set by "Save var" · makes it an output there',
      field: { type: 'any', from: 'save-var.test_message' },
      expose: { node: SAVE, output: 'test_message', field: { type: 'any' } },
    });
  });

  it('the warning names the step that sets it; the Data lens shows the read with the fix', () => {
    const d = doc(FLOW);
    expect(unknown(d)[0]?.message).toContain('"Save var" sets it (set_fact)');
    const lens = dataLens(d);
    expect(lens.dataWires).toEqual([
      expect.objectContaining({
        from: SAVE,
        to: SHOW,
        undeclared: true,
        label: 'test_message (not declared)',
      }),
    ]);
    const finding = lens.findings.find((f) => f.id === `data:undeclared:${SHOW}.test_message`);
    expect(finding?.fixes[0]).toEqual({
      label: 'Use test_message as an Input',
      command: { kind: 'useFact', reader: SHOW, setter: SAVE, name: 'test_message' },
    });
  });

  it('useFact declares it on both steps in one edit; then the read is a plain data wire', () => {
    const plan = planCommand(
      FLOW,
      { kind: 'useFact', reader: SHOW, setter: SAVE, name: 'test_message' },
      { newId: createIdFactory() },
    );
    const d = doc(plan.text);
    expect(d.nodes.find((n) => n.id === SAVE)?.outputs).toEqual({ test_message: { type: 'any' } });
    expect(d.nodes.find((n) => n.id === SHOW)?.inputs).toEqual({
      test_message: { type: 'any', from: 'save-var.test_message' },
    });
    expect(unknown(d)).toEqual([]);
    const lens = dataLens(d);
    expect(lens.dataWires).toEqual([
      expect.objectContaining({ from: SAVE, to: SHOW, label: 'test_message' }),
    ]);
    expect(lens.findings.some((f) => f.id.startsWith('data:undeclared:'))).toBe(false);
    // Again: nothing more to do.
    expect(
      planCommand(
        plan.text,
        { kind: 'useFact', reader: SHOW, setter: SAVE, name: 'test_message' },
        { newId: createIdFactory() },
      ).text,
    ).toBe(plan.text);
  });
});

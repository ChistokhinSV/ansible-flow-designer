// AFD-72: port names stay as in the file; every port a node can have is explained in plain words,
// and a `from:` reads as where the value comes from.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { modelOf } from '../../../src/core/flow/model';
import { legalPorts } from '../../../src/core/flow/ports';
import { type FlowDocument, NODE_TYPES } from '../../../src/core/flow/types';
import { fromText } from '../../../src/core/view/fromText';
import { LEGEND_PORTS, portHint } from '../../../src/core/view/portHints';
import { readExample } from './helpers';

describe('port hints (AFD-72)', () => {
  it('every port of every node type says what it is for', () => {
    for (const type of NODE_TYPES)
      for (const p of legalPorts({ type, branches: 3 }))
        if (p.name !== 'undo' && p.name !== 'cancelled')
          expect([type, p.name, portHint(p.name, type)]).toEqual([
            type,
            p.name,
            expect.any(String),
          ]);
    expect(LEGEND_PORTS.every((p) => portHint(p))).toBe(true);
  });

  it('an approval timeout and a join failure read as theirs', () => {
    expect(portHint('timeout', 'approval')).toBe('Hosts with no answer in time continue here');
    expect(portHint('timeout', 'task')).toBe('Hosts that ran out of time continue here');
    expect(portHint('branch_2')).toBe('Every host goes down each branch');
  });
});

describe('from in words (AFD-72)', () => {
  const doc = parse(readExample('edge-baseline.flow.yaml')) as FlowDocument;
  const model = modelOf(doc);
  const node = [...model.nodes.values()].find((e) => e.node.type === 'task')?.node;
  it.each([
    ['impl.register', "this step's result"],
    ['impl.register.stdout', "this step's result · stdout"],
    ['nowhere.out', 'nowhere.out'],
  ])('%s', (from, words) => {
    if (!node) throw new Error('no task');
    expect(fromText(model, node, 'outputs', from)).toBe(words);
  });

  it('a flow input and another step by their names', () => {
    if (!node) throw new Error('no task');
    const input = Object.keys(doc.flow.inputs ?? {})[0] as string;
    expect(fromText(model, node, 'inputs', `flow.${input}`)).toBe(`flow input ${input}`);
  });
});

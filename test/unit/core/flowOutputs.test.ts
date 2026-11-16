// AFD-309: a flow's outputs: what a run gives back to whoever launched it. They read top-level
// steps' outputs, follow renames, are checked, become one set_stats play before the outcome and
// reach the run's summary per host.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { optionA } from '../../../src/core/engine/optionA';
import { planCommand } from '../../../src/core/flow/commands';
import { parseFlow } from '../../../src/core/flow/document';
import { createIdFactory } from '../../../src/core/flow/ids';
import type { FlowDocument } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { OUTPUTS_MAX, summarizeRun } from '../../../src/core/run/events';

const REPO = join(__dirname, '../../..');
const DATA = readFileSync(join(REPO, 'test/fixtures/engine/data-passing.flow.yaml'), 'utf8');
const SEG = readFileSync(join(REPO, 'test/fixtures/engine/approval-segments.flow.yaml'), 'utf8');
const PRODUCE = '01JCR3N0000000000000000002';
const doc = (text: string) => parseFlow(text).doc as FlowDocument;
const plan = (text: string, command: Parameters<typeof planCommand>[1]) =>
  planCommand(text, command, { newId: createIdFactory() }).text;
const withOutput = (text: string, name: string, from: string) =>
  plan(text, {
    kind: 'setContractField',
    target: 'flow',
    side: 'outputs',
    name,
    field: { type: 'string', from },
  });
const codes = (text: string) => validateFlow(doc(text)).findings.map((f) => f.code);

describe('flow outputs', () => {
  it('are set on the flow and follow a renamed step and a renamed output', () => {
    let text = withOutput(DATA, 'line', 'produce.line');
    expect(doc(text).flow.outputs).toEqual({ line: { type: 'string', from: 'produce.line' } });
    expect(codes(text)).not.toContain('flow-output-unresolved');
    text = plan(text, { kind: 'updateNode', id: PRODUCE, patch: { key: 'make' } });
    expect(doc(text).flow.outputs?.line?.from).toBe('make.line');
    text = plan(text, {
      kind: 'setContractField',
      target: PRODUCE,
      side: 'outputs',
      name: 'line',
      rename: 'text',
      field: { type: 'string', from: 'impl.register.stdout' },
    });
    expect(doc(text).flow.outputs?.line?.from).toBe('make.text');
  });

  it('are checked: a step and an output that exist; not taken before an approval', () => {
    expect(codes(withOutput(DATA, 'line', 'nobody.line'))).toContain('flow-output-unresolved');
    expect(codes(withOutput(DATA, 'line', 'produce.nothing'))).toContain('flow-output-unresolved');
    // check runs before the approval; change after it.
    const before = plan(
      plan(SEG, {
        kind: 'setContractField',
        target: '01JCRBN0000000000000000002',
        side: 'outputs',
        name: 'window',
        field: { type: 'string' },
      }),
      {
        kind: 'setContractField',
        target: 'flow',
        side: 'outputs',
        name: 'window',
        field: { type: 'string', from: 'check.window' },
      },
    );
    expect(codes(before)).toContain('flow-output-before-approval');
  });

  it('are recorded by one play before the outcome, on the hosts the run targets', () => {
    const text = withOutput(DATA, 'line', 'produce.line');
    const code = optionA.generate(doc(text), { source: 'data.flow.yaml' });
    const playbook = code.files.map((f) => f.text).join('\n');
    const outputs = playbook.indexOf('] Outputs');
    expect(outputs).toBeGreaterThan(-1);
    expect(outputs).toBeLessThan(playbook.indexOf('] Outcome'));
    expect(playbook).toContain('afd_outputs: "{{ { inventory_hostname: (dict(');
    // Without outputs, no such play.
    expect(
      optionA
        .generate(doc(DATA), { source: 'data.flow.yaml' })
        .files.map((f) => f.text)
        .join('\n'),
    ).not.toContain('] Outputs');
  });

  it('reach the run summary per host, unless they are too large', () => {
    const stats = (custom: unknown) =>
      JSON.stringify({ event: 'stats', hosts: { h01: {}, h02: {} }, custom });
    const summary = summarizeRun(
      stats({ afd_outputs: { h01: { line: 'hello h01' }, h02: { line: 'hello h02' } } }),
      {},
    );
    expect(summary.outputs).toEqual({ h01: { line: 'hello h01' }, h02: { line: 'hello h02' } });
    const big = summarizeRun(
      stats({ afd_outputs: { h01: { blob: 'x'.repeat(OUTPUTS_MAX + 1) } } }),
      {},
    );
    expect(big.outputs).toBeUndefined();
    expect(big.outputsTooLarge).toBe(true);
    // A run whose flow has no outputs says nothing about them.
    expect(summarizeRun(stats({ afd_hostsets: {} }), {}).outputs).toBeUndefined();
  });
});

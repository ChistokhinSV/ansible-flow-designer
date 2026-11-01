// AFD-31: rules every writer shares (status on bind) and checks that make the design honest about
// the generated code: unwired success ports at every level, outputs that are shared host variables,
// and values that may not be set when a step reads them.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { buildModel } from '../../../src/core/flow/model';
import { contentStatus, statusFor } from '../../../src/core/flow/status';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const ctx = { newId: createIdFactory() };
const nodeOf = (text: string, key: string): FlowNode => {
  for (const { node } of buildModel(parse(text) as FlowDocument).nodes.values())
    if (node.key === key) return node;
  throw new Error(`no node ${key}`);
};

describe('status on bind (every writer)', () => {
  it('the content decides: a binding implemented, a contract specified, tested stays on implemented', () => {
    const task = { id: 't', key: 't', type: 'task' as const, title: 'T' };
    const v1 = { schema_version: 1 as const };
    expect(contentStatus(task)).toBe('draft');
    expect(contentStatus({ ...task, outputs: { r: { type: 'dict' as const } } })).toBe('specified');
    const bound = { ...task, impl: { kind: 'module' as const, ref: 'ansible.builtin.ping' } };
    expect(contentStatus(bound)).toBe('implemented');
    expect(statusFor(v1, { ...bound, status: 'tested' })).toBe('tested');
    expect(statusFor(v1, { ...task, status: 'tested' })).toBe('draft');
  });

  it('applies it when the command sends no status, as the AI bind op does', () => {
    const draft = [...buildModel(parse(EDGE) as FlowDocument).nodes.values()].find(
      (e) => e.node.type === 'task' && !e.node.impl && (e.node.status ?? 'draft') !== 'implemented',
    )?.node as FlowNode;
    const bound = planCommand(
      EDGE,
      {
        kind: 'setBinding',
        id: draft.id,
        impl: { kind: 'module', ref: 'ansible.builtin.ping' },
      },
      ctx,
    ).text;
    expect(nodeOf(bound, draft.key).status).toBe('implemented');
    const unbound = planCommand(bound, { kind: 'setBinding', id: draft.id, impl: null }, ctx).text;
    expect(nodeOf(unbound, draft.key).status).toBe('specified');
  });
});

// Small flows: a start, task steps, and an end.
let seq = 0;
const id = () => `01JDRNE${String(++seq).padStart(19, '0')}`;
interface Step {
  key: string;
  outputs?: Record<string, { type: 'any'; from?: string }>;
  inputs?: Record<string, { type: 'any'; from: string }>;
  impl?: FlowNode['impl'];
}
function flowOf(
  steps: Step[],
  wires: [string, string, string][],
  inputs: Record<string, unknown> = {},
): { doc: FlowDocument; ids: Record<string, string> } {
  const ids: Record<string, string> = { start: id(), done: id() };
  for (const s of steps) ids[s.key] = id();
  const nodes = [
    { id: ids.start, key: 'start', type: 'start', title: 'Start' },
    ...steps.map((s) => ({ ...s, id: ids[s.key], type: 'task', title: s.key })),
    { id: ids.done, key: 'done', type: 'end', title: 'Done', outcome: 'success' },
  ];
  const edges = wires.map(([from, port, to]) => ({
    id: id(),
    from: { node: ids[from], port },
    to: { node: ids[to], port: 'in' },
  }));
  const doc = {
    schema_version: 1,
    flow: {
      id: id(),
      key: 'rules',
      name: 'Rules',
      version: 1,
      inputs: { devices: { type: 'host_list', targets: true }, ...inputs },
    },
    nodes,
    edges,
  } as unknown as FlowDocument;
  return { doc, ids };
}
const codes = (doc: FlowDocument, code: string) =>
  validateFlow(doc).findings.filter((f) => f.code === code);

describe('honest checks (AFD-31)', () => {
  it('warns about a success port that leads nowhere on the top level', () => {
    const open = flowOf([{ key: 'a' }], [['start', 'ok_hosts', 'a']]);
    expect(codes(open.doc, 'success-port-unwired').map((f) => [f.node, f.port])).toEqual([
      [open.ids.a, 'ok_hosts'],
    ]);
    const closed = flowOf(
      [{ key: 'a' }],
      [
        ['start', 'ok_hosts', 'a'],
        ['a', 'ok_hosts', 'done'],
      ],
    );
    expect(codes(closed.doc, 'success-port-unwired')).toEqual([]);
  });

  it('a register another step or a flow input also uses is an error; other outputs are captured (AFD-53)', () => {
    const wires: [string, string, string][] = [
      ['start', 'ok_hosts', 'a'],
      ['a', 'ok_hosts', 'b'],
      ['b', 'ok_hosts', 'c'],
      ['c', 'ok_hosts', 'done'],
    ];
    const reader: Step = { key: 'c', inputs: { x: { type: 'any', from: 'a.result' } } };
    // The same output name on two steps: each is captured into its own variable.
    const shared = flowOf(
      [
        { key: 'a', outputs: { result: { type: 'any' } } },
        { key: 'b', outputs: { result: { type: 'any' } } },
        reader,
      ],
      wires,
    );
    expect(codes(shared.doc, 'register-collision')).toEqual([]);
    // Two module steps registering the same name: the reader gets whichever ran last.
    const ping = (register: string) => ({
      kind: 'module' as const,
      ref: 'ansible.builtin.ping',
      register,
    });
    const registered = flowOf(
      [
        {
          key: 'a',
          impl: ping('shared_result'),
          outputs: { result: { type: 'any', from: 'impl.register' } },
        },
        { key: 'b', impl: ping('shared_result') },
        reader,
      ],
      wires,
    );
    const [hit] = codes(registered.doc, 'register-collision');
    expect(hit?.severity).toBe('error');
    expect(hit?.message).toContain('reads the register shared_result, which "b" also sets');
    // A flow input of the register's name is an extra var: it always wins.
    const input = flowOf(
      [
        {
          key: 'a',
          impl: ping('result'),
          outputs: { result: { type: 'any', from: 'impl.register' } },
        },
        { key: 'b' },
        reader,
      ],
      wires,
      { result: { type: 'string' } },
    );
    expect(codes(input.doc, 'register-collision')[0]?.message).toContain('it reads the flow input');
  });

  it('says when a value may be missing: a path around the step, or hosts that failed in it', () => {
    // s fails some hosts straight to r, around p.
    const around = flowOf(
      [
        { key: 's' },
        { key: 'p', outputs: { v: { type: 'any' } } },
        { key: 'r', inputs: { x: { type: 'any', from: 'p.v' } } },
      ],
      [
        ['start', 'ok_hosts', 's'],
        ['s', 'ok_hosts', 'p'],
        ['s', 'failed_hosts', 'r'],
        ['p', 'ok_hosts', 'r'],
        ['r', 'ok_hosts', 'done'],
      ],
    );
    expect(codes(around.doc, 'ref-may-be-undefined')[0]?.message).toContain(
      'which some paths to here do not run',
    );
    // p's failures reach r through a handler.
    const failing = flowOf(
      [
        { key: 'p', outputs: { v: { type: 'any' } } },
        { key: 'h' },
        { key: 'r', inputs: { x: { type: 'any', from: 'p.v' } } },
      ],
      [
        ['start', 'ok_hosts', 'p'],
        ['p', 'ok_hosts', 'r'],
        ['p', 'failed_hosts', 'h'],
        ['h', 'ok_hosts', 'r'],
        ['r', 'ok_hosts', 'done'],
      ],
    );
    expect(codes(failing.doc, 'ref-may-be-undefined')[0]?.message).toContain(
      'hosts that fail in it still get here',
    );
    // A read guarded with default(), as imported handlers do, is fine.
    const guarded = structuredClone(failing.doc);
    const r = guarded.nodes.find((n) => n.key === 'r') as FlowNode;
    r.impl = {
      kind: 'module',
      ref: 'ansible.builtin.debug',
      params: { msg: 'saved' },
      keywords: { when: '(x | default({})) is changed' },
    };
    expect(codes(guarded, 'ref-may-be-undefined')).toEqual([]);
    // On the only path: no finding.
    const straight = flowOf(
      [
        { key: 'p', outputs: { v: { type: 'any' } } },
        { key: 'r', inputs: { x: { type: 'any', from: 'p.v' } } },
      ],
      [
        ['start', 'ok_hosts', 'p'],
        ['p', 'ok_hosts', 'r'],
        ['r', 'ok_hosts', 'done'],
      ],
    );
    expect(codes(straight.doc, 'ref-may-be-undefined')).toEqual([]);
  });
});

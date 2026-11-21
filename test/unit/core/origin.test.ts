// AFD-339: where a value comes from, as a chain of hops through the flow alone.

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { describeFlow } from '../../../src/core/ai/describe';
import { parseFlow } from '../../../src/core/flow/document';
import { buildModel } from '../../../src/core/flow/model';
import {
  flowInputOrigin,
  fromOrigin,
  inputOrigin,
  nameOrigin,
  originHead,
  originText,
  originValue,
} from '../../../src/core/flow/origin';
import type { Edge, FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { dataLens } from '../../../src/core/lens/data';
import { describeAt } from '../../../src/core/view/jinjaComplete';

let seq = 0;
const id = () => `01TEST${String(++seq).padStart(20, '0')}`;

/** start → steps… → done, wired in order on one level. */
function level(steps: FlowNode[]): { nodes: FlowNode[]; edges: Edge[] } {
  const start = { id: id(), key: 'start', type: 'start', title: 'Start' } as FlowNode;
  const done = {
    id: id(),
    key: 'done',
    type: 'end',
    title: 'Done',
    outcome: 'success',
  } as FlowNode;
  const all = [start, ...steps, done];
  const edges = all.slice(1).map((n, i) => ({
    id: id(),
    from: { node: (all[i] as FlowNode).id, port: 'ok_hosts' },
    to: { node: n.id, port: 'in' },
  }));
  return { nodes: [start, ...steps, done], edges };
}

const step = (key: string, rest: Partial<FlowNode> = {}): FlowNode =>
  ({ id: id(), key, type: 'task', title: key.replace(/-/g, ' '), ...rest }) as FlowNode;

function flow(steps: FlowNode[], header: Partial<FlowDocument['flow']> = {}): FlowDocument {
  return {
    schema_version: 2,
    flow: { id: id(), key: 'origin-test', name: 'Origin test', version: 1, ...header },
    ...level(steps),
  } as FlowDocument;
}

describe('originOf (AFD-339)', () => {
  it('follows a flow input with its default, asked when the run starts', () => {
    const reader = step('reader', { inputs: { tries: { type: 'integer', from: 'flow.tries' } } });
    const doc = flow([reader], { inputs: { tries: { type: 'integer', default: 3 } } });
    const o = inputOrigin(buildModel(doc), reader, 'tries');
    expect(o.hops.map((h) => h.kind)).toEqual(['nodeInput', 'flowInput']);
    expect(o.hops[1]).toMatchObject({
      value: '3',
      label: expect.stringContaining('asked when the run starts'),
    });
    expect(flowInputOrigin(buildModel(doc), 'tries').hops[0]?.value).toBe('3');
  });

  it('says a required flow input with no default is asked for', () => {
    const doc = flow([], { inputs: { change: { type: 'string', required: true } } });
    expect(originHead(flowInputOrigin(buildModel(doc), 'change'))?.label).toContain('required');
  });

  it('a register with the result field doc from the catalog', () => {
    const check = step('check-version', {
      impl: { kind: 'module', ref: 'ansible.builtin.command', params: { cmd: 'show version' } },
      outputs: { version: { type: 'dict', from: 'impl.register' } },
    });
    const reader = step('reader', {
      inputs: { out: { type: 'string', from: 'check-version.version.stdout' } },
    });
    const doc = flow([check, reader]);
    const o = inputOrigin(buildModel(doc), reader, 'out', {
      fieldsOf: () => [{ name: 'stdout', detail: 'The command standard output.' }],
    });
    expect(o.hops.at(-1)).toMatchObject({
      kind: 'register',
      node: check.id,
      path: ['stdout'],
      doc: 'The command standard output.',
      name: 'check_version_result',
    });
  });

  it('a set_fact literal is static; a templated one shows the template and follows it', () => {
    const base = step('base', {
      impl: { kind: 'module', ref: 'ansible.builtin.set_fact', params: { site: 'ams1' } },
    });
    const derive = step('derive', {
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.set_fact',
        params: { fqdn: '{{ inventory_hostname }}.{{ site }}' },
      },
      outputs: { fqdn: { type: 'string' } },
    });
    const reader = step('reader', { inputs: { name: { type: 'string', from: 'derive.fqdn' } } });
    const doc = flow([base, derive, reader]);
    const o = inputOrigin(buildModel(doc), reader, 'name');
    const fact = o.hops.find((h) => h.kind === 'setFact' && h.name === 'fqdn');
    expect(fact).toMatchObject({ template: '{{ inventory_hostname }}.{{ site }}', static: false });
    const deeper = o.hops.filter((h) => h.depth === 1);
    expect(deeper.map((h) => h.kind)).toEqual(['magic', 'setFact']);
    expect(deeper[1]).toMatchObject({ value: 'ams1', static: true, node: base.id });
  });

  it('chains through a subflow input and an output lifted from an inner step', () => {
    const inner = step('read', {
      impl: { kind: 'module', ref: 'ansible.builtin.command', params: { cmd: 'x' } },
      inputs: { host: { type: 'string', from: 'pre.target' } },
      outputs: { rc: { type: 'integer', from: 'impl.register.rc' } },
    });
    const sub = {
      ...step('pre', { type: 'subflow' }),
      inputs: { target: { type: 'string', from: 'flow.target' } },
      outputs: { rc: { type: 'integer' } },
      subflow: level([inner]),
    } as FlowNode;
    const reader = step('reader', { inputs: { code: { type: 'integer', from: 'pre.rc' } } });
    const doc = flow([sub, reader], { inputs: { target: { type: 'string', default: 'r1' } } });
    const model = buildModel(doc);
    expect(inputOrigin(model, reader, 'code').hops.map((h) => h.kind)).toEqual([
      'nodeInput',
      'lifted',
      'register',
    ]);
    const into = inputOrigin(model, inner, 'host');
    expect(into.hops.map((h) => h.kind)).toEqual(['nodeInput', 'subflowInput', 'flowInput']);
    expect(originHead(into)?.value).toBe('r1');
  });

  it('a name read without an input: external vars, magic vars, unknown', () => {
    const reader = step('reader', {
      impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ ticket }}' } },
    });
    const doc = flow([reader], { external_vars: { ticket: 'AWX survey' } });
    const m = buildModel(doc);
    expect(nameOrigin(m, reader, 'ticket').hops[0]).toMatchObject({
      kind: 'external',
      label: 'set outside the flow: AWX survey',
    });
    expect(nameOrigin(m, reader, 'group_names').hops[0]).toMatchObject({ kind: 'magic' });
    expect(nameOrigin(m, reader, 'ntp_server').hops[0]?.label).toContain('decided at run time');
  });

  it('an input with a default: static when nothing feeds it, a note when it has a source', () => {
    const reader = step('reader', {
      inputs: {
        retries: { type: 'integer', default: 5 },
        mtu: { type: 'integer', from: 'flow.mtu', default: 1500 },
      },
    });
    const doc = flow([reader], { inputs: { mtu: { type: 'integer' } } });
    const m = buildModel(doc);
    expect(inputOrigin(m, reader, 'retries').hops[0]).toMatchObject({ value: '5', static: true });
    const mtu = inputOrigin(m, reader, 'mtu');
    expect(mtu.hops[0]?.fallback).toBe('1500');
    expect(mtu.notes[0]).toContain("host's own mtu first");
  });

  it('notes an extra var of the same name and the validator findings', () => {
    const up = step('up', { outputs: { vlan: { type: 'integer' } } });
    const reader = step('reader', { inputs: { vlan: { type: 'integer', from: 'up.vlan' } } });
    const doc = flow([up, reader], { inputs: { vlan: { type: 'integer' } } });
    const o = inputOrigin(buildModel(doc), reader, 'vlan', {
      findings: [
        {
          code: 'input-shadowed',
          node: reader.id,
          subject: 'vlan',
          message: 'm',
          brief: 'shadowed',
        },
      ],
    });
    expect(o.notes).toContain('shadowed');
    expect(o.notes.some((n) => n.includes('wins over this input'))).toBe(true);
    expect(o.hops.at(-1)?.kind).toBe('placeholder');
  });

  it('stops at a cycle', () => {
    const a = step('a', {
      impl: { kind: 'module', ref: 'ansible.builtin.set_fact', params: { x: '{{ y }}' } },
      inputs: { y: { type: 'any', from: 'b.y' } },
    });
    const b = step('b', {
      impl: { kind: 'module', ref: 'ansible.builtin.set_fact', params: { y: '{{ x }}' } },
      inputs: { x: { type: 'any', from: 'a.x' } },
      outputs: { y: { type: 'any' } },
    });
    (a as FlowNode).outputs = { x: { type: 'any' } };
    const doc = flow([a, b]);
    const o = inputOrigin(buildModel(doc), b, 'x');
    expect(o.cut).toBe('cycle');
    expect(o.hops.length).toBeLessThan(10);
  });

  it('cuts a very long chain', () => {
    const steps: FlowNode[] = [step('s0', { inputs: { v: { type: 'any', default: 1 } } })];
    for (let i = 1; i < 40; i++)
      steps.push(
        step(`s${i}`, {
          impl: {
            kind: 'module',
            ref: 'ansible.builtin.set_fact',
            params: { [`v${i}`]: `{{ v${i - 1 === 0 ? '' : i - 1} }}` },
          },
        }),
      );
    const reader = step('reader', {
      impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ v39 }}' } },
    });
    const o = nameOrigin(buildModel(flow([...steps, reader])), reader, 'v39');
    expect(o.cut).toBe('depth');
    expect(o.hops.length).toBe(24);
  });

  it('never shows a secret: a secret-looking name, no_log or a vault value, down the chain', () => {
    const base = step('base', {
      impl: { kind: 'module', ref: 'ansible.builtin.set_fact', params: { part: 'hunter2' } },
    });
    const pw = step('pw', {
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.set_fact',
        params: { db_password: 'x-{{ part }}' },
      },
      outputs: { db_password: { type: 'string' } },
    });
    const reader = step('reader', {
      inputs: { db_password: { type: 'string', from: 'pw.db_password', default: 'fallback' } },
    });
    const logged = step('logged', {
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.set_fact',
        params: { token_like: 'plain' },
        keywords: { no_log: true },
      },
      outputs: { token_like: { type: 'string' } },
    });
    const vaulted = step('vaulted', {
      inputs: { blob: { type: 'string', default: '$ANSIBLE_VAULT;1.1;AES256\n6132' } },
    });
    const doc = flow([base, pw, reader, logged, vaulted]);
    const m = buildModel(doc);
    for (const o of [
      inputOrigin(m, reader, 'db_password'),
      fromOrigin(m, vaulted, 'inputs', 'logged.token_like'),
      inputOrigin(m, vaulted, 'blob'),
    ]) {
      expect(o.secret).toBe(true);
      const text = JSON.stringify(o) + originText(o);
      for (const s of ['hunter2', 'fallback', 'x-{{', 'plain', 'AES256', '6132'])
        expect(text).not.toContain(s);
    }
  });

  it('a value is one line, cut in the middle', () => {
    expect(originValue({ a: [1, 2] })).toBe('{a: [1, 2]}');
    const long = originValue('x'.repeat(50) + 'y'.repeat(50));
    expect(long).toHaveLength(79);
    expect(long.startsWith('xxx') && long.endsWith('yyy') && long.includes('…')).toBe(true);
  });

  it('the hover on a {{ name }} carries the chain (describeAt)', () => {
    const reader = step('reader', { inputs: { tries: { type: 'integer', from: 'flow.tries' } } });
    const doc = flow([reader], { inputs: { tries: { type: 'integer', default: 3 } } });
    const m = buildModel(doc);
    const text = 'n={{ tries }}';
    const d = describeAt(
      text,
      text.indexOf('tries') + 1,
      { mode: 'template' },
      {
        vars: [],
        origin: (name) => nameOrigin(m, reader, name),
      },
    );
    expect(d?.label).toBe('tries');
    expect(originHead(d?.origin as never)?.value).toBe('3');
  });

  it('a Data lens wire title goes on to where the value starts', () => {
    const inner = step('read', {
      impl: { kind: 'module', ref: 'ansible.builtin.command', params: { cmd: 'x' } },
      outputs: { rc: { type: 'integer', from: 'impl.register.rc' } },
    });
    const sub = {
      ...step('pre', { type: 'subflow' }),
      outputs: { rc: { type: 'integer' } },
      subflow: level([inner]),
    } as FlowNode;
    const reader = step('reader', { inputs: { code: { type: 'integer', from: 'pre.rc' } } });
    const wire = dataLens(flow([sub, reader])).dataWires?.find((w) => w.to === reader.id);
    expect(wire?.title).toContain('pre.rc → reader.code');
    expect(wire?.title).toContain('result of "read" (ansible.builtin.command)');
  });

  it('flow_describe with nodes adds the chain of each input', () => {
    const reader = step('reader', { inputs: { tries: { type: 'integer', from: 'flow.tries' } } });
    const doc = flow([reader], { inputs: { tries: { type: 'integer', default: 3 } } });
    const m = buildModel(doc);
    const text = describeFlow(m, [], 'r1', undefined, undefined, undefined, { nodes: ['reader'] });
    expect(text).toContain('origins: tries <= flow input tries (asked when the run starts) = 3');
    expect(describeFlow(m, [], 'r1')).not.toContain('origins:');
  });

  it('the harness flow: chains through the subflow, the template and a secret', () => {
    const text = readFileSync('test/fixtures/flows/value-origin.flow.yaml', 'utf8');
    const m = buildModel(parseFlow(text).doc as FlowDocument);
    const report = [...m.nodes.values()].find((e) => e.node.key === 'report')?.node as FlowNode;
    expect(inputOrigin(m, report, 'code').hops.map((h) => h.kind)).toEqual([
      'nodeInput',
      'lifted',
      'register',
    ]);
    const image = nameOrigin(m, report, 'change_ticket');
    expect(image.hops[0]?.kind).toBe('external');
    const token = nameOrigin(m, report, 'token');
    expect(token.secret).toBe(true);
    const stage = [...m.nodes.values()].find((e) => e.node.key === 'stage')?.node as FlowNode;
    const chain = inputOrigin(m, stage, 'image');
    expect(chain.hops.map((h) => h.kind)).toEqual([
      'nodeInput',
      'subflowInput',
      'setFact',
      'nodeInput',
      'flowInput',
      'setFact',
    ]);
    expect(originText(chain)).toContain('= 17.9.4');
    expect(originText(chain)).toContain('= ams1');
  });
});

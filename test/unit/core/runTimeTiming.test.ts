// AFD-112 (round 4: Q4): a step's Retries, Delay and Timeout given at run time. The participant
// asked to let the operator set a drain wait wrote it into the flow's goal: the fields took only
// numbers. Ansible renders `retries: "{{ drain_tries }}"` before the task runs (checked in
// afd-ee:2.19), so the flow keeps the template and the step input it reads.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { renameExprRef, singleRef, templated } from '../../../src/core/flow/jinja';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { importPlaybook } from '../../../src/core/import/playbook';
import { readPlaybook } from '../../../src/core/import/source';
import { dataLens } from '../../../src/core/lens/data';
import { askedInput, inputDefaultOf, timingChoices } from '../../../src/core/view/settings';

const schema = createSchemaValidator();

/** A new flow with one module step, "Wait for the pool to drain", between Start and Done. */
function flow() {
  const ctx = { newId: createIdFactory() };
  let text = newFlowText('Pool maintenance', 'pool', ctx.newId);
  const apply = (cmd: FlowCommand) => {
    const r = planCommand(text, cmd, ctx);
    text = r.text;
    return r;
  };
  const doc = () => parse(text) as FlowDocument;
  const wire = doc().edges?.[0]?.id as string;
  const id = apply({
    kind: 'addNode',
    type: 'task',
    title: 'Wait for the pool to drain',
    insertOn: wire,
  }).created as string;
  apply({
    kind: 'setBinding',
    id,
    impl: { kind: 'module', ref: 'ansible.builtin.command', params: { cmd: 'lbctl pool status' } },
  });
  const step = () => doc().nodes.find((n) => n.id === id) as FlowNode;
  return { apply, doc, id, step, text: () => text };
}

const findings = (d: FlowDocument, code?: string) =>
  validateFlow(d, schema(d)).findings.filter((f) => !code || f.code === code);

describe('Ask at run time (askAtRunTime)', () => {
  it('makes the flow input, the step input and the template in one edit', () => {
    const f = flow();
    f.apply({
      kind: 'askAtRunTime',
      id: f.id,
      setting: 'retries',
      name: 'drain_tries',
      description: 'How many more times to check that the pool has drained',
      default: 12,
    });
    const d = f.doc();
    expect(d.flow.inputs?.drain_tries).toEqual({
      type: 'integer',
      default: 12,
      description: 'How many more times to check that the pool has drained',
    });
    expect(f.step().inputs?.drain_tries).toEqual({ type: 'integer', from: 'flow.drain_tries' });
    expect(f.step().settings?.retries).toBe('{{ drain_tries }}');
    expect(findings(d).filter((x) => x.severity === 'error')).toEqual([]);
    expect(findings(d, 'setting-unknown-var')).toEqual([]);
  });

  it('without a default the flow input is required; a second setting reuses the input', () => {
    const f = flow();
    f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'timeout', name: 'drain_limit' });
    expect(f.doc().flow.inputs?.drain_limit).toEqual({ type: 'integer', required: true });
    const again = f.apply({
      kind: 'askAtRunTime',
      id: f.id,
      setting: 'delay',
      name: 'drain_limit',
    });
    expect(again.notes).toContain('Uses the flow input drain_limit that the flow has already');
    expect(f.step().settings).toMatchObject({
      timeout: '{{ drain_limit }}',
      delay: '{{ drain_limit }}',
    });
  });

  it('refuses an approval, a flow input that holds no number, and a step input reading elsewhere', () => {
    const f = flow();
    const wire = f.doc().edges?.[0]?.id as string;
    const gate = f.apply({ kind: 'addNode', type: 'approval', title: 'Approve', insertOn: wire })
      .created as string;
    expect(() =>
      f.apply({ kind: 'askAtRunTime', id: gate, setting: 'timeout', name: 'gate_wait' }),
    ).toThrow(/AWX needs a number/);
    f.apply({
      kind: 'setContractField',
      target: 'flow',
      side: 'inputs',
      name: 'pools',
      field: { type: 'list', default: ['web'] },
    });
    expect(() =>
      f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'retries', name: 'pools' }),
    ).toThrow(/holds no number/);
    f.apply({
      kind: 'setContractField',
      target: f.id,
      side: 'inputs',
      name: 'tries',
      field: { type: 'integer', default: 2 },
    });
    expect(() =>
      f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'retries', name: 'tries' }),
    ).toThrow(/already has an input "tries"/);
  });

  it('an @ pick in a Timing field: the setting and the input it reads are one updateNode', () => {
    const f = flow();
    const r = f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: {
        settings: { delay: '{{ drain_delay }}' },
        inputs: { drain_delay: { type: 'integer', from: 'flow.drain_delay' } },
      },
    });
    expect(r.edits.length).toBeGreaterThan(0);
    expect(f.step().settings?.delay).toBe('{{ drain_delay }}');
    expect(f.step().inputs?.drain_delay).toEqual({ type: 'integer', from: 'flow.drain_delay' });
  });

  it('renaming the step input renames it in Timing and in until', () => {
    const f = flow();
    f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'retries', name: 'drain_tries' });
    f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: { settings: { until: "'drained' in result.stdout or drain_tries == 0" } },
    });
    f.apply({
      kind: 'setContractField',
      target: f.id,
      side: 'inputs',
      name: 'drain_tries',
      field: { type: 'integer', from: 'flow.drain_tries' },
      rename: 'pool_tries',
    });
    expect(f.step().settings).toMatchObject({
      retries: '{{ pool_tries }}',
      until: "'drained' in result.stdout or pool_tries == 0",
    });
  });
});

describe('the flow check', () => {
  it('a name that is no input: a warning, or info for a flow input read directly', () => {
    const f = flow();
    f.apply({
      kind: 'setContractField',
      target: 'flow',
      side: 'inputs',
      name: 'drain_tries',
      field: { type: 'integer', default: 12 },
    });
    f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: { settings: { retries: '{{ drain_tries }}', delay: '{{ pause }}' } },
    });
    const found = findings(f.doc(), 'setting-unknown-var').map((x) => [x.severity, x.subject]);
    expect(found).toEqual([
      ['info', 'drain_tries'],
      ['warning', 'pause'],
    ]);
  });

  it('an input that holds no number is a warning; a template is no unreadable timeout', () => {
    const f = flow();
    f.apply({
      kind: 'setContractField',
      target: f.id,
      side: 'inputs',
      name: 'pools',
      field: { type: 'list', default: ['web'] },
    });
    f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: { settings: { retries: '{{ pools }}', timeout: '{{ pools }}' } },
    });
    expect(findings(f.doc(), 'setting-input-type').map((x) => x.message)).toEqual([
      '"Wait for the pool to drain" retries reads pools, a list: Ansible needs a whole number there, so the task fails',
      '"Wait for the pool to drain" timeout reads pools, a list: Ansible needs a whole number of seconds there, so the task fails',
    ]);
    expect(findings(f.doc(), 'timeout-unreadable')).toEqual([]);
  });

  it("an approval's timeout given at run time is unreadable: AWX needs a number", () => {
    const f = flow();
    const wire = f.doc().edges?.[0]?.id as string;
    const gate = f.apply({ kind: 'addNode', type: 'approval', title: 'Approve', insertOn: wire })
      .created as string;
    f.apply({ kind: 'updateNode', id: gate, patch: { settings: { timeout: '{{ gate_wait }}' } } });
    expect(findings(f.doc(), 'timeout-unreadable').map((x) => x.message)).toEqual([
      '"Approve" timeout "{{ gate_wait }}" is given at run time, but an AWX approval needs a fixed duration (30m, 4h), so it gets none',
    ]);
  });

  it('the schema takes a template for retries and delay, not other text', () => {
    const f = flow();
    f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: { settings: { retries: '{{ drain_tries }}', delay: '{{ drain_delay }}' } },
    });
    expect(schema(f.doc())).toEqual([]);
    const bad = f.doc();
    const step = bad.nodes.find((n) => n.id === f.id) as FlowNode;
    step.settings = { retries: 'twelve' as unknown as number };
    expect(schema(bad).length).toBeGreaterThan(0);
  });
});

describe('the generated task', () => {
  it('passes the templates to Ansible, which renders them before the task runs', () => {
    const f = flow();
    for (const [setting, name] of [
      ['retries', 'drain_tries'],
      ['delay', 'drain_delay'],
      ['timeout', 'drain_limit'],
    ] as const)
      f.apply({ kind: 'askAtRunTime', id: f.id, setting, name, default: 5 });
    f.apply({
      kind: 'updateNode',
      id: f.id,
      patch: { settings: { until: "'drained' in wait_for_the_pool_to_drain_result.stdout" } },
    });
    const result = optionA.generate(f.doc(), { source: 'pool.flow.yaml' });
    expect(result.ok).toBe(true);
    const code = result.files.map((x) => x.text).join('\n');
    expect(code).toMatch(/timeout: ["']\{\{ drain_limit \}\}["']/);
    expect(code).toMatch(/retries: ["']\{\{ drain_tries \}\}["']/);
    expect(code).toMatch(/delay: ["']\{\{ drain_delay \}\}["']/);
  });

  it("a role step's include_role applies a timeout given at run time", () => {
    const f = flow();
    f.apply({ kind: 'setBinding', id: f.id, impl: { kind: 'role', ref: 'lab.pool.drain' } });
    f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'timeout', name: 'drain_limit' });
    const result = optionA.generate(f.doc(), { source: 'pool.flow.yaml' });
    const code = result.files.map((x) => x.text).join('\n');
    expect(code).toMatch(/apply:[\s\S]*timeout: ["']\{\{ drain_limit \}\}["']/);
  });
});

describe('around the flow', () => {
  it('the Data lens names the Timing field on the wire of the input it reads', () => {
    const f = flow();
    f.apply({ kind: 'askAtRunTime', id: f.id, setting: 'retries', name: 'drain_tries' });
    const titles = (dataLens(f.doc()).dataWires ?? []).map((w) => w.title);
    expect(titles).toContain('flow.drain_tries → Wait for the pool to drain.drain_tries · Retries');
  });

  it('a playbook with templated retries, delay and timeout keeps them and wires the input it has', async () => {
    const book = [
      '- hosts: lab',
      '  vars:',
      '    drain_tries: 12',
      '  tasks:',
      '    - name: Wait for the pool to drain',
      '      ansible.builtin.command: lbctl pool status',
      '      register: drain',
      '      until: "\'drained\' in drain.stdout"',
      '      retries: "{{ drain_tries }}"',
      '      delay: "{{ drain_delay | default(10) }}"',
      '      timeout: "{{ drain_limit }}"',
    ].join('\n');
    const read = await readPlaybook(
      { read: async (p) => (p === 'site.yml' ? book : undefined), list: async () => [] },
      'site.yml',
    );
    if (!read.playbook) throw new Error(read.notes.join('\n'));
    const result = importPlaybook(read.playbook, {
      key: 'imported',
      newId: createIdFactory(),
      generatedDir: 'flows/imported/generated',
    });
    let step: FlowNode | undefined;
    const walk = (nodes: FlowNode[] = []) => {
      for (const n of nodes) {
        if (n.title === 'Wait for the pool to drain') step = n;
        walk(n.subflow?.nodes);
      }
    };
    walk(result.doc.nodes);
    expect(step?.settings).toMatchObject({
      retries: '{{ drain_tries }}',
      delay: '{{ drain_delay | default(10) }}',
      timeout: '{{ drain_limit }}',
    });
    // The play's var becomes a flow input the step reads; the extra vars nothing defines are
    // left for the check to name.
    expect(step?.inputs?.drain_tries).toMatchObject({ from: 'flow.drain_tries' });
    expect(result.notes.join('\n')).not.toMatch(/retries|timeout/);
    const unknown = findings(result.doc, 'setting-unknown-var').map((x) => x.subject);
    expect(unknown).toEqual(['drain_delay', 'drain_limit']);
  });
});

describe('helpers', () => {
  it('a template is a whole {{ … }}; one input is a bare name', () => {
    expect([templated('{{ x }}'), templated(' {{ (x / 10) | int }} '), templated('10')]).toEqual([
      true,
      true,
      false,
    ]);
    expect([
      singleRef('{{ drain_tries }}'),
      singleRef('{{ r.rc }}'),
      singleRef('{{ x + 1 }}'),
    ]).toEqual(['drain_tries', undefined, undefined]);
    expect(renameExprRef("x == 1 and 'x' in y.x", 'x', 'z')).toBe("z == 1 and 'x' in y.x");
  });

  it("the sentence's defaults: the step input's, else the flow input's", () => {
    const node = {
      inputs: {
        tries: { type: 'integer' as const, from: 'flow.drain_tries' },
        pause: { type: 'integer' as const, default: 7 },
        other: { type: 'integer' as const, from: 'flow.missing' },
      },
    };
    const of = inputDefaultOf({ inputs: { drain_tries: { type: 'integer', default: 12 } } }, node);
    expect([of('tries'), of('pause'), of('other'), of('nope')]).toEqual([
      12,
      7,
      undefined,
      undefined,
    ]);
    expect(askedInput('{{ tries }}', node)).toEqual({ input: 'tries', flow: 'drain_tries' });
    expect(askedInput('{{ pause }}', node)).toBeUndefined();
  });

  it("a Timing field's @ list offers inputs that can hold a number, never a result", () => {
    const node = {
      inputs: { names: { type: 'list' as const }, tries: { type: 'integer' as const } },
    };
    const offered = timingChoices(
      [
        { name: 'tries', label: 'tries', detail: 'node input' },
        { name: 'names', label: 'names', detail: 'node input' },
        {
          name: 'site',
          label: 'flow.site',
          detail: '',
          field: { type: 'string', from: 'flow.site' },
        },
        {
          name: 'hosts',
          label: 'flow.hosts',
          detail: '',
          field: { type: 'dict', from: 'flow.hosts' },
        },
        { name: 'read_result', label: 'read_result', detail: '', fields: [] },
      ],
      node,
    ).map((c) => c.name);
    expect(offered).toEqual(['tries', 'site']);
  });
});

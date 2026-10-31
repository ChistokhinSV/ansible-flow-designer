// AFD-26: Ansible task keywords on a binding (impl.keywords): schema allow-list, the validator,
// the generated task, edits and what agents and exports show.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import schemaJson from '../../../schema/flow.schema.json';
import { describeFlow } from '../../../src/core/ai/describe';
import { bindingTask } from '../../../src/core/engine/binding';
import { optionA } from '../../../src/core/engine/optionA';
import { nodeDetails } from '../../../src/core/export/details';
import { CommandError, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { ALLOWED_KEYWORDS, keywordHint, keywordReads } from '../../../src/core/flow/keywords';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode, ImplBinding } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeOf = (text: string, key: string): FlowNode => {
  for (const { node } of buildModel(docOf(text)).nodes.values()) if (node.key === key) return node;
  throw new Error(`no node ${key}`);
};
const findings = (text: string) => {
  const doc = docOf(text);
  return validateFlow(doc, schema(doc)).findings;
};

/** edge-baseline with `validate` bound to a module that carries these keywords. */
function withModule(keywords: Record<string, unknown>, extra: Partial<ImplBinding> = {}): string {
  const node = nodeOf(EDGE, 'validate');
  return planCommand(
    EDGE,
    {
      kind: 'setBinding',
      id: node.id,
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.command',
        params: { cmd: 'show ntp' },
        keywords,
        ...extra,
      },
      status: 'implemented',
    },
    ctx,
  ).text;
}

describe('impl.keywords schema', () => {
  it('allow-lists the keywords in keywords.ts, every one described', () => {
    type Described = { description?: string };
    const kw = (
      schemaJson.$defs.impl.properties as unknown as Record<
        string,
        { properties: Record<string, Described>; additionalProperties: unknown }
      >
    ).keywords as { properties: Record<string, Described>; additionalProperties: unknown };
    expect(Object.keys(kw.properties).sort()).toEqual([...ALLOWED_KEYWORDS].sort());
    for (const v of Object.values(kw.properties)) expect(v.description).toBeTruthy();
    expect(kw.additionalProperties).toBe(false);
  });

  it('accepts when, loop and with_items; names the place of a modelled keyword', () => {
    const ok = withModule({
      when: 'ansible_network_os == "ios"',
      with_items: [1, 2],
      ignore_errors: true,
    });
    expect(findings(ok).filter((f) => f.severity === 'error')).toEqual([]);
    const bad = findings(withModule({ tags: ['x'], notify: 'restart' }));
    const reserved = bad.filter((f) => f.code === 'keyword-reserved');
    expect(reserved.map((f) => f.message).sort()).toEqual([
      'notify is modelled by the flow: use a handler step with when: <register> is changed',
      'tags is modelled by the flow: use settings.tags',
    ]);
    expect(reserved.every((f) => f.severity === 'error')).toBe(true);
  });
});

describe('impl.keywords validation', () => {
  it('checks variables in keywords like params; loop variables, vars and the result are known', () => {
    const text = withModule({
      when: 'version_check.stdout is search("17")',
      loop: '{{ interfaces }}',
      loop_control: { loop_var: 'intf' },
      vars: { mtu: 9000 },
      changed_when: "'changed' in validate_result.stdout",
      environment: { HTTP_PROXY: '{{ proxy }}' },
    });
    const unknown = findings(text)
      .filter((f) => f.code === 'binding-unknown-var')
      .map((f) => f.message.match(/reads "(\w+)"/)?.[1])
      .sort();
    expect(unknown).toEqual(['interfaces', 'proxy', 'version_check']);
    const reads = keywordReads(nodeOf(text, 'validate').impl);
    expect(reads.own.sort()).toEqual(['intf', 'mtu']);
  });

  it('warns that playbook bindings take no keywords and roles take vars as params', () => {
    const role = planCommand(
      EDGE,
      {
        kind: 'setBinding',
        id: nodeOf(EDGE, 'push-baseline').id,
        impl: { kind: 'role', ref: 'netops.baseline.push_ntp_aaa', keywords: { vars: { a: 1 } } },
        status: 'implemented',
      },
      ctx,
    ).text;
    expect(findings(role).some((f) => f.code === 'keyword-ignored')).toBe(true);
    const doc = docOf(EDGE);
    const node = buildModel(doc).nodes.get(nodeOf(EDGE, 'validate').id)?.node as FlowNode;
    node.impl = { kind: 'playbook', ref: 'playbooks/x.yml', keywords: { when: 'true' } };
    expect(validateFlow(doc).findings.some((f) => f.code === 'keyword-ignored')).toBe(true);
  });
});

describe('impl.keywords code generation', () => {
  it('writes keywords on the module task, after the module and before Option A routing keys', () => {
    const node = nodeOf(withModule({ when: 'x', delegate_to: 'localhost' }), 'validate');
    const task = bindingTask(node, node.impl as ImplBinding);
    expect(Object.keys(task)).toEqual([
      'name',
      'ansible.builtin.command',
      'when',
      'delegate_to',
      'register',
      'ignore_unreachable',
      'timeout',
      'retries',
      'delay',
      'until',
    ]);
    expect(task.when).toBe('x');
  });

  it('keeps conditions and loops on include_role and applies the rest to the role tasks', () => {
    const node: FlowNode = {
      id: '01J00000000000000000000001',
      key: 'push',
      type: 'task',
      title: 'Push',
      impl: {
        kind: 'role',
        ref: 'netops.push',
        params: { tasks_from: 'ntp', servers: ['192.0.2.1'] },
        keywords: {
          when: 'ok',
          loop: [1],
          delegate_to: 'localhost',
          become_user: 'admin',
          vars: { x: 1 },
        },
      },
    };
    const task = bindingTask(node, node.impl as ImplBinding);
    expect(task.when).toBe('ok');
    expect(task.loop).toEqual([1]);
    const include = task['ansible.builtin.include_role'] as Record<string, unknown>;
    expect(include.apply).toMatchObject({
      delegate_to: 'localhost',
      become_user: 'admin',
    });
    expect(include.tasks_from).toBe('ntp');
    expect(task.vars).toEqual({ servers: ['192.0.2.1'] });
  });

  it('generates a flow with keywords without errors', () => {
    const result = optionA.generate(docOf(withModule({ when: 'inventory_hostname != "h07"' })), {
      source: 'edge-baseline.flow.yaml',
    });
    expect(result.ok).toBe(true);
    expect(result.files[0]?.text).toContain('when: inventory_hostname != "h07"');
  });
});

describe('impl.keywords edits and display', () => {
  it('update_node sets and clears keywords in one edit; a binding is required', () => {
    const text = withModule({ when: 'a' });
    const id = nodeOf(text, 'validate').id;
    const set = planCommand(
      text,
      { kind: 'updateNode', id, patch: { keywords: { loop: [1, 2] } } },
      ctx,
    ).text;
    expect(nodeOf(set, 'validate').impl?.keywords).toEqual({ loop: [1, 2] });
    expect(schema(docOf(set))).toEqual([]);
    const cleared = planCommand(
      set,
      { kind: 'updateNode', id, patch: { keywords: null } },
      ctx,
    ).text;
    expect(nodeOf(cleared, 'validate').impl?.keywords).toBeUndefined();
    const unbound = nodeOf(EDGE, 'precheck');
    expect(() =>
      planCommand(
        EDGE,
        { kind: 'updateNode', id: unbound.id, patch: { keywords: { when: 'a' } } },
        ctx,
      ),
    ).toThrow(CommandError);
  });

  it('a new binding keeps the keywords unless it brings its own', () => {
    const text = withModule({ when: 'a' });
    const id = nodeOf(text, 'validate').id;
    const rebound = planCommand(
      text,
      {
        kind: 'setBinding',
        id,
        impl: { kind: 'module', ref: 'ansible.builtin.ping' },
        status: 'implemented',
      },
      ctx,
    ).text;
    expect(nodeOf(rebound, 'validate').impl).toMatchObject({
      ref: 'ansible.builtin.ping',
      keywords: { when: 'a' },
    });
  });

  it('agents, exports and the canvas see them', () => {
    const text = withModule({ when: 'x is defined', loop: '{{ items }}' });
    const doc = docOf(text);
    expect(describeFlow(buildModel(doc), [], 'r1')).toContain(
      'keywords: when=x is defined, loop={{ items }}',
    );
    const node = nodeOf(text, 'validate');
    expect(
      nodeDetails(node, { model: buildModel(doc), findings: [], openPorts: [] }),
    ).toContainEqual(['keywords', 'when: x is defined\nloop: "{{ items }}"']);
    expect(keywordHint(node.impl)).toBe('when + loop');
  });
});

describe('AFD-27: a list input with a string default', () => {
  it('warns that it would be joined letter by letter', () => {
    const doc = docOf(EDGE);
    (doc.flow.inputs as Record<string, { type: string; default?: unknown }>).devices = {
      type: 'host_list',
      default: 'edge',
    };
    const found = validateFlow(doc).findings.filter((f) => f.code === 'input-default-type');
    expect(found.map((f) => f.message)).toEqual([
      'Flow input devices is a host_list but its default is the string "edge": write it as a list, [edge]',
    ]);
  });
});

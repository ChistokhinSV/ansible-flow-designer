// AFD-71: the Execution tab shows a setting only where the generated code uses it. The contract is
// checked against the generator: every setting set on one node, generated, and looked for.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import { type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { createIdFactory } from '../../../src/core/flow/ids';
import { newFlowText } from '../../../src/core/flow/template';
import type { FlowDocument, NodeType } from '../../../src/core/flow/types';
import { appliesTo, EXECUTION_SETTINGS, type SettingKey } from '../../../src/core/view/settings';

const ctx = { newId: createIdFactory() };

/** Each setting with a value that can only come from it, and how it shows in the playbook. */
const PROBES: Partial<Record<SettingKey, { value: unknown; shows: RegExp }>> = {
  serial: { value: 7, shows: /serial: 7\b/ },
  // With an inventory target it is the target plays' own check.
  max_fail_percentage: { value: 13, shows: /max_fail_percentage: 13\b|\* 100 > 13 \*/ },
  become: { value: true, shows: /become: true/ },
  become_user: { value: 'afd_admin', shows: /afd_admin/ },
  tags: { value: ['afd_tag'], shows: /afd_tag/ },
  timeout: { value: '31s', shows: /timeout: 31\b/ },
  retries: { value: 4, shows: /retries: 4\b/ },
  until: { value: 'afd_until is defined', shows: /afd_until/ },
  delay: { value: 6, shows: /delay: 6\b/ },
  inventory_target: { value: 'afd_target', shows: /afd_target/ },
  rolling: { value: 3, shows: /serial: 3\b/ },
};

/** A new flow with one node of the kind between Start and Done, every probe set on it. */
function flowWith(type: NodeType, inner = false, only?: readonly SettingKey[]) {
  let text = newFlowText('Probe', 'probe', ctx.newId);
  const apply = (cmd: FlowCommand) => {
    const r = planCommand(text, cmd, ctx);
    text = r.text;
    return r;
  };
  const doc = () => parse(text) as FlowDocument;
  const wire = doc().edges?.[0]?.id as string;
  const added = apply({ kind: 'addNode', type, title: 'Probe step', insertOn: wire }).created;
  const id = added as string;
  const bind = (node: string) =>
    apply({ kind: 'setBinding', id: node, impl: { kind: 'module', ref: 'ansible.builtin.ping' } });
  if (type === 'task') bind(id);
  if (type === 'decision') apply({ kind: 'updateNode', id, patch: { condition: 'x is defined' } });
  if (inner) {
    bind(apply({ kind: 'addNode', parent: id, type: 'task', title: 'Inside' }).created as string);
  }
  const settings = Object.fromEntries(
    Object.entries(PROBES)
      .filter(([k]) => (only ? only.includes(k as SettingKey) : k !== 'rolling'))
      .map(([k, p]) => [k, p?.value]),
  );
  apply({ kind: 'updateNode', id, patch: { settings } });
  const node = doc().nodes.find((n) => n.id === id);
  if (!node) throw new Error('no probe node');
  return { doc: doc(), node };
}

describe('Execution settings per node kind (AFD-71)', () => {
  it.each([
    ['task', false],
    ['decision', false],
    ['approval', false],
    ['parallel', false],
    ['join', false],
    ['subflow', true],
  ] as const)('%s (steps inside: %s): shown exactly when the code uses it', (type, inner) => {
    const { doc, node } = flowWith(type, inner);
    const result = optionA.generate(doc, { source: 'probe.flow.yaml' });
    expect(result.ok).toBe(true);
    const code = result.files.map((f) => f.text).join('\n');
    for (const field of EXECUTION_SETTINGS) {
      const probe = PROBES[field.key];
      // The approval timeout goes to the AWX approval, not the playbook; credential is format 1.
      if (!probe || (type === 'approval' && field.key === 'timeout')) continue;
      if (field.key === 'rolling') continue;
      expect([field.key, appliesTo(field, node)]).toEqual([field.key, probe.shows.test(code)]);
    }
  });

  it('a subflow with steps inside rolls them in batches (rolling, probed on its own)', () => {
    const { doc, node } = flowWith('subflow', true, ['rolling']);
    const result = optionA.generate(doc, { source: 'probe.flow.yaml' });
    expect(result.ok).toBe(true);
    expect(result.files.map((f) => f.text).join('\n')).toMatch(PROBES.rolling?.shows as RegExp);
    const rolling = EXECUTION_SETTINGS.find((s) => s.key === 'rolling');
    expect(rolling && appliesTo(rolling, node)).toBe(true);
    expect(rolling && appliesTo(rolling, { type: 'task' })).toBe(false);
  });

  it('an approval keeps its timeout, the AWX approval timeout', () => {
    const timeout = EXECUTION_SETTINGS.find((s) => s.key === 'timeout');
    expect(timeout && appliesTo(timeout, { type: 'approval' })).toBe(true);
    expect(timeout && appliesTo(timeout, { type: 'decision' })).toBe(false);
  });
});

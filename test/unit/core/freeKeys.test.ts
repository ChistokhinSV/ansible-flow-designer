// AFD-222: set_fact's facts are its parameters' own keys. Its doc's required key_value is a
// stand-in for them: Configure, its checklist and the catalog checks do not ask for it.
import { describe, expect, it } from 'vitest';
import { checklist, paramGroups } from '../../../src/core/catalog/draft';
import { documentedOptions, takesFreeKeys } from '../../../src/core/catalog/freeKeys';
import type { CatalogPlugin } from '../../../src/core/catalog/types';
import { buildModel } from '../../../src/core/flow/model';
import type { FlowDocument } from '../../../src/core/flow/types';
import { checkBindings } from '../../../src/node/catalog/bindingCheck';
import type { CatalogIndex } from '../../../src/node/catalog/catalogIndex';

const OPTIONS = {
  key_value: { type: 'str', required: true, description: 'The facts to set.' },
  cacheable: { type: 'bool', description: 'Whether facts go to the fact cache.' },
} as unknown as NonNullable<CatalogPlugin['options']>;

const plugin = {
  fqcn: 'ansible.builtin.set_fact',
  name: 'set_fact',
  type: 'module',
  collection: 'ansible.builtin',
  short_description: 'Set host variable(s) and fact(s).',
  options: OPTIONS,
} as unknown as CatalogPlugin;

const doc = {
  format: 2,
  flow: { key: 'stamp', title: 'Stamp' },
  nodes: [
    {
      id: '01J0000000000000000000000A',
      key: 'stamp',
      type: 'step',
      title: 'Stamp the run',
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.set_fact',
        params: { _ts: "{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}", _dirs: ['a', 'b'] },
      },
    },
  ],
  edges: [],
} as unknown as FlowDocument;

describe('set_fact takes free keys', () => {
  it('drops key_value from its documented options, and only for set_fact', () => {
    expect(takesFreeKeys('ansible.builtin.set_fact')).toBe(true);
    expect(takesFreeKeys('set_fact')).toBe(true);
    expect(takesFreeKeys('ansible.builtin.debug')).toBe(false);
    expect(Object.keys(documentedOptions('ansible.builtin.set_fact', OPTIONS) ?? {})).toEqual([
      'cacheable',
    ]);
    expect(documentedOptions('ansible.builtin.debug', OPTIONS)).toBe(OPTIONS);
  });

  it('Configure and its checklist do not ask for key_value', () => {
    const groups = paramGroups(documentedOptions(plugin.fqcn, plugin.options), {});
    expect(groups.required).toEqual([]);
    const node = doc.nodes[0] as FlowDocument['nodes'][number];
    const items = checklist(buildModel(doc), node, { plugin });
    expect(items[0]).toEqual({ state: 'ok', text: 'Required parameters set' });
  });

  it('the catalog checks call no fact an unknown parameter and ask for no key_value', () => {
    const index = {
      resolve: () => ({ found: true, fqcn: plugin.fqcn }),
      plugin: () => plugin,
    } as unknown as CatalogIndex;
    expect(checkBindings(doc, index, 'docker: afd-ee:2.19').map((f) => f.code)).toEqual([]);
  });
});

// AFD-274: the collections a flow needs, read from what its steps run: full module and role names
// on every level, step and undo bindings, with the version a catalog binding was made against;
// nothing for ansible.builtin/legacy, short names, repository roles, playbooks or switched-off
// steps. The requirements file wins and a step made against a version it does not allow is named.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  collectionOf,
  flowCollections,
  mergeRequirements,
  requirementsYaml,
} from '../../../src/core/flow/collections';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';

const node = (key: string, extra: Partial<FlowNode> = {}): FlowNode =>
  ({
    id: `01J${key.toUpperCase().padEnd(23, '0')}`.slice(0, 26),
    key,
    type: 'task',
    title: key,
    ...extra,
  }) as FlowNode;
const doc = (nodes: FlowNode[]): FlowDocument =>
  ({
    schema_version: 2,
    flow: { id: 'f', key: 'f', name: 'F', version: 1 },
    nodes,
    edges: [],
  }) as unknown as FlowDocument;

describe('collectionOf', () => {
  it('reads the collection of a full name, and nothing else', () => {
    expect(collectionOf({ kind: 'module', ref: 'cisco.ios.ios_config' })).toBe('cisco.ios');
    expect(collectionOf({ kind: 'role', ref: 'acme.network.baseline' })).toBe('acme.network');
    expect(collectionOf({ kind: 'module', ref: 'ansible.builtin.command' })).toBeUndefined();
    expect(collectionOf({ kind: 'module', ref: 'ansible.legacy.ping' })).toBeUndefined();
    expect(collectionOf({ kind: 'module', ref: 'command' })).toBeUndefined();
    expect(collectionOf({ kind: 'role', ref: 'baseline' })).toBeUndefined();
    expect(collectionOf({ kind: 'playbook', ref: 'playbooks/site.yml' })).toBeUndefined();
    expect(collectionOf(null)).toBeUndefined();
  });
});

describe('flowCollections', () => {
  it('gathers every level, undo bindings and versions; leaves out switched-off steps', () => {
    const found = flowCollections(
      doc([
        node('backup', {
          impl: { kind: 'module', ref: 'cisco.ios.ios_config', collection_version: '11.6.0' },
        }),
        node('facts', {
          impl: { kind: 'module', ref: 'cisco.ios.ios_facts', collection_version: '10.2.0' },
        }),
        node('parse', {
          impl: { kind: 'module', ref: 'ansible.utils.cli_parse' },
          undo: { kind: 'module', ref: 'ansible.netcommon.cli_command' },
        }),
        // A subflow keeps its steps inside it, and a switched-off one takes them along.
        node('prepare', {
          type: 'subflow',
          subflow: {
            nodes: [node('inner', { impl: { kind: 'role', ref: 'acme.network.baseline' } })],
            edges: [],
          },
        } as Partial<FlowNode>),
        node('old', {
          type: 'subflow',
          disabled: true,
          subflow: {
            nodes: [node('gone', { impl: { kind: 'module', ref: 'arista.eos.eos_config' } })],
            edges: [],
          },
        } as Partial<FlowNode>),
        node('off', {
          disabled: true,
          impl: { kind: 'module', ref: 'junos.device.config' },
        } as Partial<FlowNode>),
        node('shell', { impl: { kind: 'module', ref: 'ansible.builtin.shell' } }),
      ]),
    );
    expect(found).toEqual([
      { name: 'acme.network', versions: [], nodes: ['inner'] },
      { name: 'ansible.netcommon', versions: [], nodes: ['parse'] },
      { name: 'ansible.utils', versions: [], nodes: ['parse'] },
      { name: 'cisco.ios', versions: ['10.2.0', '11.6.0'], nodes: ['backup', 'facts'] },
    ]);
  });
});

describe('mergeRequirements', () => {
  const found = [
    { name: 'ansible.utils', versions: [], nodes: ['parse'] },
    { name: 'cisco.ios', versions: ['10.2.0', '11.6.0'], nodes: ['backup', 'facts'] },
  ];

  it('asks at least for the lowest version steps were made against, else any', () => {
    expect(mergeRequirements(found)).toEqual([
      { name: 'ansible.utils', version: '*', from: 'flow', nodes: ['parse'] },
      { name: 'cisco.ios', version: '>=10.2.0', from: 'flow', nodes: ['backup', 'facts'] },
    ]);
  });

  it('lets the requirements file win, keeps its other lines, and names a version it does not allow', () => {
    const merged = mergeRequirements(found, {
      'cisco.ios': '>=11.0.0,<12',
      'community.general': '*',
    });
    expect(merged.find((r) => r.name === 'cisco.ios')).toEqual({
      name: 'cisco.ios',
      version: '>=11.0.0,<12',
      from: 'both',
      nodes: ['backup', 'facts'],
      conflict: 'steps were made against cisco.ios 10.2.0, which >=11.0.0,<12 does not allow',
    });
    expect(merged.find((r) => r.name === 'community.general')).toMatchObject({
      from: 'requirements',
      nodes: [],
    });
    expect(parse(requirementsYaml(merged))).toEqual({
      collections: [
        { name: 'ansible.utils' },
        { name: 'cisco.ios', version: '>=11.0.0,<12' },
        { name: 'community.general' },
      ],
    });
  });
});

// M5 (AFD-8): binding commands, Jinja chips both ways, and the catalog's repository context.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isPlaybook, scanContext } from '../../../src/core/catalog/context';
import {
  bindingCommand,
  draftOf,
  formFields,
  isDirty,
  refChoices,
  upstreamNodes,
} from '../../../src/core/catalog/draft';
import {
  nameCandidates,
  planQuery,
  platformCollection,
  platformsOf,
} from '../../../src/core/catalog/rank';
import { bindingTaskText, inputVars } from '../../../src/core/engine/binding';
import { CommandError, type FlowCommand, planCommand } from '../../../src/core/flow/commands';
import { outputVar } from '../../../src/core/flow/dataNames';
import { createIdFactory } from '../../../src/core/flow/ids';
import { joinSegments, parseRefs, refsIn, renameRef, segments } from '../../../src/core/flow/jinja';
import { buildModel } from '../../../src/core/flow/model';
import { createSchemaValidator } from '../../../src/core/flow/schema';
import type { FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { applyEdits } from '../../../src/core/yaml';
import { readExample } from './helpers';

const EDGE = readExample('edge-baseline.flow.yaml');
const OS = readExample('os-upgrade.flow.yaml');
const schema = createSchemaValidator();
const ctx = { newId: createIdFactory() };
const docOf = (text: string) => parse(text) as FlowDocument;
const nodeOf = (text: string, key: string): FlowNode => {
  for (const { node } of buildModel(docOf(text)).nodes.values()) if (node.key === key) return node;
  throw new Error(`no node ${key}`);
};
const apply = (text: string, cmd: FlowCommand) => {
  const r = planCommand(text, cmd, ctx);
  expect(applyEdits(text, r.edits)).toBe(r.text);
  expect(schema(docOf(r.text))).toEqual([]);
  return r.text;
};

describe('Jinja chips', () => {
  it('splits simple references into chips and joins them back', () => {
    const value = 'boot system flash:{{ target_image }} {{ x | default(1) }}';
    const parts = segments(value);
    expect(parts).toEqual([
      { text: 'boot system flash:' },
      { ref: 'target_image', raw: '{{ target_image }}' },
      { text: ' {{ x | default(1) }}' },
    ]);
    expect(joinSegments(parts)).toBe(value);
    expect(joinSegments(segments('{{target_image}}'))).toBe('{{ target_image }}');
  });

  it('a field of a result is one chip (AFD-108)', () => {
    const value = 'echo {{ read_version_result.stdout }} {{ r.json.items | length }}';
    expect(segments(value)).toEqual([
      { text: 'echo ' },
      { ref: 'read_version_result.stdout', raw: '{{ read_version_result.stdout }}' },
      { text: ' {{ r.json.items | length }}' },
    ]);
    expect(joinSegments(segments(value))).toBe(value);
    // Still one variable read, and a rename keeps the field.
    expect(parseRefs(value)).toEqual(['read_version_result', 'r']);
    expect(renameRef(value, 'read_version_result', 'version')).toBe(
      'echo {{ version.stdout }} {{ r.json.items | length }}',
    );
  });

  it('finds variables, not attributes, filters, kwargs, functions or literals', () => {
    expect(
      parseRefs("{{ a.b | default(c, d=1) }} {{ 'e' ~ f is defined }} {{ lookup('env', 'H') }}"),
    ).toEqual(['a', 'c', 'f']);
    expect(refsIn({ lines: ['{{ a }}', { x: '{{ b.c }}' }] })).toEqual(['a', 'b']);
  });

  it('renames reads only', () => {
    expect(renameRef("{{ img }} {{ x.img }} {{ img | default('img') }} img", 'img', 'image')).toBe(
      "{{ image }} {{ x.img }} {{ image | default('img') }} img",
    );
  });
});

describe('staged binding (AFD-43)', () => {
  it('an untouched draft is not a change, for every bound node of every flow file', () => {
    const root = join(__dirname, '../../..');
    const files = ['examples', 'samples', 'test/fixtures'].flatMap((d) =>
      readdirSync(join(root, d), { recursive: true, encoding: 'utf8' })
        .filter((f) => f.endsWith('.flow.yaml'))
        .map((f) => join(root, d, f)),
    );
    const dirty: string[] = [];
    for (const file of files) {
      const doc = parse(readFileSync(file, 'utf8')) as FlowDocument;
      for (const { node } of buildModel(doc).nodes.values())
        if ((node.type === 'task' || node.type === 'subflow') && isDirty(node, draftOf(node)))
          dirty.push(`${file}: ${node.key}`);
    }
    expect(files.length).toBeGreaterThan(10);
    expect(dirty).toEqual([]);
  });
});

describe('setBinding (Save binding, one edit)', () => {
  const backup = nodeOf(EDGE, 'backup-config');

  it('writes impl, new inputs, outputs and status together', () => {
    const text = apply(EDGE, {
      kind: 'setBinding',
      id: backup.id,
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_config',
        collection_version: '9.0.3',
        params: { backup: true, lines: ['hostname {{ device_name }}'] },
        register: 'backup_out',
      },
      inputs: { device_name: { type: 'string', from: 'flow.site' } },
      outputs: { backup_out: { type: 'dict', from: 'impl.register' } },
    });
    const node = nodeOf(text, 'backup-config');
    expect(node.impl).toEqual({
      kind: 'module',
      ref: 'cisco.ios.ios_config',
      collection_version: '9.0.3',
      params: { backup: true, lines: ['hostname {{ device_name }}'] },
      register: 'backup_out',
    });
    expect(node.inputs?.device_name).toEqual({ type: 'string', from: 'flow.site' });
    expect(node.outputs).toMatchObject({
      backup_ref: { type: 'string' },
      backup_out: { from: 'impl.register' },
    });
    expect(node.status).toBe('implemented');
    // Nothing else in the document moved.
    const others = (t: string) =>
      [...buildModel(docOf(t)).nodes.values()]
        .filter((e) => e.node.id !== backup.id)
        .map((e) => e.node);
    expect(others(text)).toEqual(others(EDGE));
  });

  it('unbinds with impl null and refuses bad names and node types', () => {
    const os = nodeOf(OS, 'set-boot-variable');
    expect(
      nodeOf(apply(OS, { kind: 'setBinding', id: os.id, impl: null }), 'set-boot-variable').impl,
    ).toBeUndefined();
    const start = buildModel(docOf(EDGE)).doc.nodes.find((n) => n.type === 'start');
    expect(() =>
      planCommand(
        EDGE,
        { kind: 'setBinding', id: start?.id ?? '', impl: { kind: 'module', ref: 'x.y.z' } },
        ctx,
      ),
    ).toThrow(CommandError);
    expect(() =>
      planCommand(
        EDGE,
        {
          kind: 'setBinding',
          id: backup.id,
          impl: { kind: 'module', ref: 'x.y.z', register: '1bad' },
        },
        ctx,
      ),
    ).toThrow(/valid variable name/);
  });

  it('renaming an input rewrites the parameters that read it, in the same edit', () => {
    const node = nodeOf(OS, 'set-boot-variable');
    const text = apply(OS, {
      kind: 'setContractField',
      target: node.id,
      side: 'inputs',
      name: 'target_image',
      rename: 'image',
      field: { type: 'string', from: 'flow.target_image' },
    });
    expect(nodeOf(text, 'set-boot-variable').impl?.params?.lines).toEqual([
      'boot system flash:{{ image }}',
    ]);
  });
});

describe('data passing helpers', () => {
  it('maps module outputs to the registered result and inputs to play vars', () => {
    const doc = docOf(OS);
    const model = buildModel(doc);
    const sbv = nodeOf(OS, 'set-boot-variable');
    expect(outputVar(model, sbv, 'boot_result')).toBe('boot_result');
    const reloadEntry = [...model.nodes.values()].find((e) => e.node.key === 'reload');
    if (!reloadEntry) throw new Error('no reload');
    reloadEntry.node.inputs = {
      boot: { type: 'dict', from: 'set-boot-variable.boot_result.changed' },
    };
    expect(inputVars(model, reloadEntry.level, reloadEntry.node)).toEqual({
      boot: '{{ boot_result.changed }}',
    });
  });

  it('previews the task the binding generates', () => {
    const sbv = nodeOf(OS, 'set-boot-variable');
    const text = bindingTaskText(sbv, sbv.impl ?? { kind: 'module', ref: '' });
    expect(text).toContain('cisco.ios.ios_config:');
    expect(text).toContain('register: boot_result');
    expect(text).toContain(`tags: [node_${sbv.id}]`);
    expect(text).not.toContain('ignore_unreachable');
  });
});

describe('catalog query and context', () => {
  it('plans words, type hints and name candidates', () => {
    expect(planQuery('ip address filter')).toEqual({ words: ['ip', 'address'], type: 'filter' });
    const names = nameCandidates(['ip', 'address']);
    expect(names.get('ipaddr')).toBe(2);
    expect(names.get('ip_address')).toBe(2);
    expect(names.get('ip')).toBe(1);
  });

  it('reads collections in use and inventory platforms from the repository', () => {
    const value = scanContext([
      {
        path: 'collections/requirements.yml',
        text: 'collections:\n  - name: arista.eos\n  - cisco.ios\n',
      },
      {
        path: 'site.yml',
        text: '- hosts: all\n  tasks:\n    - cisco.ios.ios_facts:\n    - community.general.json_query:\n',
      },
      { path: 'group_vars/edge.yml', text: 'ansible_network_os: cisco.ios.ios\n' },
      { path: 'inventory.ini', text: 'leaf1 ansible_network_os=eos\n' },
      {
        path: 'flows/a/a.flow.yaml',
        text: 'impl:\n  kind: module\n  ref: ansible.utils.cli_parse\n',
      },
    ]);
    expect(value.collections.slice(0, 2)).toEqual(['cisco.ios', 'arista.eos']);
    expect(value.collections).toContain('ansible.utils');
    expect(value.platforms).toEqual(['arista.eos', 'cisco.ios']);
    expect(platformCollection('junos')).toBe('junipernetworks.junos');
    expect(platformsOf({ collections: ['cisco.ios', 'community.general'] })).toEqual(['cisco.ios']);
  });

  it('tells playbooks from task files', () => {
    expect(isPlaybook({ path: 'playbooks/site.yml', text: '- hosts: edge\n  tasks: []\n' })).toBe(
      true,
    );
    expect(isPlaybook({ path: 'roles/x/tasks/main.yml', text: '- hosts: edge\n' })).toBe(false);
    expect(isPlaybook({ path: 'tasks.yml', text: '- name: x\n  debug:\n' })).toBe(false);
  });
});

describe('binding draft (properties page)', () => {
  it('saves a new binding, and an unbinding, without a status of its own (AFD-50)', () => {
    const node = { ...nodeOf(EDGE, 'backup-config'), status: 'specified' as const };
    const draft = { ...draftOf(node), ref: 'cisco.ios.ios_config', params: { backup: true } };
    const save = bindingCommand(node, draft);
    expect(save).toMatchObject({
      kind: 'setBinding',
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_config',
        params: { backup: true },
        register: 'backup_config_result',
      },
    });
    expect(save).not.toHaveProperty('status');
    const bound = { ...nodeOf(OS, 'set-boot-variable'), status: 'tested' as const };
    expect(bindingCommand(bound, { ...draftOf(bound), ref: '' })).toMatchObject({ impl: null });
    expect(isDirty(bound, draftOf(bound))).toBe(false);
  });

  it('lists required parameters first and offers flow inputs and upstream outputs to @', () => {
    const { shown, more } = formFields(
      {
        a: { type: 'str', description: '', required: true },
        b: { type: 'bool', description: '' },
        c: { type: 'list', description: '', elements: 'str' },
      },
      { c: ['x'] },
    );
    expect(shown.map((f) => [f.name, f.control])).toEqual([
      ['a', 'text'],
      ['c', 'list'],
    ]);
    expect(more.map((f) => f.name)).toEqual(['b']);
    const model = buildModel(docOf(OS));
    const reload = nodeOf(OS, 'reload');
    const labels = refChoices(model, reload).map((c) => c.label);
    expect(labels).toContain('flow.target_image');
    // Upstream of reload inside upgrade-os: set-boot-variable outputs boot_result.
    expect(labels).toContain('set-boot-variable.boot_result');
    expect(upstreamNodes(model, reload.id).map((n) => n.key)).toContain('set-boot-variable');
  });
});

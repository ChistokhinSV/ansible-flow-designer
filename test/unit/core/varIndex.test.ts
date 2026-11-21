// AFD-340: the repository's variables (inventory, group_vars/host_vars, roles, vars_files and
// include_vars), their precedence and the winner per host, and how origin uses them.

import { describe, expect, it } from 'vitest';
import { checklist } from '../../../src/core/catalog/draft';
import { describeFlow } from '../../../src/core/ai/describe';
import { buildModel } from '../../../src/core/flow/model';
import {
  inputOrigin,
  nameOrigin,
  originHead,
  originText,
  quietRepoReads,
  repoFindings,
  repoSetsName,
} from '../../../src/core/flow/origin';
import type { Edge, FlowDocument, FlowNode } from '../../../src/core/flow/types';
import { validateFlow } from '../../../src/core/flow/validate';
import { memoryFs } from '../../../src/core/inventory/memoryFs';
import {
  buildVarIndex,
  hostGroups,
  indexInputs,
  RANK,
  rankWord,
  repoAnswer,
  type VarIndex,
} from '../../../src/core/inventory/varIndex';
import { dataLens } from '../../../src/core/lens/data';

const memFs = memoryFs;

const REPO: Record<string, string> = {
  'ansible.cfg': '[defaults]\ninventory = inventory/hosts.yml\n',
  'inventory/hosts.yml': [
    'all:',
    '  vars:',
    '    ntp_server: 192.0.2.1',
    '  children:',
    '    dc:',
    '      vars:',
    '        ntp_server: 192.0.2.2',
    '      children:',
    '        web:',
    '          hosts:',
    '            web-01:',
    '              ntp_server: 192.0.2.9',
    '            web-02:',
    '        db:',
    '          hosts:',
    '            db-01:',
    '',
  ].join('\n'),
  'inventory/group_vars/all.yml': 'syslog_host: 198.51.100.5\nntp_server: 192.0.2.3\n',
  'inventory/group_vars/web.yml': [
    'ntp_server: 192.0.2.4',
    'api_token: tok-123456',
    'snmp_community: !vault |',
    '  $ANSIBLE_VAULT;1.1;AES256',
    '  6162636465',
    '',
  ].join('\n'),
  'inventory/group_vars/db/vault.yml': '$ANSIBLE_VAULT;1.1;AES256\n3132333435\n',
  'group_vars/web.yml': 'ntp_server: 192.0.2.5\n',
  'inventory/host_vars/web-02.yml': 'ntp_server: "{{ ntp_base }}.6"\n',
  'roles/nginx/tasks/main.yml': '- debug: msg=hi\n',
  'roles/nginx/defaults/main.yml': 'nginx_port: 80\nnginx_user: www\n',
  'roles/nginx/vars/main.yml': 'nginx_user: nginx\n',
  'roles/nginx/meta/argument_specs.yml': [
    'argument_specs:',
    '  main:',
    '    options:',
    '      nginx_port:',
    '        type: int',
    '        default: 8080',
    '        description: The port nginx listens on',
    '',
  ].join('\n'),
  'playbooks/site.yml': [
    '- hosts: all',
    '  vars_files:',
    '    - vars/site.yml',
    '  tasks:',
    '    - ansible.builtin.include_vars: extra.yml',
    '    - include_vars:',
    '        file: maybe.yml',
    '      when: lab | bool',
    '',
  ].join('\n'),
  'playbooks/vars/site.yml': 'site_name: ams1\n',
  'playbooks/vars/extra.yml': 'mtu: 9000\n',
  'playbooks/vars/maybe.yml': 'mtu_lab: 1500\n',
};

const build = (files = REPO, extra: Partial<Parameters<typeof buildVarIndex>[1]> = {}) =>
  buildVarIndex(memFs(files), {
    inventory: '',
    roles: ['nginx'],
    files: ['playbooks/site.yml'],
    ...extra,
  });

describe('variable index (AFD-340)', () => {
  it('ranks follow the precedence list, lowest to highest', () => {
    const order = [
      RANK.roleDefault,
      RANK.groupInlineAll,
      RANK.groupInline,
      RANK.groupFileAll,
      RANK.groupRootAll,
      RANK.groupFile,
      RANK.groupRoot,
      RANK.hostInline,
      RANK.hostFile,
      RANK.hostRoot,
      RANK.playVar,
      RANK.varsFile,
      RANK.roleVar,
      RANK.includeVars,
      RANK.setFact,
      RANK.roleParam,
      RANK.extraVar,
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(order.map(rankWord)).toEqual([
      'role default',
      'inventory group var',
      'inventory group var',
      'group_vars',
      'group_vars',
      'group_vars',
      'group_vars',
      'inventory host var',
      'host_vars',
      'host_vars',
      'play var',
      'play vars_files',
      'role var',
      'include_vars',
      'set_fact / register',
      'role param',
      'extra var',
    ]);
  });

  it('reads the group hierarchy: parents, children and all', async () => {
    const index = await build();
    expect(index.groups.web?.parents).toEqual(['dc']);
    expect(index.groups.dc?.parents).toEqual(['all']);
    expect([...hostGroups(index, 'web-01')].sort()).toEqual(['all', 'dc', 'web']);
    expect(index.hosts).toEqual(['db-01', 'web-01', 'web-02']);
  });

  it('INI children sections link groups too', async () => {
    const index = await build(
      {
        'hosts.ini': '[web]\nweb-[01:02]\n[dc:children]\nweb\n[dc:vars]\nntp_server=192.0.2.7\n',
      },
      { inventory: 'hosts.ini' },
    );
    expect(index.groups.web?.parents).toEqual(['dc']);
    expect(index.hosts).toEqual(['web-01', 'web-02']);
    expect(repoAnswer(index, 'ntp_server', {}, 'web-02')?.winner?.value).toBe('192.0.2.7');
  });

  it('picks the winner per host: host > group_vars > inventory groups, child over parent', async () => {
    const index = await build();
    // web-01: its own inventory line beats every group.
    expect(repoAnswer(index, 'ntp_server', {}, 'web-01')?.winner).toMatchObject({
      file: 'inventory/hosts.yml',
      value: '192.0.2.9',
      rank: RANK.hostInline,
    });
    // web-02: its host_vars file, a template shown raw.
    expect(repoAnswer(index, 'ntp_server', {}, 'web-02')?.winner).toMatchObject({
      file: 'inventory/host_vars/web-02.yml',
      template: '{{ ntp_base }}.6',
    });
    // db-01: group_vars/all beats the inventory file's groups (dc, all), as Ansible's default
    // precedence setting has it.
    expect(repoAnswer(index, 'ntp_server', {}, 'db-01')?.winner).toMatchObject({
      file: 'inventory/group_vars/all.yml',
      value: '192.0.2.3',
    });
  });

  it('the root group_vars (loaded by flow runs) beat the ones beside the inventory', async () => {
    const index = await build({ ...REPO, 'inventory/host_vars/web-02.yml': 'other: 1\n' });
    const a = repoAnswer(index, 'ntp_server', {}, 'web-02');
    expect(a?.winner).toMatchObject({ file: 'group_vars/web.yml', rank: RANK.groupRoot });
    expect(a?.defs.map((d) => d.file)).toContain('inventory/group_vars/web.yml');
  });

  it('with the inventory at the root, its group_vars are the inventory-adjacent ones', async () => {
    const index = await build(
      {
        'hosts.yml': 'all:\n  children:\n    web:\n      hosts:\n        web-01:\n',
        'group_vars/web.yml': 'ntp_server: 192.0.2.5\n',
      },
      { inventory: 'hosts.yml' },
    );
    expect(repoAnswer(index, 'ntp_server', {}, 'web-01')?.winner?.rank).toBe(RANK.groupFile);
  });

  it('names a winner without a host only when every definition applies to every host', async () => {
    const index = await build();
    expect(repoAnswer(index, 'syslog_host', {})).toMatchObject({
      scope: 'for every host',
      winner: { value: '198.51.100.5' },
    });
    const ntp = repoAnswer(index, 'ntp_server', {});
    expect(ntp?.winner).toBeUndefined();
    expect(ntp?.scope).toContain('depends on the host');
    expect(repoAnswer(index, 'ntp_server', {}, 'unknown-host')?.winner).toBeUndefined();
  });

  it('role defaults, vars and argument_specs only for a step that runs the role', async () => {
    const index = await build();
    expect(repoAnswer(index, 'nginx_user', {})).toBeUndefined();
    const user = repoAnswer(index, 'nginx_user', { role: 'nginx' });
    expect(user?.winner).toMatchObject({ value: 'nginx', rank: RANK.roleVar });
    const port = repoAnswer(index, 'nginx_port', { role: 'nginx' });
    expect(port?.winner).toMatchObject({ value: '80', rank: RANK.roleDefault });
    // The spec documents it; its default is never the winner.
    expect(port?.defs.at(-1)).toMatchObject({
      rank: RANK.spec,
      value: '8080',
      doc: 'The port nginx listens on',
    });
  });

  it('literal vars_files and include_vars of the bound playbook', async () => {
    const index = await build();
    const own = { own: ['playbooks/site.yml'] };
    expect(repoAnswer(index, 'site_name', own)?.winner).toMatchObject({
      file: 'playbooks/vars/site.yml',
      rank: RANK.varsFile,
    });
    // vars_files are the play's own: a later step does not see them; include_vars stay.
    expect(repoAnswer(index, 'site_name', { upstream: ['playbooks/site.yml'] })).toBeUndefined();
    expect(repoAnswer(index, 'mtu', { upstream: ['playbooks/site.yml'] })?.winner?.rank).toBe(
      RANK.includeVars,
    );
    // Under a condition: listed, never a certain winner.
    const lab = repoAnswer(index, 'mtu_lab', own);
    expect(lab?.defs).toHaveLength(1);
    expect(lab?.winner).toBeUndefined();
  });

  it('never keeps a vaulted or secret-looking value, not even in part', async () => {
    const index = await build();
    const text = JSON.stringify(index);
    expect(text).not.toContain('tok-123456');
    expect(text).not.toContain('6162636465');
    expect(text).not.toContain('3132333435');
    expect(repoAnswer(index, 'api_token', {}, 'web-01')?.winner).toMatchObject({ secret: true });
    expect(repoAnswer(index, 'snmp_community', {}, 'web-01')?.winner?.value).toBeUndefined();
  });

  it('stops at its limits and then names no winner', async () => {
    const index = await build(REPO, { maxFiles: 3 });
    expect(index.cut).toBe('files');
    expect(repoAnswer(index, 'syslog_host', {})?.winner).toBeUndefined();
  });

  it('a dynamic source makes every winner uncertain', async () => {
    const index = await build({
      ...REPO,
      'ansible.cfg': '[defaults]\ninventory = inventory/hosts.yml,inventory/aws_ec2.yml\n',
      'inventory/aws_ec2.yml': 'plugin: amazon.aws.aws_ec2\n',
    });
    expect(index.dynamic).toBe(true);
    expect(repoAnswer(index, 'syslog_host', {})).toMatchObject({
      why: expect.stringContaining('dynamic'),
    });
  });
});

// ---------------------------------------------------------------- origin with the index

let seq = 0;
const id = () => `01REPO${String(++seq).padStart(20, '0')}`;

function flow(steps: FlowNode[]): FlowDocument {
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
  })) as Edge[];
  return {
    schema_version: 2,
    flow: { id: id(), key: 'repo-origin', name: 'Repo origin', version: 1 },
    nodes: all,
    edges,
  } as FlowDocument;
}

const step = (key: string, rest: Partial<FlowNode> = {}): FlowNode =>
  ({ id: id(), key, type: 'task', title: key, ...rest }) as FlowNode;

describe('origin with the repository (AFD-340)', () => {
  let index: VarIndex;
  const ready = build().then((i) => {
    index = i;
  });

  it('a name the flow does not set: the winner for the picked host, the rest as Defined in', async () => {
    await ready;
    const reader = step('reader', {
      impl: { kind: 'module', ref: 'ansible.builtin.debug', params: { msg: '{{ ntp_server }}' } },
    });
    const model = buildModel(flow([reader]));
    const picked = nameOrigin(model, reader, 'ntp_server', { index, host: 'web-01' });
    expect(originHead(picked)).toMatchObject({
      kind: 'hostVar',
      value: '192.0.2.9',
      file: 'inventory/hosts.yml',
      line: 11,
    });
    expect(picked.defined?.winner).toBe(1);
    expect(picked.defined?.others).toContain(0);
    expect(picked.defined?.hops.map((h) => h.kind)).toContain('groupVar');
    const any = nameOrigin(model, reader, 'ntp_server', { index });
    expect(originHead(any)?.kind).toBe('unknown');
    expect(originHead(any)?.label).toContain('the repository sets it per host');
    expect(originText(any)).toContain('Defined in the repository');
    // Without an index: phase 1's answer.
    expect(originHead(nameOrigin(model, reader, 'ntp_server'))?.label).toContain(
      'decided at run time',
    );
  });

  it('a template in the repository is followed one level deeper', async () => {
    await ready;
    const reader = step('reader');
    const model = buildModel(flow([reader]));
    const o = nameOrigin(model, reader, 'ntp_server', { index, host: 'web-02' });
    expect(o.hops.map((h) => [h.kind, h.depth])).toEqual([
      ['hostVar', 0],
      ['unknown', 1],
    ]);
  });

  it('an input default hides the inventory value: a note and a finding', async () => {
    await ready;
    const reader = step('reader', {
      inputs: { syslog_host: { type: 'string', default: '203.0.113.1' } },
    });
    const model = buildModel(flow([reader]));
    const o = inputOrigin(model, reader, 'syslog_host', { index });
    expect(o.notes.join('\n')).toContain(
      "The input's default (play var) wins over the repository's",
    );
    const findings = repoFindings(model, index);
    expect(findings).toMatchObject([
      { code: 'input-hides-inventory', severity: 'info', node: reader.id, subject: 'syslog_host' },
    ]);
    // Read from the host itself (no default): no finding.
    const plain = step('plain', { inputs: { syslog_host: { type: 'string' } } });
    expect(repoFindings(buildModel(flow([plain])), index)).toEqual([]);
  });

  it('a name the repository sets is not an unknown read: its warning becomes information', async () => {
    await ready;
    const reader = step('reader', {
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.debug',
        params: { msg: '{{ syslog_host }} {{ nowhere_set }}' },
      },
    });
    const { model, findings } = validateFlow(flow([reader]));
    const unknown = (fs: typeof findings, name: string) =>
      fs.find((f) => f.code === 'binding-unknown-var' && f.subject === name);
    expect(unknown(findings, 'syslog_host')?.severity).toBe('warning');
    const quiet = quietRepoReads(findings, model, index);
    expect(unknown(quiet, 'syslog_host')).toMatchObject({ severity: 'info' });
    expect(unknown(quiet, 'syslog_host')?.message).toContain('inventory/group_vars/all.yml:1');
    // Nothing in the repository sets it: still a warning.
    expect(unknown(quiet, 'nowhere_set')?.severity).toBe('warning');
  });

  it('the Binding checklist says the repository sets a name the step reads', async () => {
    await ready;
    const reader = step('reader', {
      impl: {
        kind: 'module',
        ref: 'ansible.builtin.debug',
        params: { msg: '{{ syslog_host }} {{ nowhere_set }}' },
      },
    });
    const model = buildModel(flow([reader]));
    const items = checklist(model, reader, {
      repoSets: (name) => repoSetsName(model, reader, name, index),
    });
    expect(items).toContainEqual({
      state: 'ok',
      text: 'syslog_host is set by the repository (group_vars of all, inventory/group_vars/all.yml:1)',
    });
    expect(items).toContainEqual({
      state: 'missing',
      text: 'nowhere_set is not an input of this node',
    });
    expect(repoSetsName(model, reader, 'syslog_host', undefined)).toBeUndefined();
  });

  it('a same-name read with a default: the host value wins, said for the host', async () => {
    await ready;
    const reader = step('reader', {
      inputs: { syslog_host: { type: 'string', from: 'flow.syslog_host', default: 'x' } },
    });
    const doc = flow([reader]);
    doc.flow.inputs = { syslog_host: { type: 'string' } };
    const o = inputOrigin(buildModel(doc), reader, 'syslog_host', { index });
    expect(o.notes.join('\n')).toContain("the host's own syslog_host is the group_vars of all");
  });

  it('a role var ranks above the input and wins; a role param too', async () => {
    await ready;
    const role = step('web', {
      impl: { kind: 'role', ref: 'nginx', params: { nginx_port: 81 } },
      inputs: {
        nginx_user: { type: 'string', default: 'me' },
        nginx_port: { type: 'integer', default: 82 },
      },
    });
    const model = buildModel(flow([role]));
    const user = inputOrigin(model, role, 'nginx_user', { index });
    expect(user.notes.join('\n')).toContain('role var of nginx (roles/nginx/vars/main.yml:1)');
    const port = inputOrigin(model, role, 'nginx_port', { index });
    expect(port.notes.join('\n')).toContain('role param');
    expect(port.notes.join('\n')).toContain("wins over the repository's nginx_port");
  });

  it('the flow value that outranks the repository is said to win; the Data lens shows it', async () => {
    await ready;
    const role = step('web', {
      impl: { kind: 'role', ref: 'nginx' },
      inputs: { nginx_port: { type: 'integer', from: 'flow.port' } },
    });
    const doc = flow([role]);
    doc.flow.inputs = { port: { type: 'integer', default: 8080 } };
    const o = inputOrigin(buildModel(doc), role, 'nginx_port', { index });
    expect(o.defined?.beaten).toBe('the input (play var)');
    expect(originText(o)).toContain('* highest here: default of role nginx');
    const titles = dataLens(doc, index).dataWires?.map((w) => w.title) ?? [];
    expect(titles.join(' ')).toContain('Defined in the repository');
    // flow_describe with nodes: the origins line carries the definitions in short.
    const text = describeFlow(buildModel(doc), [], 'r1', undefined, undefined, undefined, {
      nodes: ['web'],
      index,
    });
    expect(text).toContain('{defined in: highest here default of role nginx');
  });

  it('a secret-looking name: no value anywhere, Defined in included', async () => {
    await ready;
    const reader = step('reader');
    const o = nameOrigin(buildModel(flow([reader])), reader, 'api_token', {
      index,
      host: 'web-01',
    });
    expect(o.secret).toBe(true);
    expect(JSON.stringify(o)).not.toContain('tok-123456');
  });

  it('collects the roles, playbooks and task files a flow runs', () => {
    const doc = flow([
      step('a', { impl: { kind: 'role', ref: 'nginx' } }),
      step('b', { impl: { kind: 'playbook', ref: './playbooks/site.yml' } }),
      step('c', {
        impl: {
          kind: 'module',
          ref: 'ansible.builtin.include_tasks',
          params: { file: 'tasks/x.yml' },
        },
      }),
      step('d', {
        impl: { kind: 'module', ref: 'include_tasks', params: { file: '{{ which }}.yml' } },
      }),
    ]);
    expect(indexInputs(doc.nodes)).toEqual({
      roles: ['nginx'],
      files: ['playbooks/site.yml', 'tasks/x.yml'],
    });
  });
});

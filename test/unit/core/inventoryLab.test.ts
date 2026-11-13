// AFD-259, AFD-260 against real Ansible: an inventory changed by the edit engine reads in
// ansible-inventory as what was asked for. Skipped unless AFD_SSH_HOST names a host with Ansible on
// the account's PATH (an alias of your SSH config):
//   AFD_SSH_HOST=gns3 npx vitest run test/unit/core/inventoryLab.test.ts
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  editInventory,
  type InventoryFile,
  type InventoryOp,
  setVarInFile,
} from '../../../src/core/inventory/edit';

const HOST = process.env.AFD_SSH_HOST ?? '';

const INI = [
  '# Fictional lab',
  'jump-01 ansible_host=192.0.2.5',
  '',
  '[edge]',
  'sw-edge-0[1:2]',
  '',
  '[lab]',
  'h01',
  'h02 ansible_port=2222   # console',
  '',
  '[lab:vars]',
  'ansible_user=netops',
  '',
].join('\n');

const YAML = [
  '# Fictional lab',
  'all:',
  '  vars:',
  '    ansible_user: netops # the service account',
  '  children:',
  '    edge:',
  '      hosts:',
  '        sw-edge-[01:02]:',
  '    lab:',
  '      hosts:',
  '        h01:',
  '        h02:',
  '          ansible_port: 2222',
  '',
].join('\n');

/** The same changes for both formats. */
const OPS: InventoryOp[] = [
  { op: 'add_group', group: 'core' },
  { op: 'add_host', host: 'core-sp-01', group: 'core' },
  { op: 'add_host', host: 'core-sp-02', group: 'core' },
  { op: 'set_var', host: 'core-sp-01', key: 'ansible_host', value: '192.0.2.21' },
  { op: 'set_var', host: 'core-sp-01', key: 'site', value: 'Lab A' },
  { op: 'set_var', group: 'core', key: 'mtu', value: 9000 },
  { op: 'add_group', group: 'spines', parent: 'core' },
  { op: 'add_host', host: 'h03', group: 'lab' },
  { op: 'rename_host', host: 'h01', to: 'h11' },
  { op: 'move_host', host: 'h02', from: 'lab', to: 'core' },
  { op: 'remove_host', host: 'core-sp-02', group: 'core' },
  { op: 'rename_group', group: 'edge', to: 'access' },
  { op: 'set_var', group: 'lab', key: 'ansible_user', value: 'ops' },
  { op: 'remove_var', host: 'h02', key: 'ansible_port' },
  // AFD-262: groups move in the hierarchy with everything in them.
  { op: 'add_group', group: 'dc1' },
  { op: 'move_group', group: 'lab', to: 'dc1' },
  { op: 'move_group', group: 'spines', from: 'core', to: 'dc1' },
];

function after(start: InventoryFile): string {
  let file = start;
  for (const op of OPS) {
    const r = editInventory([file], op);
    if (!r.ok) throw new Error(`${JSON.stringify(op)}: ${r.error}`);
    file = r.files[0] ?? file;
  }
  return file.text;
}

/** What ansible-inventory reads from these files, put in a temporary folder on the host. */
function listed(files: Record<string, string>, inventory: string) {
  const dir = `/tmp/afd-inv-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  const put = Object.entries(files)
    .map(
      ([path, text]) =>
        `mkdir -p "${dir}/$(dirname ${path})" && printf %s ${Buffer.from(text).toString('base64')} | base64 -d > "${dir}/${path}"`,
    )
    .join(' && ');
  // ansible-inventory beside the ansible-playbook of the PATH (a venv links only some of them).
  const tool = '"$(dirname "$(readlink -f "$(command -v ansible-playbook)")")/ansible-inventory"';
  const script = `. ~/.profile >/dev/null 2>&1; ${put} && cd ${dir} && ${tool} -i ${inventory} --list 2>&1; rm -rf ${dir}`;
  const out = execFileSync('ssh', ['-T', '-o', 'BatchMode=yes', HOST, script], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  if (!out.includes('{')) throw new Error(`ansible-inventory printed no data: ${out}`);
  interface Listed {
    hosts?: string[];
    children?: string[];
    hostvars?: Record<string, Record<string, unknown>>;
  }
  const data = JSON.parse(out.slice(out.indexOf('{'))) as Record<string, Listed>;
  const groups: Record<string, string[]> = {};
  for (const [name, g] of Object.entries(data))
    if (name !== '_meta') groups[name] = [...(g.hosts ?? [])].sort();
  return {
    groups,
    children: Object.fromEntries(
      Object.entries(data)
        .filter(([n, g]) => n !== '_meta' && g.children)
        .map(([n, g]) => [n, [...(g.children ?? [])].sort()]),
    ) as Record<string, string[]>,
    vars: data._meta?.hostvars ?? {},
  };
}

describe.skipIf(!HOST)(`edited inventories in Ansible on ${HOST || '(AFD_SSH_HOST)'}`, () => {
  const expectations = (r: ReturnType<typeof listed>) => {
    expect(r.groups.core).toEqual(['core-sp-01', 'h02']);
    expect(r.groups.lab).toEqual(['h03', 'h11']);
    expect(r.groups.access).toEqual(['sw-edge-01', 'sw-edge-02']);
    expect(r.groups.edge).toBeUndefined();
    expect(r.children.core).toBeUndefined();
    expect(r.children.dc1).toEqual(['lab', 'spines']);
    expect(r.vars['core-sp-01']).toMatchObject({
      ansible_host: '192.0.2.21',
      site: 'Lab A',
      mtu: 9000,
    });
    expect(r.vars.h02).toMatchObject({ mtu: 9000 });
    expect(r.vars.h02?.ansible_port).toBeUndefined();
    expect(r.vars.h11).toMatchObject({ ansible_user: 'ops' });
    expect(r.vars.h03).toMatchObject({ ansible_user: 'ops' });
  };

  it('an INI inventory after the changes', () => {
    const text = after({ path: 'hosts', kind: 'ini', text: INI });
    expect(text).toContain('# Fictional lab');
    expectations(listed({ hosts: text }, 'hosts'));
  }, 180_000);

  it('a YAML inventory after the changes', () => {
    const text = after({ path: 'hosts.yml', kind: 'yaml', text: YAML });
    expect(text).toContain('ansible_user: netops # the service account');
    const r = listed({ 'hosts.yml': text }, 'hosts.yml');
    expectations(r);
    // The comment's variable is `all`'s: still netops where lab's own value does not apply.
    expect(r.vars['core-sp-01']).toMatchObject({ ansible_user: 'netops' });
  }, 180_000);

  it('a variables file written for a host of a range', () => {
    const vars = setVarInFile(
      setVarInFile(undefined, 'vlans', [10, 20]) as string,
      'site',
      'Lab A',
    );
    const r = listed({ hosts: INI, 'host_vars/sw-edge-02.yml': vars as string }, 'hosts');
    expect(r.vars['sw-edge-02']).toMatchObject({ vlans: [10, 20], site: 'Lab A' });
    expect(r.vars['sw-edge-01']?.vlans).toBeUndefined();
  }, 180_000);
});

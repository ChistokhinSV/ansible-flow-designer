// AFD-261: the inventory tool for AI assistants, on files in memory. It lists what is written,
// changes it with the view's engine (all or none), puts variables where the repository keeps
// them, and never shows a vaulted value or one whose name looks like a secret.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { type InventoryIO, inventoryTool, shownToAgent } from '../../../../src/core/ai/inventory';
import { type InventoryFs, readInventory } from '../../../../src/core/inventory/files';

const INI = [
  '# Fictional lab',
  '[edge]',
  'sw-edge-0[1:2]',
  '',
  '[lab]',
  'h01 ansible_host=192.0.2.11 ansible_password=hunter2',
  'h02',
  '',
  '[lab:vars]',
  'ansible_user=netops',
  'snmp_community=public',
  '',
].join('\n');

/** A repository in memory: path → text. */
function repo(files: Record<string, string>) {
  const disk = new Map(Object.entries(files));
  const written: string[] = [];
  const fs: InventoryFs = {
    read: async (path) => disk.get(path),
    list: async (dir) => {
      const names = new Map<string, boolean>();
      for (const path of disk.keys()) {
        if (!path.startsWith(`${dir}/`)) continue;
        const rest = path.slice(dir.length + 1);
        names.set(rest.split('/')[0] as string, rest.includes('/'));
      }
      return names.size
        ? [...names]
            .map(([name, dir]) => ({ name, dir }))
            .sort((a, b) => a.name.localeCompare(b.name))
        : undefined;
    },
    kind: async (path) =>
      disk.has(path)
        ? 'file'
        : [...disk.keys()].some((p) => p.startsWith(`${path}/`))
          ? 'dir'
          : undefined,
  };
  const io: InventoryIO = {
    read: async (inventory) => {
      const data = await readInventory(fs, inventory ?? '');
      return { data, label: inventory ?? data.named.join(', ') };
    },
    write: async (writes, renames) => {
      for (const [from, to] of renames)
        for (const [path, text] of [...disk]) {
          if (path !== from && !path.startsWith(`${from}/`)) continue;
          disk.delete(path);
          disk.set(`${to}${path.slice(from.length)}`, text);
        }
      for (const w of writes) {
        disk.set(w.path, w.text);
        written.push(w.path);
      }
      return ['Saved.'];
    },
  };
  return { io, disk, written };
}

const CFG = '[defaults]\ninventory = inventory.ini\n';

describe('inventory list', () => {
  it('shows the sources, the groups as written, and where details are', async () => {
    const { io } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const r = await inventoryTool(io, {});
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Inventory: inventory.ini');
    expect(r.text).toContain('- inventory.ini: INI');
    expect(r.text).toContain('- edge: 1 host line: sw-edge-0[1:2]');
    expect(r.text).toContain('- lab: 2 host lines: h01, h02; 2 variables');
    expect(r.text).not.toContain('hunter2');
  });

  it('a host: its groups and variables with where each is written; secrets and vault masked', async () => {
    const { io } = repo({
      'ansible.cfg': CFG,
      'inventory.ini': INI,
      'host_vars/h01.yml':
        'site: Lab A\nenable_secret: s3cr3t\nbanner: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6162\n',
    });
    const r = await inventoryTool(io, { host: 'h01' });
    expect(r.text).toContain('Groups: lab');
    expect(r.text).toContain('- ansible_host = 192.0.2.11  (inventory.ini:6)');
    expect(r.text).toContain('- ansible_password = (hidden: the name looks like a secret)');
    expect(r.text).toContain('- site = Lab A  (host_vars/h01.yml:1)');
    expect(r.text).toContain('- enable_secret = (hidden: the name looks like a secret)');
    expect(r.text).toContain('- banner = (vaulted)');
    expect(r.text).not.toMatch(/hunter2|s3cr3t|6162/);
    const group = await inventoryTool(io, { group: 'lab' });
    expect(group.text).toContain('- ansible_user = netops');
    // `community` is not on the product owner's list: shown.
    expect(group.text).toContain('- snmp_community = public');
    expect(shownToAgent({ key: 'api_token', value: 'x', file: 'f', line: 0 })).toMatch(/hidden/);
    expect(shownToAgent({ key: 'ssh_key_file', value: '~/.ssh/id', file: 'f', line: 0 })).toMatch(
      /hidden/,
    );
  });

  it('a host of a range, and names that are not there', async () => {
    const { io } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const range = await inventoryTool(io, { host: 'sw-edge-02' });
    expect(range.text).toContain('Written as one of the range sw-edge-0[1:2]');
    expect((await inventoryTool(io, { host: 'nope' })).isError).toBe(true);
    expect((await inventoryTool(io, { group: 'nope' })).isError).toBe(true);
  });

  it('a dynamic source is named as read-only, and its hosts are not listed', async () => {
    const { io } = repo({
      'ansible.cfg': '[defaults]\ninventory = inventory\n',
      'inventory/netbox.yml':
        'plugin: netbox.netbox.nb_inventory\napi_endpoint: https://netbox.example.net\n',
      'inventory/static.yml': 'all:\n  children:\n    lab:\n      hosts:\n        h01:\n',
    });
    const r = await inventoryTool(io, {});
    expect(r.text).toContain('- inventory/netbox.yml: dynamic: an inventory plugin (read-only)');
    expect(r.text).toContain('- inventory/static.yml: YAML');
    expect(r.text).toContain('Hosts of inventory/netbox.yml come from elsewhere');
  });
});

describe('inventory edit', () => {
  it('applies the ops in order and writes once; the answer says each change', async () => {
    const { io, disk, written } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const r = await inventoryTool(io, {
      action: 'edit',
      ops: [
        { op: 'add_group', group: 'core' },
        { op: 'add_host', host: 'core-sp-01', group: 'core' },
        { op: 'set_var', host: 'core-sp-01', key: 'ansible_host', value: '192.0.2.21' },
        { op: 'move_host', host: 'h02', from: 'lab', to: 'core' },
        { op: 'rename_group', group: 'edge', to: 'access' },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('5 changes.');
    expect(r.text).toContain('- Set ansible_host for core-sp-01 in inventory.ini.');
    expect(written).toEqual(['inventory.ini']);
    const text = disk.get('inventory.ini') as string;
    expect(text).toContain('[core]\ncore-sp-01 ansible_host=192.0.2.21\nh02\n');
    expect(text).toContain('[access]\nsw-edge-0[1:2]\n');
    expect(text.startsWith('# Fictional lab\n')).toBe(true);
  });

  it('one op that cannot be done: nothing is written, and the answer says which', async () => {
    const { io, disk, written } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const r = await inventoryTool(io, {
      action: 'edit',
      ops: [
        { op: 'add_host', host: 'h03', group: 'lab' },
        { op: 'remove_host', host: 'sw-edge-01', group: 'edge' },
      ],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/^op 2 \(remove_host\): .*one of the range.*Nothing was changed\.$/);
    expect(written).toEqual([]);
    expect(disk.get('inventory.ini')).toBe(INI);
  });

  it('a new variable goes to the variables folder when there is one, else to the inventory file', async () => {
    const plain = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    await inventoryTool(plain.io, {
      action: 'edit',
      ops: [{ op: 'set_var', host: 'h02', key: 'site', value: 'Lab A' }],
    });
    expect(plain.disk.get('inventory.ini')).toContain('h02 site="Lab A"\n');

    const folder = repo({
      'ansible.cfg': CFG,
      'inventory.ini': INI,
      'host_vars/h01.yml': 'site: Lab A\n',
    });
    const r = await inventoryTool(folder.io, {
      action: 'edit',
      ops: [
        { op: 'set_var', host: 'h02', key: 'vlans', value: [10, 20] },
        { op: 'set_var', host: 'h02', key: 'mtu', value: 9000 },
        { op: 'set_var', host: 'h02', key: 'rack', value: 4, where: 'inventory' },
      ],
    });
    expect(r.text).toContain('- Set vlans for h02 in host_vars/h02.yml.');
    expect(parse(folder.disk.get('host_vars/h02.yml') as string)).toEqual({
      vlans: [10, 20],
      mtu: 9000,
    });
    expect(folder.disk.get('inventory.ini')).toContain('h02 rack=4\n');
  });

  it('a host of a range, or of a dynamic source, gets its variables in host_vars/', async () => {
    const { io, disk } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const r = await inventoryTool(io, {
      action: 'edit',
      ops: [
        { op: 'set_var', host: 'sw-edge-02', key: 'mgmt_vlan', value: 99 },
        { op: 'set_var', host: 'nb-sw-01', key: 'site', value: 'DC1' },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(disk.get('host_vars/sw-edge-02.yml')).toBe('---\nmgmt_vlan: 99\n');
    expect(disk.get('host_vars/nb-sw-01.yml')).toBe('---\nsite: DC1\n');
    expect(disk.get('inventory.ini')).toBe(INI);
  });

  it('an existing variable changes where it is written; a vaulted one is refused; removal too', async () => {
    const vaulted = 'enable: !vault |\n  $ANSIBLE_VAULT;1.1;AES256\n  6162\nsite: lab\n';
    const { io, disk } = repo({
      'ansible.cfg': CFG,
      'inventory.ini': INI,
      'group_vars/lab.yml': vaulted,
    });
    let r = await inventoryTool(io, {
      action: 'edit',
      ops: [
        { op: 'set_var', group: 'lab', key: 'site', value: 'dc1' },
        { op: 'set_var', group: 'lab', key: 'ansible_user', value: 'ops' },
        { op: 'remove_var', group: 'lab', key: 'snmp_community' },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(disk.get('group_vars/lab.yml')).toContain('site: dc1\n');
    expect(disk.get('group_vars/lab.yml')).toContain('$ANSIBLE_VAULT;1.1;AES256');
    expect(disk.get('inventory.ini')).toContain('[lab:vars]\nansible_user=ops\n');
    expect(disk.get('inventory.ini')).not.toContain('snmp_community');
    r = await inventoryTool(io, {
      action: 'edit',
      ops: [{ op: 'set_var', group: 'lab', key: 'enable', value: 'x' }],
    });
    expect(r.text).toMatch(/vault-encrypted.*Nothing was changed/);
  });

  it('a rename takes the variables file with it, and a variable set after it goes to the new name', async () => {
    const { io, disk } = repo({
      'ansible.cfg': CFG,
      'inventory.ini': INI,
      'host_vars/h01.yml': 'site: Lab A\n',
    });
    const r = await inventoryTool(io, {
      action: 'edit',
      ops: [
        { op: 'rename_host', host: 'h01', to: 'h11' },
        { op: 'set_var', host: 'h11', key: 'rack', value: 4 },
      ],
    });
    expect(r.isError).toBeFalsy();
    expect(r.text).toContain('Its variables file is renamed too (host_vars/h11.yml)');
    expect(disk.has('host_vars/h01.yml')).toBe(false);
    expect(parse(disk.get('host_vars/h11.yml') as string)).toEqual({ site: 'Lab A', rack: 4 });
    expect(disk.get('inventory.ini')).toContain('h11 ansible_host=192.0.2.11');
  });

  it("what is refused: Ansible's own groups, bad names, no ops, only a dynamic source", async () => {
    const { io } = repo({ 'ansible.cfg': CFG, 'inventory.ini': INI });
    const run = (ops: unknown[]) => inventoryTool(io, { action: 'edit', ops: ops as never });
    expect((await run([{ op: 'remove_group', group: 'all' }])).text).toMatch(/Ansible's own group/);
    expect((await run([{ op: 'add_host', host: 'a b', group: 'lab' }])).text).toMatch(/host name/);
    expect((await run([{ op: 'set_var', key: 'x', value: 1 }])).text).toMatch(
      /name a host or a group/,
    );
    expect((await run([])).text).toMatch(/at least one change/);
    expect((await inventoryTool(undefined, {})).isError).toBe(true);
    const dynamic = repo({
      'ansible.cfg': '[defaults]\ninventory = nb.yml\n',
      'nb.yml': 'plugin: netbox.netbox.nb_inventory\n',
    });
    const r = await inventoryTool(dynamic.io, {
      action: 'edit',
      ops: [{ op: 'add_group', group: 'x' }],
    });
    expect(r.text).toMatch(/no YAML or INI file to change/);
  });
});

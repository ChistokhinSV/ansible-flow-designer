// AFD-259, AFD-260: changes to an inventory's YAML and INI files. Each is the smallest edit of the
// text: comments, order and layout stay, and what is not written as a plain name (a range, a
// dynamic source) is refused with a reason.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  editInventory,
  fileVars,
  groupNameProblem,
  hostNameProblem,
  type InventoryEdit,
  type InventoryFile,
  type InventoryOp,
  inlineVars,
  parseValue,
  removeVarInFile,
  setVarInFile,
  showValue,
} from '../../../src/core/inventory/edit';

const INI = [
  '# Fictional lab',
  'jump-01 ansible_host=192.0.2.5',
  '',
  '[edge]',
  'sw-edge-0[1:4]',
  'sw-edge-09 ansible_host=192.0.2.19  # spare',
  '',
  '[lab]',
  '# the lab rack',
  'h01',
  'h02 ansible_port=2222',
  '',
  '[edge_switches:children]',
  'edge',
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
  '    core:',
  '      hosts:',
  '        core-sp-01:',
  '          ansible_host: 192.0.2.21',
  '        core-sp-02:',
  '        core-sp-[03:04]:',
  '    lab: {}',
  '    spare:',
  '',
].join('\n');

const ini = (text = INI): InventoryFile => ({ path: 'inventory.ini', kind: 'ini', text });
const yaml = (text = YAML): InventoryFile => ({ path: 'hosts.yml', kind: 'yaml', text });

function text(r: InventoryEdit, path?: string): string {
  if (!r.ok) throw new Error(r.error);
  const file = path ? r.files.find((f) => f.path === path) : r.files[0];
  if (!file) throw new Error('no file changed');
  return file.text;
}
const error = (r: InventoryEdit) => (r.ok ? '' : r.error);
/** The lines `after` has that `before` has not, and the other way round. */
function diff(before: string, after: string): { added: string[]; removed: string[] } {
  const a = before.split('\n');
  const b = after.split('\n');
  return { added: b.filter((l) => !a.includes(l)), removed: a.filter((l) => !b.includes(l)) };
}
const edit = (file: InventoryFile, op: InventoryOp) => editInventory([file], op);

describe('an INI inventory', () => {
  it('adds a host at the end of its section, and to hosts without a group at the top', () => {
    const lab = text(edit(ini(), { op: 'add_host', host: 'h03', group: 'lab' }));
    expect(diff(INI, lab)).toEqual({ added: ['h03'], removed: [] });
    expect(lab.split('\n').slice(9, 13)).toEqual(['h01', 'h02 ansible_port=2222', 'h03', '']);
    const top = text(edit(ini(), { op: 'add_host', host: 'jump-02', group: 'ungrouped' }));
    expect(top.split('\n').slice(0, 4)).toEqual([
      '# Fictional lab',
      'jump-01 ansible_host=192.0.2.5',
      'jump-02',
      '',
    ]);
  });

  it('removes and renames a host on its lines only; a host of a range is refused', () => {
    const gone = text(edit(ini(), { op: 'remove_host', host: 'h02', group: 'lab' }));
    expect(diff(INI, gone)).toEqual({ added: [], removed: ['h02 ansible_port=2222'] });
    const named = text(edit(ini(), { op: 'rename_host', host: 'sw-edge-09', to: 'sw-edge-10' }));
    expect(diff(INI, named)).toEqual({
      added: ['sw-edge-10 ansible_host=192.0.2.19  # spare'],
      removed: ['sw-edge-09 ansible_host=192.0.2.19  # spare'],
    });
    expect(error(edit(ini(), { op: 'remove_host', host: 'sw-edge-02', group: 'edge' }))).toMatch(
      /one of the range sw-edge-0\[1:4\]/,
    );
    expect(error(edit(ini(), { op: 'rename_host', host: 'h01', to: 'h02' }))).toMatch(/already/);
  });

  it('moves a host between groups, the variables on its line with it', () => {
    const carried = text(edit(ini(), { op: 'move_host', host: 'h02', from: 'lab', to: 'edge' }));
    expect(diff(INI, carried)).toEqual({ added: [], removed: [] });
    const at = carried.split('\n');
    expect(at.indexOf('h02 ansible_port=2222')).toBe(
      at.indexOf('sw-edge-09 ansible_host=192.0.2.19  # spare') + 1,
    );
    const moved = text(edit(ini(), { op: 'move_host', host: 'h01', from: 'lab', to: 'edge' }));
    const lines = moved.split('\n');
    expect(lines.indexOf('h01')).toBe(
      lines.indexOf('sw-edge-09 ansible_host=192.0.2.19  # spare') + 1,
    );
    expect(lines.filter((l) => l === 'h01')).toHaveLength(1);
  });

  it('adds a group, as a child too; renames it everywhere; removes all of it', () => {
    const added = text(edit(ini(), { op: 'add_group', group: 'core' }));
    expect(added.endsWith('\n[core]\n')).toBe(true);
    const child = text(edit(ini(), { op: 'add_group', group: 'lab', parent: 'edge_switches' }));
    expect(diff(INI, child)).toEqual({ added: ['lab'], removed: [] });
    const fresh = text(edit(ini(), { op: 'add_group', group: 'dc1', parent: 'lab' }));
    expect(fresh).toContain('[dc1]\n');
    expect(fresh).toContain('[lab:children]\ndc1\n');

    const renamed = text(edit(ini(), { op: 'rename_group', group: 'edge', to: 'access' }));
    expect(diff(INI, renamed)).toEqual({
      added: ['[access]', 'access'],
      removed: ['[edge]', 'edge'],
    });

    const removed = text(edit(ini(), { op: 'remove_group', group: 'lab' }));
    expect(removed).not.toMatch(/lab\]|h01|ansible_user|the lab rack/);
    expect(removed).toContain('[edge_switches:children]\nedge\n');
    expect(error(edit(ini(), { op: 'add_group', group: 'edge' }))).toMatch(/already/);
  });

  it('sets, changes and removes a variable on a host line, keeping its comment', () => {
    const set = text(
      edit(ini(), { op: 'set_var', host: 'sw-edge-09', key: 'ansible_port', value: 22 }),
    );
    expect(diff(INI, set).added).toEqual([
      'sw-edge-09 ansible_host=192.0.2.19 ansible_port=22  # spare',
    ]);
    const changed = text(
      edit(ini(), { op: 'set_var', host: 'sw-edge-09', key: 'ansible_host', value: '192.0.2.20' }),
    );
    expect(diff(INI, changed).added).toEqual(['sw-edge-09 ansible_host=192.0.2.20  # spare']);
    const spaced = text(edit(ini(), { op: 'set_var', host: 'h01', key: 'site', value: 'Lab A' }));
    expect(diff(INI, spaced).added).toEqual(['h01 site="Lab A"']);
    const gone = text(edit(ini(), { op: 'remove_var', host: 'h02', key: 'ansible_port' }));
    expect(diff(INI, gone)).toEqual({ added: ['h02'], removed: ['h02 ansible_port=2222'] });
    expect(
      error(edit(ini(), { op: 'set_var', host: 'h01', key: 'vlans', value: [10, 20] })),
    ).toMatch(/simple values/);
  });

  it('group variables go to its :vars section, made when it is not there', () => {
    const set = text(edit(ini(), { op: 'set_var', group: 'lab', key: 'ansible_port', value: 22 }));
    expect(set).toContain('[lab:vars]\nansible_user=netops\nansible_port=22\n');
    const made = text(
      edit(ini(), { op: 'set_var', group: 'edge', key: 'ansible_network_os', value: 'ios' }),
    );
    expect(made.endsWith('\n[edge:vars]\nansible_network_os=ios\n')).toBe(true);
    const gone = text(edit(ini(), { op: 'remove_var', group: 'lab', key: 'ansible_user' }));
    expect(diff(INI, gone)).toEqual({ added: [], removed: ['ansible_user=netops'] });
  });

  it('reads the variables written on a host line and in :vars', () => {
    expect(inlineVars([ini()], { host: 'sw-edge-09' })).toEqual([
      { key: 'ansible_host', value: '192.0.2.19', file: 'inventory.ini', line: 5 },
    ]);
    expect(inlineVars([ini()], { host: 'h02' })[0]).toMatchObject({
      key: 'ansible_port',
      value: 2222,
    });
    expect(inlineVars([ini()], { group: 'lab' })).toEqual([
      { key: 'ansible_user', value: 'netops', file: 'inventory.ini', line: 16 },
    ]);
  });
});

describe('a YAML inventory', () => {
  it('adds a host to a group with hosts, to an empty one and to one with no value', () => {
    const core = text(edit(yaml(), { op: 'add_host', host: 'core-sp-05', group: 'core' }));
    expect(diff(YAML, core)).toEqual({ added: ['        core-sp-05: {}'], removed: [] });
    const lab = text(edit(yaml(), { op: 'add_host', host: 'h01', group: 'lab' }));
    expect(lab).toContain('    lab:\n      hosts:\n        h01: {}\n');
    const spare = text(edit(yaml(), { op: 'add_host', host: 'h09', group: 'spare' }));
    expect(spare).toContain('    spare:\n      hosts:\n        h09: {}\n');
    for (const t of [core, lab, spare]) {
      expect(t).toContain('ansible_user: netops # the service account');
      expect(t.startsWith('# Fictional lab\n')).toBe(true);
    }
    expect(parse(lab).all.children.lab).toEqual({ hosts: { h01: {} } });
  });

  it('removes and renames a host; a host of a range is refused', () => {
    const gone = text(edit(yaml(), { op: 'remove_host', host: 'core-sp-02', group: 'core' }));
    expect(diff(YAML, gone)).toEqual({ added: [], removed: ['        core-sp-02:'] });
    const named = text(edit(yaml(), { op: 'rename_host', host: 'core-sp-01', to: 'core-sp-11' }));
    expect(diff(YAML, named)).toEqual({
      added: ['        core-sp-11:'],
      removed: ['        core-sp-01:'],
    });
    expect(parse(named).all.children.core.hosts['core-sp-11']).toEqual({
      ansible_host: '192.0.2.21',
    });
    expect(error(edit(yaml(), { op: 'remove_host', host: 'core-sp-03' }))).toMatch(
      /range core-sp-\[03:04\]/,
    );
  });

  it('moves a host, with the variables written on it', () => {
    const carried = text(
      edit(yaml(), { op: 'move_host', host: 'core-sp-01', from: 'core', to: 'lab' }),
    );
    expect(parse(carried).all.children.lab).toEqual({
      hosts: { 'core-sp-01': { ansible_host: '192.0.2.21' } },
    });
    expect('core-sp-01' in parse(carried).all.children.core.hosts).toBe(false);
    const moved = text(
      edit(yaml(), { op: 'move_host', host: 'core-sp-02', from: 'core', to: 'lab' }),
    );
    const data = parse(moved).all.children;
    expect(Object.keys(data.core.hosts)).toEqual(['core-sp-01', 'core-sp-[03:04]']);
    expect(data.lab).toEqual({ hosts: { 'core-sp-02': {} } });
  });

  it('adds a group under all, and as a child; renames and removes it', () => {
    const added = text(edit(yaml(), { op: 'add_group', group: 'edge' }));
    expect(diff(YAML, added)).toEqual({ added: ['    edge: {}'], removed: [] });
    const child = text(edit(yaml(), { op: 'add_group', group: 'spines', parent: 'core' }));
    expect(parse(child).all.children.core.children).toEqual({ spines: {} });
    const renamed = text(edit(yaml(), { op: 'rename_group', group: 'core', to: 'spine' }));
    expect(diff(YAML, renamed)).toEqual({ added: ['    spine:'], removed: ['    core:'] });
    const removed = text(edit(yaml(), { op: 'remove_group', group: 'core' }));
    expect(Object.keys(parse(removed).all.children)).toEqual(['lab', 'spare']);
    expect(removed).toContain('ansible_user: netops # the service account');
  });

  it('a file without all: gets a new group at the top', () => {
    const flat = 'lab:\n  hosts:\n    h01:\n';
    const added = text(edit(yaml(flat), { op: 'add_group', group: 'edge' }));
    expect(parse(added)).toEqual({ lab: { hosts: { h01: null } }, edge: {} });
  });

  it('sets, changes and removes variables of a host and of a group', () => {
    const set = text(
      edit(yaml(), { op: 'set_var', host: 'core-sp-01', key: 'ansible_port', value: 22 }),
    );
    expect(diff(YAML, set)).toEqual({ added: ['          ansible_port: 22'], removed: [] });
    const first = text(
      edit(yaml(), { op: 'set_var', host: 'core-sp-02', key: 'vlans', value: [10, 20] }),
    );
    expect(parse(first).all.children.core.hosts['core-sp-02']).toEqual({ vlans: [10, 20] });
    const group = text(
      edit(yaml(), { op: 'set_var', group: 'all', key: 'ansible_user', value: 'ops' }),
    );
    expect(diff(YAML, group)).toEqual({
      added: ['    ansible_user: ops # the service account'],
      removed: ['    ansible_user: netops # the service account'],
    });
    const empty = text(edit(yaml(), { op: 'set_var', group: 'lab', key: 'site', value: 'Lab A' }));
    expect(parse(empty).all.children.lab).toEqual({ vars: { site: 'Lab A' } });
    const gone = text(edit(yaml(), { op: 'remove_var', host: 'core-sp-01', key: 'ansible_host' }));
    expect(parse(gone).all.children.core.hosts['core-sp-01'] ?? {}).toEqual({});
    expect(error(edit(yaml(), { op: 'remove_var', group: 'core', key: 'nope' }))).toMatch(
      /not written/,
    );
  });

  it('reads variables with their lines; a vaulted value is never read', () => {
    expect(inlineVars([yaml()], { group: 'all' })).toEqual([
      { key: 'ansible_user', value: 'netops', file: 'hosts.yml', line: 3 },
    ]);
    expect(inlineVars([yaml()], { host: 'core-sp-01' })).toEqual([
      { key: 'ansible_host', value: '192.0.2.21', file: 'hosts.yml', line: 8 },
    ]);
    const vaulted =
      'all:\n  vars:\n    enable: !vault |\n      $ANSIBLE_VAULT;1.1;AES256\n      6162\n    site: lab\n';
    const vars = inlineVars([yaml(vaulted)], { group: 'all' });
    expect(vars[0]).toEqual({ key: 'enable', vaulted: true, file: 'hosts.yml', line: 2 });
    expect(showValue(vars[0] as never)).toBe('(vaulted)');
    expect(vars[1]).toMatchObject({ key: 'site', value: 'lab' });
  });
});

describe('AFD-262: a group moves in the hierarchy with everything in it', () => {
  const NESTED = [
    'all:',
    '  children:',
    '    lab:',
    '      hosts:',
    '        sw-lab-01:',
    '          ansible_host: 192.0.2.12 # the console server',
    '      vars:',
    '        ansible_network_os: cisco.ios.ios',
    '      children:',
    '        test:',
    '          # hosts under test',
    '          hosts:',
    '            testhost: {}',
    '    spare: {}',
    '',
  ].join('\n');

  it('YAML: out to the top level, its lines and comments as they were', () => {
    const up = text(edit(yaml(NESTED), { op: 'move_group', group: 'test', from: 'lab' }));
    expect(up).toBe(
      [
        'all:',
        '  children:',
        '    lab:',
        '      hosts:',
        '        sw-lab-01:',
        '          ansible_host: 192.0.2.12 # the console server',
        '      vars:',
        '        ansible_network_os: cisco.ios.ios',
        '      children: {}',
        '    spare: {}',
        '    test:',
        '      # hosts under test',
        '      hosts:',
        '        testhost: {}',
        '',
      ].join('\n'),
    );
  });

  it('YAML: under another group, and under an empty one; data unchanged', () => {
    const down = text(edit(yaml(NESTED), { op: 'move_group', group: 'lab', to: 'spare' }));
    const data = parse(down).all.children;
    expect(Object.keys(data)).toEqual(['spare']);
    expect(data.spare.children.lab).toEqual(parse(NESTED).all.children.lab);
    expect(down).toContain('# the console server');
    expect(down).toContain('# hosts under test');
    const across = text(
      edit(yaml(NESTED), { op: 'move_group', group: 'test', from: 'lab', to: 'spare' }),
    );
    expect(parse(across).all.children.spare).toEqual({
      children: { test: { hosts: { testhost: {} } } },
    });
  });

  it('YAML: refused into itself, where it is already, and when it is not there', () => {
    const run = (op: InventoryOp) => error(edit(yaml(NESTED), op));
    expect(run({ op: 'move_group', group: 'lab', to: 'test' })).toMatch(/cannot hold itself/);
    expect(run({ op: 'move_group', group: 'lab', to: 'lab' })).toMatch(/cannot hold itself/);
    expect(run({ op: 'move_group', group: 'spare' })).toMatch(/already/);
    expect(run({ op: 'move_group', group: 'test', from: 'spare' })).toMatch(/not a child of spare/);
    expect(run({ op: 'move_group', group: 'test', from: 'lab', to: 'nope' })).toMatch(
      /not written/,
    );
    const flow = 'all:\n  children: {lab: {hosts: {h1: {}}}, spare: {}}\n';
    expect(error(edit(yaml(flow), { op: 'move_group', group: 'lab', to: 'spare' }))).toMatch(
      /inline/,
    );
  });

  it('INI: a group is a child by its line in :children; moving changes those lines only', () => {
    const down = text(edit(ini(), { op: 'move_group', group: 'lab', to: 'edge_switches' }));
    expect(diff(INI, down)).toEqual({ added: ['lab'], removed: [] });
    expect(down).toContain('[edge_switches:children]\nedge\nlab\n');
    const up = text(edit(ini(), { op: 'move_group', group: 'edge', from: 'edge_switches' }));
    expect(up).not.toMatch(/\[edge_switches:children\]\nedge/);
    expect(up).toContain('[edge]\nsw-edge-0[1:4]\n');
    const across = text(
      edit(ini(), { op: 'move_group', group: 'edge', from: 'edge_switches', to: 'lab' }),
    );
    expect(across).toContain('[lab:children]\nedge\n');
    expect(error(edit(ini(), { op: 'move_group', group: 'edge_switches', to: 'edge' }))).toMatch(
      /cannot hold itself/,
    );
    expect(error(edit(ini(), { op: 'move_group', group: 'edge', to: 'edge_switches' }))).toMatch(
      /already/,
    );
  });

  it('a child group added in YAML is written once, under its parent', () => {
    const start = 'all:\n  children:\n    lab:\n      hosts:\n        sw-lab-01:\n';
    const added = text(edit(yaml(start), { op: 'add_group', group: 'test', parent: 'lab' }));
    expect(parse(added)).toEqual({
      all: { children: { lab: { hosts: { 'sw-lab-01': null }, children: { test: {} } } } },
    });
  });
});

describe('several files, and files that cannot be changed', () => {
  const plugin: InventoryFile = {
    path: 'inventory/netbox.yml',
    kind: 'plugin',
    text: 'plugin: x\n',
  };

  it('a change goes to the file that writes the group or the host', () => {
    const files = [
      { ...ini(), path: 'inventory/lab' },
      { ...yaml(), path: 'inventory/core.yml' },
    ];
    const a = editInventory(files, { op: 'add_host', host: 'h03', group: 'lab' });
    expect(a.ok && a.files.map((f) => f.path)).toEqual(['inventory/lab']);
    const b = editInventory(files, { op: 'add_host', host: 'core-sp-09', group: 'core' });
    expect(b.ok && b.files.map((f) => f.path)).toEqual(['inventory/core.yml']);
    // A new group with two files to hold it: asked which.
    const c = editInventory(files, { op: 'add_group', group: 'dmz' });
    expect(c).toMatchObject({ ok: false, choose: ['inventory/lab', 'inventory/core.yml'] });
    const d = editInventory(files, { op: 'add_group', group: 'dmz', file: 'inventory/core.yml' });
    expect(d.ok && d.files.map((f) => f.path)).toEqual(['inventory/core.yml']);
  });

  it('a dynamic source alone has nothing to change; beside a static file it is left alone', () => {
    expect(error(editInventory([plugin], { op: 'add_group', group: 'x' }))).toMatch(/read-only/);
    const r = editInventory([plugin, ini()], { op: 'add_group', group: 'x' });
    expect(r.ok && r.files.map((f) => f.path)).toEqual(['inventory.ini']);
    expect(error(editInventory([plugin, ini()], { op: 'remove_host', host: 'nb-sw-01' }))).toMatch(
      /not written in a file/,
    );
  });

  it('names are checked before anything is written', () => {
    expect(hostNameProblem('sw 01')).toBeDefined();
    expect(hostNameProblem('sw[01:02]')).toMatch(/range/);
    expect(hostNameProblem('sw-01.example.net')).toBeUndefined();
    expect(groupNameProblem('edge-switches')).toBeDefined();
    expect(groupNameProblem('edge_switches')).toBeUndefined();
    expect(error(edit(ini(), { op: 'add_host', host: 'a b', group: 'lab' }))).toMatch(/host name/);
    expect(error(edit(ini(), { op: 'add_group', group: '1st' }))).toMatch(/group name/);
  });

  it('a YAML file with anchors there is refused, not rewritten', () => {
    const anchored = 'all:\n  children:\n    a: &a\n      hosts:\n        h1:\n    b: *a\n';
    const r = edit(yaml(anchored), { op: 'remove_host', host: 'h1' });
    expect(r.ok).toBe(false);
  });
});

describe('variables in host_vars/ and group_vars/ files', () => {
  it('a new file, a first variable, another one, a change, a removal', () => {
    const made = setVarInFile(undefined, 'ansible_host', '192.0.2.11') as string;
    expect(made).toBe('---\nansible_host: 192.0.2.11\n');
    const more = setVarInFile(made, 'vlans', [10, 20]) as string;
    expect(parse(more)).toEqual({ ansible_host: '192.0.2.11', vlans: [10, 20] });
    const kept = setVarInFile('# site facts\nsite: lab # where\n', 'site', 'dc1') as string;
    expect(kept).toBe('# site facts\nsite: dc1 # where\n');
    expect(removeVarInFile(more, 'vlans')).toBe(made);
    expect(fileVars('host_vars/sw-01.yml', more).map((v) => [v.key, v.line])).toEqual([
      ['ansible_host', 1],
      ['vlans', 2],
    ]);
  });

  it('a vault-encrypted file is neither read nor changed', () => {
    const vault = '$ANSIBLE_VAULT;1.1;AES256\n6162\n';
    expect(fileVars('group_vars/all/vault.yml', vault)).toEqual([]);
    expect(setVarInFile(vault, 'x', 1)).toEqual({
      error: expect.stringContaining('ansible-vault'),
    });
    expect(removeVarInFile(vault, 'x')).toEqual({
      error: expect.stringContaining('ansible-vault'),
    });
  });

  it('what is typed for a value is read as YAML, else kept as text', () => {
    expect(parseValue('22')).toBe(22);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('[10, 20]')).toEqual([10, 20]);
    expect(parseValue('192.0.2.11')).toBe('192.0.2.11');
    expect(parseValue('{{ lookup("env", "X") }}')).toBe('{{ lookup("env", "X") }}');
    expect(parseValue('')).toBe('');
  });
});

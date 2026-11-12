// AFD-258: where an inventory's hosts and groups are written, found in the text of its static
// files (Ansible does not report it), so the Inventory view opens them at their line.
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import {
  defaultInventory,
  expandRange,
  ignoredInFolder,
  iniEntries,
  newInventoryText,
  OriginIndex,
  sourceEntries,
  sourceKind,
  touchesInventory,
  yamlEntries,
} from '../../../src/core/inventory/origins';

const INI = [
  '# Fictional hosts',
  'jump-01 ansible_host=192.0.2.5',
  '',
  '[edge]',
  'sw-edge-0[1:4]',
  '',
  '[lab]',
  'h0[1:2]',
  'h07 ansible_connection=ssh ansible_port=1   ; closed port',
  '',
  '[edge_switches:children]',
  'edge',
  '',
  '[all:vars]',
  'ansible_connection=local',
].join('\n');

const YAML = [
  'all:',
  '  vars:',
  '    ansible_user: netops',
  '  hosts:',
  '    jump-01:',
  '  children:',
  '    core:',
  '      hosts:',
  '        core-sp-01:',
  '          ansible_host: 192.0.2.21',
  '        core-sp-[02:03]:',
  '      children:',
  '        spines:',
  '          hosts:',
  '            core-sp-01:',
  '    empty: {}',
].join('\n');

describe('an INI inventory', () => {
  it('finds each section, host line and child group at its line', () => {
    expect(iniEntries('inventory.ini', INI).map((e) => [e.type, e.name, e.group, e.line])).toEqual([
      ['host', 'jump-01', 'ungrouped', 1],
      ['group', 'edge', undefined, 3],
      ['host', 'sw-edge-0[1:4]', 'edge', 4],
      ['group', 'lab', undefined, 6],
      ['host', 'h0[1:2]', 'lab', 7],
      ['host', 'h07', 'lab', 8],
      ['group', 'edge_switches', undefined, 10],
      ['group', 'edge', undefined, 11],
      ['group', 'all', undefined, 13],
    ]);
  });

  it('a host of a range opens at the range, and says so', () => {
    const index = new OriginIndex(iniEntries('inventory.ini', INI));
    expect(index.host('sw-edge-03', 'edge')).toEqual({
      file: 'inventory.ini',
      line: 4,
      range: 'sw-edge-0[1:4]',
    });
    expect(index.host('h07', 'lab')).toEqual({ file: 'inventory.ini', line: 8 });
    expect(index.host('sw-edge-05')).toBeUndefined();
    // A group opens where it is first written: its own section, before a mention as a child.
    expect(index.group('edge')).toEqual({ file: 'inventory.ini', line: 3 });
    expect(index.group('edge_switches')).toEqual({ file: 'inventory.ini', line: 10 });
  });
});

describe('a YAML inventory', () => {
  it('finds groups, their hosts and child groups at the line of the key', () => {
    expect(yamlEntries('hosts.yml', YAML).map((e) => [e.type, e.name, e.group, e.line])).toEqual([
      ['group', 'all', undefined, 0],
      ['host', 'jump-01', 'all', 4],
      ['group', 'core', undefined, 6],
      ['host', 'core-sp-01', 'core', 8],
      ['host', 'core-sp-[02:03]', 'core', 10],
      ['group', 'spines', undefined, 12],
      ['host', 'core-sp-01', 'spines', 14],
      ['group', 'empty', undefined, 15],
    ]);
  });

  it('a host in two groups opens under the group it is asked for, else at its first place', () => {
    const index = new OriginIndex(yamlEntries('hosts.yml', YAML));
    expect(index.host('core-sp-01', 'spines')?.line).toBe(14);
    expect(index.host('core-sp-01', 'core')?.line).toBe(8);
    expect(index.host('core-sp-01', 'all')?.line).toBe(8);
    expect(index.host('core-sp-03', 'core')).toMatchObject({ line: 10, range: 'core-sp-[02:03]' });
  });

  it('a file that does not read has no entries, and does not throw', () => {
    // What still reads of a broken file is kept (the group), and nothing is invented.
    expect(
      sourceEntries('x.yml', 'all: [unclosed', 'yaml').filter((e) => e.type === 'host'),
    ).toEqual([]);
    expect(sourceEntries('x.yml', '{{{', 'yaml')).toEqual([]);
    expect(sourceEntries('x.yml', 'plugin: netbox.netbox.nb_inventory', 'plugin')).toEqual([]);
  });
});

describe('several files', () => {
  it('one index over all of them', () => {
    const index = new OriginIndex([
      ...iniEntries('inventory/lab.ini', INI),
      ...yamlEntries('inventory/core.yml', YAML),
    ]);
    expect(index.host('h07')?.file).toBe('inventory/lab.ini');
    expect(index.group('spines')?.file).toBe('inventory/core.yml');
    // `all` is written in both: the first file wins.
    expect(index.group('all')).toEqual({ file: 'inventory/lab.ini', line: 13 });
  });
});

describe('host ranges', () => {
  it('numbers keep their width, letters and steps work, two ranges multiply', () => {
    expect(expandRange('sw[01:03]')).toEqual(['sw01', 'sw02', 'sw03']);
    expect(expandRange('sw[8:10]')).toEqual(['sw8', 'sw9', 'sw10']);
    expect(expandRange('db-[a:c].example.net')).toEqual([
      'db-a.example.net',
      'db-b.example.net',
      'db-c.example.net',
    ]);
    expect(expandRange('n[1:5:2]')).toEqual(['n1', 'n3', 'n5']);
    expect(expandRange('r[1:2]-p[a:b]')).toEqual(['r1-pa', 'r1-pb', 'r2-pa', 'r2-pb']);
    expect(expandRange('plain')).toEqual(['plain']);
  });

  it('a range that does not read, or is too large, is left alone', () => {
    expect(expandRange('sw[a:10]')).toBeUndefined();
    expect(expandRange('sw[1:100000]')).toBeUndefined();
  });
});

describe('what a source is', () => {
  it('by its name and first lines, as the inventory plugins take it', () => {
    expect(sourceKind('inventory/hosts.yml', YAML)).toBe('yaml');
    expect(sourceKind('inventory/netbox.yml', '---\nplugin: netbox.netbox.nb_inventory\n')).toBe(
      'plugin',
    );
    expect(sourceKind('hosts', INI)).toBe('ini');
    expect(sourceKind('inventory.ini', INI)).toBe('ini');
    expect(sourceKind('inventory/ec2.py', 'import boto3')).toBe('script');
    expect(sourceKind('inventory/dynamic', '#!/usr/bin/env python3\n')).toBe('script');
    expect(sourceKind('hosts.toml', '')).toBe('toml');
  });

  it('a directory inventory skips variables, notes and, as Ansible does, .ini files', () => {
    expect(ignoredInFolder('inventory/hosts.yml')).toBe(false);
    expect(ignoredInFolder('inventory/hosts')).toBe(false);
    expect(ignoredInFolder('inventory/lab.ini')).toBe(true);
    expect(ignoredInFolder('inventory/group_vars/all.yml')).toBe(true);
    expect(ignoredInFolder('inventory/README.md')).toBe(true);
    expect(ignoredInFolder('inventory/.gitkeep')).toBe(true);
  });
});

describe('a file that changed', () => {
  it('makes the view read again when the inventory is read from it, or it holds its variables', () => {
    const sources = ['inventory/hosts.yml', 'inventory/core.yml'];
    expect(touchesInventory('inventory/hosts.yml', sources)).toBe(true);
    expect(touchesInventory('inventory\\core.yml', sources)).toBe(true);
    expect(touchesInventory('inventory/group_vars/all.yml', sources)).toBe(true);
    expect(touchesInventory('host_vars/sw-01.yml', sources)).toBe(true);
    expect(touchesInventory('ansible.cfg', sources)).toBe(true);
    expect(touchesInventory('inventory/other.yml', sources)).toBe(false);
    expect(touchesInventory('flows/x/x.flow.yaml', sources)).toBe(false);
  });

  it('with the files unknown, anything that looks like an inventory counts', () => {
    expect(touchesInventory('inventories/prod/hosts.yml', undefined)).toBe(true);
    expect(touchesInventory('inventory.ini', undefined)).toBe(true);
    expect(touchesInventory('roles/x/tasks/main.yml', undefined)).toBe(false);
  });
});

describe('the default inventory and a new one', () => {
  it("ansible.cfg's [defaults] inventory, as a list", () => {
    const cfg =
      '[defaults]\n# inventory = old\ninventory = inventory/lab.ini, inventory/core.yml\n';
    expect(defaultInventory(cfg)).toEqual(['inventory/lab.ini', 'inventory/core.yml']);
    expect(defaultInventory('[ssh_connection]\ninventory = x\n')).toEqual([]);
    expect(defaultInventory('')).toEqual([]);
  });

  it('a new inventory is YAML that reads, with no hosts', () => {
    const text = newInventoryText();
    expect(parse(text)).toEqual({ all: { children: {} } });
    expect(yamlEntries('hosts.yml', text).filter((e) => e.type === 'host')).toEqual([]);
  });
});

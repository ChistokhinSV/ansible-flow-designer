// AFD-255, AFD-256: what Switch Ansible Environment… and Switch Inventory… offer and write. The
// environments the settings describe are one click away; an SSH host's image is its own setting.
import { describe, expect, it } from 'vitest';
import {
  type AfdEnvSettings,
  type Environment,
  resolveEnvironment,
  settingsFromJson,
} from '../../../src/core/run/environment';
import {
  environmentSwitches,
  type SwitchSettings,
  switchWrites,
} from '../../../src/core/run/switch';
import { inventoryCandidates, inventoryPath } from '../../../src/core/view/inventorySources';

const none: SwitchSettings = {
  image: '',
  containerEngine: 'auto',
  wslDistro: '',
  sshHost: '',
  sshImage: '',
  python: '',
};
const windows = { platform: 'win32', docker: true, podman: false, distros: ['Debian', 'Ubuntu'] };
const linux = { platform: 'linux', docker: false, podman: true, distros: [] };
const base: AfdEnvSettings = {
  kind: 'ssh',
  containerEngine: 'auto',
  image: '',
  containerOptions: [],
  python: '',
  wslDistro: '',
  sshHost: 'ops1',
};
const env = (afd: AfdEnvSettings): Environment => {
  const r = resolveEnvironment(afd, {}, 'win32', 'netops');
  if (!r.ok) throw new Error(r.error);
  return r.env;
};

describe('Switch Ansible Environment…', () => {
  it('offers what the settings describe and the WSL distributions, the one in use marked', () => {
    const settings = { ...none, image: 'reg.example.net/ee:2.19', sshHost: 'ops1' };
    const now = env({ ...base, image: settings.image, sshImage: '' });
    const list = environmentSwitches(settings, windows, now);
    expect(list.map((c) => [c.label, c.current])).toEqual([
      ['Docker: reg.example.net/ee:2.19', false],
      ['WSL: Debian', false],
      ['WSL: Ubuntu', false],
      ['SSH: ops1', true],
    ]);
    expect(list[3]?.detail).toContain("the host's own Ansible");
  });

  it('nothing configured on Windows: the distributions only; on Linux: this machine', () => {
    expect(environmentSwitches(none, windows).map((c) => c.label)).toEqual([
      'WSL: Debian',
      'WSL: Ubuntu',
    ]);
    expect(environmentSwitches(none, linux).map((c) => c.label)).toEqual(['This machine: python3']);
    // Podman alone on the machine names the engine an image would run with.
    expect(environmentSwitches({ ...none, image: 'ee:1' }, linux)[0]?.label).toBe('Podman: ee:1');
  });

  it('a distribution of the settings that WSL did not list, and the default one in use', () => {
    const named = environmentSwitches({ ...none, wslDistro: 'Alma' }, { ...windows, distros: [] });
    expect(named.map((c) => c.label)).toEqual(['WSL: Alma']);
    const now = env({ ...base, kind: 'wsl' });
    const list = environmentSwitches(none, windows, now);
    expect(list.at(-1)).toMatchObject({ label: 'WSL: the default distribution', current: true });
    expect(list.filter((c) => c.current)).toHaveLength(1);
  });

  it('a switch writes the kind, and the distribution for WSL; nothing else is touched', () => {
    const list = environmentSwitches({ ...none, image: 'ee:1', sshHost: 'ops1' }, windows);
    const [container, debian, , ssh] = list;
    expect(switchWrites(ssh as never, undefined)).toEqual({ kind: 'ssh' });
    expect(switchWrites(debian as never, undefined)).toEqual({ kind: 'wsl', wslDistro: 'Debian' });
    expect(switchWrites(container as never, 'ee:1')).toEqual({ kind: 'container' });
    // 0.83.1 wrote an empty workspace image to keep the user's off the SSH host: it would hide it.
    expect(switchWrites(container as never, '')).toEqual({ kind: 'container', image: undefined });
  });
});

describe("the SSH host's image is a setting of its own", () => {
  it('sshImage decides when it is set, also when empty; not set, 0.83 image runs there', () => {
    const image = 'reg.example.net/ee:2.19';
    expect(env({ ...base, image, sshImage: '' })).toMatchObject({
      kind: 'ssh',
      label: 'ssh: ops1 (ansible on its PATH)',
    });
    expect(env({ ...base, image, sshImage: 'other/ee:1' })).toMatchObject({
      container: { image: 'other/ee:1' },
    });
    expect(env({ ...base, image })).toMatchObject({ container: { image } });
    // The same image setting still runs a container on this machine.
    expect(env({ ...base, kind: 'container', image, sshImage: '' })).toMatchObject({
      kind: 'container',
      image,
    });
  });

  it('the MCP server reads it from settings JSON, set or not', () => {
    const set = settingsFromJson({ 'afd.environment.sshImage': '' }).afd;
    expect(set.sshImage).toBe('');
    expect('sshImage' in settingsFromJson({}).afd).toBe(false);
  });
});

describe('Switch Inventory…', () => {
  it('finds root files, inventory/ and one folder for each environment under inventories/', () => {
    expect(
      inventoryCandidates([
        'inventory.ini',
        'hosts',
        'hosts.yml',
        'inventory/lab.ini',
        'inventory/prod.yml',
        'inventory/group_vars/all.yml',
        'inventories/prod/hosts.yml',
        'inventories/prod/group_vars/all/vault.yml',
        'inventories/lab/hosts',
        'inventories/netbox.yml',
        'inventories\\dev\\hosts.ini',
      ]),
    ).toEqual([
      'inventories/dev',
      'inventories/lab',
      'inventories/prod',
      'inventory',
      'hosts',
      'hosts.yml',
      'inventories/netbox.yml',
      'inventory.ini',
      'inventory/lab.ini',
      'inventory/prod.yml',
    ]);
  });

  it('leaves out what is no inventory: variables alone, notes, other files', () => {
    expect(
      inventoryCandidates([
        'inventory/README.md',
        'inventories/prod/group_vars/all.yml',
        'inventories/prod/host_vars/sw1.yml',
        'hosts.bak',
        'hostsfile.yml',
        'playbooks/inventory.yml',
        'inventory/.gitkeep',
      ]),
    ).toEqual([]);
  });

  it('the setting compares as a path of the list', () => {
    expect(inventoryPath(' ./inventories/prod/ ')).toBe('inventories/prod');
    expect(inventoryPath('inventory\\lab.ini')).toBe('inventory/lab.ini');
    expect(inventoryPath('')).toBe('');
  });
});

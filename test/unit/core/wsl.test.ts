// AFD-75: WSL as an Ansible environment: Windows paths as WSL sees them, and wsl.exe command lines
// whose secrets come from Windows only in variables (WSLENV).
import { describe, expect, it } from 'vitest';
import { insidePaths, probeProcess, runProcess, wslPath } from '../../../src/core/run/command';
import { type AfdEnvSettings, resolveEnvironment } from '../../../src/core/run/environment';
import { environmentChoices, parseWslList } from '../../../src/core/run/setup';

const afd = (over: Partial<AfdEnvSettings> = {}): AfdEnvSettings => ({
  kind: 'wsl',
  containerEngine: 'auto',
  image: '',
  containerOptions: [],
  python: '',
  wslDistro: '',
  ...over,
});
const resolved = resolveEnvironment(afd({ wslDistro: 'Debian' }), {}, 'win32');
const env = resolved.ok ? resolved.env : (undefined as never);
const paths = { root: 'C:\\HOME\\my repo', probe: 'C:\\ext\\probe' };

describe('Windows paths in WSL (AFD-75)', () => {
  it.each([
    ['C:\\HOME\\1.SCRIPTS\\repo', '/mnt/c/HOME/1.SCRIPTS/repo'],
    ['D:/work/flows/', '/mnt/d/work/flows'],
    ['C:\\', '/mnt/c'],
    ['\\\\wsl$\\Ubuntu\\home\\jane', '/home/jane'],
    ['\\\\wsl.localhost\\Debian\\srv', '/srv'],
    ['/already/linux', '/already/linux'],
  ])('%s', (windows, linux) => {
    expect(wslPath(windows)).toBe(linux);
  });
});

describe('the WSL environment (AFD-75)', () => {
  it('is for Windows, and names its distribution or WSL default one', () => {
    expect(resolved).toEqual({
      ok: true,
      env: { kind: 'wsl', distro: 'Debian', python: 'python3', label: 'wsl: Debian' },
    });
    expect(resolveEnvironment(afd(), {}, 'win32')).toMatchObject({
      ok: true,
      env: { kind: 'wsl', distro: undefined, label: 'wsl: the default distribution' },
    });
    expect(resolveEnvironment(afd(), {}, 'linux')).toMatchObject({
      ok: false,
      code: 'wsl-not-windows',
    });
  });

  it('probe: wsl.exe in the distribution, from the repository, the probe on /mnt', () => {
    expect(probeProcess(env, paths, 'n')).toEqual({
      command: 'wsl.exe',
      args: [
        '-d',
        'Debian',
        '--cd',
        '/mnt/c/HOME/my repo',
        '--',
        'env',
        'PYTHONPATH=/mnt/c/ext/probe',
        'PYTHONDONTWRITEBYTECODE=1',
        'python3',
        '-m',
        'afd_probe',
        'serve',
        '--root',
        '/mnt/c/HOME/my repo',
      ],
      env: {},
    });
  });

  it('run: the same script, its paths on /mnt, secrets only through WSLENV', () => {
    const spec = runProcess(
      env,
      paths,
      {
        playbook: 'flows/x/generated/x.yml',
        check: true,
        runDir: 'C:\\runs\\1',
        vault: true,
        secrets: true,
        hasConfig: true,
      },
      'n',
    );
    expect(spec.command).toBe('wsl.exe');
    expect(spec.args.slice(0, 6)).toEqual([
      '-d',
      'Debian',
      '--cd',
      '/mnt/c/HOME/my repo',
      '--',
      'env',
    ]);
    expect(spec.args).toContain('AFD_EVENTS=/mnt/c/runs/1/events.jsonl');
    expect(spec.args).toContain('ANSIBLE_CONFIG=/mnt/c/HOME/my repo/ansible.cfg');
    expect(spec.args).toContain('ANSIBLE_CALLBACK_PLUGINS=/mnt/c/ext/probe/callback_plugins');
    expect(spec.args.join(' ')).not.toMatch(/AFD_VAULT_PASSWORD=|AFD_SECRET_VARS=/);
    expect(spec.env).toEqual({ WSLENV: 'AFD_VAULT_PASSWORD/u:AFD_SECRET_VARS/u' });
    expect(spec.args.at(-1)).toContain('-e @/mnt/c/runs/1/vars.json -e @"$sv" --check');
    expect(spec.cwd).toBeUndefined();
  });

  it('the catalog cache and a scenario run folder on /mnt too', () => {
    expect(insidePaths(env, { ...paths, run: 'C:\\runs\\2', cache: 'C:\\cache' })).toEqual({
      root: '/mnt/c/HOME/my repo',
      probe: '/mnt/c/ext/probe',
      run: '/mnt/c/runs/2',
      cache: '/mnt/c/cache',
    });
  });
});

describe('WSL distributions in Set Up Ansible Environment… (AFD-75)', () => {
  it('reads wsl -l -q, without Docker Desktop own ones', () => {
    expect(parseWslList('\uFEFFDebian\r\ndocker-desktop\r\nUbuntu-24.04\r\n\r\n')).toEqual([
      'Debian',
      'Ubuntu-24.04',
    ]);
  });

  it('offers each distribution on Windows, before the WSL extension and the guide', () => {
    const kinds = environmentChoices({
      platform: 'win32',
      docker: false,
      podman: false,
      remoteWsl: true,
      distros: ['Debian', 'Ubuntu-24.04'],
    }).map((c) => (c.kind === 'wsl-distro' ? c.distro : c.kind));
    expect(kinds).toEqual(['Debian', 'Ubuntu-24.04', 'wsl', 'read']);
  });
});

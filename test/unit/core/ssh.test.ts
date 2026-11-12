// AFD-247: the command lines for an SSH host. What reaches the host is one quoted script; secrets
// are never in it; paths under the home folder expand there. (The same commands against a real
// host: sshLab.test.ts.)
import { describe, expect, it } from 'vitest';
import { insidePaths, probeProcess, runProcess } from '../../../src/core/run/command';
import type { Environment } from '../../../src/core/run/environment';
import { sshConfigHosts } from '../../../src/core/run/setup';
import {
  hostProblems,
  parseHostFacts,
  readFromInput,
  remoteDir,
  remotePaths,
  rq,
  sshHostProblem,
  syncCommand,
  writeFileCommand,
} from '../../../src/core/run/ssh';

type Ssh = Extract<Environment, { kind: 'ssh' }>;
const host: Ssh = { kind: 'ssh', host: 'ops1', dir: '$HOME/.afd/netops', label: 'ssh: ops1' };
const image: Ssh = {
  ...host,
  container: { engine: 'podman', image: 'reg.example.net/ee:2.19', options: ['--network', 'host'] },
};
const paths = { root: 'C:\\repo', probe: 'C:\\ext\\dist\\probe' };
const request = {
  playbook: 'flows/x/generated/x.yml',
  inventory: 'inventory/lab.ini',
  check: true,
  runDir: 'C:\\storage\\runs\\01FLOW\\20261112T140200Z',
  vault: true,
  secrets: true,
  hasConfig: true,
};
/** The script the host runs: the one argument after ssh's own. */
const script = (spec: { command: string; args: string[] }) => {
  expect(spec.command).toBe('ssh');
  expect(spec.args.slice(0, -1)).toEqual([
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    'ops1',
  ]);
  return spec.args.at(-1) as string;
};

describe('quoting for the host', () => {
  it('$HOME expands there; everything else is literal', () => {
    expect(rq('$HOME/.afd/x')).toBe('"$HOME"/.afd/x');
    expect(rq("$HOME/it's $USER")).toBe(`"$HOME"'/it'"'"'s $USER'`);
    expect(rq('/srv/afd')).toBe('/srv/afd');
    expect(rq('a:$HOME/b')).toBe('a:"$HOME"/b');
    expect(rq('$(reboot)')).toBe(`'$(reboot)'`);
  });

  it('a host is a name, never an option', () => {
    expect(sshHostProblem('ops1')).toBeUndefined();
    expect(sshHostProblem('jane@ops1.example.net')).toBeUndefined();
    expect(sshHostProblem('-oProxyCommand=sh')).toMatch(/not a host/);
    expect(sshHostProblem('ops1 -R 1:x:2')).toMatch(/not a host/);
    expect(sshHostProblem('')).toMatch(/sshHost/);
  });

  it('the folder there: under the home unless absolute, never upward', () => {
    expect(remoteDir('', 'Net Ops')).toBe('$HOME/.afd/Net-Ops');
    expect(remoteDir('~/work/afd/', 'x')).toBe('$HOME/work/afd');
    expect(remoteDir('/srv/afd', 'x')).toBe('/srv/afd');
    expect(remoteDir('../etc', 'x')).toEqual({ error: expect.stringContaining('..') });
    expect(remotePaths(host, request.runDir)).toEqual({
      root: '$HOME/.afd/netops/repo',
      probe: '$HOME/.afd/netops/probe',
      cache: '$HOME/.afd/netops/cache',
      files: '$HOME/.afd/netops/files',
      run: '$HOME/.afd/netops/runs/20261112T140200Z',
    });
  });
});

describe('the probe on the host', () => {
  it("ansible on the PATH: the login profile, its Python, the copy's root", () => {
    const s = script(probeProcess(host, paths, 'afd-probe-1'));
    expect(s).toMatch(/^sh -c '/);
    expect(s).toContain('cd "$HOME"/.afd/netops/repo');
    expect(s).toContain('PYTHONPATH="$HOME"/.afd/netops/probe');
    expect(s).toContain('-m afd_probe serve --root "$HOME"/.afd/netops/repo');
    expect(insidePaths(host, paths).root).toBe('$HOME/.afd/netops/repo');
  });

  it('in an image: mounts over the copies, removed by name on stop', () => {
    const spec = probeProcess(image, paths, 'afd-probe-2');
    const s = script(spec);
    expect(s).toContain('exec podman run -i --rm --name afd-probe-2');
    expect(s).toContain('-v "$HOME"/.afd/netops/repo:/work:ro');
    expect(s).toContain('-v "$HOME"/.afd/netops/cache:/afd-cache');
    expect(s).toContain('--network host reg.example.net/ee:2.19 python3 -m afd_probe serve');
    expect(script(spec.stop as never)).toBe(`sh -c 'podman rm -f afd-probe-2'`);
    expect(insidePaths(image, paths)).toMatchObject({ root: '/work', cache: '/afd-cache' });
  });
});

describe('a run on the host', () => {
  it('secrets come on the input, in order, and are in no argument', () => {
    const spec = runProcess(host, paths, request, 'afd-run-1');
    expect(spec.input).toEqual(['AFD_VAULT_PASSWORD', 'AFD_SECRET_VARS']);
    expect(spec.env).toEqual({});
    const s = script(spec);
    expect(s.indexOf('read -r afd_in')).toBeGreaterThan(0);
    expect(s.indexOf('AFD_VAULT_PASSWORD=$(')).toBeLessThan(s.indexOf('AFD_SECRET_VARS=$('));
    expect(s).toContain('base64 -d');
    expect(s).toContain('cd "$HOME"/.afd/netops/repo');
    expect(s).toContain('AFD_EVENTS="$HOME"/.afd/netops/runs/20261112T140200Z/events.jsonl');
    expect(s).toContain('ANSIBLE_CONFIG="$HOME"/.afd/netops/repo/ansible.cfg');
    expect(s).toContain('ansible-playbook -i inventory/lab.ini');
    expect(s).toContain('--check');
    // The run's name is the shell's $0: the stop finds it there, in two halves.
    expect(s.endsWith(` afd-run-1'`)).toBe(true);
    expect(script(spec.stop as never)).toContain('afd-stop afd-r un-1');
  });

  it('without secrets nothing is read from the input', () => {
    const spec = runProcess(host, paths, { ...request, vault: false, secrets: false }, 'r');
    expect(spec.input).toBeUndefined();
    expect(script(spec)).not.toContain('read -r');
  });

  it('in an image: the same script inside, the secrets passed by name only', () => {
    const spec = runProcess(image, paths, request, 'afd-run-2');
    const s = script(spec);
    expect(s).toContain('exec podman run --rm --name afd-run-2');
    expect(s).toContain('-v "$HOME"/.afd/netops/runs/20261112T140200Z:/afd-run');
    expect(s).toContain('-e AFD_VAULT_PASSWORD -e AFD_SECRET_VARS');
    expect(s).toContain('AFD_EVENTS=/afd-run/events.jsonl');
    expect(spec.input).toEqual(['AFD_VAULT_PASSWORD', 'AFD_SECRET_VARS']);
    expect(readFromInput([])).toBe('');
  });
});

describe('files to the host', () => {
  it('the workspace folder is the account’s alone; the copies inside are readable', () => {
    const s = script(syncCommand(host, { into: 'repo', clean: true, fixModes: true }));
    const at = (text: string) => {
      expect(s).toContain(text);
      return s.indexOf(text);
    };
    expect(at('umask 077')).toBeLessThan(at('chmod 700 "$HOME"/.afd/netops'));
    expect(at('chmod 700')).toBeLessThan(at('umask 022'));
    // The first copy mirrors in place: the folder stays (a container may have it mounted), and
    // the files the archive did not bring go.
    expect(s).not.toContain('rm -rf');
    expect(at('tar -xif -')).toBeLessThan(at('comm -z -23 .afd-have .afd-keep'));
    expect(at('xargs -0 chmod a-x')).toBeLessThan(at('xargs -0 chmod u+x'));
    const later = script(syncCommand(host, { into: 'repo', clean: false, fixModes: false }));
    expect(later).not.toContain('comm -z');
    expect(later).not.toContain('chmod a-x');
  });

  it('a file written there is the account’s alone, unless an image must read it', () => {
    const own = script(writeFileCommand(host, '$HOME/.afd/netops/files/vault_pass'));
    expect(own).toContain('umask 077');
    expect(own).not.toContain('chmod 777');
    const open = script(writeFileCommand(host, '$HOME/.afd/netops/runs/r/vars.json', true));
    expect(open).toContain('chmod 777 "$HOME"/.afd/netops/runs/r');
    expect(open).toContain('chmod 644 "$HOME"/.afd/netops/runs/r/vars.json');
  });
});

describe('what the host has', () => {
  it('reads the facts and says what is missing for each way to run', () => {
    const facts = parseHostFacts(
      'home=/home/jane\nuser=jane\nansible=\npython=/usr/bin/python3\ndocker=/usr/bin/docker\npodman=\ntar=/usr/bin/tar\nbase64=/usr/bin/base64\n',
    );
    expect(facts).toMatchObject({ home: '/home/jane', docker: '/usr/bin/docker' });
    expect(facts.ansible).toBeUndefined();
    expect(hostProblems(facts, true, 'docker')).toEqual([]);
    expect(hostProblems(facts, true, 'podman')).toEqual(['podman is not installed there']);
    expect(hostProblems(facts, false)[0]).toMatch(/ansible-playbook is not on the PATH/);
  });

  it('the hosts of an SSH config, without patterns', () => {
    const config = 'Host gns3 lab-*\n  HostName 192.0.2.10\n\nhost ops1\nHost *\n  User jane\n';
    expect(sshConfigHosts(config)).toEqual(['gns3', 'ops1']);
  });
});

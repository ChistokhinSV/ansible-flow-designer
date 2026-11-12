// AFD-247 against a real host. Skipped unless AFD_SSH_HOST names one (an alias of your SSH config):
//   AFD_SSH_HOST=gns3 AFD_SSH_IMAGE=afd-ee:2.19 npx vitest run test/unit/core/sshLab.test.ts
// With AFD_SSH_IMAGE the probe and a run go through that image on the host (Docker); without it
// they use the ansible-playbook on the account's PATH.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { probeProcess, runProcess } from '../../../src/core/run/command';
import { type Environment, resolveEnvironment } from '../../../src/core/run/environment';
import { onHost, removeCommand } from '../../../src/core/run/ssh';
import { ProbeClient } from '../../../src/node/env/probeClient';
import { run } from '../../../src/node/ssh/exec';
import {
  followRunFile,
  hostFacts,
  putRunFile,
  removeRunDir,
  type SshEnv,
  syncWorkspace,
} from '../../../src/node/ssh/remote';
import { forgetSynced, syncFolder } from '../../../src/node/ssh/sync';

const HOST = process.env.AFD_SSH_HOST ?? '';
const IMAGE = process.env.AFD_SSH_IMAGE ?? '';
const PROBE = join(__dirname, '../../../probe');

function envFor(dir: string): SshEnv {
  const r = resolveEnvironment(
    {
      kind: 'ssh',
      containerEngine: 'auto',
      image: IMAGE,
      containerOptions: [],
      python: '',
      wslDistro: '',
      sshHost: HOST,
      sshDir: dir,
    },
    {},
    process.platform,
    'lab',
  );
  if (!r.ok || r.env.kind !== 'ssh') throw new Error('no ssh environment');
  return r.env;
}

/** Runs a process spec to its end, its secrets written to its input as afd-ssh-run does. */
function exec(spec: ReturnType<typeof runProcess>, values: Record<string, string> = {}) {
  return new Promise<{ code: number | null; out: string }>((resolve) => {
    const p = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    p.stdout.on('data', (d) => {
      out += d;
    });
    p.stderr.on('data', (d) => {
      out += d;
    });
    for (const name of spec.input ?? [])
      p.stdin.write(`${Buffer.from(values[name] ?? '', 'utf8').toString('base64')}\n`);
    p.stdin.end();
    p.on('close', (code) => resolve({ code, out }));
  });
}

describe.skipIf(!HOST)(`an SSH host as the environment (${HOST || 'no host'})`, () => {
  const dir = `.afd/test-${process.pid}`;
  let root: string;
  let env: SshEnv;
  const remote = async (script: string) => (await run(onHost(HOST, script))).stdout.trim();

  beforeAll(() => {
    env = envFor(dir);
    root = mkdtempSync(join(tmpdir(), 'afd-ssh-repo-'));
    mkdirSync(join(root, 'roles/demo/tasks'), { recursive: true });
    writeFileSync(join(root, 'inventory.ini'), '[lab]\nlocalhost ansible_connection=local\n');
    writeFileSync(join(root, "it's odd $name.txt"), 'a name the shell must not read\n');
    writeFileSync(join(root, 'roles/demo/tasks/main.yml'), '- ansible.builtin.ping:\n');
    writeFileSync(
      join(root, 'play.yml'),
      [
        '- hosts: all',
        '  gather_facts: false',
        '  tasks:',
        '    - ansible.builtin.debug:',
        '        msg: "greeting={{ greeting }} secret_len={{ api_token | length }}"',
        '    - ansible.builtin.copy:',
        "        content: \"{{ lookup('ansible.builtin.file', 'vaulted.txt') }}\"",
        '        dest: /tmp/afd-ssh-test-out',
        '      check_mode: false',
        '',
      ].join('\n'),
    );
    writeFileSync(join(root, 'vaulted.txt'), 'plain for now\n');
    forgetSynced();
  });

  afterAll(async () => {
    if (root) rmSync(root, { recursive: true, force: true });
    if (env) await run(removeCommand(env, env.dir));
  });

  it('says what the host has', async () => {
    const { facts, error } = await hostFacts(HOST);
    expect(error).toBeUndefined();
    expect(facts?.home).toMatch(/^\//);
    expect(facts?.tar).toBeTruthy();
    expect(facts?.base64).toBeTruthy();
  });

  it('copies the folder, then only what changed, and deletes what is gone', async () => {
    const first = await syncFolder(env, root, 'repo');
    expect(first).toMatchObject({ ok: true, removed: 0 });
    expect(first.sent).toBe(5);
    expect(await remote(`cd "$HOME/${dir}/repo" && find . -type f | sort`)).toBe(
      [
        './inventory.ini',
        "./it's odd $name.txt",
        './play.yml',
        './roles/demo/tasks/main.yml',
        './vaulted.txt',
      ].join('\n'),
    );
    // Nothing changed: nothing is run.
    expect(await syncFolder(env, root, 'repo')).toEqual({ ok: true, sent: 0, removed: 0 });
    writeFileSync(
      join(root, 'inventory.ini'),
      '[lab]\nlocalhost ansible_connection=local\n# changed\n',
    );
    rmSync(join(root, "it's odd $name.txt"));
    writeFileSync(join(root, 'new.txt'), 'new\n');
    expect(await syncFolder(env, root, 'repo')).toEqual({ ok: true, sent: 2, removed: 1 });
    expect(await remote(`cd "$HOME/${dir}/repo" && ls && tail -1 inventory.ini`)).toBe(
      ['inventory.ini', 'new.txt', 'play.yml', 'roles', 'vaulted.txt', '# changed'].join('\n'),
    );
    // The folder is the account's alone, and no data file became executable.
    expect(await remote(`stat -c %a "$HOME/${dir}" "$HOME/${dir}/repo/inventory.ini"`)).toMatch(
      /^700\n6[04][04]$/,
    );
  });

  it('runs the probe there and maps its root', async () => {
    expect(await syncWorkspace(env, { root, probe: PROBE })).toBeUndefined();
    const spec = probeProcess(env, { root, probe: PROBE }, `afd-probe-test-${process.pid}`);
    const client = new ProbeClient(spec, root, undefined);
    try {
      const ready = await client.start();
      expect(ready.kind).toBe('ready');
      expect(ready.ansible_core).toMatch(/^2\./);
      expect(ready.root).toMatch(IMAGE ? /^\/work$/ : new RegExp(`/${dir}/repo$`));
    } finally {
      client.dispose();
    }
  }, 120_000);

  it('runs a playbook with inputs, a secret and a vault password, and brings the events back', async () => {
    const runDir = join(root, '..', `afd-ssh-run-${process.pid}`);
    mkdirSync(runDir, { recursive: true });
    try {
      expect(await syncWorkspace(env, { root, probe: PROBE })).toBeUndefined();
      expect(
        await putRunFile(env, runDir, 'vars.json', '{"greeting": "hello from here"}'),
      ).toBeUndefined();
      const local = join(runDir, 'events.jsonl');
      const follow = followRunFile(env, runDir, 'events.jsonl', local);
      const spec = runProcess(
        env,
        { root, probe: PROBE },
        {
          playbook: 'play.yml',
          inventory: 'inventory.ini',
          check: true,
          runDir,
          vault: true,
          secrets: true,
          hasConfig: false,
        },
        `afd-run-test-${process.pid}`,
      );
      expect(spec.input).toEqual(['AFD_VAULT_PASSWORD', 'AFD_SECRET_VARS']);
      const secret = `p'a"ss $HOME \\n word`;
      const r = await exec(spec, {
        AFD_VAULT_PASSWORD: secret,
        AFD_SECRET_VARS: JSON.stringify({ api_token: 'abcde' }),
      });
      await follow.stop();
      expect(r.out).toContain('greeting=hello from here secret_len=5');
      expect(r.code).toBe(0);
      // The secrets were never arguments: neither value is in the command line.
      expect(spec.args.join(' ')).not.toContain('abcde');
      const events = readFileSync(local, 'utf8').trim().split('\n');
      expect(events.length).toBeGreaterThan(2);
      expect(() => events.map((l) => JSON.parse(l))).not.toThrow();
      await removeRunDir(env, runDir);
      expect(await remote(`ls "$HOME/${dir}/runs" | wc -l`)).toBe('0');
    } finally {
      rmSync(runDir, { recursive: true, force: true });
    }
  }, 180_000);
});

describe('the environment an SSH run resolves to', () => {
  const afd = {
    kind: 'ssh' as const,
    containerEngine: 'auto' as const,
    image: '',
    containerOptions: [],
    python: '',
    wslDistro: '',
  };

  it('needs a host ssh can take as a destination', () => {
    expect(resolveEnvironment(afd, {}, 'win32')).toMatchObject({ ok: false, code: 'no-ssh-host' });
    expect(resolveEnvironment({ ...afd, sshHost: '-oProxyCommand=x' }, {}, 'linux')).toMatchObject({
      ok: false,
      code: 'no-ssh-host',
    });
  });

  it('a folder under the home by default, named after the workspace; an image means a container', () => {
    const host = resolveEnvironment({ ...afd, sshHost: 'ops1' }, {}, 'win32', 'Net Ops!') as {
      env: Environment;
    };
    expect(host.env).toEqual({
      kind: 'ssh',
      host: 'ops1',
      dir: '$HOME/.afd/Net-Ops',
      python: undefined,
      label: 'ssh: ops1 (ansible on its PATH)',
    });
    const image = resolveEnvironment(
      { ...afd, sshHost: 'jane@ops1', sshDir: '/srv/afd/shared', image: 'reg.example.net/ee:2.19' },
      {},
      'linux',
    ) as { env: Environment };
    expect(image.env).toMatchObject({
      dir: '/srv/afd/shared',
      container: { engine: 'docker', image: 'reg.example.net/ee:2.19' },
      label: 'ssh: jane@ops1 (docker: reg.example.net/ee:2.19)',
    });
    expect(
      resolveEnvironment({ ...afd, sshHost: 'ops1', sshDir: '../x' }, {}, 'linux'),
    ).toMatchObject({
      ok: false,
    });
  });
});

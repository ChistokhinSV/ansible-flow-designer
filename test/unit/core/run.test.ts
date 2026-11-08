// Environment resolution, run command lines and the run-event summary (AFD-4 acceptance 5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import { probeProcess, runProcess, shQuote, splitInputs } from '../../../src/core/run/command';
import {
  type AfdEnvSettings,
  resolveEnvironment,
  splitOptions,
} from '../../../src/core/run/environment';
import { summarizeRun } from '../../../src/core/run/events';
import {
  DEV_TOOLS_IMAGE,
  environmentChoices,
  type MachineFindings,
} from '../../../src/core/run/setup';

const afd = (over: Partial<AfdEnvSettings> = {}): AfdEnvSettings => ({
  kind: 'auto',
  containerEngine: 'auto',
  image: '',
  containerOptions: [],
  python: '',
  wslDistro: '',
  ...over,
});

describe('environment', () => {
  it('prefers our image, then the redhat.ansible EE, then a local interpreter', () => {
    const redhat = {
      eeEnabled: true,
      image: 'quay.example.net/ee:2.19',
      containerEngine: 'podman',
      containerOptions: '--network host -e "X=a b"',
      volumeMounts: [{ src: '/srv/keys', dest: '/keys', options: 'ro' }],
    };
    const ours = resolveEnvironment(afd({ image: 'afd-ee:2.19' }), redhat, 'win32');
    expect(ours).toMatchObject({
      ok: true,
      env: {
        kind: 'container',
        image: 'afd-ee:2.19',
        engine: 'podman',
        options: [],
        mounts: [],
        source: 'afd',
      },
    });
    const theirs = resolveEnvironment(afd(), redhat, 'win32');
    expect(theirs).toMatchObject({
      ok: true,
      env: {
        image: 'quay.example.net/ee:2.19',
        options: ['--network', 'host', '-e', 'X=a b'],
        source: 'redhat.ansible',
      },
    });
    expect(theirs.ok && theirs.env.kind === 'container' && theirs.env.mounts).toHaveLength(1);
    expect(
      resolveEnvironment(afd(), { interpreterPath: '/opt/venv/bin/python' }, 'linux'),
    ).toMatchObject({
      ok: true,
      env: { kind: 'local', python: '/opt/venv/bin/python', source: 'redhat.ansible' },
    });
    expect(resolveEnvironment(afd(), {}, 'linux')).toMatchObject({
      ok: true,
      env: { python: 'python3', source: 'default' },
    });
  });

  it('refuses native Windows and a container without an image, saying which (AFD-71)', () => {
    expect(resolveEnvironment(afd(), {}, 'win32')).toMatchObject({
      ok: false,
      code: 'windows-native',
      error: expect.stringMatching(/^Runs need an Ansible environment/),
    });
    expect(resolveEnvironment(afd({ kind: 'container' }), {}, 'linux')).toMatchObject({
      ok: false,
      code: 'no-image',
    });
    expect(splitOptions(undefined)).toEqual([]);
  });
});

describe('Set Up Ansible Environment… (AFD-71)', () => {
  const kinds = (m: Partial<MachineFindings>) =>
    environmentChoices({
      platform: 'win32',
      docker: false,
      podman: false,
      remoteWsl: false,
      ...m,
    }).map((c) => (c.kind === 'container' ? c.engine : c.kind));
  it.each([
    ['Docker found', { docker: true }, ['docker', 'read']],
    ['both engines', { docker: true, podman: true }, ['docker', 'podman', 'read']],
    ['WSL extension on Windows', { remoteWsl: true }, ['wsl', 'read']],
    ['WSL is no choice off Windows', { platform: 'linux', remoteWsl: true }, ['install', 'read']],
    ['nothing yet', {}, ['install', 'read']],
  ])('%s', (_, m, want) => {
    expect(kinds(m)).toEqual(want);
  });

  it('proposes the public dev tools image, the last release', () => {
    expect(DEV_TOOLS_IMAGE).toBe('ghcr.io/ansible/community-ansible-dev-tools:latest');
  });
});

describe('command lines', () => {
  const container = resolveEnvironment(
    afd({ image: 'afd-ee:2.19', containerOptions: ['--network', 'host'] }),
    {},
    'win32',
  );
  const env = container.ok ? container.env : (undefined as never);
  const paths = { root: 'C:\\repo', probe: 'C:\\ext\\dist\\probe' };

  it('probe: read-only repo and probe mounts, stdin kept open', () => {
    const spec = probeProcess(env, paths, 'afd-probe-1');
    expect(spec.command).toBe('docker');
    expect(spec.args.slice(0, 3)).toEqual(['run', '-i', '--rm']);
    expect(spec.args).toContain('C:\\repo:/work:ro');
    expect(spec.args.slice(-9)).toEqual([
      '--network',
      'host',
      'afd-ee:2.19',
      'python3',
      '-m',
      'afd_probe',
      'serve',
      '--root',
      '/work',
    ]);
  });

  it('run: check mode, events callback, vault through an env var only', () => {
    const spec = runProcess(
      env,
      paths,
      {
        playbook: 'flows/x/generated/x.yml',
        inventory: 'inventories/lab',
        check: true,
        runDir: 'C:\\runs\\1',
        vault: true,
        hasConfig: true,
      },
      'afd-run-1',
    );
    expect(spec.args).toContain('C:\\runs\\1:/afd-run');
    expect(spec.args).toContain('AFD_EVENTS=/afd-run/events.jsonl');
    expect(spec.args).toContain('ANSIBLE_CONFIG=/work/ansible.cfg');
    expect(spec.args).toContain('AFD_VAULT_PASSWORD');
    expect(spec.args.join(' ')).not.toMatch(/AFD_VAULT_PASSWORD=/);
    const script = spec.args.at(-1) ?? '';
    expect(script).toContain(
      'ansible-playbook -i inventories/lab -e @/afd-run/vars.json --check --vault-password-file "$vp" flows/x/generated/x.yml',
    );
    // AFD-138: the password goes into an owner-only file the vault script cats; the variable goes.
    expect(script).toContain('unset AFD_VAULT_PASSWORD');
    expect(script).toContain(`printf '#!/bin/sh\\ncat "%s"\\n' "$pw" > "$vp"`);
    expect(script).not.toContain('echo "$AFD_VAULT_PASSWORD"');
    expect(script.startsWith(`trap 'rm -f "$pw" "$vp"' EXIT;`)).toBe(true);
    const local = resolveEnvironment(afd(), {}, 'linux');
    const plain = runProcess(
      local.ok ? local.env : (undefined as never),
      { root: '/repo', probe: '/ext/probe' },
      { playbook: 'g/x.yml', check: false, runDir: '/tmp/r', vault: false, hasConfig: false },
      'n',
    );
    expect(plain).toMatchObject({
      command: 'sh',
      args: ['-c', 'ansible-playbook -e @/tmp/r/vars.json g/x.yml'],
      cwd: '/repo',
    });
    expect(plain.env.ANSIBLE_CALLBACK_PLUGINS).toBe('/ext/probe/callback_plugins');
    // AFD-29: secret inputs never reach vars.json; a temporary file inside the run holds them.
    const secret = runProcess(
      env,
      paths,
      {
        playbook: 'g/x.yml',
        check: false,
        runDir: 'C:\\runs\\2',
        vault: true,
        secrets: true,
        hasConfig: false,
      },
      'afd-run-2',
    );
    expect(secret.args).toContain('AFD_SECRET_VARS');
    expect(secret.args.join(' ')).not.toMatch(/AFD_SECRET_VARS=/);
    const both = secret.args.at(-1) ?? '';
    expect(both).toContain(`sv=$(mktemp) && printf '%s' "$AFD_SECRET_VARS" > "$sv"`);
    expect(both).toContain('-e @/afd-run/vars.json -e @"$sv" --vault-password-file "$vp" g/x.yml');
    // AFD-138: every exit removes the files, a stop included; the variables are gone after use.
    expect(both).toContain(
      `trap 'rm -f "$pw" "$vp" "$sv"' EXIT; trap 'exit 129' HUP; trap 'exit 130' INT; trap 'exit 143' TERM;`,
    );
    expect(both).toContain('unset AFD_SECRET_VARS && export AFD_SECRETS_FILE="$sv"');
    expect(both).toContain('export AFD_VAULT_FILE="$pw"');
    // AFD-141: the repository's callbacks and plugin folders stay, ours is added.
    const kept = runProcess(
      local.ok ? local.env : (undefined as never),
      { root: '/repo', probe: '/ext/probe' },
      {
        playbook: 'g/x.yml',
        check: false,
        runDir: '/tmp/r',
        vault: false,
        hasConfig: true,
        callbacks: {
          enabled: ['ara_default', 'profile_tasks', 'afd_events', 'bad name'],
          paths: ['/repo/callback_plugins', '/usr/share/ansible/plugins/callback', 'a:b'],
        },
      },
      'n',
    );
    expect(kept.env.ANSIBLE_CALLBACKS_ENABLED).toBe('ara_default,profile_tasks,afd_events');
    expect(kept.env.ANSIBLE_CALLBACK_PLUGINS).toBe(
      '/repo/callback_plugins:/usr/share/ansible/plugins/callback:/ext/probe/callback_plugins',
    );
    expect(splitInputs({ devices: ['a'], enable_secret: 'x', api_key: 'k', count: 2 })).toEqual({
      plain: { devices: ['a'], count: 2 },
      secret: { enable_secret: 'x', api_key: 'k' },
    });
    expect(shQuote("it's")).toBe(`'it'"'"'s'`);
  });
});

describe('run summary', () => {
  it('maps a recorded run back to nodes and ports', () => {
    const dir = join(__dirname, '../../fixtures/engine');
    const doc = parse(readFileSync(join(dir, 'routing-ports.flow.yaml'), 'utf8')) as FlowDocument;
    const { routes } = optionA.generate(doc, { source: 'routing-ports.flow.yaml' });
    const summary = summarizeRun(
      readFileSync(join(dir, 'routing-ports.events.jsonl'), 'utf8'),
      routes,
    );
    const id = (key: string) => doc.nodes.find((n) => n.key === key)?.id ?? '';
    expect(summary.nodes[id('probe')]).toEqual({
      unchanged: ['h01', 'h02', 'h03', 'h04', 'h05', 'h06'],
      unreachable: ['h07'],
    });
    expect(summary.nodes[id('work')]?.timeout).toEqual(['h06']);
    expect(summary.nodes[id('join')]).toEqual({ ok_hosts: ['h01'], failed_hosts: ['h03'] });
    expect(summary.outcome).toEqual({
      h03: 'Ended at [stopped] Stopped (outcome: failed)',
      h04: 'Ended at [stopped] Stopped (outcome: failed)',
      h05: 'Ended at [failed] Failed (outcome: failed)',
      h06: 'Stopped at [work] Work: timeout is not wired',
      h07: 'Ended at [stopped] Stopped (outcome: failed)',
    });
    expect(summary.failures).toEqual([]);
    expect(summary.unreachable).toEqual([]);
    expect(summary.stoppedEarly).toBe(false);
    expect(summary.hosts).toHaveLength(7);
  });
});

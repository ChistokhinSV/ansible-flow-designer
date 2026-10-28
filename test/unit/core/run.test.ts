// Environment resolution, run command lines and the run-event summary (AFD-4 acceptance 5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { optionA } from '../../../src/core/engine/optionA';
import type { FlowDocument } from '../../../src/core/flow/types';
import { probeProcess, runProcess, shQuote } from '../../../src/core/run/command';
import {
  type AfdEnvSettings,
  resolveEnvironment,
  splitOptions,
} from '../../../src/core/run/environment';
import { summarizeRun } from '../../../src/core/run/events';

const afd = (over: Partial<AfdEnvSettings> = {}): AfdEnvSettings => ({
  kind: 'auto',
  containerEngine: 'auto',
  image: '',
  containerOptions: [],
  python: '',
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

  it('refuses native Windows and a container without an image', () => {
    expect(resolveEnvironment(afd(), {}, 'win32').ok).toBe(false);
    expect(resolveEnvironment(afd({ kind: 'container' }), {}, 'linux').ok).toBe(false);
    expect(splitOptions(undefined)).toEqual([]);
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
    expect(script).toContain('rm -f "$vp"');
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

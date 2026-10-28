// Command lines for the probe session and for flow runs in an environment (ADR-0005, ADR-0009).
// Pure: the host supplies paths; container paths are fixed so generated code and events map back.
import type { Environment } from './environment';

export const CONTAINER = {
  root: '/work',
  probe: '/afd',
  run: '/afd-run',
} as const;

export interface ProcessSpec {
  command: string;
  args: string[];
  /** Extra environment for the spawned process (values never appear in args). */
  env: Record<string, string>;
  cwd?: string;
}

export interface Paths {
  /** Repository root on this machine. */
  root: string;
  /** Folder with afd_probe/ and callback_plugins/. */
  probe: string;
}

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;

/** Shell-quotes one word for `sh -c`. */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

function containerBase(
  env: Extract<Environment, { kind: 'container' }>,
  paths: Paths,
  name: string,
) {
  const args = ['run', '--rm', '--name', name, '-v', `${paths.root}:${CONTAINER.root}:ro`];
  args.push('-v', `${paths.probe}:${CONTAINER.probe}:ro`, '-w', CONTAINER.root);
  for (const m of env.mounts)
    args.push('-v', `${m.src}:${m.dest}${m.options ? `:${m.options}` : ''}`);
  return args;
}

export function probeProcess(env: Environment, paths: Paths, name: string): ProcessSpec {
  const tail = ['-m', 'afd_probe', 'serve', '--root'];
  if (env.kind === 'container') {
    const args = containerBase(env, paths, name);
    args.splice(1, 0, '-i');
    args.push('-e', `PYTHONPATH=${CONTAINER.probe}`, '-e', 'PYTHONDONTWRITEBYTECODE=1');
    args.push(...env.options, env.image, 'python3', ...tail, CONTAINER.root);
    return { command: env.engine, args, env: {} };
  }
  return {
    command: env.python,
    args: [...tail, paths.root],
    env: { PYTHONPATH: paths.probe, PYTHONDONTWRITEBYTECODE: '1' },
    cwd: paths.root,
  };
}

export interface RunRequest {
  /** Root playbook, relative to the repository root (forward slashes). */
  playbook: string;
  /** Inventory relative to the repository root; empty = ansible.cfg default. */
  inventory?: string;
  check: boolean;
  /** Folder for vars.json and events.jsonl on this machine. */
  runDir: string;
  /** Ask Ansible for the vault password through AFD_VAULT_PASSWORD (set by the caller). */
  vault: boolean;
  /** Use <root>/ansible.cfg explicitly (Docker Desktop mounts are world-writable). */
  hasConfig: boolean;
}

/** Environment variables every run gets: our event callback and quiet routing groups. */
function runEnv(probeDir: string, runDir: string, root: string, hasConfig: boolean) {
  const env: Record<string, string> = {
    ANSIBLE_CALLBACK_PLUGINS: join(probeDir, 'callback_plugins'),
    ANSIBLE_CALLBACKS_ENABLED: 'afd_events',
    AFD_EVENTS: join(runDir, 'events.jsonl'),
    ANSIBLE_HOST_PATTERN_MISMATCH: 'ignore',
    ANSIBLE_FORCE_COLOR: '1',
  };
  if (hasConfig) env.ANSIBLE_CONFIG = join(root, 'ansible.cfg');
  return env;
}

/**
 * `ansible-playbook` for a run. With a vault, a tiny script that echoes $AFD_VAULT_PASSWORD is
 * written inside the run's shell; the password itself only ever travels in that variable.
 */
export function runProcess(
  env: Environment,
  paths: Paths,
  request: RunRequest,
  name: string,
): ProcessSpec {
  const inContainer = env.kind === 'container';
  const root = inContainer ? CONTAINER.root : paths.root;
  const runDir = inContainer ? CONTAINER.run : request.runDir;
  const probeDir = inContainer ? CONTAINER.probe : paths.probe;
  const words = ['ansible-playbook'];
  if (request.inventory) words.push('-i', request.inventory);
  words.push('-e', `@${join(runDir, 'vars.json')}`);
  if (request.check) words.push('--check');
  if (request.vault) words.push('--vault-password-file', '"$vp"');
  words.push(request.playbook);
  const line = words.map((w) => (w === '"$vp"' ? w : shQuote(w))).join(' ');
  const script = request.vault
    ? `vp=$(mktemp) && printf '#!/bin/sh\\necho "$AFD_VAULT_PASSWORD"\\n' > "$vp" && chmod 700 "$vp" && ${line}; rc=$?; rm -f "$vp"; exit $rc`
    : line;
  const variables = runEnv(probeDir, runDir, root, request.hasConfig);
  if (inContainer) {
    const args = containerBase(env, paths, name);
    args.push('-v', `${request.runDir}:${CONTAINER.run}`);
    for (const [k, v] of Object.entries(variables)) args.push('-e', `${k}=${v}`);
    if (request.vault) args.push('-e', 'AFD_VAULT_PASSWORD');
    args.push(...env.options, env.image, 'sh', '-c', script);
    return { command: env.engine, args, env: {} };
  }
  return { command: 'sh', args: ['-c', script], env: variables, cwd: paths.root };
}

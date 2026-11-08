// Command lines for the probe session and for flow runs in an environment (ADR-0005, ADR-0009).
// Pure: the host supplies paths; container paths are fixed so generated code and events map back,
// and a WSL distribution sees this machine's drives under /mnt (AFD-75).
import { SECRET } from '../import/secrets';
import type { Environment } from './environment';

export const CONTAINER = {
  root: '/work',
  probe: '/afd',
  run: '/afd-run',
  /** The catalog cache in global storage, read-write (M5). */
  cache: '/afd-cache',
} as const;

export interface ProcessSpec {
  command: string;
  args: string[];
  /** Extra environment for the spawned process (values never appear in args). */
  env: Record<string, string>;
  cwd?: string;
  /**
   * AFD-131: what ends the work this process started beyond itself. Killing the docker or podman
   * client leaves its container running (the shell inside is PID 1 and ignores SIGTERM), so a
   * stopped run, a timed-out scenario or a hung probe call also removes the container by name.
   */
  stop?: { command: string; args: string[] };
}

const containerStop = (env: Extract<Environment, { kind: 'container' }>, name: string) => ({
  command: env.engine,
  args: ['rm', '-f', name],
});

export interface Paths {
  /** Repository root on this machine. */
  root: string;
  /** Folder with afd_probe/ and callback_plugins/. */
  probe: string;
  /** Catalog cache folder; the probe writes collection dumps there (M5). */
  cache?: string;
}

const join = (a: string, b: string) => `${a.replace(/[\\/]+$/, '')}/${b}`;

/**
 * A Windows path as WSL sees it (AFD-75): `C:\x` is `/mnt/c/x`, and a path inside a distribution
 * (`\\wsl$\Ubuntu\home`, `\\wsl.localhost\Ubuntu\home`) is `/home`. Anything else stays as it is.
 */
export function wslPath(path: string): string {
  const p = path.replaceAll('\\', '/');
  const drive = /^([A-Za-z]):(\/.*)?$/.exec(p);
  if (drive) return `/mnt/${drive[1]?.toLowerCase()}${(drive[2] ?? '').replace(/\/+$/, '')}`;
  const inside = /^\/\/(?:wsl\$|wsl\.localhost)\/[^/]+(\/.*)?$/i.exec(p);
  if (inside) return inside[1] ?? '/';
  return p;
}

/** The repository, probe, run and cache folders as the environment sees them. */
export function insidePaths(
  env: Environment,
  paths: { root: string; probe: string; run?: string; cache?: string },
): { root: string; probe: string; run?: string; cache?: string } {
  if (env.kind === 'container')
    return {
      root: CONTAINER.root,
      probe: CONTAINER.probe,
      run: CONTAINER.run,
      cache: CONTAINER.cache,
    };
  if (env.kind === 'wsl')
    return {
      root: wslPath(paths.root),
      probe: wslPath(paths.probe),
      run: paths.run && wslPath(paths.run),
      cache: paths.cache && wslPath(paths.cache),
    };
  return paths;
}

/**
 * `wsl.exe` up to the command it runs: the distribution, the folder to start in, and `-e`, which
 * passes the words as they are (after `--` the default shell parses them again, so `$x` in our
 * scripts would expand too early).
 */
function wslArgs(env: Extract<Environment, { kind: 'wsl' }>, cwd: string): string[] {
  return [...(env.distro ? ['-d', env.distro] : []), '--cd', cwd, '-e'];
}

/**
 * The login PATH (pipx puts ansible in ~/.local/bin) without a login shell's output, which would
 * garble the probe's protocol on stdout.
 */
const WSL_PROFILE =
  'for f in /etc/profile "$HOME/.profile"; do [ -r "$f" ] && . "$f"; done >/dev/null 2>&1';

/**
 * `$p`: the interpreter on ansible-playbook's #! line, else python3. Used unquoted, so a line like
 * `/usr/bin/env python3` stays two words.
 */
const WSL_ANSIBLE_PYTHON = `p=$(sed -n '1s/^#! *//p' "$(command -v ansible-playbook)" 2>/dev/null); [ -n "$p" ] || p=python3`;

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
    if (paths.cache) args.push('-v', `${paths.cache}:${CONTAINER.cache}`);
    args.push('-e', `PYTHONPATH=${CONTAINER.probe}`, '-e', 'PYTHONDONTWRITEBYTECODE=1');
    args.push(...env.options, env.image, 'python3', ...tail, CONTAINER.root);
    return { command: env.engine, args, env: {}, stop: containerStop(env, name) };
  }
  if (env.kind === 'wsl') {
    // The variables are set inside the distribution; WSLENV is only for values from Windows.
    const inside = insidePaths(env, paths);
    const python = env.python ? shQuote(env.python) : '$p';
    const vars = `PYTHONPATH=${shQuote(inside.probe)} PYTHONDONTWRITEBYTECODE=1`;
    const serve = `exec env ${vars} ${python} ${[...tail, inside.root].map(shQuote).join(' ')}`;
    const script = [WSL_PROFILE, ...(env.python ? [] : [WSL_ANSIBLE_PYTHON]), serve].join('; ');
    return {
      command: 'wsl.exe',
      args: [...wslArgs(env, inside.root), 'sh', '-c', script],
      env: {},
    };
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
  /** Secret inputs travel as JSON in AFD_SECRET_VARS (set by the caller), never in vars.json. */
  secrets?: boolean;
  /** Use <root>/ansible.cfg explicitly (Docker Desktop mounts are world-writable). */
  hasConfig: boolean;
  /**
   * AFD-126: use the empty ansible.cfg the caller wrote in the run folder, so no repository, user
   * or system config applies. Ansible reads ./ansible.cfg from the working directory (the
   * repository) when ANSIBLE_CONFIG names no existing file, and its plugin paths are code.
   */
  emptyConfig?: boolean;
}

/** Run inputs split by name, with the import's rule: secret-looking ones never reach vars.json. */
export function splitInputs(inputs: Record<string, unknown>): {
  plain: Record<string, unknown>;
  secret: Record<string, unknown>;
} {
  const plain: Record<string, unknown> = {};
  const secret: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) (SECRET.test(k) ? secret : plain)[k] = v;
  return { plain, secret };
}

/** Environment variables every run gets: our event callback and quiet routing groups. */
function runEnv(
  probeDir: string,
  runDir: string,
  root: string,
  config: { hasConfig: boolean; emptyConfig?: boolean },
) {
  const env: Record<string, string> = {
    ANSIBLE_CALLBACK_PLUGINS: join(probeDir, 'callback_plugins'),
    ANSIBLE_CALLBACKS_ENABLED: 'afd_events',
    AFD_EVENTS: join(runDir, 'events.jsonl'),
    ANSIBLE_HOST_PATTERN_MISMATCH: 'ignore',
    ANSIBLE_FORCE_COLOR: '1',
  };
  if (config.emptyConfig) env.ANSIBLE_CONFIG = join(runDir, 'ansible.cfg');
  else if (config.hasConfig) env.ANSIBLE_CONFIG = join(root, 'ansible.cfg');
  return env;
}

/**
 * `ansible-playbook` for a run. With a vault, a tiny script that echoes $AFD_VAULT_PASSWORD is
 * written inside the run's shell; the password itself only ever travels in that variable. Secret
 * inputs do the same through $AFD_SECRET_VARS: a temporary extra-vars file that lives as long as
 * the run, inside the environment (AFD-29).
 */
export function runProcess(
  env: Environment,
  paths: Paths,
  request: RunRequest,
  name: string,
): ProcessSpec {
  const inContainer = env.kind === 'container';
  const inside = insidePaths(env, { ...paths, run: request.runDir });
  const root = inside.root;
  const runDir = inside.run ?? request.runDir;
  const probeDir = inside.probe;
  const words = ['ansible-playbook'];
  if (request.inventory) words.push('-i', request.inventory);
  words.push('-e', `@${join(runDir, 'vars.json')}`);
  if (request.secrets) words.push('-e', '@"$sv"');
  if (request.check) words.push('--check');
  if (request.vault) words.push('--vault-password-file', '"$vp"');
  words.push(request.playbook);
  const raw = new Set(['"$vp"', '@"$sv"']);
  const line = words.map((w) => (raw.has(w) ? w : shQuote(w))).join(' ');
  const setup: string[] = [];
  const temps: string[] = [];
  if (request.vault) {
    setup.push(
      `vp=$(mktemp) && printf '#!/bin/sh\\necho "$AFD_VAULT_PASSWORD"\\n' > "$vp" && chmod 700 "$vp"`,
    );
    temps.push('"$vp"');
  }
  if (request.secrets) {
    setup.push(`sv=$(mktemp) && printf '%s' "$AFD_SECRET_VARS" > "$sv"`);
    temps.push('"$sv"');
  }
  const script = setup.length
    ? `${setup.join(' && ')} && ${line}; rc=$?; rm -f ${temps.join(' ')}; exit $rc`
    : line;
  const variables = runEnv(probeDir, runDir, root, request);
  if (inContainer) {
    const args = containerBase(env, paths, name);
    args.push('-v', `${request.runDir}:${CONTAINER.run}`);
    for (const [k, v] of Object.entries(variables)) args.push('-e', `${k}=${v}`);
    if (request.vault) args.push('-e', 'AFD_VAULT_PASSWORD');
    if (request.secrets) args.push('-e', 'AFD_SECRET_VARS');
    args.push(...env.options, env.image, 'sh', '-c', script);
    return { command: env.engine, args, env: {}, stop: containerStop(env, name) };
  }
  if (env.kind === 'wsl') {
    // The secrets come from Windows in variables only: WSLENV passes just those names (AFD-29).
    const pass = [
      ...(request.vault ? ['AFD_VAULT_PASSWORD/u'] : []),
      ...(request.secrets ? ['AFD_SECRET_VARS/u'] : []),
    ];
    const vars = Object.entries(variables).map(([k, v]) => `${k}=${v}`);
    return {
      command: 'wsl.exe',
      args: [...wslArgs(env, root), 'env', ...vars, 'sh', '-c', `${WSL_PROFILE}; ${script}`],
      env: pass.length ? { WSLENV: pass.join(':') } : {},
    };
  }
  return { command: 'sh', args: ['-c', script], env: variables, cwd: paths.root };
}

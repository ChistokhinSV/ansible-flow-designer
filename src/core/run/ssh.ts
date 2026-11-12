// AFD-247: a remote Linux host over SSH as the Ansible environment (ADR-0005 amendment). The host
// shares no disk with this machine, so the repository and the probe are copied to a folder there,
// and what a run needs or leaves (its inputs, its events, catalog dumps) travels over the same
// connection. Pure: this module only writes the `ssh` command lines and the scripts they carry;
// `node/ssh` runs them.
//
// Every word that reaches the host is quoted here. The connection is the user's own OpenSSH setup
// (the host is an alias or a name from their config, with their keys or agent): BatchMode keeps it
// from ever asking for a password, and host keys are checked as their config says.

/** Shell-quotes one word for `sh -c`. */
export function shQuote(word: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(word) ? word : `'${word.replaceAll("'", `'"'"'`)}'`;
}

/** The home folder of the account on the host, written into paths and expanded there. */
export const REMOTE_HOME = '$HOME';

/**
 * Quotes a word for the host's shell, letting `$HOME` in it expand there: the folder on the host
 * is under the account's home unless the user gave an absolute path, and only the host knows
 * where that is.
 */
export function rq(word: string): string {
  if (!word.includes(REMOTE_HOME)) return shQuote(word);
  return word
    .split(REMOTE_HOME)
    .map((part) => (part === '' ? '' : shQuote(part)))
    .join('"$HOME"');
}

export interface SshTarget {
  /** A Host alias of the user's OpenSSH config, or `user@host`. */
  host: string;
  /** The folder on the host this workspace uses: absolute, or starting with `$HOME/`. */
  dir: string;
}

/** A host name ssh takes as a destination, never as an option. */
export function sshHostProblem(host: string): string | undefined {
  if (!host) return 'Set afd.environment.sshHost to the host, as in your SSH config (or user@host)';
  if (!/^[A-Za-z0-9_][A-Za-z0-9_.@:-]*$/.test(host))
    return `"${host}" is not a host ssh can connect to: use a Host alias of your SSH config, or user@host`;
  return undefined;
}

/**
 * The folder on the host: the setting as given when absolute, under the home folder otherwise
 * (`~/x` and `x` both mean `$HOME/x`); empty is `.afd/<workspace>`.
 */
export function remoteDir(setting: string, workspace: string): string | { error: string } {
  const given = setting.trim().replace(/\/+$/, '');
  const name =
    workspace.replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^[-.]+|-+$/g, '') || 'workspace';
  const dir = given || `.afd/${name}`;
  if (/[\0\n\r]/.test(dir) || dir.split('/').includes('..'))
    return { error: 'afd.environment.sshDir must be a plain folder path, without ".."' };
  if (dir.startsWith('/')) return dir;
  return `${REMOTE_HOME}/${dir.replace(/^~\//, '')}`;
}

/** Where things are on the host, under the workspace's folder there. */
export function remotePaths(target: SshTarget, runDir?: string) {
  const run = runDir?.replaceAll('\\', '/').replace(/\/+$/, '').split('/').pop();
  return {
    root: `${target.dir}/repo`,
    probe: `${target.dir}/probe`,
    cache: `${target.dir}/cache`,
    /** Files the user copied there by hand (a vault password file). */
    files: `${target.dir}/files`,
    run: run ? `${target.dir}/runs/${run}` : undefined,
  };
}

/** `ssh` up to the command the host runs. No terminal, no questions, a connection that gives up. */
export function sshArgs(host: string): string[] {
  return [
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=15',
    '-o',
    'ServerAliveInterval=30',
    host,
  ];
}

/**
 * The command for the host: a script for `sh`, whatever the account's login shell is. One
 * argument, since ssh joins its arguments with spaces and the host's shell parses them again.
 */
export function onHost(host: string, script: string): { command: string; args: string[] } {
  return { command: 'ssh', args: [...sshArgs(host), `sh -c ${shQuote(script)}`] };
}

/**
 * The login PATH (pipx puts ansible in ~/.local/bin) without a login shell's output, which would
 * garble the probe's protocol on stdout.
 */
export const LOGIN_PROFILE =
  'for f in /etc/profile "$HOME/.profile"; do [ -r "$f" ] && . "$f"; done >/dev/null 2>&1';

/**
 * Reads values this machine sends on the connection's input, one base64 line each, into exported
 * variables (a vault password, secret inputs): they are never arguments, here or on the host.
 */
export function readFromInput(names: readonly string[]): string {
  return names
    .map((n) => `IFS= read -r afd_in && ${n}=$(printf %s "$afd_in" | base64 -d) && export ${n}`)
    .concat(names.length ? ['unset afd_in'] : [])
    .join(' && ');
}

export interface SyncRequest {
  /** `repo` or `probe`: the folder under the workspace's folder on the host. */
  into: string;
  /** Nothing is known of what is there: files the archive does not bring are deleted. */
  clean: boolean;
  /** The files come from Windows, which keeps no executable bit: set it from the lists sent. */
  fixModes: boolean;
}

/** Deletes the files of the current folder that `.afd-sent` does not name, then empty folders. */
const MIRROR = [
  "find . -type f ! -name '.afd-*' -printf '%P\\0' | LC_ALL=C sort -z > .afd-have",
  'LC_ALL=C sort -z .afd-sent > .afd-keep',
  'LC_ALL=C comm -z -23 .afd-have .afd-keep | xargs -0 -r rm -f --',
  'find . -mindepth 1 -type d -empty -delete',
  'rm -f .afd-have .afd-keep',
].join(' && ');

/** Names of the lists that travel in the archive with the files, removed once used. */
export const SYNC_LISTS = { remove: '.afd-remove', sent: '.afd-sent', exec: '.afd-exec' } as const;

/**
 * Unpacks the archive on the connection's input into a folder on the host. The archive brings
 * three lists of its own (NUL-separated): files to delete, the files it holds, and those that are
 * executable. The workspace's folder is the account's alone.
 */
export function syncCommand(target: SshTarget, r: SyncRequest) {
  const dir = `${target.dir}/${r.into}`;
  const lists = Object.values(SYNC_LISTS).join(' ');
  const steps = [
    'umask 077',
    `mkdir -p ${rq(target.dir)} && chmod 700 ${rq(target.dir)}`,
    // Inside that folder the copies are readable: an image's own user reads them through its
    // mounts, which do not pass through the folder above.
    'umask 022',
    `mkdir -p ${rq(dir)} && cd ${rq(dir)}`,
    // Files, not modes or owners, from the archive: the modes below are the ones that count.
    // -i: the lists and the files are two archives, one after the other.
    'tar -xif - --no-same-owner',
    `if [ -s ${SYNC_LISTS.remove} ]; then xargs -0 rm -f -- < ${SYNC_LISTS.remove}; fi`,
    // Nothing is known of what the folder held: every file the archive did not bring goes. The
    // folder itself stays, since a probe's container may have it mounted.
    ...(r.clean ? [MIRROR] : []),
    ...(r.fixModes
      ? [
          `if [ -s ${SYNC_LISTS.sent} ]; then xargs -0 chmod a-x -- < ${SYNC_LISTS.sent}; fi`,
          `if [ -s ${SYNC_LISTS.exec} ]; then xargs -0 chmod u+x -- < ${SYNC_LISTS.exec}; fi`,
        ]
      : []),
    `rm -f ${lists}`,
  ];
  return onHost(target.host, steps.join(' && '));
}

/** Writes the connection's input to a file on the host, readable by the account alone. */
export function writeFileCommand(target: SshTarget, path: string, open = false) {
  const dir = path.slice(0, path.lastIndexOf('/'));
  const steps = [
    'umask 077',
    `mkdir -p ${rq(dir)}`,
    // A container's own user writes the run's events here; only the mount leads to the folder.
    ...(open ? [`chmod 777 ${rq(dir)}`] : []),
    `cat > ${rq(path)}`,
    ...(open ? [`chmod 644 ${rq(path)}`] : []),
  ];
  return onHost(target.host, steps.join(' && '));
}

/**
 * A folder of the run that an image's own user writes into (the events), open to all and sticky,
 * as the scenario runner makes it here (AFD-159).
 */
export function openDirCommand(target: SshTarget, dir: string) {
  return onHost(target.host, `mkdir -p ${rq(dir)} && chmod 1777 ${rq(dir)}`);
}

/**
 * Follows a file on the host from its first line. The file is made first, open to the run that
 * appends to it (an image's own user): tail then follows it at once, where a file that appears
 * later is only found at tail's next look, a second or more into a short run.
 */
export function followCommand(target: SshTarget, path: string) {
  const f = rq(path);
  return onHost(
    target.host,
    `{ : >> ${f}; chmod a+rw ${f}; } 2>/dev/null; exec tail -n +1 -F -s 0.2 ${f} 2>/dev/null`,
  );
}

/** The whole file, once the run is over. */
export function readFileCommand(target: SshTarget, path: string) {
  return onHost(target.host, `cat ${rq(path)} 2>/dev/null`);
}

/** A folder on the host as an archive on the connection's output (the catalog's dumps). */
export function fetchDirCommand(target: SshTarget, dir: string) {
  return onHost(target.host, `mkdir -p ${rq(dir)} && tar -cf - -C ${rq(dir)} .`);
}

export function removeCommand(target: SshTarget, path: string) {
  return onHost(target.host, `rm -rf ${rq(path)}`);
}

/**
 * What the host has, one `key=value` a line: for the setup, and for the message when a run or the
 * probe cannot start there.
 */
export function checkCommand(host: string) {
  const script = [
    LOGIN_PROFILE,
    'echo "home=$HOME"',
    'echo "user=$(id -un)"',
    'echo "ansible=$(command -v ansible-playbook || true)"',
    'echo "python=$(command -v python3 || true)"',
    'echo "docker=$(command -v docker || true)"',
    'echo "podman=$(command -v podman || true)"',
    'echo "tar=$(command -v tar || true)"',
    'echo "base64=$(command -v base64 || true)"',
  ].join('; ');
  return onHost(host, script);
}

export interface HostFacts {
  home?: string;
  user?: string;
  ansible?: string;
  python?: string;
  docker?: string;
  podman?: string;
  tar?: string;
  base64?: string;
}

export function parseHostFacts(text: string): HostFacts {
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const at = line.indexOf('=');
    if (at > 0 && line.slice(at + 1).trim())
      out[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return out as HostFacts;
}

/** What is missing on the host for this environment to work, in words; empty when nothing is. */
export function hostProblems(facts: HostFacts, container: boolean, engine = 'docker'): string[] {
  const out: string[] = [];
  if (!facts.tar) out.push('tar is not installed there (the files are copied with it)');
  if (!facts.base64) out.push('base64 is not installed there (coreutils)');
  if (container) {
    if (!facts[engine as 'docker' | 'podman']) out.push(`${engine} is not installed there`);
  } else {
    if (!facts.ansible)
      out.push(
        'ansible-playbook is not on the PATH there: install ansible-core 2.19 or later (pipx install ansible-core), or set afd.environment.image to run in a container on the host',
      );
    if (!facts.python) out.push('python3 is not installed there');
  }
  return out;
}

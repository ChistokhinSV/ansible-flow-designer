// Which Ansible environment runs the probe and the flows (ADR-0005): an EE image through Docker or
// Podman, a WSL distribution from Windows (AFD-75), or a local interpreter (VS Code Remote, venv). Our settings win; when they are unset the
// redhat.ansible extension's settings are read as defaults (decision 6). Pure: settings in, plan out.
// AFD-247: or a remote Linux host over SSH, with Ansible on its PATH or in an image there.
import { remoteDir, sshHostProblem } from './ssh';

export interface AfdEnvSettings {
  kind: 'auto' | 'container' | 'local' | 'wsl' | 'ssh';
  containerEngine: 'auto' | 'docker' | 'podman';
  image: string;
  containerOptions: string[];
  python: string;
  /** AFD-75: the WSL distribution for `kind: wsl`; empty is WSL's default one. */
  wslDistro: string;
  /** AFD-247: for `kind: ssh`, the host as the user's SSH config names it (or user@host). */
  sshHost?: string;
  /** AFD-247: the folder on the host; empty is `.afd/<workspace>` under the account's home. */
  sshDir?: string;
  /**
   * AFD-255: the image Ansible runs in on the SSH host; empty is the host's own Ansible. Not set
   * at all (undefined): `image` is used, as 0.83 wrote it. Apart from `image`, so that switching
   * between a container here and the SSH host carries neither into the other.
   */
  sshImage?: string;
}

/** The subset of redhat.ansible settings we honour (names checked against its package.json). */
export interface RedHatSettings {
  eeEnabled?: boolean;
  image?: string;
  containerEngine?: string;
  containerOptions?: string;
  volumeMounts?: { src: string; dest: string; options?: string }[];
  interpreterPath?: string;
}

export interface Mount {
  src: string;
  dest: string;
  options?: string;
}

export type Environment =
  | {
      kind: 'container';
      engine: 'docker' | 'podman';
      image: string;
      options: string[];
      mounts: Mount[];
      source: 'afd' | 'redhat.ansible';
      label: string;
    }
  | { kind: 'local'; python: string; source: 'afd' | 'redhat.ansible' | 'default'; label: string }
  /**
   * AFD-75: Ansible inside a WSL distribution, started with wsl.exe from Windows. Without `python`
   * the probe uses the Python that runs ansible-playbook (pipx keeps ansible-core in its own venv).
   */
  | { kind: 'wsl'; distro?: string; python?: string; label: string }
  /**
   * AFD-247: a remote Linux host over SSH. The repository is copied to `dir` there. Ansible is the
   * one on the account's PATH (with `python` for the probe when set), or runs in `container`: an
   * image started with the host's Docker or Podman.
   */
  | {
      kind: 'ssh';
      host: string;
      /** Absolute, or starting with `$HOME/` (expanded on the host). */
      dir: string;
      python?: string;
      container?: { engine: 'docker' | 'podman'; image: string; options: string[] };
      label: string;
    };

/** Why no environment resolves; set up with Set Up Ansible Environment… (AFD-71). */
export type EnvironmentProblem = 'no-image' | 'windows-native' | 'wsl-not-windows' | 'no-ssh-host';

export type EnvironmentResult =
  | { ok: true; env: Environment }
  | { ok: false; error: string; code?: EnvironmentProblem };

/** Splits a container options string the way a shell would for simple quoted words. */
export function splitOptions(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g))
    out.push(m[1] ?? m[2] ?? m[3] ?? '');
  return out;
}

export function resolveEnvironment(
  afd: AfdEnvSettings,
  redhat: RedHatSettings,
  platform: string,
  /** The workspace folder's name: the default folder on an SSH host is named after it. */
  workspace = 'workspace',
): EnvironmentResult {
  if (afd.kind === 'ssh') {
    const host = (afd.sshHost ?? '').trim();
    const bad = sshHostProblem(host);
    if (bad) return { ok: false, error: bad, code: 'no-ssh-host' };
    const dir = remoteDir(afd.sshDir ?? '', workspace);
    if (typeof dir !== 'string') return { ok: false, error: dir.error, code: 'no-ssh-host' };
    // An image named in our settings runs there in a container; redhat.ansible's is for this machine.
    const image = (afd.sshImage ?? afd.image).trim();
    const container = image
      ? {
          engine: afd.containerEngine === 'podman' ? ('podman' as const) : ('docker' as const),
          image,
          options: afd.containerOptions,
        }
      : undefined;
    const how = container ? `${container.engine}: ${container.image}` : 'ansible on its PATH';
    return {
      ok: true,
      env: {
        kind: 'ssh',
        host,
        dir,
        python: afd.python || undefined,
        ...(container ? { container } : {}),
        label: `ssh: ${host} (${how})`,
      },
    };
  }
  if (afd.kind === 'wsl') {
    if (platform !== 'win32')
      return {
        ok: false,
        error: 'afd.environment.kind wsl is for Windows: here, use local (or a container image)',
        code: 'wsl-not-windows',
      };
    const distro = afd.wslDistro.trim() || undefined;
    const label = `wsl: ${distro ?? 'the default distribution'}`;
    return { ok: true, env: { kind: 'wsl', distro, python: afd.python || undefined, label } };
  }
  const redhatImage = redhat.eeEnabled && redhat.image ? redhat.image : undefined;
  const container =
    afd.kind === 'container' || (afd.kind === 'auto' && (!!afd.image || !!redhatImage));
  if (container) {
    const image = afd.image || redhatImage;
    if (!image)
      return {
        ok: false,
        error: 'Set afd.environment.image to the execution environment image',
        code: 'no-image',
      };
    const fromRedhat = !afd.image;
    const engine =
      afd.containerEngine !== 'auto'
        ? afd.containerEngine
        : redhat.containerEngine === 'podman'
          ? 'podman'
          : 'docker';
    const options =
      afd.containerOptions.length > 0
        ? afd.containerOptions
        : fromRedhat
          ? splitOptions(redhat.containerOptions)
          : [];
    const mounts = fromRedhat ? (redhat.volumeMounts ?? []).filter((m) => m?.src && m.dest) : [];
    return {
      ok: true,
      env: {
        kind: 'container',
        engine,
        image,
        options,
        mounts,
        source: fromRedhat ? 'redhat.ansible' : 'afd',
        label: `${engine}: ${image}`,
      },
    };
  }
  if (platform === 'win32')
    return {
      ok: false,
      error:
        'Runs need an Ansible environment. On Windows that is Docker or Podman with an execution environment image, or this folder opened in WSL.',
      code: 'windows-native',
    };
  const python = afd.python || redhat.interpreterPath || 'python3';
  const source = afd.python ? 'afd' : redhat.interpreterPath ? 'redhat.ansible' : 'default';
  return { ok: true, env: { kind: 'local', python, source, label: `local: ${python}` } };
}

/**
 * AFD-117: the environment settings from a workspace's `.vscode/settings.json` (its flat
 * `afd.environment.*` and `ansible.*` keys), for hosts without VS Code's configuration (the MCP
 * server). User settings are not there: a workspace that relies on them says so in the error.
 */
export function settingsFromJson(json: Record<string, unknown>): {
  afd: AfdEnvSettings;
  redhat: RedHatSettings;
} {
  const get = <T>(key: string, fallback: T): T => {
    const v = json[key];
    return v === undefined || v === null || typeof v !== typeof fallback ? fallback : (v as T);
  };
  const list = json['afd.environment.containerOptions'];
  return {
    afd: {
      kind: get('afd.environment.kind', 'auto') as AfdEnvSettings['kind'],
      containerEngine: get(
        'afd.environment.containerEngine',
        'auto',
      ) as AfdEnvSettings['containerEngine'],
      image: get('afd.environment.image', ''),
      containerOptions: Array.isArray(list) ? list.map(String) : [],
      python: get('afd.environment.python', ''),
      wslDistro: get('afd.environment.wslDistro', ''),
      sshHost: get('afd.environment.sshHost', ''),
      sshDir: get('afd.environment.sshDir', ''),
      ...(typeof json['afd.environment.sshImage'] === 'string'
        ? { sshImage: json['afd.environment.sshImage'] }
        : {}),
    },
    redhat: {
      eeEnabled: json['ansible.executionEnvironment.enabled'] as boolean | undefined,
      image: json['ansible.executionEnvironment.image'] as string | undefined,
      containerEngine: json['ansible.executionEnvironment.containerEngine'] as string | undefined,
      containerOptions: json['ansible.executionEnvironment.containerOptions'] as string | undefined,
      volumeMounts: json[
        'ansible.executionEnvironment.volumeMounts'
      ] as RedHatSettings['volumeMounts'],
      interpreterPath: json['ansible.python.interpreterPath'] as string | undefined,
    },
  };
}

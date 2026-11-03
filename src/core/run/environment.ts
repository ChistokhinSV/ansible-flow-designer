// Which Ansible environment runs the probe and the flows (ADR-0005): an EE image through Docker or
// Podman, or a local interpreter (VS Code Remote, venv). Our settings win; when they are unset the
// redhat.ansible extension's settings are read as defaults (decision 6). Pure: settings in, plan out.

export interface AfdEnvSettings {
  kind: 'auto' | 'container' | 'local';
  containerEngine: 'auto' | 'docker' | 'podman';
  image: string;
  containerOptions: string[];
  python: string;
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
  | { kind: 'local'; python: string; source: 'afd' | 'redhat.ansible' | 'default'; label: string };

/** Why no environment resolves; set up with Set Up Ansible Environment… (AFD-71). */
export type EnvironmentProblem = 'no-image' | 'windows-native';

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
): EnvironmentResult {
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

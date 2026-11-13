// AFD-255: Switch Ansible Environment…. The settings keep every environment side by side (an SSH
// host, a WSL distribution, an image for this machine), so going from one to another rewrites
// `afd.environment.kind` and asks nothing. Pure: settings and machine findings in, the list and
// the writes out.
import type { Environment } from './environment';

export interface SwitchSettings {
  /** `afd.environment.image`, or the Red Hat Ansible extension's when it enables one. */
  image: string;
  containerEngine: 'auto' | 'docker' | 'podman';
  wslDistro: string;
  sshHost: string;
  /** The image on the SSH host as it resolves (`sshImage`, else 0.83's `image`). */
  sshImage: string;
  python: string;
}

export interface SwitchFindings {
  platform: string;
  docker: boolean;
  podman: boolean;
  /** The WSL distributions (`parseWslList`), on Windows. */
  distros: readonly string[];
}

export type SwitchChoice = {
  label: string;
  detail: string;
  /** This is the environment in use now. */
  current: boolean;
} & (
  | { kind: 'container' }
  /** `distro` undefined: WSL's default distribution. */
  | { kind: 'wsl'; distro?: string }
  | { kind: 'ssh' }
  | { kind: 'local' }
);

/**
 * The environments one click away: what the settings already describe, and the WSL distributions
 * of this machine (they need no question). Anything else is the setup's.
 */
export function environmentSwitches(
  s: SwitchSettings,
  m: SwitchFindings,
  now?: Environment,
): SwitchChoice[] {
  const out: SwitchChoice[] = [];
  if (s.image) {
    const engine =
      s.containerEngine !== 'auto'
        ? s.containerEngine
        : !m.docker && m.podman
          ? 'podman'
          : 'docker';
    out.push({
      kind: 'container',
      label: `${engine === 'podman' ? 'Podman' : 'Docker'}: ${s.image}`,
      detail: 'An execution environment image on this machine',
      current: now?.kind === 'container',
    });
  }
  if (m.platform === 'win32') {
    const distros = [...m.distros];
    // Named in the settings but not listed (WSL did not answer): still one click away.
    if (s.wslDistro && !distros.includes(s.wslDistro)) distros.push(s.wslDistro);
    for (const distro of distros)
      out.push({
        kind: 'wsl',
        distro,
        label: `WSL: ${distro}`,
        detail: 'Ansible inside this distribution (ansible-core 2.19 or later there)',
        current: now?.kind === 'wsl' && now.distro === distro,
      });
    if (now?.kind === 'wsl' && !now.distro)
      out.push({
        kind: 'wsl',
        label: 'WSL: the default distribution',
        detail: 'Ansible inside the distribution WSL starts by default',
        current: true,
      });
  }
  if (s.sshHost)
    out.push({
      kind: 'ssh',
      label: `SSH: ${s.sshHost}`,
      detail: s.sshImage
        ? `A copy of the repository there; Ansible in ${s.sshImage}`
        : "A copy of the repository there; the host's own Ansible",
      current: now?.kind === 'ssh',
    });
  if (m.platform !== 'win32')
    out.push({
      kind: 'local',
      label: `This machine: ${s.python || 'python3'}`,
      detail: 'The Ansible of this interpreter (a venv, VS Code Remote)',
      current: now?.kind === 'local',
    });
  return out;
}

/**
 * What a switch writes, by `afd.environment.*` key (undefined removes the value). `workspaceImage`
 * is the workspace's own `image` value: an empty one (0.83.1 wrote it to keep the user's image off
 * the SSH host) would leave a container without an image.
 */
export function switchWrites(
  choice: SwitchChoice,
  workspaceImage: string | undefined,
): Record<string, string | undefined> {
  if (choice.kind === 'wsl') return { kind: 'wsl', wslDistro: choice.distro };
  if (choice.kind === 'container')
    return { kind: 'container', ...(workspaceImage === '' ? { image: undefined } : {}) };
  return { kind: choice.kind };
}

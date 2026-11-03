// Set Up Ansible Environment… (AFD-71): the choices for where Ansible runs, from what this machine
// has. A container engine runs an execution environment image (the public Ansible dev tools image
// unless the user names their own); on Windows, a WSL distribution runs Ansible itself, from Windows
// VS Code (AFD-75) or with the folder reopened in WSL. Pure: findings in.

/** The public image the setup proposes: the last ansible-dev-tools release, usable as an EE. */
export const DEV_TOOLS_IMAGE = 'ghcr.io/ansible/community-ansible-dev-tools:latest';

export type EnvironmentChoice =
  | { kind: 'container'; engine: 'docker' | 'podman'; label: string; detail: string }
  /** AFD-75: Ansible inside this WSL distribution, run from Windows. */
  | { kind: 'wsl-distro'; distro: string; label: string; detail: string }
  | { kind: 'wsl' | 'install' | 'read'; label: string; detail: string };

export interface MachineFindings {
  platform: string;
  docker: boolean;
  podman: boolean;
  /** The WSL extension is installed (ms-vscode-remote.remote-wsl). */
  remoteWsl: boolean;
  /** AFD-75: the WSL distributions (`parseWslList`), on Windows. */
  distros?: readonly string[];
}

/**
 * The distributions in `wsl.exe -l -q` (decoded from its UTF-16): one name a line. Docker Desktop's
 * own distributions run no Ansible, so they are left out.
 */
export function parseWslList(text: string): string[] {
  return text
    .replaceAll('\uFEFF', '')
    .replaceAll('\0', '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !/^docker-desktop/i.test(l));
}

export function environmentChoices(m: MachineFindings): EnvironmentChoice[] {
  const out: EnvironmentChoice[] = [];
  for (const engine of ['docker', 'podman'] as const)
    if (m[engine])
      out.push({
        kind: 'container',
        engine,
        label: engine === 'docker' ? 'Docker' : 'Podman',
        detail: `Run Ansible in an execution environment image with ${engine === 'docker' ? 'Docker' : 'Podman'}`,
      });
  if (m.platform === 'win32')
    for (const distro of m.distros ?? [])
      out.push({
        kind: 'wsl-distro',
        distro,
        label: `WSL: ${distro}`,
        detail: 'Run Ansible inside this distribution (it needs ansible-core 2.19 or later there)',
      });
  if (m.platform === 'win32' && m.remoteWsl)
    out.push({
      kind: 'wsl',
      label: 'Reopen the Folder in WSL',
      detail: 'Ansible runs inside WSL: install it there (pipx install ansible-core)',
    });
  if (out.length === 0)
    out.push({
      kind: 'install',
      label: 'Install Docker, Podman or WSL First',
      detail:
        m.platform === 'win32'
          ? 'None is here yet: Docker Desktop or Podman Desktop, or the WSL extension with a Linux distribution'
          : 'Neither Docker nor Podman is here: install one, or Ansible on this machine',
    });
  out.push({
    kind: 'read',
    label: 'Read About Ansible Environments',
    detail: 'Containers, WSL, a venv: what each needs',
  });
  return out;
}

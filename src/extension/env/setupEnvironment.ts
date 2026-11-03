// Set Up Ansible Environment… (AFD-71): instead of a bare error when a run has nowhere to run, find
// what this machine has and set the environment up. Nothing is pulled here: the first run pulls the
// image. The WSL step opens the WSL extension's own command (its ID is not public API).
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { DEV_TOOLS_IMAGE, environmentChoices, parseWslList } from '../../core/run/setup';
import { programsOnPath } from '../ai/launcher';
import { CMD } from '../commands/ids';
import { UNTRUSTED } from './environment';

const GUIDE = 'how-to/runs-and-environments.md';

/** The WSL distributions on this machine (AFD-75); none when WSL is off or missing. */
function wslDistros(): Promise<string[]> {
  if (process.platform !== 'win32') return Promise.resolve([]);
  return new Promise((resolve) =>
    execFile('wsl.exe', ['-l', '-q'], { encoding: 'buffer', timeout: 10_000 }, (err, out) =>
      resolve(err ? [] : parseWslList(out.toString('utf16le'))),
    ),
  );
}

/** Walks the user through it; resolves true once an environment is set. */
export async function setUpEnvironment(retry?: () => unknown): Promise<boolean> {
  const [found, distros] = await Promise.all([programsOnPath(['docker', 'podman']), wslDistros()]);
  const choices = environmentChoices({
    platform: process.platform,
    docker: found.has('docker'),
    podman: found.has('podman'),
    remoteWsl: !!vscode.extensions.getExtension('ms-vscode-remote.remote-wsl'),
    distros,
  });
  const pick = await vscode.window.showQuickPick(
    choices.map((c) => ({ label: c.label, detail: c.detail, choice: c })),
    { title: 'Set Up Ansible Environment', placeHolder: 'Where should Ansible run?' },
  );
  const choice = pick?.choice;
  if (!choice) return false;
  if (choice.kind === 'wsl') {
    await vscode.commands.executeCommand(
      'workbench.action.quickOpen',
      '>WSL: Reopen Folder in WSL',
    );
    return false;
  }
  if (choice.kind === 'wsl-distro') {
    const afd = vscode.workspace.getConfiguration('afd');
    await afd.update('environment.kind', 'wsl', vscode.ConfigurationTarget.Global);
    await afd.update('environment.wslDistro', choice.distro, vscode.ConfigurationTarget.Global);
    return done(
      `The Ansible environment is set: WSL ${choice.distro}. It needs ansible-core 2.19 or later there (pipx install ansible-core).`,
      retry,
    );
  }
  if (choice.kind !== 'container') {
    await vscode.commands.executeCommand(CMD.openGuide, GUIDE);
    return false;
  }
  const image = await vscode.window.showInputBox({
    title: `Set Up Ansible Environment: ${choice.label}`,
    prompt:
      'The execution environment image runs need (ansible-core 2.19 or later). The public Ansible dev tools image works; use your own if you have one. The first run pulls it.',
    value: DEV_TOOLS_IMAGE,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'Enter an image'),
  });
  if (!image) return false;
  const afd = vscode.workspace.getConfiguration('afd');
  await afd.update('environment.image', image.trim(), vscode.ConfigurationTarget.Global);
  await afd.update('environment.containerEngine', choice.engine, vscode.ConfigurationTarget.Global);
  if (afd.get('environment.kind') !== 'auto' && afd.get('environment.kind') !== 'container')
    await afd.update('environment.kind', 'container', vscode.ConfigurationTarget.Global);
  return done(
    `The Ansible environment is set: ${choice.engine}: ${image.trim()}. The first run pulls the image.`,
    retry,
  );
}

/** Says what is set, and offers the run that asked for it again. */
async function done(message: string, retry?: () => unknown): Promise<boolean> {
  const again = retry
    ? await vscode.window.showInformationMessage(message, 'Run as Skeleton')
    : await vscode.window.showInformationMessage(message);
  if (again && retry) await retry();
  return true;
}

/** A run that found no environment: say why, and offer the setup (or trust, or the settings). */
export function showEnvironmentError(error: string, retry?: () => unknown): void {
  const trust = error === UNTRUSTED;
  const actions = trust
    ? ['Manage Workspace Trust']
    : ['Set Up Ansible Environment…', 'Open Settings'];
  void vscode.window.showErrorMessage(error, ...actions).then((pick) => {
    if (pick === 'Manage Workspace Trust')
      return vscode.commands.executeCommand('workbench.trust.manage');
    if (pick === 'Open Settings')
      return vscode.commands.executeCommand('workbench.action.openSettings', 'afd.environment');
    if (pick) return setUpEnvironment(retry);
    return undefined;
  });
}

// Set Up Ansible Environment… (AFD-71): instead of a bare error when a run has nowhere to run, find
// what this machine has and set the environment up. Nothing is pulled here: the first run pulls the
// image. The WSL step opens the WSL extension's own command (its ID is not public API).
import * as vscode from 'vscode';
import { DEV_TOOLS_IMAGE, environmentChoices } from '../../core/run/setup';
import { programsOnPath } from '../ai/launcher';
import { CMD } from '../commands/ids';
import { UNTRUSTED } from './environment';

const GUIDE = 'how-to/runs-and-environments.md';

/** Walks the user through it; resolves true once an environment is set. */
export async function setUpEnvironment(retry?: () => unknown): Promise<boolean> {
  const found = await programsOnPath(['docker', 'podman']);
  const choices = environmentChoices({
    platform: process.platform,
    docker: found.has('docker'),
    podman: found.has('podman'),
    remoteWsl: !!vscode.extensions.getExtension('ms-vscode-remote.remote-wsl'),
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
  if (afd.get('environment.kind') === 'local')
    await afd.update('environment.kind', 'container', vscode.ConfigurationTarget.Global);
  const done = `The Ansible environment is set: ${choice.engine}: ${image.trim()}. The first run pulls the image.`;
  const again = retry
    ? await vscode.window.showInformationMessage(done, 'Run as Skeleton')
    : await vscode.window.showInformationMessage(done);
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

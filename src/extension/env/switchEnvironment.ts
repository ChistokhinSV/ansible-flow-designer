// AFD-255: Switch Ansible Environment…, from the Inventory view, the launch dialog and the Command
// Palette. The environments the settings already describe are one click away; anything else is
// Set Up Ansible Environment…. A switch is this workspace's (the user settings without a folder).
import * as vscode from 'vscode';
import { environmentSwitches, type SwitchChoice, switchWrites } from '../../core/run/switch';
import { programsOnPath } from '../ai/launcher';
import { environmentFor } from './environment';
import { setUpEnvironment, wslDistros } from './setupEnvironment';

type Pick = vscode.QuickPickItem & { choice?: SwitchChoice; setup?: true };

/** Resolves true when the environment was changed. */
export async function switchEnvironment(scope?: vscode.Uri): Promise<boolean> {
  const folder =
    (scope && vscode.workspace.getWorkspaceFolder(scope)) ?? vscode.workspace.workspaceFolders?.[0];
  const afd = vscode.workspace.getConfiguration('afd', folder?.uri);
  const redhat = vscode.workspace.getConfiguration('ansible', folder?.uri);
  const [found, distros] = await Promise.all([programsOnPath(['docker', 'podman']), wslDistros()]);
  const at = folder?.uri ?? vscode.Uri.file('/');
  const now = environmentFor(at);
  const sshImage = afd.inspect<string>('environment.sshImage');
  const image =
    afd.get('environment.image', '') ||
    (redhat.get<boolean>('executionEnvironment.enabled')
      ? (redhat.get<string>('executionEnvironment.image') ?? '')
      : '');
  const choices = environmentSwitches(
    {
      image,
      containerEngine: afd.get('environment.containerEngine', 'auto'),
      wslDistro: afd.get('environment.wslDistro', ''),
      sshHost: afd.get('environment.sshHost', ''),
      sshImage:
        sshImage?.workspaceFolderValue ??
        sshImage?.workspaceValue ??
        sshImage?.globalValue ??
        afd.get('environment.image', ''),
      python: afd.get('environment.python', ''),
    },
    {
      platform: process.platform,
      docker: found.has('docker'),
      podman: found.has('podman'),
      distros,
    },
    now.ok ? now.env : undefined,
  );
  const items: Pick[] = [
    ...choices.map(
      (choice): Pick => ({
        label: choice.label,
        detail: choice.detail,
        description: choice.current ? 'in use' : undefined,
        iconPath: new vscode.ThemeIcon(choice.current ? 'check' : 'blank'),
        choice,
      }),
    ),
    { label: '', kind: vscode.QuickPickItemKind.Separator },
    {
      label: 'Set Up Another…',
      detail: 'Docker or Podman with an image, another SSH host: the setup asks what it needs',
      iconPath: new vscode.ThemeIcon('add'),
      setup: true,
    },
  ];
  const picked = await vscode.window.showQuickPick(items, {
    title: 'Switch Ansible Environment',
    placeHolder: now.ok ? `Now: ${now.env.label}` : 'No environment is set',
  });
  if (!picked) return false;
  if (picked.setup) return setUpEnvironment();
  const choice = picked.choice;
  if (!choice || choice.current) return false;
  const target = folder ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const workspaceImage = afd.inspect<string>('environment.image')?.workspaceValue;
  for (const [key, value] of Object.entries(switchWrites(choice, workspaceImage)))
    await afd.update(`environment.${key}`, value, target);
  const after = environmentFor(at);
  if (after.ok) vscode.window.setStatusBarMessage(`Ansible environment: ${after.env.label}`, 5000);
  else void vscode.window.showErrorMessage(after.error);
  return true;
}

// Set Up Ansible Environment… (AFD-71): instead of a bare error when a run has nowhere to run, find
// what this machine has and set the environment up. Nothing is pulled here: the first run pulls the
// image. The WSL step opens the WSL extension's own command (its ID is not public API).
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';
import * as vscode from 'vscode';
import {
  DEV_TOOLS_IMAGE,
  environmentChoices,
  parseWslList,
  sshConfigHosts,
} from '../../core/run/setup';
import { hostProblems, remoteDir, remotePaths, sshHostProblem } from '../../core/run/ssh';
import { copyFile, hostFacts } from '../../node/ssh/remote';
import { programsOnPath } from '../ai/launcher';
import { CMD } from '../commands/ids';
import { environmentFor, UNTRUSTED } from './environment';

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
  if (choice.kind === 'ssh') return setUpSsh(retry);
  if (choice.kind === 'wsl-distro') {
    const afd = vscode.workspace.getConfiguration('afd');
    const target = settingsTarget();
    await afd.update('environment.kind', 'wsl', target);
    await afd.update('environment.wslDistro', choice.distro, target);
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
  const target = settingsTarget();
  await afd.update('environment.image', image.trim(), target);
  await afd.update('environment.containerEngine', choice.engine, target);
  if (afd.get('environment.kind') !== 'auto' && afd.get('environment.kind') !== 'container')
    await afd.update('environment.kind', 'container', target);
  return done(
    `The Ansible environment is set: ${choice.engine}: ${image.trim()}. The first run pulls the image.`,
    retry,
  );
}

/**
 * Where a container or WSL setup writes: the user settings, unless this workspace sets an
 * environment of its own (an SSH host). A workspace value hides the user's, so written to the user
 * settings the setup would say one environment is set while runs went on using the other (AFD-250).
 */
function settingsTarget(): vscode.ConfigurationTarget {
  const afd = vscode.workspace.getConfiguration('afd');
  const inWorkspace = ['kind', 'image', 'containerEngine', 'wslDistro', 'sshHost'].some(
    (key) => afd.inspect(`environment.${key}`)?.workspaceValue !== undefined,
  );
  return inWorkspace ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
}

/** The hosts of the user's SSH config (`~/.ssh/config`); none when it cannot be read. */
function configuredHosts(): string[] {
  try {
    return sshConfigHosts(readFileSync(join(homedir(), '.ssh', 'config'), 'utf8'));
  } catch {
    return [];
  }
}

/**
 * AFD-247: asks for the host, looks at what it has, and sets the environment. A host without
 * Ansible on its PATH but with Docker or Podman is offered an image to run in.
 */
async function setUpSsh(retry?: () => unknown): Promise<boolean> {
  const title = 'Set Up Ansible Environment: SSH Host';
  const other = 'Another Host…';
  const hosts = configuredHosts();
  const picked =
    hosts.length > 0
      ? await vscode.window.showQuickPick([...hosts, other], {
          title,
          placeHolder: 'The host, as your SSH config names it',
        })
      : other;
  if (!picked) return false;
  const host =
    picked === other
      ? (
          await vscode.window.showInputBox({
            title,
            prompt:
              'A Host of your SSH config, or user@host. Your keys or agent sign in: it must connect without asking for a password (try `ssh <host>` in a terminal).',
            ignoreFocusOut: true,
            validateInput: (v) => sshHostProblem(v.trim()),
          })
        )?.trim()
      : picked;
  if (!host) return false;
  const found = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Connecting to ${host}…` },
    () => hostFacts(host),
  );
  if (!found.facts) {
    void vscode.window.showErrorMessage(
      `${found.error}. It must connect from a terminal with \`ssh ${host}\` without asking anything.`,
    );
    return false;
  }
  const facts = found.facts;
  const engine = facts.docker ? 'docker' : facts.podman ? 'podman' : undefined;
  let image = '';
  if (!facts.ansible) {
    if (!engine) {
      void vscode.window.showErrorMessage(
        `${host} has no ansible-playbook on its PATH and no Docker or Podman: install ansible-core 2.19 or later there (pipx install ansible-core).`,
      );
      return false;
    }
    image =
      (
        await vscode.window.showInputBox({
          title,
          prompt: `${host} has no ansible-playbook on its PATH, but it has ${engine}: the execution environment image to run in there (ansible-core 2.19 or later).`,
          value: userImage() || DEV_TOOLS_IMAGE,
          ignoreFocusOut: true,
          validateInput: (v) => (v.trim() ? undefined : 'Enter an image'),
        })
      )?.trim() ?? '';
    if (!image) return false;
  }
  const missing = hostProblems(facts, !!image, engine);
  if (missing.length > 0) {
    void vscode.window.showErrorMessage(`${host} cannot run flows yet: ${missing.join('; ')}.`);
    return false;
  }
  const afd = vscode.workspace.getConfiguration('afd');
  const target = vscode.workspace.workspaceFolders?.length
    ? vscode.ConfigurationTarget.Workspace
    : vscode.ConfigurationTarget.Global;
  await afd.update('environment.kind', 'ssh', target);
  await afd.update('environment.sshHost', host, target);
  // AFD-250: an image in the user settings (the Docker setup writes it there) would be used on the
  // host too, where the host's own Ansible was chosen: an empty value here says "no image".
  const noImage = userImage() && target === vscode.ConfigurationTarget.Workspace ? '' : undefined;
  await afd.update('environment.image', image || noImage, target);
  if (image && engine) await afd.update('environment.containerEngine', engine, target);
  const where = image
    ? `${engine}: ${image} on ${host}`
    : `the ansible-playbook of ${facts.user ?? 'the account'} on ${host}`;
  const dir = remoteDir(
    vscode.workspace.getConfiguration('afd').get<string>('environment.sshDir') ?? '',
    vscode.workspace.workspaceFolders?.[0]?.name ?? 'workspace',
  );
  const there = typeof dir === 'string' ? dir.replace('$HOME/', '~/') : '~/.afd/<workspace>';
  return done(
    `The Ansible environment is set: ${where}. Each run copies the repository to ${there} there.`,
    retry,
  );
}

/** The image of the user settings: what the workspace has when it names none itself. */
function userImage(): string {
  const image = vscode.workspace.getConfiguration('afd').inspect<string>('environment.image');
  return (image?.globalValue ?? '').trim();
}

/**
 * AFD-247: copies one file of this machine to the SSH host, readable by the account alone. For
 * what a run needs and the repository does not hold: a vault password file, a key.
 */
export async function copyFileToHost(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  const resolved = folder ? environmentFor(folder.uri) : undefined;
  const env = resolved?.ok ? resolved.env : undefined;
  if (!folder || env?.kind !== 'ssh') {
    void vscode.window.showErrorMessage(
      'Copy a File to the SSH Host is for an SSH environment: set one up with Set Up Ansible Environment… first.',
    );
    return;
  }
  const [file] =
    (await vscode.window.showOpenDialog({
      title: `Copy a File to ${env.host}`,
      openLabel: 'Copy to the Host',
      canSelectMany: false,
    })) ?? [];
  if (!file) return;
  const name = basename(file.fsPath);
  // Beside the repository's copy, never inside it: the next run does not delete it.
  const proposed = `${remotePaths(env).files}/${name}`.replace('$HOME/', '~/');
  const given = await vscode.window.showInputBox({
    title: `Copy ${name} to ${env.host}`,
    prompt:
      'Where on the host. Name this path where it is used, for example vault_password_file in ansible.cfg. It is written readable by the account alone.',
    value: proposed,
    ignoreFocusOut: true,
    validateInput: (v) => {
      const dir = remoteDir(v.trim(), 'x');
      return typeof dir === 'string' && v.trim() && !v.trim().endsWith('/')
        ? undefined
        : 'A file path on the host, absolute or under the home folder (~/…)';
    },
  });
  if (!given) return;
  const path = remoteDir(given.trim(), 'x');
  if (typeof path !== 'string') return;
  const error = await copyFile(env, Buffer.from(await vscode.workspace.fs.readFile(file)), path);
  if (error) void vscode.window.showErrorMessage(error);
  else
    void vscode.window.showInformationMessage(
      `Copied ${name} to ${env.host}:${given.trim()} (readable by the account alone).`,
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

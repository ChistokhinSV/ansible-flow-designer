// AFD-301: connecting a folder to Ansible Flow Server from the Flows pane. Connect asks for the
// address (checked against the server's meta), an access token (checked, kept in SecretStorage) and
// the folder's project (its git remote on the server, else picked from the server's workspaces),
// and writes afd.runner.url and afd.runner.project for the folder. Disconnect forgets them. The
// pane's title shows a connect button, or the server's with its menu, by the context key
// `afd.serverConnected`; the pane's description names the server and the project.
import * as vscode from 'vscode';
import { RunnerClient, type RunnerProject } from '../../node/runner/client';
import { untrustedCertificate } from '../../node/runner/gitTrust';
import {
  type GitAuth,
  getProjectFlows,
  repositoryOf,
  sendFolder,
} from '../../node/runner/projectGit';
import { CMD } from '../commands/ids';
import { CANCELLED, isCancelled } from '../errors';
import type { Host } from '../host';
import { remoteProject } from './runnerRun';

export const tokenKey = (url: string) => `afd.runner.token:${url}`;

/** The connection's token and certificate setting when the remote is the server's git address. */
export async function gitAuthFor(
  scope: vscode.Uri,
  remoteUrl: string,
  secrets: vscode.SecretStorage,
): Promise<GitAuth | undefined> {
  const { url, verifyTls } = config(scope);
  if (!url) return undefined;
  try {
    if (new URL(remoteUrl).host !== new URL(url).host) return undefined;
  } catch {
    return undefined;
  }
  const token = await secrets.get(tokenKey(url));
  return token ? { token, verifyTls } : undefined;
}

/**
 * AFD-305: an error from git; one that does not trust the server's certificate comes with Set Up
 * Git for the Server.
 */
export function offerGitSetup(message: string): void {
  if (!untrustedCertificate(message)) {
    void vscode.window.showErrorMessage(message);
    return;
  }
  const setUp = 'Set Up Git for the Server…';
  void vscode.window
    .showErrorMessage(
      `${message} Git does not trust the server's certificate: Set Up Git for the Server trusts it for this folder.`,
      setUp,
    )
    .then((pick) => {
      if (pick === setUp) void vscode.commands.executeCommand(CMD.runnerSetUpGit);
    });
}
const CONTEXT = 'afd.serverConnected';

/** The flows pane, to say which server it is connected to. */
let pane: vscode.TreeView<unknown> | undefined;
export function attachFlowsPane(view: vscode.TreeView<unknown>): void {
  pane = view;
}
/** What the pane says of its server (the test API). */
export const flowsPaneDescription = (): string | undefined => pane?.description;

export function config(scope: vscode.Uri) {
  const c = vscode.workspace.getConfiguration('afd', scope);
  return {
    c,
    url: (c.get<string>('runner.url', '') ?? '').trim().replace(/\/+$/, ''),
    project: (c.get<string>('runner.project', '') ?? '').trim(),
    // Like runnerRun's: a workspace cannot turn verification off, only the user.
    verifyTls: c.inspect<boolean>('runner.verifyTls')?.globalValue ?? true,
    allowHttp: c.inspect<boolean>('runner.allowHttp')?.globalValue ?? false,
  };
}

/** Where the folder's settings are written: the folder itself in a multi-root workspace. */
const target = () =>
  (vscode.workspace.workspaceFolders?.length ?? 0) > 1
    ? vscode.ConfigurationTarget.WorkspaceFolder
    : vscode.ConfigurationTarget.Workspace;

/** Connected: an address is set for the folder and a token is kept for it. */
export async function serverState(
  scope: vscode.Uri | undefined,
  secrets: vscode.SecretStorage,
): Promise<{ url?: string; project?: string; connected: boolean }> {
  if (!scope) return { connected: false };
  const { url, project } = config(scope);
  if (!url) return { connected: false };
  const token = await secrets.get(tokenKey(url));
  return { url, ...(project ? { project } : {}), connected: !!token };
}

/** The context key for the pane's title buttons, and the pane's description. */
export async function showServerState(
  scope: vscode.Uri | undefined,
  secrets: vscode.SecretStorage,
): Promise<void> {
  const s = await serverState(scope, secrets);
  await vscode.commands.executeCommand('setContext', CONTEXT, s.connected);
  if (!pane) return;
  let host = s.url;
  try {
    if (s.url) host = new URL(s.url).host;
  } catch {
    // An address that does not read is shown as it is.
  }
  pane.description = s.connected ? `${host}${s.project ? ` · ${s.project}` : ''}` : undefined;
}

const tlsProblem = (message: string) =>
  /certificate|self[- ]signed|UNABLE_TO_VERIFY|unable to get local issuer|CERT_/i.test(message);

/** What the prompts would ask, given instead (the test API). */
export interface ConnectAnswers {
  url: string;
  token: string;
  /** `<workspace>/<project>`; absent: from the git remote, else none. */
  project?: string;
  /** Turn verification off for a self-signed certificate, as the warning offers. */
  labCertificate?: boolean;
}

/**
 * Connects the folder: address, token, project. Answers an error message, CANCELLED, or
 * undefined once connected.
 */
export async function connectServer(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  given?: ConnectAnswers,
): Promise<string | undefined> {
  const before = config(scope);
  const typed =
    given?.url ??
    (await vscode.window.showInputBox({
      title: 'Connect to Ansible Flow Server (1/3): address',
      prompt: 'The address of the server, as in the browser',
      value: before.url || 'https://',
      placeHolder: 'https://flows.example.net:8443',
      ignoreFocusOut: true,
      validateInput: (v) => {
        try {
          const u = new URL(v.trim());
          return /^https?:$/.test(u.protocol) ? undefined : 'An https:// address';
        } catch {
          return 'An address such as https://flows.example.net:8443';
        }
      },
    }));
  if (!typed) return CANCELLED;
  const url = typed.trim().replace(/\/+$/, '');
  let { verifyTls } = before;
  const { allowHttp } = before;

  // The server answers, and is Ansible Flow Server.
  for (;;) {
    try {
      await new RunnerClient(url, '', { verifyTls, allowHttp }).meta();
      break;
    } catch (e) {
      const message = (e as Error).message;
      if (!verifyTls || !tlsProblem(message)) return message;
      const off = 'Turn Off Verification (Lab Only)';
      const pick = given
        ? given.labCertificate
          ? off
          : undefined
        : await vscode.window.showWarningMessage(
            `The certificate of ${url} is not trusted (a self-signed certificate?).`,
            {
              modal: true,
              detail:
                'For a lab server, verification can be turned off in your user settings (afd.runner.verifyTls): the token then goes to whoever answers at this address. For any other server, trust its certificate authority instead.',
            },
            off,
          );
      if (pick !== off) return CANCELLED;
      await vscode.workspace
        .getConfiguration('afd')
        .update('runner.verifyTls', false, vscode.ConfigurationTarget.Global);
      verifyTls = false;
    }
  }

  // A token: the one kept for this address if it still works, else a new one.
  let token = given ? given.token : await secrets.get(tokenKey(url));
  let me: { login: string } | undefined;
  if (token)
    me = await new RunnerClient(url, token, { verifyTls, allowHttp }).me().catch(() => undefined);
  if (given && !me) return `The token is not accepted at ${url}`;
  if (!me) {
    const typedToken = await vscode.window.showInputBox({
      title: `Connect to Ansible Flow Server (2/3): access token for ${url}`,
      prompt:
        'A personal access token (My account → Access tokens on the server); kept in VS Code SecretStorage',
      password: true,
      ignoreFocusOut: true,
    });
    if (!typedToken) return CANCELLED;
    token = typedToken.trim();
    try {
      me = await new RunnerClient(url, token, { verifyTls, allowHttp }).me();
    } catch (e) {
      return (e as Error).message;
    }
  }
  const client = new RunnerClient(url, token as string, { verifyTls, allowHttp });

  // The project: the repository's remote on this server says it; else it is picked. AFD-302: a
  // folder without flows may get the picked project's flows; a folder with its own flows may be
  // sent to a new project instead.
  let project = given?.project ?? (await remoteProject(url, scope));
  const auth: GitAuth = { token: token as string, verifyTls };
  let got = '';
  if (!project && !given) {
    const hasFlows = await folderHasFlows(scope);
    const items: (vscode.QuickPickItem & { value?: string })[] = [];
    if (hasFlows)
      items.push({
        label: '$(cloud-upload) New Project from This Folder…',
        description: 'Make a project on the server and send this folder to it',
        value: NEW,
      });
    try {
      for (const ws of await client.workspaces())
        for (const p of await client.projects(ws.key))
          items.push({
            label: `${ws.key}/${p.key}`,
            description: p.name,
            detail: ws.name,
            value: `${ws.key}/${p.key}`,
          });
    } catch (e) {
      return (e as Error).message;
    }
    items.push({
      label: 'No project now',
      description: 'Runs on the server need one: set it later with Change Project',
    });
    const pick = await vscode.window.showQuickPick(items, {
      title: 'Connect to Ansible Flow Server (3/3): the project of this folder',
      placeHolder: hasFlows
        ? 'This folder has flows: send them to a new project, or pick the project it is a copy of'
        : 'The project whose flows this folder gets',
      ignoreFocusOut: true,
    });
    if (!pick) return CANCELLED;
    // AFD-303: a folder with flows of its own linked to another project mixes the two: said first.
    let choice = pick.value;
    if (choice && choice !== NEW && hasFlows) {
      const send = 'New Project from This Folder…';
      const link = 'Link Anyway';
      const answer = await vscode.window.showWarningMessage(
        `This folder has flows of its own, and ${choice} is a project on the server.`,
        {
          modal: true,
          detail: `Linking copies nothing: this folder's flows stay here and ${choice}'s stay on the server; Run on Server runs only flows the project has. The Flows pane marks each flow (on server, changed here, only here) and lists the project's flows this folder does not have. To work on ${choice}'s flows, get them into an empty folder; to put this folder on the server, make a new project from it.`,
        },
        send,
        link,
      );
      if (!answer) return CANCELLED;
      if (answer === send) choice = NEW;
    }
    if (choice === NEW) {
      const made = await sendToNewProject(scope, client, url, auth);
      if (typeof made === 'string') return made;
      project = made.project;
      got = made.note;
    } else {
      project = choice;
      if (project && !hasFlows) {
        const error = await getFlowsInto(scope, client, url, project, auth, true);
        if (error && !isCancelled(error)) return error;
        if (!error) got = "; the project's flows are in this folder";
      }
    }
  }

  // Kept: the token for the address, the address and project for the folder. A token of the
  // address the folder had before is forgotten when the address changes.
  await secrets.store(tokenKey(url), token as string);
  if (before.url && before.url !== url) await secrets.delete(tokenKey(before.url));
  await before.c.update('runner.url', url, target());
  await before.c.update('runner.project', project || undefined, target());
  void vscode.window.showInformationMessage(
    `Connected to ${url} as ${me.login}${project ? `, project ${project}` : ''}${got}.`,
  );
  return undefined;
}

const NEW = '__new_project__';

/** True when the folder has a flow file of its own. */
async function folderHasFlows(scope: vscode.Uri): Promise<boolean> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(scope, '**/*.flow.yaml'),
    '**/{node_modules,.git,generated}/**',
    1,
  );
  return found.length > 0;
}

/** The project `<workspace>/<key>` as the server has it. */
async function projectNamed(client: RunnerClient, named: string): Promise<RunnerProject | string> {
  const [ws, key] = named.split('/');
  if (!ws || !key) return `"${named}" is not <workspace>/<project>`;
  try {
    return (
      (await client.projects(ws)).find((p) => p.key === key) ??
      `The server has no project ${named} that this token reaches`
    );
  } catch (e) {
    return (e as Error).message;
  }
}

/**
 * AFD-302: the project's flows into the folder (it becomes a git copy of the project). Asked first
 * when `ask`; answers an error, CANCELLED, or undefined once they are there.
 */
async function getFlowsInto(
  scope: vscode.Uri,
  client: RunnerClient,
  url: string,
  named: string,
  auth: GitAuth,
  ask: boolean,
): Promise<string | undefined> {
  const project = await projectNamed(client, named);
  if (typeof project === 'string') return project;
  if (ask) {
    const yes = "Get the Project's Flows";
    const pick = await vscode.window.showInformationMessage(
      `Get the flows of ${named} into this folder?`,
      {
        modal: true,
        detail: `The folder becomes a git copy of the project (branch ${project.gitRef}): change the flows here, and push to send them back. git asks for a password when it pulls or pushes: an access token.`,
      },
      yes,
    );
    if (pick !== yes) return CANCELLED;
  }
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Getting the flows of ${named}…` },
      () => getProjectFlows(scope.fsPath, `${url}${project.gitPath}`, project.gitRef, auth),
    );
  } catch (e) {
    return (e as Error).message;
  }
  return undefined;
}

/**
 * AFD-302: a hosted project made on the server from this folder: its workspace, key and name are
 * asked, then the folder's history is pushed to it (a folder that is not a git repository is made
 * one, asked first).
 */
async function sendToNewProject(
  scope: vscode.Uri,
  client: RunnerClient,
  url: string,
  auth: GitAuth,
): Promise<{ project: string; note: string } | string> {
  const repo = await repositoryOf(scope.fsPath);
  if (typeof repo === 'object')
    return `This folder is inside the git repository ${repo.above}: open that folder to send it`;
  let spaces: { key: string; name: string }[];
  try {
    spaces = await client.workspaces();
  } catch (e) {
    return (e as Error).message;
  }
  if (!spaces.length) return 'This token reaches no workspace of the server';
  const space =
    spaces.length === 1
      ? spaces[0]
      : await vscode.window
          .showQuickPick(
            spaces.map((w) => ({ label: w.key, description: w.name, w })),
            { title: 'New project: its workspace', ignoreFocusOut: true },
          )
          .then((p) => p?.w);
  if (!space) return CANCELLED;
  const folderName = scope.path.split('/').filter(Boolean).at(-1) ?? 'flows';
  const slug =
    folderName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 63) || 'flows';
  const key = await vscode.window.showInputBox({
    title: `New project in ${space.key}: its key`,
    prompt: 'Lower case letters, digits and dashes; part of its git address',
    value: slug,
    ignoreFocusOut: true,
    validateInput: (v) =>
      /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(v.trim())
        ? undefined
        : 'Lower case letters, digits and dashes, not starting or ending with a dash',
  });
  if (!key) return CANCELLED;
  const name = await vscode.window.showInputBox({
    title: `New project ${space.key}/${key.trim()}: its name`,
    value: folderName,
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : 'A name'),
  });
  if (!name) return CANCELLED;
  let commitAll = false;
  if (repo === 'none') {
    const yes = 'Make It a Repository and Send';
    const pick = await vscode.window.showWarningMessage(
      'This folder is not a git repository.',
      {
        modal: true,
        detail:
          'The server keeps a project as git history. The folder is made a repository with all its files in a first commit ("Flows from VS Code"), which is then sent.',
      },
      yes,
    );
    if (pick !== yes) return CANCELLED;
    commitAll = true;
  }
  let project: RunnerProject;
  try {
    project = await client.createProject(space.key, key.trim(), name.trim());
  } catch (e) {
    return (e as Error).message;
  }
  try {
    const sent = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Sending this folder to ${space.key}/${project.key}…`,
      },
      () => sendFolder(scope.fsPath, `${url}${project.gitPath}`, project.gitRef, auth, commitAll),
    );
    return {
      project: `${space.key}/${project.key}`,
      note: `; this folder was sent to it (remote ${sent.remoteName})`,
    };
  } catch (e) {
    return `The project ${space.key}/${project.key} was made, but sending the folder failed: ${(e as Error).message}`;
  }
}

/** Get the Project's Flows (the pane's welcome while connected): into this folder. */
export async function getProjectFlowsHere(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<string | undefined> {
  const { url, project, verifyTls, allowHttp } = config(scope);
  const token = url ? await secrets.get(tokenKey(url)) : undefined;
  if (!url || !token) return 'Connect to Ansible Flow Server first';
  if (!project) return "Pick the folder's project first: Change Server Project";
  const client = new RunnerClient(url, token, { verifyTls, allowHttp });
  return getFlowsInto(scope, client, url, project, { token, verifyTls }, false);
}

/** Forgets the folder's server: its token, address and project. */
export async function disconnectServer(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
  confirmed = false,
): Promise<string | undefined> {
  const { c, url } = config(scope);
  if (!url) return 'This folder is not connected to Ansible Flow Server';
  const ok = 'Disconnect';
  const pick = confirmed
    ? ok
    : await vscode.window.showWarningMessage(
        `Disconnect this folder from ${url}?`,
        {
          modal: true,
          detail:
            'The access token is forgotten. Runs on the server stay there; flows here stay as they are.',
        },
        ok,
      );
  if (pick !== ok) return CANCELLED;
  await secrets.delete(tokenKey(url));
  for (const key of ['runner.url', 'runner.project']) {
    await c.update(key, undefined, vscode.ConfigurationTarget.WorkspaceFolder).then(
      () => undefined,
      () => undefined,
    );
    await c.update(key, undefined, vscode.ConfigurationTarget.Workspace);
  }
  // An address in the user settings stays the user's: said, not changed.
  const left = config(scope).url;
  if (left)
    void vscode.window.showInformationMessage(
      `Disconnected. Your user settings still name ${left} (afd.runner.url): remove it there to forget it everywhere.`,
    );
  return undefined;
}

/** The server button's menu, while connected. */
export async function serverMenu(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<'connect' | 'disconnect' | 'project' | 'open' | 'git' | undefined> {
  const s = await serverState(scope, secrets);
  const items: (vscode.QuickPickItem & {
    id: 'connect' | 'disconnect' | 'project' | 'open' | 'git';
  })[] = [
    { id: 'open', label: '$(link-external) Open in Browser', description: s.url },
    {
      id: 'project',
      label: '$(repo) Change Project',
      description: s.project ?? 'none set',
    },
    {
      id: 'git',
      label: '$(source-control) Set Up Git for the Server…',
      description: 'trust its certificate, sign in with the token',
    },
    { id: 'connect', label: '$(plug) Connect to a Different Server…' },
    { id: 'disconnect', label: '$(debug-disconnect) Disconnect' },
  ];
  const pick = await vscode.window.showQuickPick(items, {
    title: `Ansible Flow Server: ${s.url ?? ''}`,
  });
  return pick?.id;
}

/** Picks another project of the connected server for the folder. */
export async function changeProject(
  scope: vscode.Uri,
  secrets: vscode.SecretStorage,
): Promise<string | undefined> {
  const { c, url, verifyTls, allowHttp, project } = config(scope);
  const token = url ? await secrets.get(tokenKey(url)) : undefined;
  if (!url || !token) return 'Connect to Ansible Flow Server first';
  const client = new RunnerClient(url, token, { verifyTls, allowHttp });
  const items: (vscode.QuickPickItem & { value?: string })[] = [];
  try {
    for (const ws of await client.workspaces())
      for (const p of await client.projects(ws.key))
        items.push({
          label: `${ws.key}/${p.key}`,
          description: `${p.name}${`${ws.key}/${p.key}` === project ? ' (now)' : ''}`,
          value: `${ws.key}/${p.key}`,
        });
  } catch (e) {
    return (e as Error).message;
  }
  const pick = await vscode.window.showQuickPick(items, {
    title: 'The server project of this folder',
    ignoreFocusOut: true,
  });
  if (!pick?.value) return CANCELLED;
  await c.update('runner.project', pick.value, target());
  return undefined;
}

/** The commands, and the pane's title kept in step with the settings and the kept tokens. */
export function serverCommands(host: Host): vscode.Disposable[] {
  const secrets = host.context.secrets;
  const show = () => void showServerState(host.folderUri(), secrets);
  const done = (error: string | undefined) => {
    if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
    // Open designers follow the server now (AFD-284), and the pane says which one.
    if (!error) host.server.retry();
    show();
    // AFD-302: flows that came from the server show in the pane at once.
    if (!error) void vscode.commands.executeCommand('afd.flows.refresh');
  };
  const scoped =
    (act: (scope: vscode.Uri, s: vscode.SecretStorage) => Promise<string | undefined>) =>
    async (uri?: vscode.Uri) => {
      const scope = host.folderUri(uri);
      if (!scope) {
        void vscode.window.showInformationMessage(
          'Open a folder first: the server is set for a folder of flows.',
        );
        return;
      }
      done(await act(scope, secrets));
    };
  // After activation has made the Flows pane too.
  setTimeout(show, 0);
  return [
    vscode.commands.registerCommand(CMD.runnerConnect, scoped(connectServer)),
    vscode.commands.registerCommand(CMD.runnerDisconnect, scoped(disconnectServer)),
    vscode.commands.registerCommand(CMD.runnerChangeProject, scoped(changeProject)),
    vscode.commands.registerCommand(CMD.runnerGetFlows, scoped(getProjectFlowsHere)),
    vscode.commands.registerCommand(CMD.runnerServer, async (uri?: vscode.Uri) => {
      const scope = host.folderUri(uri);
      if (!scope) return;
      const picked = await serverMenu(scope, secrets);
      if (picked === 'connect') done(await connectServer(scope, secrets));
      else if (picked === 'disconnect') done(await disconnectServer(scope, secrets));
      else if (picked === 'project') done(await changeProject(scope, secrets));
      else if (picked === 'git') void vscode.commands.executeCommand(CMD.runnerSetUpGit, scope);
      else if (picked === 'open') {
        const { url } = config(scope);
        if (url) void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }),
    secrets.onDidChange((e) => {
      if (e.key.startsWith('afd.runner.token:')) show();
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('afd.runner')) show();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(show),
  ];
}

// AFD-301: connecting a folder to Ansible Flow Server from the Flows pane. Connect asks for the
// address (checked against the server's meta), an access token (checked, kept in SecretStorage) and
// the folder's project (its git remote on the server, else picked from the server's workspaces),
// and writes afd.runner.url and afd.runner.project for the folder. Disconnect forgets them. The
// pane's title shows a connect button, or the server's with its menu, by the context key
// `afd.serverConnected`; the pane's description names the server and the project.
import * as vscode from 'vscode';
import { RunnerClient } from '../../node/runner/client';
import { CMD } from '../commands/ids';
import { CANCELLED, isCancelled } from '../errors';
import type { Host } from '../host';
import { remoteProject } from './runnerRun';

const tokenKey = (url: string) => `afd.runner.token:${url}`;
const CONTEXT = 'afd.serverConnected';

/** The flows pane, to say which server it is connected to. */
let pane: vscode.TreeView<unknown> | undefined;
export function attachFlowsPane(view: vscode.TreeView<unknown>): void {
  pane = view;
}
/** What the pane says of its server (the test API). */
export const flowsPaneDescription = (): string | undefined => pane?.description;

function config(scope: vscode.Uri) {
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

  // The project: the repository's remote on this server says it; else it is picked.
  let project = given?.project ?? (await remoteProject(url, scope));
  if (!project && !given) {
    const items: (vscode.QuickPickItem & { value?: string })[] = [];
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
      placeHolder: items.length > 1 ? 'The server project this folder is a copy of' : undefined,
      ignoreFocusOut: true,
    });
    if (!pick) return CANCELLED;
    project = pick.value;
  }

  // Kept: the token for the address, the address and project for the folder. A token of the
  // address the folder had before is forgotten when the address changes.
  await secrets.store(tokenKey(url), token as string);
  if (before.url && before.url !== url) await secrets.delete(tokenKey(before.url));
  await before.c.update('runner.url', url, target());
  await before.c.update('runner.project', project || undefined, target());
  void vscode.window.showInformationMessage(
    `Connected to ${url} as ${me.login}${project ? `, project ${project}` : ''}.`,
  );
  return undefined;
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
): Promise<'connect' | 'disconnect' | 'project' | 'open' | undefined> {
  const s = await serverState(scope, secrets);
  const items: (vscode.QuickPickItem & { id: 'connect' | 'disconnect' | 'project' | 'open' })[] = [
    { id: 'open', label: '$(link-external) Open in Browser', description: s.url },
    {
      id: 'project',
      label: '$(repo) Change Project',
      description: s.project ?? 'none set',
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
  const show = () => void showServerState(host.scopeUri(), secrets);
  const done = (error: string | undefined) => {
    if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
    // Open designers follow the server now (AFD-284), and the pane says which one.
    if (!error) host.server.retry();
    show();
  };
  const scoped =
    (act: (scope: vscode.Uri, s: vscode.SecretStorage) => Promise<string | undefined>) =>
    async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
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
    vscode.commands.registerCommand(CMD.runnerServer, async (uri?: vscode.Uri) => {
      const scope = host.scopeUri(uri);
      if (!scope) return;
      const picked = await serverMenu(scope, secrets);
      if (picked === 'connect') done(await connectServer(scope, secrets));
      else if (picked === 'disconnect') done(await disconnectServer(scope, secrets));
      else if (picked === 'project') done(await changeProject(scope, secrets));
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

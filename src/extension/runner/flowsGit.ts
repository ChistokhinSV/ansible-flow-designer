// AFD-304: git from the Flows pane, so the editor is not left for it. Commit & Push (all of the
// folder's changes, or one flow with its generated code and scenarios) and Pull; Duplicate and
// Delete of one flow. A remote that is the connected Ansible Flow Server's git address gets the
// token and the certificate setting of the connection, for that git call only (a self-signed lab
// server works as the designer's own requests do); any other remote uses git's own sign-in.
import { basename, dirname, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import { createIdFactory, SLUG } from '../../core/flow/ids';
import { copiedFlowText } from '../../core/flow/template';
import { repositoryRoot } from '../../node/history/gitLog';
import { nestedRepos } from '../../node/runner/nestedRepos';
import { commitAndPush, pullBranch, upstreamOf } from '../../node/runner/projectGit';
import { generatedDir } from '../codegen';
import { isCancelled } from '../errors';
import type { Host } from '../host';
import { gitAuthFor as authFor, offerGitSetup } from './connect';
import { setUpGit } from './gitSetup';

/**
 * The flows pane's item: a flow (`{ kind: 'flow', uri }`), or (AFD-326) a folder of flows
 * (`{ kind: 'folder', folder: {path}, base }`) or a workspace folder's root (`{ kind: 'root' }`).
 */
type FlowItem =
  | {
      kind?: string;
      uri?: vscode.Uri;
      folder?: { path?: string; uri?: vscode.Uri };
      base?: vscode.Uri;
    }
  | vscode.Uri
  | undefined;
const uriOf = (item: FlowItem): vscode.Uri | undefined =>
  item instanceof vscode.Uri ? item : item?.kind === 'flow' ? item.uri : undefined;

/** AFD-326: the folder of a folder item (or a workspace folder's root item). */
export const dirOf = (item: FlowItem): vscode.Uri | undefined => {
  if (!item || item instanceof vscode.Uri) return undefined;
  if (item.kind === 'root') return item.folder?.uri;
  if (item.kind === 'folder' && item.base)
    return item.folder?.path ? vscode.Uri.joinPath(item.base, item.folder.path) : item.base;
  return undefined;
};

/** A flow's own files: the flow, its generated playbook and its scenarios, relative to `root`. */
async function flowFiles(root: string, flow: vscode.Uri): Promise<string[]> {
  const rel = (u: vscode.Uri) => relative(root, u.fsPath).split(sep).join('/');
  const key = flow.path
    .split('/')
    .pop()
    ?.replace(/\.flow\.yaml$/, '');
  const out = [rel(flow)];
  if (key) {
    out.push(rel(vscode.Uri.joinPath(generatedDir(flow), `${key}.yml`)));
    out.push(rel(vscode.Uri.joinPath(flow, '..', `${key}.scenarios.yaml`)));
  }
  return out;
}

/**
 * AFD-324: the git repository a command works in: the flow's own (a repository inside the
 * workspace folder too), else the workspace folder's; a folder that is not one but holds
 * repositories of flows asks which. Undefined: none (said), or the question was dismissed.
 */
async function repositoryFor(
  flow: vscode.Uri | undefined,
  folder: vscode.WorkspaceFolder | undefined,
  dir?: vscode.Uri,
): Promise<{ root: string; scope: vscode.Uri } | undefined> {
  const of = (root: string) => ({ root, scope: vscode.Uri.file(root) });
  const start = dir ? dir.fsPath : flow ? dirname(flow.fsPath) : folder?.uri.fsPath;
  if (!start) return undefined;
  const root = await repositoryRoot(start);
  if (root) return of(root);
  const nested = folder ? nestedRepos(folder.uri.fsPath) : [];
  if (!nested.length) {
    void vscode.window.showErrorMessage(
      `${flow ? basename(flow.fsPath) : (folder?.name ?? 'This folder')} is not in a git repository`,
    );
    return undefined;
  }
  if (nested.length === 1) return of((nested[0] as { path: string }).path);
  const pick = await vscode.window.showQuickPick(
    nested.map((n) => ({
      label: n.name,
      description: n.project ?? n.server ?? '',
      detail: n.path,
      path: n.path,
    })),
    { title: 'Which repository?', placeHolder: `${folder?.name} holds several` },
  );
  return pick ? of(pick.path) : undefined;
}

export function flowsGitCommands(host: Host): vscode.Disposable[] {
  const secrets = host.context.secrets;
  const folderOf = (uri?: vscode.Uri) => {
    const scope = host.scopeUri(uri);
    return scope ? vscode.workspace.getWorkspaceFolder(scope) : undefined;
  };
  const fail = (e: unknown, repo?: vscode.Uri) => {
    const message = (e as Error).message ?? String(e);
    // AFD-305: git that does not trust the server's certificate is offered the setup.
    if (!isCancelled(message)) offerGitSetup(message, repo);
  };
  const refresh = () => void vscode.commands.executeCommand('afd.flows.refresh');

  async function commitPush(item?: FlowItem) {
    const flow = uriOf(item);
    const dir = dirOf(item);
    const repo = await repositoryFor(flow, folderOf(flow ?? dir), dir);
    if (!repo) return;
    try {
      // Unsaved flows are part of what is sent.
      await vscode.workspace.saveAll(false);
      const up = await upstreamOf(repo.root);
      // AFD-326: a folder sends what changed in it; the repository's top sends everything.
      const inside = dir ? relative(repo.root, dir.fsPath).split(sep).join('/') : '';
      const paths = flow ? await flowFiles(repo.root, flow) : inside ? [inside] : undefined;
      const name = flow
        ? (flow.path
            .split('/')
            .pop()
            ?.replace(/\.flow\.yaml$/, '') ?? 'the flow')
        : inside || 'flows';
      const message = await vscode.window.showInputBox({
        title: flow
          ? `Commit & Push ${name}`
          : `Commit & Push ${inside ? `${inside} in ` : ''}${basename(repo.root)}`,
        prompt: `The commit's message; then it goes to ${up.remote}/${up.branch}`,
        value: flow ? `Change ${name}` : 'Change flows',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'A message'),
      });
      if (!message) return;
      const auth = await authFor(repo.scope, up.url, secrets);
      const done = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Committing and pushing to ${up.remote}/${up.branch}…`,
        },
        () =>
          commitAndPush(repo.root, message.trim(), {
            ...(paths ? { paths } : {}),
            ...(auth ? { auth } : {}),
          }),
      );
      void vscode.window.showInformationMessage(
        done.committed
          ? `Committed and pushed to ${done.pushed}.`
          : `Nothing new to commit; pushed to ${done.pushed}.`,
      );
      refresh();
    } catch (e) {
      fail(e, repo.scope);
    }
  }

  async function pull(item?: FlowItem) {
    const flow = uriOf(item);
    const dir = dirOf(item);
    const repo = await repositoryFor(flow, folderOf(flow ?? dir), dir);
    if (!repo) return;
    try {
      await vscode.workspace.saveAll(false);
      const up = await upstreamOf(repo.root);
      const auth = await authFor(repo.scope, up.url, secrets);
      const from = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling ${up.remote}/${up.branch}…`,
        },
        () => pullBranch(repo.root, auth),
      );
      void vscode.window.showInformationMessage(`Up to date with ${from}.`);
      refresh();
    } catch (e) {
      fail(e, repo.scope);
    }
  }

  async function duplicate(item?: FlowItem) {
    const flow = uriOf(item);
    if (!flow) return;
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(flow));
      const base =
        flow.path
          .split('/')
          .pop()
          ?.replace(/\.flow\.yaml$/, '') ?? 'flow';
      const name = await vscode.window.showInputBox({
        title: 'Duplicate the flow',
        prompt: 'The copy’s name; it gets its own id and key, beside the flow',
        value: `${base} copy`,
        ignoreFocusOut: true,
        validateInput: (v) => (SLUG.test(keyOf(v)) ? undefined : 'A name with letters or digits'),
      });
      if (!name) return;
      const key = keyOf(name);
      const target = vscode.Uri.joinPath(flow, '..', `${key}.flow.yaml`);
      try {
        await vscode.workspace.fs.stat(target);
        throw new Error(`${vscode.workspace.asRelativePath(target)} is there already`);
      } catch (e) {
        if (!(e instanceof vscode.FileSystemError)) throw e;
      }
      await vscode.workspace.fs.writeFile(
        target,
        new TextEncoder().encode(copiedFlowText(text, name.trim(), key, createIdFactory())),
      );
      refresh();
      await host.openDesigner(target);
    } catch (e) {
      fail(e);
    }
  }

  async function remove(item?: FlowItem) {
    const flow = uriOf(item);
    const folder = folderOf(flow);
    if (!flow || !folder) return;
    try {
      const files: vscode.Uri[] = [];
      for (const rel of await flowFiles(folder.uri.fsPath, flow)) {
        const uri = vscode.Uri.joinPath(folder.uri, rel);
        try {
          await vscode.workspace.fs.stat(uri);
          files.push(uri);
        } catch {
          // Not there: nothing to delete.
        }
      }
      const yes = 'Delete';
      const pick = await vscode.window.showWarningMessage(
        `Delete ${vscode.workspace.asRelativePath(flow)}?`,
        {
          modal: true,
          detail: `These go to the trash: ${files.map((f) => vscode.workspace.asRelativePath(f)).join(', ')}. Commit & Push sends the deletion to the server.`,
        },
        yes,
      );
      if (pick !== yes) return;
      for (const uri of files) await vscode.workspace.fs.delete(uri, { useTrash: true });
      refresh();
    } catch (e) {
      fail(e);
    }
  }

  return [
    vscode.commands.registerCommand('afd.git.commitPush', () => commitPush()),
    vscode.commands.registerCommand('afd.git.pull', () => pull()),
    vscode.commands.registerCommand('afd.flows.commitPush', (item?: FlowItem) => commitPush(item)),
    // AFD-326: a folder of the Flows pane: what changed in it, and its repository's pull.
    vscode.commands.registerCommand('afd.flows.commitPushFolder', (item?: FlowItem) =>
      commitPush(item),
    ),
    vscode.commands.registerCommand('afd.flows.pullFolder', (item?: FlowItem) => pull(item)),
    vscode.commands.registerCommand('afd.flows.duplicate', (item?: FlowItem) => duplicate(item)),
    vscode.commands.registerCommand('afd.flows.delete', (item?: FlowItem) => remove(item)),
    vscode.commands.registerCommand('afd.runner.setUpGit', async (uri?: vscode.Uri) => {
      // AFD-324: a repository inside the workspace folder is its own scope.
      const given = uri instanceof vscode.Uri ? uri : undefined;
      const scope = given ?? host.scopeUri() ?? host.folderUri();
      if (!scope) return;
      try {
        const error = await setUpGit(scope, secrets);
        if (error && !isCancelled(error)) void vscode.window.showErrorMessage(error);
      } catch (e) {
        void vscode.window.showErrorMessage(`Git was not set up: ${(e as Error).message}`);
      }
    }),
  ];
}

/** A key from a name: lower case words joined by dashes. */
export const keyOf = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

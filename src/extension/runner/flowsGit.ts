// AFD-304: git from the Flows pane, so the editor is not left for it. Commit & Push (all of the
// folder's changes, or one flow with its generated code and scenarios) and Pull; Duplicate and
// Delete of one flow. A remote that is the connected Ansible Flow Server's git address gets the
// token and the certificate setting of the connection, for that git call only (a self-signed lab
// server works as the designer's own requests do); any other remote uses git's own sign-in.
import * as vscode from 'vscode';
import { createIdFactory, SLUG } from '../../core/flow/ids';
import { copiedFlowText } from '../../core/flow/template';
import { commitAndPush, pullBranch, upstreamOf } from '../../node/runner/projectGit';
import { generatedDir } from '../codegen';
import { isCancelled } from '../errors';
import type { Host } from '../host';
import { gitAuthFor as authFor, offerGitSetup } from './connect';
import { setUpGit } from './gitSetup';

/** The flows pane's flow item (flowsView's `{ kind: 'flow', uri }`). */
type FlowItem = { kind?: string; uri?: vscode.Uri } | vscode.Uri | undefined;
const uriOf = (item: FlowItem): vscode.Uri | undefined =>
  item instanceof vscode.Uri ? item : item?.uri;

/** A flow's own files: the flow, its generated playbook and its scenarios, relative to the folder. */
async function flowFiles(folder: vscode.WorkspaceFolder, flow: vscode.Uri): Promise<string[]> {
  const rel = (u: vscode.Uri) => vscode.workspace.asRelativePath(u, false).replaceAll('\\', '/');
  const key = flow.path
    .split('/')
    .pop()
    ?.replace(/\.flow\.yaml$/, '');
  const out = [rel(flow)];
  if (key) {
    out.push(rel(vscode.Uri.joinPath(generatedDir(flow), `${key}.yml`)));
    out.push(rel(vscode.Uri.joinPath(flow, '..', `${key}.scenarios.yaml`)));
  }
  void folder;
  return out;
}

export function flowsGitCommands(host: Host): vscode.Disposable[] {
  const secrets = host.context.secrets;
  const folderOf = (uri?: vscode.Uri) => {
    const scope = host.scopeUri(uri);
    return scope ? vscode.workspace.getWorkspaceFolder(scope) : undefined;
  };
  const fail = (e: unknown) => {
    const message = (e as Error).message ?? String(e);
    // AFD-305: git that does not trust the server's certificate is offered the setup.
    if (!isCancelled(message)) offerGitSetup(message);
  };
  const refresh = () => void vscode.commands.executeCommand('afd.flows.refresh');

  async function commitPush(item?: FlowItem) {
    const flow = uriOf(item);
    const folder = folderOf(flow);
    if (!folder) return;
    try {
      // Unsaved flows are part of what is sent.
      await vscode.workspace.saveAll(false);
      const up = await upstreamOf(folder.uri.fsPath);
      const paths = flow ? await flowFiles(folder, flow) : undefined;
      const name = flow
        ? (flow.path
            .split('/')
            .pop()
            ?.replace(/\.flow\.yaml$/, '') ?? 'the flow')
        : 'flows';
      const message = await vscode.window.showInputBox({
        title: flow ? `Commit & Push ${name}` : 'Commit & Push the folder',
        prompt: `The commit's message; then it goes to ${up.remote}/${up.branch}`,
        value: flow ? `Change ${name}` : 'Change flows',
        ignoreFocusOut: true,
        validateInput: (v) => (v.trim() ? undefined : 'A message'),
      });
      if (!message) return;
      const auth = await authFor(folder.uri, up.url, secrets);
      const done = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Committing and pushing to ${up.remote}/${up.branch}…`,
        },
        () =>
          commitAndPush(folder.uri.fsPath, message.trim(), {
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
      fail(e);
    }
  }

  async function pull(item?: FlowItem) {
    const folder = folderOf(uriOf(item));
    if (!folder) return;
    try {
      await vscode.workspace.saveAll(false);
      const up = await upstreamOf(folder.uri.fsPath);
      const auth = await authFor(folder.uri, up.url, secrets);
      const from = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Pulling ${up.remote}/${up.branch}…`,
        },
        () => pullBranch(folder.uri.fsPath, auth),
      );
      void vscode.window.showInformationMessage(`Up to date with ${from}.`);
      refresh();
    } catch (e) {
      fail(e);
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
      for (const rel of await flowFiles(folder, flow)) {
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
    vscode.commands.registerCommand('afd.flows.duplicate', (item?: FlowItem) => duplicate(item)),
    vscode.commands.registerCommand('afd.flows.delete', (item?: FlowItem) => remove(item)),
    vscode.commands.registerCommand('afd.runner.setUpGit', async (uri?: vscode.Uri) => {
      const scope = host.folderUri(uri);
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

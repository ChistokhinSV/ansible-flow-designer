// AFD-283: Ansible Flow: Set Up Flow Merging in Repository. Puts the merge driver into the
// repository (.afd/afd-merge.js, to commit), tells git which files it merges (.gitattributes, to
// commit) and sets this clone's git to call it (git settings are per clone: others run the same
// two `git config` lines, which the message gives).
import { execFile } from 'node:child_process';
import * as vscode from 'vscode';
import { MERGE_DRIVER, withMergeAttributes } from '../node/flowMerge';

const git = (cwd: string, args: string[]) =>
  new Promise<void>((done, fail) =>
    execFile('git', args, { cwd, timeout: 15_000, windowsHide: true }, (e) =>
      e ? fail(e) : done(),
    ),
  );

export async function setupFlowMerging(extensionUri: vscode.Uri, uri?: vscode.Uri): Promise<void> {
  const folder =
    (uri && vscode.workspace.getWorkspaceFolder(uri)) ?? vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('Open a folder to set up flow merging in');
    return;
  }
  await vscode.workspace.fs.copy(
    vscode.Uri.joinPath(extensionUri, 'dist', 'afd-merge.js'),
    vscode.Uri.joinPath(folder.uri, '.afd', 'afd-merge.js'),
    { overwrite: true },
  );
  const attributes = vscode.Uri.joinPath(folder.uri, '.gitattributes');
  const before = await vscode.workspace.fs.readFile(attributes).then(
    (b) => new TextDecoder().decode(b),
    () => '',
  );
  const after = withMergeAttributes(before);
  if (after !== undefined)
    await vscode.workspace.fs.writeFile(attributes, new TextEncoder().encode(after));
  try {
    const cwd = folder.uri.fsPath;
    await git(cwd, ['config', 'merge.ansible-flow.name', 'Ansible Flow Designer flow merge']);
    await git(cwd, ['config', 'merge.ansible-flow.driver', MERGE_DRIVER]);
  } catch (e) {
    void vscode.window.showErrorMessage(
      `Copied .afd/afd-merge.js, but git could not be set up here: ${(e as Error).message}`,
    );
    return;
  }
  void vscode.window.showInformationMessage(
    `Flows now merge by their steps in this clone. Commit .afd/afd-merge.js and .gitattributes; each other clone runs once: git config merge.ansible-flow.driver "${MERGE_DRIVER}"`,
  );
}

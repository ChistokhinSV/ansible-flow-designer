// Committed content of a file at HEAD and the Git user name, through the built-in Git extension's
// API (works under Remote).
import { userInfo } from 'node:os';
import * as vscode from 'vscode';

// The subset of vscode.git's API (extensions/git/src/api/git.d.ts) used here.
interface GitRepository {
  show(ref: string, path: string): Promise<string>;
  getConfig(key: string): Promise<string>;
  getGlobalConfig(key: string): Promise<string>;
}
interface GitApi {
  getRepository(uri: vscode.Uri): GitRepository | null;
}
interface GitExtension {
  getAPI(version: 1): GitApi;
}

let api: GitApi | undefined;

async function gitApi(): Promise<GitApi | undefined> {
  if (api) return api;
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    api = exports.getAPI(1);
    return api;
  } catch {
    return undefined;
  }
}

/** HEAD's text of the file, or undefined when it is not in a repository or not committed yet. */
export async function headText(uri: vscode.Uri): Promise<string | undefined> {
  const git = await gitApi();
  const repo = git?.getRepository(uri);
  if (!repo) return undefined;
  try {
    return await repo.show('HEAD', uri.fsPath);
  } catch {
    return undefined;
  }
}

/** Who records a decision (decision 13): Git user.name for the file's repository, else the OS user. */
export async function authorName(uri: vscode.Uri): Promise<string | undefined> {
  const repo = (await gitApi())?.getRepository(uri);
  for (const read of [
    () => repo?.getConfig('user.name'),
    () => repo?.getGlobalConfig('user.name'),
  ]) {
    try {
      const name = (await read())?.trim();
      if (name) return name;
    } catch {
      // Not set at this level; try the next one.
    }
  }
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

// Committed content of a file at HEAD and the Git user name, through the built-in Git extension's
// API (works under Remote).
import { userInfo } from 'node:os';
import { isAbsolute, relative, sep } from 'node:path';
import * as vscode from 'vscode';
import type { GitState } from '../core/drift/types';

// The subset of vscode.git's API (extensions/git/src/api/git.d.ts) used here.
interface GitChange {
  uri: vscode.Uri;
}
interface GitRepository {
  rootUri: vscode.Uri;
  state: {
    HEAD?: { name?: string; commit?: string };
    /** Ref type 0 is a local branch (vscode.git RefType.Head). */
    refs?: { type: number; name?: string; commit?: string }[];
    workingTreeChanges: GitChange[];
    indexChanges: GitChange[];
    untrackedChanges?: GitChange[];
  };
  show(ref: string, path: string): Promise<string>;
  getConfig(key: string): Promise<string>;
  getGlobalConfig(key: string): Promise<string>;
  getCommit(ref: string): Promise<{ hash: string; commitDate?: Date; authorDate?: Date }>;
  status(): Promise<void>;
  log(options?: { maxEntries?: number; path?: string }): Promise<GitCommit[]>;
}
interface GitCommit {
  hash: string;
  message: string;
  authorDate?: Date;
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

/**
 * Versions of a flow to compare with (AFD-57): HEAD, the other local branches, and the last commits
 * that touched the file. Empty outside a repository.
 */
export async function fileVersions(
  uri: vscode.Uri,
  commits = 15,
): Promise<{ ref: string; label: string }[]> {
  const repo = (await gitApi())?.getRepository(uri);
  if (!repo) return [];
  const head = repo.state.HEAD;
  const out = [{ ref: 'HEAD', label: `HEAD${head?.name ? ` (${head.name})` : ''}` }];
  for (const r of repo.state.refs ?? [])
    if (r.type === 0 && r.name && r.name !== head?.name)
      out.push({ ref: r.name, label: `branch ${r.name}` });
  try {
    for (const c of await repo.log({ maxEntries: commits, path: uri.fsPath })) {
      const subject = c.message.split('\n')[0]?.trim() ?? '';
      const date = c.authorDate ? ` · ${c.authorDate.toISOString().slice(0, 10)}` : '';
      out.push({ ref: c.hash, label: `${c.hash.slice(0, 7)} ${subject}${date}` });
    }
  } catch {
    // A repository without commits yet: HEAD and branches only.
  }
  return out;
}

/** The file's text at a ref (HEAD, a branch, a commit), or undefined when that version has none. */
export async function textAt(uri: vscode.Uri, ref: string): Promise<string | undefined> {
  const repo = (await gitApi())?.getRepository(uri);
  if (!repo) return undefined;
  try {
    return await repo.show(ref, uri.fsPath);
  } catch {
    return undefined;
  }
}

/**
 * Branch, HEAD commit and its time, and the uncommitted changes among the paths that matter
 * (M6 sync label). Paths are relative to `folder`, forward slashes.
 */
export async function gitState(
  folder: vscode.Uri,
  relevant: (path: string) => boolean,
): Promise<GitState | undefined> {
  const repo = (await gitApi())?.getRepository(folder);
  if (!repo) return undefined;
  // The Git extension refreshes on file events, later than a sync right after an edit.
  try {
    await repo.status();
  } catch {
    // Keep the state it has.
  }
  const head = repo.state.HEAD;
  let when: string | undefined;
  if (head?.commit) {
    try {
      const c = await repo.getCommit(head.commit);
      when = (c.commitDate ?? c.authorDate)?.toISOString();
    } catch {
      // A fresh repository without commits.
    }
  }
  const changes = [
    ...repo.state.workingTreeChanges,
    ...repo.state.indexChanges,
    ...(repo.state.untrackedChanges ?? []),
  ];
  const dirty = [
    ...new Set(
      changes
        .map((c) => relative(folder.fsPath, c.uri.fsPath))
        .filter((p) => p && !p.startsWith('..') && !isAbsolute(p))
        .map((p) => p.split(sep).join('/'))
        .filter(relevant),
    ),
  ].sort();
  return { branch: head?.name, commit: head?.commit?.slice(0, 7), sha: head?.commit, when, dirty };
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

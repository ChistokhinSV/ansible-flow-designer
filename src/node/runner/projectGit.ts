// AFD-302: a folder and a project of Ansible Flow Server over git. Getting the project's flows
// makes the folder a copy of the project (init, fetch, check out its branch from the server's git
// address); sending the folder makes it the history of a new hosted project (push). The token goes
// to git in its environment (GIT_CONFIG_*), never on the command line or into .git/config, and is
// taken out of whatever git says.
import { execFile } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { porcelainPaths } from '../../core/view/serverFlows';

export interface GitAuth {
  token: string;
  /** False for a lab server with a self-signed certificate (afd.runner.verifyTls). */
  verifyTls: boolean;
}

export class ProjectGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProjectGitError';
  }
}

function git(
  cwd: string,
  args: string[],
  auth?: GitAuth,
  timeoutMs = 120_000,
  /** As git wrote it: `-z` output starts with a status that may be a space. */
  raw = false,
): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (auth) {
    env.GIT_CONFIG_COUNT = '1';
    env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
    env.GIT_CONFIG_VALUE_0 = `Authorization: Bearer ${auth.token}`;
    if (!auth.verifyTls) env.GIT_SSL_NO_VERIFY = '1';
  }
  return new Promise((done, fail) => {
    execFile(
      'git',
      args,
      { cwd, env, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (!error) return done(raw ? stdout : stdout.trim());
        let said = `${stderr || error.message}`.trim();
        if (auth) said = said.split(auth.token).join('***');
        fail(new ProjectGitError(said.split('\n').slice(-3).join(' ')));
      },
    );
  });
}

/** Where the folder's git repository is: `none`, the folder itself, or a folder above it. */
export async function repositoryOf(folder: string): Promise<'none' | 'self' | { above: string }> {
  try {
    const top = await git(folder, ['rev-parse', '--show-toplevel']);
    return resolve(top).toLowerCase() === resolve(folder).toLowerCase() ? 'self' : { above: top };
  } catch {
    return 'none';
  }
}

/** True when the folder holds nothing but VS Code's own settings. */
export function folderIsEmpty(folder: string): boolean {
  return readdirSync(folder).every((name) => name === '.vscode');
}

/**
 * Makes the folder a copy of the project: a new repository whose `origin` is the project's git
 * address, with the project's branch checked out. Files already in the folder stay; one the
 * project also has stops it with git's reason.
 */
export async function getProjectFlows(
  folder: string,
  remote: string,
  branch: string,
  auth: GitAuth,
): Promise<void> {
  const repo = await repositoryOf(folder);
  if (repo !== 'none')
    throw new ProjectGitError(
      repo === 'self'
        ? 'This folder is already a git repository: clone the project into an empty folder instead'
        : `This folder is inside the git repository ${repo.above}: use an empty folder of its own`,
    );
  await git(folder, ['init', '-q', '-b', branch]);
  try {
    await git(folder, ['remote', 'add', 'origin', remote]);
    try {
      await git(folder, ['fetch', '-q', 'origin', branch], auth);
    } catch (e) {
      throw new ProjectGitError(
        /couldn't find remote ref|not found/i.test((e as Error).message)
          ? `The project has nothing on ${branch} yet`
          : (e as Error).message,
      );
    }
    await git(folder, ['checkout', '-q', '-B', branch, '--track', `origin/${branch}`]);
  } catch (e) {
    // Nothing half-made is left behind: the folder is as it was.
    rmSync(join(folder, '.git'), { recursive: true, force: true });
    throw e;
  }
}

/**
 * Sends the folder's history to a new project's branch. A folder that is not a repository is made
 * one with all its files committed, only when `commitAll` says so. The project's address becomes
 * the remote `origin` (or `afs` when `origin` is another one).
 */
export async function sendFolder(
  folder: string,
  remote: string,
  branch: string,
  auth: GitAuth,
  commitAll: boolean,
): Promise<{ remoteName: string; committed: boolean }> {
  const repo = await repositoryOf(folder);
  if (typeof repo === 'object')
    throw new ProjectGitError(
      `This folder is inside the git repository ${repo.above}: open that folder to send it`,
    );
  let committed = false;
  if (repo === 'none') {
    if (!commitAll) throw new ProjectGitError('This folder is not a git repository');
    await git(folder, ['init', '-q', '-b', branch]);
    await git(folder, ['add', '-A']);
    await git(folder, ['commit', '-q', '-m', 'Flows from VS Code']).catch((e: Error) => {
      throw new ProjectGitError(
        /user\.(name|email)|Author identity/i.test(e.message)
          ? 'git does not know who you are: set user.name and user.email (git config --global), then try again'
          : e.message,
      );
    });
    committed = true;
  } else if (!(await git(folder, ['rev-parse', '--verify', '-q', 'HEAD']).catch(() => ''))) {
    throw new ProjectGitError('The repository has no commit yet: commit the flows first');
  }
  const remotes = (await git(folder, ['remote'])).split('\n').filter(Boolean);
  let remoteName = 'origin';
  if (remotes.includes('origin')) {
    const there = await git(folder, ['remote', 'get-url', 'origin']);
    remoteName = there === remote ? 'origin' : 'afs';
  }
  if (!remotes.includes(remoteName)) await git(folder, ['remote', 'add', remoteName, remote]);
  else await git(folder, ['remote', 'set-url', remoteName, remote]);
  await git(folder, ['push', '-q', remoteName, `HEAD:refs/heads/${branch}`], auth);
  return { remoteName, committed };
}

/**
 * AFD-303: the paths of the folder (its own repository) that differ from the server's commit: the
 * working tree, the index, untracked files, and commits made since that commit. `behind`: the
 * server has a commit this repository does not (pull to get it); then only the working tree and
 * the index are compared.
 */
export async function changedSince(
  folder: string,
  serverCommit: string | undefined,
): Promise<{ changed: Set<string>; behind: boolean } | undefined> {
  if ((await repositoryOf(folder)) !== 'self') return undefined;
  const status = await git(
    folder,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    undefined,
    60_000,
    true,
  );
  const changed = new Set(porcelainPaths(status));
  let behind = false;
  if (serverCommit) {
    const known = await git(folder, ['cat-file', '-e', `${serverCommit}^{commit}`]).then(
      () => true,
      () => false,
    );
    if (!known) behind = true;
    else {
      for (const p of (await git(folder, ['diff', '--name-only', serverCommit, 'HEAD']))
        .split('\n')
        .filter(Boolean))
        changed.add(p);
      behind = !(await git(folder, ['merge-base', '--is-ancestor', serverCommit, 'HEAD']).then(
        () => true,
        () => false,
      ));
    }
  }
  return { changed, behind };
}

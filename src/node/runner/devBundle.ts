// AFD-282: someone's unpushed work as a git bundle, for a dev run on Ansible Flow Server
// (AFS-26). The work is HEAD, or, with uncommitted changes, a commit of the working tree made with
// a temporary index: the user's index, working tree and branches are not touched. It is bundled
// from the server's commit when this repository has it (the server has everything before it),
// else with its whole history.
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const REF = 'refs/afd-dev/run';

function git(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      {
        cwd,
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...env },
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        error
          ? reject(new Error(stderr.trim().split('\n').at(-1) || error.message))
          : resolve(stdout.trim()),
    );
  });
}

export interface DevWork {
  /** The commit the bundle holds: HEAD, or the commit of the working tree. */
  commit: string;
  /** It has uncommitted changes in it. */
  uncommitted: boolean;
  /** Bundled from the server's commit (else the whole history). */
  fromServer: boolean;
  bundle: Buffer;
}

/**
 * The work in the repository at `root` as a bundle, or undefined when it is the server's commit
 * (nothing to send).
 */
export async function devBundle(root: string, serverCommit: string): Promise<DevWork | undefined> {
  const dir = await mkdtemp(join(tmpdir(), 'afd-dev-'));
  try {
    const head = await git(root, ['rev-parse', 'HEAD']);
    const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=all'])) !== '';
    let commit = head;
    if (dirty) {
      // A commit of everything as it is now (what `git add -A` would stage, ignored files left
      // out), made with an index of its own.
      const env = { GIT_INDEX_FILE: join(dir, 'index') };
      await git(root, ['read-tree', 'HEAD'], env);
      await git(root, ['add', '-A'], env);
      const tree = await git(root, ['write-tree'], env);
      commit = await git(
        root,
        ['commit-tree', tree, '-p', head, '-m', 'Work in progress: a dev run from VS Code'],
        // The commit is the extension's, whoever has no git identity set up.
        {
          GIT_AUTHOR_NAME: 'Ansible Flow Designer',
          GIT_AUTHOR_EMAIL: 'dev-run@ansible-flow.invalid',
          GIT_COMMITTER_NAME: 'Ansible Flow Designer',
          GIT_COMMITTER_EMAIL: 'dev-run@ansible-flow.invalid',
        },
      );
    }
    if (commit === serverCommit) return undefined;
    const fromServer = await git(root, ['cat-file', '-e', `${serverCommit}^{commit}`]).then(
      () => true,
      () => false,
    );
    const file = join(dir, 'work.bundle');
    await git(root, ['update-ref', REF, commit]);
    try {
      try {
        await git(root, [
          'bundle',
          'create',
          '--quiet',
          file,
          REF,
          ...(fromServer ? [`^${serverCommit}`] : []),
        ]);
      } catch (e) {
        // Nothing new since the server's commit (HEAD is behind it): the whole history, then.
        if (!fromServer || !/empty bundle/i.test((e as Error).message)) throw e;
        await git(root, ['bundle', 'create', '--quiet', file, REF]);
      }
    } finally {
      await git(root, ['update-ref', '-d', REF]).catch(() => undefined);
    }
    return { commit, uncommitted: dirty, fromServer, bundle: await readFile(file) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

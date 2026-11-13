// AFD-282: the work sent for a dev run on Ansible Flow Server, made in a real git repository:
// nothing when it is the server's commit; committed work bundled from the server's commit;
// uncommitted work (untracked files too) as a commit made beside the user's index, which stays as
// it was; the whole history when the server's commit is not here. A clone at the server's commit
// takes every bundle.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { devBundle } from '../../../src/node/runner/devBundle';

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Rita Okafor',
  GIT_AUTHOR_EMAIL: 'rita@example.net',
  GIT_COMMITTER_NAME: 'Rita Okafor',
  GIT_COMMITTER_EMAIL: 'rita@example.net',
};
const root = mkdtempSync(join(tmpdir(), 'afd-devbundle-'));
const repo = join(root, 'repo');
const server = join(root, 'server.git');
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
let base = '';

/** The server's side: a bare clone at `base` takes the bundle; what commit it holds. */
function take(bundle: Buffer): string {
  const file = join(root, `b-${Date.now()}.bundle`);
  writeFileSync(file, bundle);
  git(server, 'bundle', 'verify', '--quiet', file);
  const head = git(server, 'bundle', 'list-heads', file).split(' ')[0] as string;
  git(server, 'bundle', 'unbundle', file);
  return head;
}

beforeAll(() => {
  git(root, 'init', '-q', '-b', 'main', repo);
  git(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'hello.flow.yaml'), 'flow: one\n');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'one');
  base = git(repo, 'rev-parse', 'HEAD');
  git(root, 'clone', '-q', '--bare', repo, server);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('the work of a dev run', () => {
  it("is nothing when it is the server's commit", async () => {
    expect(await devBundle(repo, base)).toBeUndefined();
  });

  it("is a bundle of the commits since the server's", async () => {
    writeFileSync(join(repo, 'hello.flow.yaml'), 'flow: two\n');
    git(repo, 'commit', '-q', '-am', 'two');
    const work = await devBundle(repo, base);
    expect(work).toMatchObject({ uncommitted: false, fromServer: true });
    expect(work?.commit).toBe(git(repo, 'rev-parse', 'HEAD'));
    expect(take(work?.bundle as Buffer)).toBe(work?.commit);
    // The temporary ref is gone again.
    expect(git(repo, 'for-each-ref', 'refs/afd-dev')).toBe('');
  });

  it('takes uncommitted changes and new files, and leaves the index as it was', async () => {
    writeFileSync(join(repo, 'hello.flow.yaml'), 'flow: three\n');
    writeFileSync(join(repo, 'new.flow.yaml'), 'flow: new\n');
    git(repo, 'add', 'hello.flow.yaml');
    const staged = git(repo, 'diff', '--cached', '--name-only');
    const head = git(repo, 'rev-parse', 'HEAD');
    const work = await devBundle(repo, base);
    expect(work?.uncommitted).toBe(true);
    expect(work?.commit).not.toBe(head);
    expect(git(repo, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(repo, 'diff', '--cached', '--name-only')).toBe(staged);
    expect(git(repo, 'status', '--porcelain')).toContain('?? new.flow.yaml');
    const commit = take(work?.bundle as Buffer);
    expect(git(server, 'show', `${commit}:new.flow.yaml`)).toBe('flow: new');
    expect(git(server, 'show', `${commit}:hello.flow.yaml`)).toBe('flow: three');
  });

  it("carries the whole history when the server's commit is not here", async () => {
    const work = await devBundle(repo, 'f'.repeat(40));
    expect(work?.fromServer).toBe(false);
    const fresh = join(root, 'fresh.git');
    git(root, 'init', '-q', '--bare', fresh);
    const file = join(root, 'whole.bundle');
    writeFileSync(file, work?.bundle as Buffer);
    git(fresh, 'bundle', 'verify', '--quiet', file);
  });
});

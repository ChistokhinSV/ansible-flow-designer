// A colleague's change arriving as a Git pull would bring it (round 3 T16, round 4 D10): the
// participant's work so far is committed, then the colleague's edit lands as a commit of theirs.
// Shared by round3/ and round4/ (AFD-109).
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OutsideChange, SessionDirs } from './study';

export function git(cwd: string, args: string[]): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr.trim()}`);
  return r.stdout;
}

/**
 * When the designer last remembered a flow (its shown store, AFD-92), or undefined if it never
 * did: then reopening it marks nothing, and the analysis has to know.
 */
export function shownAt(dirs: SessionDirs, file: string): string | undefined {
  const base = join(dirs.profile, 'User', 'workspaceStorage');
  if (!existsSync(base)) return undefined;
  const tail = file.replaceAll('\\', '/').toLowerCase();
  for (const ws of readdirSync(base)) {
    const index = join(base, ws, 'afd-dev.ansible-flow-designer', 'shown', 'index.json');
    if (!existsSync(index)) continue;
    const entries = JSON.parse(readFileSync(index, 'utf8')) as Record<
      string,
      { uri: string; at: string }
    >;
    const hit = Object.values(entries).find((e) =>
      decodeURIComponent(e.uri).toLowerCase().endsWith(tail),
    );
    if (hit) return hit.at;
  }
  return undefined;
}

/** Commits the work so far, applies `change` and commits it as the colleague. */
export async function colleagueCommit(
  dirs: SessionDirs,
  file: string,
  colleague: { name: string; email: string },
  message: string,
  change: () => Promise<void>,
): Promise<OutsideChange> {
  const root = dirs.workspace;
  const seen = shownAt(dirs, file);
  git(root, ['add', '-A']);
  // Nothing to commit is fine: the participant may have saved nothing since the start.
  spawnSync('git', ['commit', '-q', '-m', 'Work so far'], { cwd: root });
  await change();
  git(root, ['add', '-A']);
  git(root, [
    '-c',
    `user.name=${colleague.name}`,
    '-c',
    `user.email=${colleague.email}`,
    'commit',
    '-q',
    '-m',
    message,
  ]);
  return {
    file,
    message: `A colleague's change to ${file} has arrived, as a Git pull would bring it. Look at it in VS Code now.`,
    facts: { shownAt: seen ?? 'never', at: new Date().toISOString() },
  };
}

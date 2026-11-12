// AFD-247: copies a folder of this machine to the SSH host, and keeps the copy current. The files
// are the ones Git would see (tracked, and untracked ones no .gitignore names), as they are on
// disk now: uncommitted work runs. They travel as a tar archive through the connection.
//
// After the first copy only what changed is sent: each file's size and time are remembered, and
// files that are gone here are deleted there. The first copy of a session empties the folder on
// the host, since nothing is known of what an earlier session, or another person on a shared
// account, left in it.
import { execFile } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type SshTarget, SYNC_LISTS, syncCommand } from '../../core/run/ssh';
import { pipe, sshWhy, tarExe } from './exec';

interface Entry {
  /** Size and modification time: a file with the same two is taken as unchanged. */
  stamp: string;
  exec: boolean;
}

/** What was last sent, per host, folder there and folder here. */
const sent = new Map<string, Map<string, Entry>>();

/** Forgets what was sent: the next sync copies everything again (tests, a changed host). */
export function forgetSynced(): void {
  sent.clear();
}

function git(root: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['-C', root, ...args],
      { maxBuffer: 64 * 1024 * 1024, windowsHide: true },
      (error, stdout) => resolve(error ? undefined : stdout),
    );
  });
}

/** Every file under a folder, for one that is not a Git repository; `.git` is never copied. */
function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
    const path = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (e.name !== '.git' && e.name !== 'node_modules') out.push(...walk(root, path));
    } else if (e.isFile()) out.push(path);
  }
  return out;
}

/** The files to copy, relative with forward slashes, and which of them Git marks executable. */
export async function listFiles(
  root: string,
  include: readonly string[] = [],
): Promise<{ files: string[]; exec: Set<string> }> {
  const listed = await git(root, ['ls-files', '-co', '--exclude-standard', '-z']);
  // Not a repository, or a folder a repository above it ignores whole: every file under it.
  if (listed === undefined || listed === '') return { files: walk(root), exec: new Set() };
  // `include`: folders copied whatever .gitignore says (code generated for one run).
  const also = include.flatMap((dir) => {
    try {
      return walk(root, dir.replace(/\/+$/, ''));
    } catch {
      return [];
    }
  });
  const files = [...new Set([...listed.split('\0').filter(Boolean), ...also])];
  const exec = new Set<string>();
  // `100755 <hash> 0\t<path>`: the mode Git keeps, which Windows has no other way to know.
  const staged = (await git(root, ['ls-files', '-s', '-z'])) ?? '';
  for (const line of staged.split('\0')) {
    const tab = line.indexOf('\t');
    if (tab > 0 && line.startsWith('100755')) exec.add(line.slice(tab + 1));
  }
  return { files, exec };
}

function manifest(root: string, files: string[], exec: Set<string>): Map<string, Entry> {
  const out = new Map<string, Entry>();
  for (const f of files) {
    try {
      const st = statSync(join(root, f));
      if (!st.isFile()) continue;
      const mode = process.platform === 'win32' ? exec.has(f) : (st.mode & 0o100) !== 0;
      out.set(f, { stamp: `${st.size}:${Math.floor(st.mtimeMs)}`, exec: mode });
    } catch {
      // Listed by Git, gone from disk (deleted, not committed yet): not copied.
    }
  }
  return out;
}

export interface SyncResult {
  ok: boolean;
  /** Files sent and files deleted on the host. */
  sent: number;
  removed: number;
  error?: string;
}

/** One sync at a time per folder on the host: a second one waits, then finds nothing to send. */
const queue = new Map<string, Promise<unknown>>();

/**
 * Makes `<target.dir>/<into>` on the host hold the files of `root`. Nothing is run when nothing
 * changed since the last sync of this session.
 */
export function syncFolder(
  target: SshTarget,
  root: string,
  into: string,
  /** Folders of `root` copied whatever .gitignore says. */
  include: readonly string[] = [],
): Promise<SyncResult> {
  const key = `${target.host}|${target.dir}|${into}`;
  const turn = (queue.get(key) ?? Promise.resolve()).then(
    () => syncNow(target, root, into, include),
    () => syncNow(target, root, into, include),
  );
  queue.set(
    key,
    turn.catch(() => undefined),
  );
  return turn;
}

async function syncNow(
  target: SshTarget,
  root: string,
  into: string,
  /** Folders of `root` copied whatever .gitignore says. */
  include: readonly string[] = [],
): Promise<SyncResult> {
  const key = `${target.host}|${target.dir}|${into}|${root}`;
  const before = sent.get(key);
  const { files, exec } = await listFiles(root, include);
  const now = manifest(root, files, exec);
  const changed = [...now.keys()].filter((f) => {
    const was = before?.get(f);
    return !was || was.stamp !== now.get(f)?.stamp || was.exec !== now.get(f)?.exec;
  });
  const removed = before ? [...before.keys()].filter((f) => !now.has(f)) : [];
  if (before && changed.length === 0 && removed.length === 0)
    return { ok: true, sent: 0, removed: 0 };

  const lists = mkdtempSync(join(tmpdir(), 'afd-sync-'));
  try {
    const nul = (items: string[]) => (items.length ? `${items.join('\0')}\0` : '');
    writeFileSync(join(lists, SYNC_LISTS.remove), nul(removed));
    writeFileSync(join(lists, SYNC_LISTS.sent), nul(changed));
    writeFileSync(join(lists, SYNC_LISTS.exec), nul(changed.filter((f) => now.get(f)?.exec)));
    // The names to archive, one a line: file names with a newline in them are not copied.
    const plain = changed.filter((f) => !/[\r\n]/.test(f));
    writeFileSync(join(lists, 'files'), plain.join('\n') + (plain.length ? '\n' : ''));
    // Two archives, one after the other on the same connection: the lists, then the files. One
    // tar cannot take both folders with a list of names (bsdtar and GNU tar differ there).
    const tars = [
      { command: tarExe(), args: ['-cf', '-', ...Object.values(SYNC_LISTS)], cwd: lists },
      ...(plain.length
        ? [{ command: tarExe(), args: ['-cf', '-', '-T', join(lists, 'files')], cwd: root }]
        : []),
    ];
    const there = syncCommand(target, {
      into,
      clean: !before,
      fixModes: process.platform === 'win32',
    });
    const r = await pipe(tars, there, { timeoutMs: 600_000 });
    if (r.from !== 0 || r.to !== 0) {
      sent.delete(key);
      return {
        ok: false,
        sent: 0,
        removed: 0,
        error: `Could not copy the files to ${target.host}: ${sshWhy(r.stderr)}`,
      };
    }
    sent.set(key, now);
    return { ok: true, sent: plain.length, removed: removed.length };
  } finally {
    rmSync(lists, { recursive: true, force: true });
  }
}

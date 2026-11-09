// How terminal agents start the flow MCP server (AFD-19). The server is copied out of the
// extension folder (which changes with every update) to global storage, so registrations survive
// updates; it runs on Node when Node 20+ is on PATH, else on VS Code's own runtime.
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { delimiter, join } from 'node:path';
import type * as vscode from 'vscode';
import type { Launch } from '../../node/ai/writers';

/**
 * What goes to global storage, in this order: what mcp.js loads (elk.js, and probe/ for
 * flow_scenarios' Ansible runs, which looks for it beside the running mcp.js) before mcp.js, so
 * an agent that starts the new mcp.js finds them. The stamp is written last.
 */
const PARTS = [
  { name: 'elk.js', tree: false },
  { name: 'probe', tree: true },
  { name: 'mcp.js', tree: false },
] as const;

/** What was copied: each source's size and modification time (no hashing at startup). */
interface PartStamp {
  size: number;
  mtimeMs: number;
  /** A folder: how many files. */
  files?: number;
}
type Stamp = Record<string, PartStamp>;

async function stampOf(path: string): Promise<PartStamp | undefined> {
  try {
    const s = await fs.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/** A folder's files: total size, newest change, count. Python's bytecode caches do not count. */
async function treeStamp(dir: string): Promise<PartStamp | undefined> {
  const stamp = { size: 0, mtimeMs: 0, files: 0 };
  const walk = async (d: string): Promise<void> => {
    for (const e of await fs.readdir(d, { withFileTypes: true })) {
      if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
      const path = join(d, e.name);
      if (e.isDirectory()) await walk(path);
      else {
        const s = await fs.stat(path);
        stamp.size += s.size;
        stamp.mtimeMs = Math.max(stamp.mtimeMs, s.mtimeMs);
        stamp.files++;
      }
    }
  };
  try {
    await walk(dir);
  } catch {
    return undefined;
  }
  return stamp;
}

/** Unique per process and call: two windows (two extension hosts) may install at once. */
const tag = () => `${process.pid}-${randomBytes(4).toString('hex')}`;

const code = (e: unknown) => (e as NodeJS.ErrnoException).code;

/** rename over the old file, retried briefly: on Windows a scanner may hold it for a moment. */
async function renameOver(tmp: string, to: string): Promise<void> {
  for (let i = 0; ; i++) {
    try {
      await fs.rename(tmp, to);
      return;
    } catch (e) {
      if (i >= 4 || !['EPERM', 'EBUSY', 'EACCES'].includes(code(e) ?? '')) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      await new Promise((r) => setTimeout(r, 50 * (i + 1)));
    }
  }
}

/** A temporary copy beside the target, then a rename: an agent never starts a half-copied file. */
async function replaceFile(from: string, to: string): Promise<void> {
  const tmp = `${to}.${tag()}.tmp`;
  try {
    await fs.copyFile(from, tmp);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
  await renameOver(tmp, to);
}

async function writeAtomic(to: string, text: string): Promise<void> {
  const tmp = `${to}.${tag()}.tmp`;
  await fs.writeFile(tmp, text, 'utf8');
  await renameOver(tmp, to);
}

async function copyTree(from: string, to: string): Promise<void> {
  await fs.mkdir(to, { recursive: true });
  for (const e of await fs.readdir(from, { withFileTypes: true })) {
    if (e.name === '__pycache__' || e.name.endsWith('.pyc')) continue;
    if (e.isDirectory()) await copyTree(join(from, e.name), join(to, e.name));
    else await fs.copyFile(join(from, e.name), join(to, e.name));
  }
}

/**
 * A folder copied beside the target, then swapped in (a folder cannot be renamed over another):
 * the old one moves aside, the new one takes its name, the old one goes.
 */
async function replaceTree(from: string, to: string): Promise<void> {
  const fresh = `${to}.${tag()}.new`;
  const old = `${to}.${tag()}.old`;
  try {
    await copyTree(from, fresh);
  } catch (e) {
    await fs.rm(fresh, { recursive: true, force: true });
    throw e;
  }
  let moved = false;
  try {
    await fs.rename(to, old);
    moved = true;
  } catch (e) {
    // Missing: the first install, or another window moved it aside a moment ago.
    if (code(e) !== 'ENOENT') {
      await fs.rm(fresh, { recursive: true, force: true });
      throw e;
    }
  }
  try {
    await fs.rename(fresh, to);
  } catch (e) {
    await fs.rm(fresh, { recursive: true, force: true });
    // Another window put the same files in place first; otherwise put the old ones back.
    if (!(await stampOf(to))) {
      if (moved) await fs.rename(old, to).catch(() => undefined);
      throw e;
    }
  }
  if (moved) await fs.rm(old, { recursive: true, force: true }).catch(() => undefined);
}

/** Where the server is installed (whether or not it is there yet). */
export const serverPath = (context: Pick<vscode.ExtensionContext, 'globalStorageUri'>) =>
  join(context.globalStorageUri.fsPath, 'mcp', 'mcp.js');

async function install(extension: string, dir: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const stampFile = join(dir, 'installed.json');
  let installed: Stamp = {};
  try {
    installed = JSON.parse(await fs.readFile(stampFile, 'utf8')) as Stamp;
  } catch {}
  let changed = false;
  for (const { name, tree } of PARTS) {
    const from = join(extension, 'dist', name);
    const to = join(dir, name);
    const src = await (tree ? treeStamp(from) : stampOf(from));
    if (!src) continue;
    const was = installed[name];
    const there = await (tree ? treeStamp(to) : stampOf(to));
    const same =
      was?.size === src.size &&
      was.mtimeMs === src.mtimeMs &&
      was.files === src.files &&
      there?.size === src.size &&
      there.files === src.files;
    if (same) continue;
    await (tree ? replaceTree(from, to) : replaceFile(from, to));
    installed[name] = src;
    changed = true;
  }
  if (changed) await writeAtomic(stampFile, JSON.stringify(installed));
  return join(dir, 'mcp.js');
}

/** Installs in progress, by folder: activation asks from more than one place at once. */
const installing = new Map<string, Promise<string>>();

/**
 * Copies the server into global storage when it changed; returns its path there. "Changed" is the
 * source's size or modification time against what was copied (AFD-37: hashing ~2.4 MB at every
 * start was the slowest part of activation after an AI setup), or a copy that is not all there.
 * AFD-195: run at every start; each file lands by rename, so an agent starting the server while
 * it is copied gets the old one or the new one, never part of one.
 */
export function installServer(
  context: Pick<vscode.ExtensionContext, 'globalStorageUri' | 'extensionUri'>,
): Promise<string> {
  const dir = join(context.globalStorageUri.fsPath, 'mcp');
  let running = installing.get(dir);
  if (!running) {
    running = install(context.extensionUri.fsPath, dir).finally(() => installing.delete(dir));
    installing.set(dir, running);
  }
  return running;
}

/** A program on PATH (with Windows extensions), or undefined. */
export async function onPath(name: string): Promise<string | undefined> {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';')
      : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean))
    for (const ext of process.platform === 'win32' ? exts : ['']) {
      const file = join(dir, name + ext);
      try {
        if ((await fs.stat(file)).isFile()) return file;
      } catch {}
    }
  return undefined;
}

/**
 * Several programs at once: each PATH folder is listed once instead of a stat per name and
 * extension, so the check after startup stays cheap. Returns name -> path for those found.
 */
export async function programsOnPath(names: string[]): Promise<Map<string, string>> {
  const exts =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').toLowerCase().split(';').filter(Boolean)
      : [''];
  const wanted = new Map<string, string>();
  for (const n of names) for (const e of exts) wanted.set(`${n}${e}`.toLowerCase(), n);
  const found = new Map<string, string>();
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const name = wanted.get(entry.toLowerCase());
      if (name && !found.has(name)) found.set(name, join(dir, entry));
    }
  }
  return found;
}

function nodeMajor(path: string): Promise<number> {
  return new Promise((done) =>
    execFile(path, ['--version'], { timeout: 5000, windowsHide: true }, (err, out) =>
      done(err ? 0 : Number(/^v(\d+)/.exec(out.trim())?.[1] ?? 0)),
    ),
  );
}

export async function launchFor(server: string): Promise<Launch> {
  const node = await onPath('node');
  if (node && (await nodeMajor(node)) >= 20) return { command: 'node', args: [server] };
  // VS Code's runtime is Electron; ELECTRON_RUN_AS_NODE makes it plain Node.
  return { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/**
 * AFD-174: for agents started by a desktop app (the editors' built-in agents), an absolute command:
 * such an app may not have the shell's PATH. Node 20+ when installed, else the editor's runtime.
 */
export async function absoluteLaunch(server: string): Promise<Launch> {
  const node = await onPath('node');
  if (node && (await nodeMajor(node)) >= 20) return { command: node, args: [server] };
  return { command: process.execPath, args: [server], env: { ELECTRON_RUN_AS_NODE: '1' } };
}

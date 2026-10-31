// How terminal agents start the flow MCP server (AFD-19). The server is copied out of the
// extension folder (which changes with every update) to global storage, so registrations survive
// updates; it runs on Node when Node 20+ is on PATH, else on VS Code's own runtime.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { delimiter, join } from 'node:path';
import type * as vscode from 'vscode';
import type { Launch } from '../../node/ai/writers';

const FILES = ['mcp.js', 'elk.js'];

/** What was copied: each source file's size and modification time (no hashing at startup). */
type Stamp = Record<string, { size: number; mtimeMs: number }>;

async function stampOf(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try {
    const s = await fs.stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return undefined;
  }
}

/**
 * Copies the server into global storage when it changed; returns its path there. "Changed" is the
 * source's size or modification time against what was copied (AFD-37: hashing ~2.4 MB at every
 * start was the slowest part of activation after an AI setup).
 */
export async function installServer(context: vscode.ExtensionContext): Promise<string> {
  const dir = join(context.globalStorageUri.fsPath, 'mcp');
  await fs.mkdir(dir, { recursive: true });
  const stampFile = join(dir, 'installed.json');
  let installed: Stamp = {};
  try {
    installed = JSON.parse(await fs.readFile(stampFile, 'utf8')) as Stamp;
  } catch {}
  let changed = false;
  for (const name of FILES) {
    const from = join(context.extensionUri.fsPath, 'dist', name);
    const to = join(dir, name);
    const src = await stampOf(from);
    if (!src) continue;
    const was = installed[name];
    const same = was && was.size === src.size && was.mtimeMs === src.mtimeMs;
    if (same && (await stampOf(to))?.size === src.size) continue;
    await fs.copyFile(from, to);
    installed[name] = src;
    changed = true;
  }
  if (changed) await fs.writeFile(stampFile, JSON.stringify(installed), 'utf8');
  return join(dir, 'mcp.js');
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

// How terminal agents start the flow MCP server (AFD-19). The server is copied out of the
// extension folder (which changes with every update) to global storage, so registrations survive
// updates; it runs on Node when Node 20+ is on PATH, else on VS Code's own runtime.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { delimiter, join } from 'node:path';
import type * as vscode from 'vscode';
import type { Launch } from './writers';

const FILES = ['mcp.js', 'elk.js'];

const digest = async (path: string) => {
  try {
    return createHash('sha256')
      .update(await fs.readFile(path))
      .digest('hex');
  } catch {
    return undefined;
  }
};

/** Copies the server into global storage when it changed; returns its path there. */
export async function installServer(context: vscode.ExtensionContext): Promise<string> {
  const dir = join(context.globalStorageUri.fsPath, 'mcp');
  await fs.mkdir(dir, { recursive: true });
  for (const name of FILES) {
    const from = join(context.extensionUri.fsPath, 'dist', name);
    const to = join(dir, name);
    const src = await digest(from);
    if (src && src !== (await digest(to))) await fs.copyFile(from, to);
  }
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

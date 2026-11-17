// AFD-323: git repositories of flows inside a folder that is not one (a folder opened above its
// projects, such as a downloads folder holding two clones). The designer's server, pull, push and
// git trust work per workspace folder, so such repositories are offered as workspace folders.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

export interface NestedRepo {
  path: string;
  name: string;
  /** afd.runner.url in its .vscode/settings.json, when it is connected to a server. */
  server?: string;
  /** afd.runner.project there. */
  project?: string;
}

const SKIP = new Set(['node_modules', '.git', '.venv', 'venv', '__pycache__', 'generated', 'out']);

/** The repository's server settings, from its own .vscode/settings.json (JSON with comments). */
export function serverOf(dir: string): { server?: string; project?: string } {
  try {
    const text = readFileSync(join(dir, '.vscode', 'settings.json'), 'utf8')
      .replace(/^\s*\/\/.*$/gm, '')
      .replace(/,(\s*[}\]])/g, '$1');
    const s = JSON.parse(text) as Record<string, unknown>;
    const server = typeof s['afd.runner.url'] === 'string' ? s['afd.runner.url'] : undefined;
    const project =
      typeof s['afd.runner.project'] === 'string' ? s['afd.runner.project'] : undefined;
    return { ...(server ? { server } : {}), ...(project ? { project } : {}) };
  } catch {
    return {};
  }
}

/**
 * AFD-324: the repository holding `path` (a file or folder) below `top` (the workspace folder,
 * whose own settings VS Code reads), or undefined when `path` is in `top`'s repository or none.
 */
export function nestedRepoOf(path: string, top: string): string | undefined {
  const norm = (p: string) => resolve(p).toLowerCase();
  const stop = norm(top);
  let dir = statSync(path, { throwIfNoEntry: false })?.isDirectory() ? path : dirname(path);
  while (norm(dir).startsWith(stop) && norm(dir) !== stop) {
    if (existsSync(join(dir, '.git'))) return dir;
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

/** True when the folder has a flow file within two levels (flows/<key>/<key>.flow.yaml). */
function hasFlows(dir: string, depth = 3): boolean {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return false;
  }
  if (names.some((n) => n.endsWith('.flow.yaml'))) return true;
  if (depth <= 0) return false;
  return names.some(
    (n) =>
      !SKIP.has(n) &&
      !n.startsWith('.') &&
      isDir(join(dir, n)) &&
      hasFlows(join(dir, n), depth - 1),
  );
}

function isDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Repositories of flows (or connected to a server) under `folder`, at most `depth` levels down and
 * `limit` folders looked at; a repository's own folders are not entered. Empty when `folder` is a
 * repository itself.
 */
export function nestedRepos(folder: string, depth = 3, limit = 400): NestedRepo[] {
  if (existsSync(join(folder, '.git'))) return [];
  const out: NestedRepo[] = [];
  let seen = 0;
  const walk = (dir: string, left: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names.sort()) {
      if (SKIP.has(n) || n.startsWith('.') || ++seen > limit) continue;
      const path = join(dir, n);
      if (!isDir(path)) continue;
      if (existsSync(join(path, '.git'))) {
        const settings = serverOf(path);
        if (settings.server || hasFlows(path))
          out.push({ path, name: basename(path), ...settings });
      } else if (left > 1) walk(path, left - 1);
    }
  };
  walk(folder, depth);
  return out;
}

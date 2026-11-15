// Roles expanded into subflows (AFD-293) against the role's files: a subflow made from a role that
// has changed since gets an info problem with Update Expanded Role, one whose role folder is gone a
// warning. The files are read from disk on each check.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { modelOf } from '../core/flow/model';
import type { FlowDocument } from '../core/flow/types';
import type { Finding } from '../core/flow/validate';
import { ROLE_PARTS, roleFingerprint } from '../core/import/expandRole';

const MAX_FILES = 500;
const MAX_BYTES = 1024 * 1024;

/** The role's files as expandRole reads them, or undefined when the folder is not there. */
export function roleFilesOnDisk(dir: string): { path: string; text: string }[] | undefined {
  try {
    if (!statSync(dir).isDirectory()) return undefined;
  } catch {
    return undefined;
  }
  const out: { path: string; text: string }[] = [];
  const walk = (rel: string, depth: number) => {
    if (depth > 6 || out.length >= MAX_FILES) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path, depth + 1);
      else if (e.isFile() && /\.ya?ml$/.test(e.name)) {
        const full = join(dir, path);
        try {
          if (statSync(full).size > MAX_BYTES) continue;
          out.push({ path, text: readFileSync(full, 'utf8') });
        } catch {}
      }
    }
  };
  for (const part of ROLE_PARTS) walk(part, 0);
  return out;
}

/** The role folder `dir` (a repository path) names, when it stays inside `root`. */
export function roleDir(root: string, dir: string): string | undefined {
  if (isAbsolute(dir) || /^[\\/]|^[A-Za-z]:|\0/.test(dir)) return undefined;
  const full = resolve(root, dir);
  const rel = relative(resolve(root), full);
  return rel.startsWith('..') || isAbsolute(rel) ? undefined : full;
}

/** Problems for the flow's expanded roles; none without a repository root. */
export function roleFindings(doc: FlowDocument, root?: string): Finding[] {
  if (!root) return [];
  const out: Finding[] = [];
  for (const { node, path } of modelOf(doc).nodes.values()) {
    const was = node.expanded_from;
    if (!was) continue;
    const label = `"${node.title}"`;
    const dir = roleDir(root, was.dir);
    const files = dir ? roleFilesOnDisk(dir) : undefined;
    if (!files)
      out.push({
        code: 'role-source',
        severity: 'warning',
        message: `${label} was expanded from role ${was.role}, whose folder ${was.dir} is gone: it runs as it is`,
        path: [...path, 'expanded_from', 'dir'],
        node: node.id,
      });
    else if (roleFingerprint(files) !== was.source)
      out.push({
        code: 'role-source',
        severity: 'info',
        message: `${label}: role ${was.role} changed since it was expanded: Update Expanded Role reads it again`,
        path: [...path, 'expanded_from', 'source'],
        node: node.id,
      });
  }
  return out;
}

// AFD-291: a step that reads a repository file (a template's or copy's source, a script, a vars
// file) whose file is not there. Generated plays read such a path from the repository root
// (core/flow/localFiles.ts), so it is looked for there, written as the step has it or already
// from `{{ afd_repo_root }}` (as import writes it).
import { existsSync } from 'node:fs';
import { join, normalize, relative } from 'node:path';
import { LOCAL_FILES, localFileOf, REPO_ROOT_VAR } from '../core/flow/localFiles';
import { modelOf } from '../core/flow/model';
import type { FlowDocument } from '../core/flow/types';
import type { Finding } from '../core/flow/validate';
import { shortName } from '../core/import/builtins';

const ROOTED = new RegExp(`^\\{\\{\\s*${REPO_ROOT_VAR}\\s*\\}\\}/(?<path>[^{}%]+)$`);

/** The repository path a step's file param names, relative or from afd_repo_root; else none. */
function repoPathOf(module: string, params: unknown): { param: string; path: string } | undefined {
  const plain = localFileOf(module, params);
  if (plain) return plain;
  const spec = LOCAL_FILES[shortName(module).replace(/^ansible\.windows\./, '')];
  if (!spec || !params || typeof params !== 'object') return undefined;
  let value = (params as Record<string, unknown>)[spec.param];
  if (spec.param === 'cmd' && typeof value === 'string') value = value.trim().split(/\s+/)[0];
  const path = typeof value === 'string' ? ROOTED.exec(value.trim())?.groups?.path : undefined;
  return path ? { param: spec.param, path } : undefined;
}

/** Warnings for steps whose repository file is missing; none without a repository root. */
export function repoFileFindings(doc: FlowDocument, root?: string): Finding[] {
  if (!root) return [];
  const out: Finding[] = [];
  for (const { node, path } of modelOf(doc).nodes.values()) {
    const impl = node.impl;
    if (impl?.kind !== 'module' || !impl.ref) continue;
    const file = repoPathOf(impl.ref, impl.params);
    if (!file) continue;
    const full = normalize(join(root, file.path));
    // A path that climbs out of the repository is not checked here.
    if (relative(root, full).startsWith('..')) continue;
    if (existsSync(full)) continue;
    out.push({
      code: 'binding-file-missing',
      severity: 'warning',
      message: `"${node.title}" reads ${file.path}, which is not in the repository: a relative path is from the repository root when the flow runs`,
      path: [...path, 'impl', 'params', file.param],
      node: node.id,
    });
  }
  return out;
}

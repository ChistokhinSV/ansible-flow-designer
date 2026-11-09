// Paths in imported bindings (AFD-176, AFD-177). Generated plays run from flows/<key>/generated,
// so `playbook_dir` points there, and Ansible does not let a play change it. The generated plays set
// `afd_repo_root`, the repository root, for the steps that read it: paths the source finds next to
// its playbook are written from there, for the as-is import and the outline alike.

import { mapStrings, renameExprRef, renameRef } from '../flow/jinja';
import { BARE_KEYWORDS } from '../flow/keywords';
import type { LocalFile } from './source';

export const REPO_ROOT = 'afd_repo_root';

/** `{{ afd_repo_root }}/<repository path>`. */
export function fromRoot(repoPath: string): string {
  const path = repoPath.replace(/^\.?\/+/, '');
  return `{{ ${REPO_ROOT} }}${path && path !== '.' ? `/${path}` : ''}`;
}

/** What `playbook_dir` was for the source play, as an expression from the repository root. */
function playDirExpr(playDir: string): string {
  const dir = playDir.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  return dir && dir !== '.' ? `(${REPO_ROOT} ~ '/${dir}')` : REPO_ROOT;
}

/** A template with every read of playbook_dir turned into the play's folder from the root. */
export function rootTemplate(text: string, playDir: string): string {
  if (!text.includes('playbook_dir')) return text;
  const dir = playDir.replace(/^\.?\/+/, '').replace(/\/+$/, '');
  // The common form, `{{ playbook_dir }}/x`, stays a plain path.
  const out = text.replaceAll(/\{\{-?\s*playbook_dir\s*-?\}\}/g, fromRoot(dir === '.' ? '' : dir));
  return out.includes('playbook_dir') ? renameRef(out, 'playbook_dir', playDirExpr(playDir)) : out;
}

/** Task keywords with playbook_dir rewritten; `when` and its kind are bare expressions. */
function rootKeywords(keywords: Record<string, unknown>, playDir: string): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(keywords).map(([k, v]) => [
      k,
      mapStrings(v, (s) =>
        BARE_KEYWORDS.has(k) && !s.includes('{{')
          ? renameExprRef(s, 'playbook_dir', playDirExpr(playDir))
          : rootTemplate(s, playDir),
      ),
    ]),
  );
}

/**
 * A task's params and keywords as they run from generated/: each local file Ansible would find
 * next to the play or task (template, copy, script, include_vars src) is written from the root,
 * and every other read of playbook_dir means the source play's folder under the root.
 */
export function localize(
  params: Record<string, unknown>,
  keywords: Record<string, unknown>,
  files: LocalFile[],
  playDir: string,
): { params: Record<string, unknown>; keywords: Record<string, unknown> } {
  const out: Record<string, unknown> = { ...params };
  for (const f of files) {
    if (!f.path) continue;
    const local = fromRoot(f.path);
    out[f.param] =
      f.param === 'cmd' && typeof out.cmd === 'string' ? out.cmd.replace(f.written, local) : local;
  }
  return {
    params: mapStrings(out, (s) => rootTemplate(s, playDir)) as Record<string, unknown>,
    keywords: rootKeywords(keywords, playDir),
  };
}

/** Whether a value still reads playbook_dir (it points at generated/ in a generated play). */
export function readsPlaybookDir(value: unknown): boolean {
  let found = false;
  mapStrings(value, (s) => {
    if (/\bplaybook_dir\b/.test(s)) found = true;
    return s;
  });
  return found;
}

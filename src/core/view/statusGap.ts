// AFD-334 (AFS-151): a step whose binding makes it implemented by the file's rule, but which would
// not run as it is: its module lacks a required parameter (from the catalog's docs), or the role it
// runs is not in the project (the host's `role-missing` finding). The canvas, its accessible name
// and Lifecycle then say "specified" and why, never "implemented". AFD-360: or what the findings
// say fails every host at run time (runFailures).

import type { NodeStatus } from '../flow/types';
import type { Finding } from '../flow/validate';

export interface StatusGap {
  /** Required module parameters not set. */
  params: readonly string[];
  /** The role bound, when the project does not have it. */
  role?: string;
  /** AFD-360: what the findings say fails every host at run time, in words. */
  fails?: readonly string[];
}

/** The finding a host adds for a step bound to a role the project does not have. */
export const ROLE_MISSING = 'role-missing';

/** The missing role of node `id`, from the host's findings. */
export function missingRole(
  findings: readonly Finding[] | undefined,
  id: string,
): string | undefined {
  const f = findings?.find((x) => x.code === ROLE_MISSING && x.node === id);
  return f ? (f.subject ?? 'its role') : undefined;
}

export function hasGap(gap: StatusGap | undefined): boolean {
  return !!gap && (gap.params.length > 0 || !!gap.role || (gap.fails?.length ?? 0) > 0);
}

const ASSERT = /^(ansible\.(builtin|legacy)\.)?assert$/;

/**
 * AFD-360: the findings about node `id` that make it fail on every host when it runs, in words: a
 * network module on hosts the inventory connects to locally, an assert on a name nothing sets.
 * Such a step showed a green implemented, and the first run failed.
 */
export function runFailures(
  findings: readonly Finding[] | undefined,
  node: { id: string; impl?: { kind?: string; ref?: string } | null },
): string[] {
  const out: string[] = [];
  for (const f of findings ?? []) {
    if (f.node !== node.id || f.severity === 'info') continue;
    if (f.code === 'binding-connection-local')
      out.push('The inventory connects to its hosts locally (ansible_connection: local)');
    else if (
      f.code === 'binding-unknown-var' &&
      node.impl?.kind === 'module' &&
      ASSERT.test(node.impl.ref ?? '') &&
      f.subject
    )
      out.push(`It asserts on ${f.subject}, which nothing sets`);
  }
  return out;
}

/** The status shown: an implemented step with a gap is specified. A tested record stays. */
export function shownStatus(status: NodeStatus, gap: StatusGap | undefined): NodeStatus {
  return status === 'implemented' && hasGap(gap) ? 'specified' : status;
}

/** What is missing, in words ("Required parameter missing: banner"). */
export function gapWords(gap: StatusGap): string {
  const parts: string[] = [];
  if (gap.params.length > 0)
    parts.push(
      `Required parameter${gap.params.length === 1 ? '' : 's'} missing: ${gap.params.join(', ')}`,
    );
  if (gap.role) parts.push(`Role ${gap.role} is not in this project`);
  for (const f of gap.fails ?? []) parts.push(f);
  return parts.join('; ');
}

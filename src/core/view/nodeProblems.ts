// A node's problems for its Details (AFD-44): which tab each one belongs to, and the problem a
// field shows under itself. Findings carry the node's path in the file plus the field they are about.

import type { Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import type { Path } from '../yaml/parse';

export type ProblemTab = 'general' | 'binding' | 'io' | 'ports' | 'execution';

export interface NodeProblem {
  finding: Finding;
  tab: ProblemTab;
  /** The node field it is about (`key`, `settings.timeout`), when one. */
  field?: string;
}

const TAB_OF: Record<string, ProblemTab> = {
  impl: 'binding',
  inputs: 'io',
  outputs: 'io',
  settings: 'execution',
  ports: 'ports',
};

/** The findings about node `id` at `nodePath`, each with its tab and field. */
export function nodeProblems(
  findings: readonly Finding[],
  id: Ulid,
  nodePath: Path,
): NodeProblem[] {
  return findings
    .filter((f) => f.node === id)
    .map((finding) => {
      const inNode =
        finding.path.length > nodePath.length &&
        nodePath.every((seg, i) => finding.path[i] === seg);
      const rest = inNode ? finding.path.slice(nodePath.length).map(String) : [];
      const head = rest[0];
      const tab: ProblemTab = finding.port ? 'ports' : (head && TAB_OF[head]) || 'general';
      const field = head === 'settings' && rest[1] ? `settings.${rest[1]}` : head;
      return { finding, tab, ...(field ? { field } : {}) };
    });
}

/** The first problem about a field, to show under it. */
export function fieldProblem(problems: readonly NodeProblem[], field: string): string | undefined {
  return problems.find((p) => p.field === field)?.finding.message;
}

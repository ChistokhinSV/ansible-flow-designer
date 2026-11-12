// AFD-236: the problems a node shows as a badge on the canvas. Errors and warnings about the node
// itself, and, on a subflow, those of the steps inside it (at any depth), so a problem is seen
// from the level above. An open fail port has its own mark and banner, and a note (info) is not a
// problem: neither counts.
import type { FlowModel } from '../flow/model';
import type { Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import { nodeProblems, type ProblemTab } from './nodeProblems';

export interface ProblemBadge {
  /** About the node itself. */
  errors: number;
  warnings: number;
  /** About steps inside it (a subflow). */
  inside: number;
  /** The worst of all of them. */
  severity: 'error' | 'warning';
  /** The Details tab of the node's first own problem, errors first. */
  tab?: ProblemTab;
  /** What the badge says on hover: the first problems, one a line. */
  title: string;
}

const OWN_MARK: ReadonlySet<string> = new Set(['open-fail-port']);
const MAX_LINES = 4;

export function problemBadges(
  model: FlowModel,
  findings: readonly Finding[],
): Map<Ulid, ProblemBadge> {
  const out = new Map<Ulid, ProblemBadge>();
  const lines = new Map<Ulid, string[]>();
  const at = (id: Ulid): ProblemBadge => {
    let b = out.get(id);
    if (!b) {
      b = { errors: 0, warnings: 0, inside: 0, severity: 'warning', title: '' };
      out.set(id, b);
    }
    return b;
  };
  // Errors first, so the tab and the first lines are those of the worst problem.
  const counted = findings
    .filter((f) => f.node && f.severity !== 'info' && !OWN_MARK.has(f.code))
    .sort((a, b) => Number(b.severity === 'error') - Number(a.severity === 'error'));
  for (const f of counted) {
    const entry = model.nodes.get(f.node as Ulid);
    if (!entry) continue;
    const own = at(entry.node.id);
    if (f.severity === 'error') {
      own.errors++;
      own.severity = 'error';
    } else own.warnings++;
    own.tab ??= nodeProblems([f], entry.node.id, entry.path)[0]?.tab;
    lines.set(entry.node.id, [...(lines.get(entry.node.id) ?? []), f.message]);
    // Up through the subflows that hold it.
    for (let up = entry.level; model.nodes.has(up); up = model.nodes.get(up)?.level as string) {
      const around = at(up);
      around.inside++;
      if (f.severity === 'error') around.severity = 'error';
    }
  }
  for (const [id, b] of out) {
    const own = lines.get(id) ?? [];
    const shown = own.slice(0, MAX_LINES);
    if (own.length > shown.length) shown.push(`…and ${own.length - shown.length} more`);
    if (b.inside > 0)
      shown.push(`${b.inside} problem${b.inside === 1 ? '' : 's'} in the steps inside`);
    b.title = shown.join('\n');
  }
  return out;
}

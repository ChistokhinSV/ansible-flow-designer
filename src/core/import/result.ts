// What every import returns (M9, AFD-26): the flow, what did not map one to one, and the counts the
// command announces.
import { NODE_TYPE_LABEL } from '../export/details';
import { modelOf } from '../flow/model';
import type { FlowDocument, NodeType } from '../flow/types';

export interface ImportResult {
  doc: FlowDocument;
  /** What did not map one to one, as sentences for the user. */
  notes: string[];
  counts: { steps: number; implemented: number; drafts: number };
}

/**
 * AFD-380: the nodes of a flow as Readiness counts them (every node but start and end, all levels),
 * and how many of them are not steps (subflows, decisions, approvals, …), by type.
 */
export function nodeTally(doc: FlowDocument | undefined): {
  total: number;
  others: Partial<Record<NodeType, number>>;
} {
  const others: Partial<Record<NodeType, number>> = {};
  let total = 0;
  if (!doc) return { total, others };
  for (const { node } of modelOf(doc).nodes.values()) {
    if (node.type === 'start' || node.type === 'end') continue;
    total++;
    if (node.type !== 'task') others[node.type] = (others[node.type] ?? 0) + 1;
  }
  return { total, others };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;

/**
 * AFD-378, AFD-380: the import's notice. With subflows or other nodes it says the nodes as Readiness
 * counts them, so the two agree ("20 steps, 20 ready to run" beside Readiness's 28 implemented
 * read as a mistake, and a decision left out made 27).
 */
export function importLine(
  what: string,
  c: ImportResult['counts'] | undefined,
  tally?: ReturnType<typeof nodeTally>,
): string {
  const steps = c?.steps ?? 0;
  const others = Object.entries(tally?.others ?? {}).filter(([, n]) => (n ?? 0) > 0);
  const head =
    tally && others.length > 0
      ? `${plural(steps + others.reduce((a, [, n]) => a + (n ?? 0), 0), 'node')} (${[
          plural(steps, 'step'),
          ...others.map(([type, n]) =>
            plural(n ?? 0, NODE_TYPE_LABEL[type as NodeType].toLowerCase()),
          ),
        ].join(', ')})`
      : plural(steps, 'step');
  return `Imported ${what}: ${head}; ${c?.implemented ?? 0} step${c?.implemented === 1 ? '' : 's'} ready to run, ${c?.drafts ?? 0} to check.`;
}

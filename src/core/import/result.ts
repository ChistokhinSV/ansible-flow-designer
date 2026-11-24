// What every import returns (M9, AFD-26): the flow, what did not map one to one, and the counts the
// command announces.
import type { FlowDocument } from '../flow/types';

export interface ImportResult {
  doc: FlowDocument;
  /** What did not map one to one, as sentences for the user. */
  notes: string[];
  counts: { steps: number; implemented: number; drafts: number };
}

/** Subflows that hold steps: Readiness counts them as nodes too, the step counts do not. */
export function subflowCount(doc: FlowDocument | undefined): number {
  let n = 0;
  const walk = (nodes: FlowDocument['nodes'] | undefined) => {
    for (const node of nodes ?? []) {
      if (node?.type === 'subflow' && node.subflow?.nodes?.length) {
        n++;
        walk(node.subflow.nodes);
      }
    }
  };
  walk(doc?.nodes);
  return n;
}

/**
 * AFD-378: the import's notice. With subflows it says the nodes as Readiness counts them, so the
 * two agree ("20 steps, 20 ready to run" beside Readiness's 28 implemented read as a mistake).
 */
export function importLine(
  what: string,
  c: ImportResult['counts'] | undefined,
  subflows = 0,
): string {
  const steps = c?.steps ?? 0;
  const head =
    subflows > 0
      ? `${steps + subflows} nodes (${steps} step${steps === 1 ? '' : 's'} in ${subflows} subflow${subflows === 1 ? '' : 's'})`
      : `${steps} step${steps === 1 ? '' : 's'}`;
  return `Imported ${what}: ${head}; ${c?.implemented ?? 0} step${c?.implemented === 1 ? '' : 's'} ready to run, ${c?.drafts ?? 0} to check.`;
}

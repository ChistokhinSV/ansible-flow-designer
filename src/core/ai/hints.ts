// AFD-219: hints in a flow_edit answer, for agents only: no finding, nothing on the canvas. Agents
// grow a flow one `after:` at a time and rarely step back to group it; the answer they read after
// every batch is where a nudge lands.
import type { FlowModel, Level } from '../flow/model';
import type { FlowNode } from '../flow/types';
import { keyPath, levelName } from './refs';

/** Steps a level may hold before an edit that grows it past them suggests a subflow. */
export const LONG_LEVEL = 8;
/** Step keys named in a hint; a longer level ends the list with a count. */
const NAMED = 12;

const isStep = (n: FlowNode | undefined): n is FlowNode =>
  !!n && n.type !== 'start' && n.type !== 'end';

const stepCount = (level: Level | undefined) => (level?.nodes ?? []).filter(isStep).length;

/**
 * A level's steps in run order: along its wires, document order between steps that are ready
 * together. A cycle (refused elsewhere) leaves its steps in document order at the end.
 */
function runOrder(level: Level): FlowNode[] {
  const nodes = level.nodes.filter((n): n is FlowNode => !!n?.id);
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const waiting = new Map(nodes.map((n) => [n.id, 0]));
  const next = new Map<string, string[]>();
  for (const e of level.edges) {
    const from = e?.from?.node;
    const to = e?.to?.node;
    if (!from || !to || !index.has(from) || !index.has(to)) continue;
    next.set(from, [...(next.get(from) ?? []), to]);
    waiting.set(to, (waiting.get(to) ?? 0) + 1);
  }
  const ready = nodes.filter((n) => waiting.get(n.id) === 0);
  const out: FlowNode[] = [];
  const seen = new Set<string>();
  while (ready.length > 0) {
    ready.sort((a, b) => (index.get(a.id) ?? 0) - (index.get(b.id) ?? 0));
    const n = ready.shift() as FlowNode;
    if (seen.has(n.id)) continue;
    seen.add(n.id);
    out.push(n);
    for (const to of next.get(n.id) ?? []) {
      const left = (waiting.get(to) ?? 1) - 1;
      waiting.set(to, left);
      const node = nodes[index.get(to) ?? -1];
      if (left === 0 && node) ready.push(node);
    }
  }
  return [...out, ...nodes.filter((n) => !seen.has(n.id))].filter(isStep);
}

/**
 * One hint per level the edit grew past LONG_LEVEL steps (start and end nodes not counted). A
 * level the edit did not grow gets none, so a long imported flow is not flagged on every edit.
 * Steps are named by key path, as extract_subflow takes them.
 */
export function longLevelHints(before: FlowModel, after: FlowModel): string[] {
  const hints: string[] = [];
  for (const [id, level] of after.levels) {
    const count = stepCount(level);
    if (count <= LONG_LEVEL || count <= stepCount(before.levels.get(id))) continue;
    const keys = runOrder(level).map((n) => keyPath(after, n.id));
    const named =
      keys.length > NAMED ? [...keys.slice(0, NAMED), `… ${keys.length - NAMED} more`] : keys;
    hints.push(
      `Hint: ${levelName(after, id)} has ${count} steps (${named.join(', ')}). Put the steps of one purpose (pre-checks, backup, change, verify, rollback) in a subflow: extract_subflow {"nodes": [...], "title": "..."}.`,
    );
  }
  return hints;
}

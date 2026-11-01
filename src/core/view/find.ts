// Find a node (AFD-48): every level of the flow, by title, key or what it is bound to, best match
// first. Each word of the query has to match somewhere; a title that starts with the query wins.
import { type FlowModel, ROOT } from '../flow/model';
import type { NodeType, Ulid } from '../flow/types';

export interface FoundNode {
  id: Ulid;
  title: string;
  key: string;
  type: NodeType;
  level: Ulid;
  /** The titles of the subflows around it, outermost first; empty on the top level. */
  trail: string[];
  /** The module, role or playbook it is bound to. */
  ref?: string;
}

export function trailOf(model: FlowModel, level: Ulid): string[] {
  const trail: string[] = [];
  for (let at = level; at !== ROOT; ) {
    const entry = model.nodes.get(at);
    if (!entry) break;
    trail.unshift(entry.node.title);
    at = entry.level;
  }
  return trail;
}

export function findNodes(model: FlowModel, query: string, limit = 50): FoundNode[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const whole = words.join(' ');
  const scored: { found: FoundNode; score: number; depth: number }[] = [];
  for (const { node, level } of model.nodes.values()) {
    const title = node.title.toLowerCase();
    const key = node.key?.toLowerCase() ?? '';
    const ref = node.impl?.ref?.toLowerCase() ?? '';
    if (!words.every((w) => title.includes(w) || key.includes(w) || ref.includes(w))) continue;
    const score = title.startsWith(whole)
      ? 0
      : title.split(/\W+/).some((w) => w.startsWith(words[0] ?? ''))
        ? 1
        : title.includes(whole)
          ? 2
          : key.includes(whole)
            ? 3
            : 4;
    const trail = trailOf(model, level);
    scored.push({
      found: {
        id: node.id,
        title: node.title,
        key: node.key ?? '',
        type: node.type,
        level,
        trail,
        ...(node.impl?.ref ? { ref: node.impl.ref } : {}),
      },
      score,
      depth: trail.length,
    });
  }
  return scored
    .sort(
      (a, b) =>
        a.score - b.score || a.depth - b.depth || a.found.title.localeCompare(b.found.title),
    )
    .slice(0, limit)
    .map((s) => s.found);
}

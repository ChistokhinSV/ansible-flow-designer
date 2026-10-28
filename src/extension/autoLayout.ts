// Top-down layered layout with ELK, run in the host (5–15 nodes per level: milliseconds, no worker).
import ELK from 'elkjs/lib/elk.bundled.js';
import { nodeSize } from '../core/flow/geometry';
import type { Level } from '../core/flow/model';
import type { Layout, Position, Ulid } from '../core/flow/types';

const elk = new ELK();

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '48',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL',
};

/** Positions for every node of a level. */
export async function layoutLevel(level: Level): Promise<Record<Ulid, Position>> {
  const nodes = level.nodes.filter((n) => n?.id);
  const ids = new Set(nodes.map((n) => n.id));
  const graph = await elk.layout({
    id: level.id,
    layoutOptions: OPTIONS,
    children: nodes.map((n) => ({ id: n.id, ...nodeSize(n.type) })),
    edges: level.edges
      .filter((e) => e && ids.has(e.from?.node) && ids.has(e.to?.node))
      .map((e) => ({ id: e.id, sources: [e.from.node], targets: [e.to.node] })),
  });
  const out: Record<Ulid, Position> = {};
  for (const c of graph.children ?? [])
    out[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  return out;
}

/**
 * In-memory positions for nodes the layout block does not place (ADR-0002). With no stored
 * positions at all the level gets a full ELK layout; otherwise each missing node goes below its
 * placed predecessor, or below everything.
 */
export async function autoPositions(
  level: Level,
  layout: Layout | undefined,
): Promise<Record<Ulid, Position>> {
  const placed = new Map<Ulid, Position>();
  for (const n of level.nodes) {
    const p = n && layout?.[n.id];
    if (p && typeof p.x === 'number' && typeof p.y === 'number') placed.set(n.id, p);
  }
  const missing = level.nodes.filter((n) => n?.id && !placed.has(n.id));
  if (missing.length === 0) return {};
  if (placed.size === 0) return layoutLevel(level);

  const out: Record<Ulid, Position> = {};
  let bottom = Math.max(...[...placed.values()].map((p) => p.y)) + 120;
  for (const n of missing) {
    const pred = level.edges.find(
      (e) => e?.to?.node === n.id && (placed.has(e.from.node) || out[e.from.node]),
    );
    const from = pred ? (placed.get(pred.from.node) ?? out[pred.from.node]) : undefined;
    if (from) {
      out[n.id] = { x: from.x, y: from.y + 120 };
    } else {
      out[n.id] = { x: 0, y: bottom };
      bottom += 100;
    }
  }
  return out;
}

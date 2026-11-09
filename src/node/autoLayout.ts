// Top-down layered layout with ELK, run in the host (5–15 nodes per level: milliseconds, no worker).
import type ELK from 'elkjs/lib/elk.bundled.js';
import { nodeSize } from '../core/flow/geometry';
import { portOffsets } from '../core/flow/levelView';
import { buildModel, type FlowModel, type Level } from '../core/flow/model';
import type { PortSide } from '../core/flow/ports';
import type { FlowDocument, FlowNode, Layout, Position, Ulid } from '../core/flow/types';

// ELK is three quarters of the host code (about 160 ms to load). It loads at the first layout, not
// at activation; the build ships it as dist/elk.js next to the extension (scripts/build.mjs).
let engine: Promise<InstanceType<typeof ELK>> | undefined;
function elk(): Promise<InstanceType<typeof ELK>> {
  engine ??= import('elkjs/lib/elk.bundled.js').then((m) => new m.default());
  return engine;
}

/** Top to bottom (the default) or left to right: the user setting `afd.canvas.direction` (AFD-42). */
export type LayoutDirection = 'TB' | 'LR';

const OPTIONS = {
  'elk.algorithm': 'layered',
  'elk.layered.spacing.nodeNodeBetweenLayers': '56',
  'elk.spacing.nodeNode': '48',
  // AFD-192: room between a wire and a node it passes (ELK's default is 10). A step fed from a
  // right side port lines up beside the wire of the column it leaves; at 10 the wire's label
  // (`failed_hosts`, 80 px) then lay on the column's nodes.
  'elk.spacing.edgeNode': '40',
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.edgeRouting': 'ORTHOGONAL',
};

const SIDE: Record<PortSide, string> = {
  top: 'NORTH',
  bottom: 'SOUTH',
  right: 'EAST',
  left: 'WEST',
};

const portId = (node: Ulid, port: string) => `${node}:${port}`;

/**
 * A node for ELK with its ports where the canvas draws them (AFD-192). Without ports ELK invented
 * one bottom port per wire, in wire order: a decision's `true` target could land under the canvas's
 * `false` handle (the two labels then shared one gap), and a step fed by `failed_hosts` (a right
 * side port) could land left of the column it handles, its wires across that column.
 */
function elkNode(n: FlowNode) {
  const size = nodeSize(n.type);
  const ports = portOffsets(n).map((p) => {
    const across = p.side === 'top' || p.side === 'bottom';
    const along = Math.round((across ? size.width : size.height) * p.offset);
    return {
      id: portId(n.id, p.name),
      x: across ? along : p.side === 'right' ? size.width : 0,
      y: across ? (p.side === 'bottom' ? size.height : 0) : along,
      width: 0,
      height: 0,
      layoutOptions: { 'elk.port.side': SIDE[p.side] },
    };
  });
  return { id: n.id, ...size, ports, layoutOptions: { 'elk.portConstraints': 'FIXED_POS' } };
}

/**
 * Positions for every node of a level. Wires run port to port. Model order
 * (`considerModelOrder`) and straightness priority on main outputs were tried for AFD-192: both
 * gave more crossings on the fixtures, so ELK orders the layers by crossings alone.
 */
export async function layoutLevel(
  level: Level,
  direction: LayoutDirection = 'TB',
): Promise<Record<Ulid, Position>> {
  const nodes = level.nodes.filter((n) => n?.id);
  const children = nodes.map(elkNode);
  const ports = new Set(children.flatMap((c) => c.ports.map((p) => p.id)));
  const ids = new Set(nodes.map((n) => n.id));
  // A wire on a port the node does not have (the validator reports it) ends at the node itself.
  const end = (r: { node: Ulid; port: string }) =>
    ports.has(portId(r.node, r.port)) ? portId(r.node, r.port) : r.node;
  const graph = await (await elk()).layout({
    id: level.id,
    layoutOptions: { ...OPTIONS, 'elk.direction': direction === 'LR' ? 'RIGHT' : 'DOWN' },
    children,
    edges: level.edges
      .filter((e) => e && ids.has(e.from?.node) && ids.has(e.to?.node))
      .map((e) => ({ id: e.id, sources: [end(e.from)], targets: [end(e.to)] })),
  });
  const out: Record<Ulid, Position> = {};
  for (const c of graph.children ?? [])
    out[c.id] = { x: Math.round(c.x ?? 0), y: Math.round(c.y ?? 0) };
  return out;
}

/** ELK positions for every level of a new document, in the one flat layout map (ADR-0002). */
export async function layoutAll(doc: FlowDocument): Promise<void> {
  const layout: Layout = {};
  for (const level of buildModel(doc).levels.values())
    Object.assign(layout, await layoutLevel(level));
  doc.layout = layout;
}

/**
 * In-memory positions for nodes the layout block does not place (ADR-0002). With no stored
 * positions at all the level gets a full ELK layout. Otherwise (AFD-23) the missing nodes keep
 * ELK's shape around the placed ones: each goes where ELK puts it relative to a placed neighbour
 * (its predecessor first), else by the placed nodes' median shift, and moves right while it would
 * overlap a node. Before, each missing node went straight below its predecessor, so a flow with
 * only Start and Done placed (the New Flow template) and everything else added by an AI agent
 * stood in one column, siblings on top of each other.
 */
export async function autoPositions(
  level: Level,
  layout: Layout | undefined,
  direction: LayoutDirection = 'TB',
): Promise<Record<Ulid, Position>> {
  const placed = new Map<Ulid, Position>();
  for (const n of level.nodes) {
    const p = n && layout?.[n.id];
    if (p && typeof p.x === 'number' && typeof p.y === 'number') placed.set(n.id, p);
  }
  const missing = level.nodes.filter((n) => n?.id && !placed.has(n.id));
  if (missing.length === 0) return {};
  const elkAt = await layoutLevel(level, direction);
  if (placed.size === 0) return elkAt;

  const out: Record<Ulid, Position> = {};
  const known = (id: Ulid) => placed.get(id) ?? out[id];
  const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
  const shifts = [...placed].flatMap(([id, p]) => {
    const e = elkAt[id];
    return e ? [{ x: p.x - e.x, y: p.y - e.y }] : [];
  });
  const shift = { x: median(shifts.map((s) => s.x)), y: median(shifts.map((s) => s.y)) };
  const type = new Map(level.nodes.filter((n) => n?.id).map((n) => [n.id, n.type]));
  const boxes = [...placed].map(([id, p]) => ({ ...p, ...nodeSize(type.get(id) ?? 'task') }));
  const overlaps = (p: Position, size: { width: number; height: number }) =>
    boxes.some(
      (b) =>
        p.x < b.x + b.width + GAP &&
        p.x + size.width + GAP > b.x &&
        p.y < b.y + b.height + GAP &&
        p.y + size.height + GAP > b.y,
    );
  // Top-down in ELK's order, so a predecessor is placed before the nodes below it.
  const order = [...missing].sort(
    (a, b) =>
      (elkAt[a.id]?.y ?? 0) - (elkAt[b.id]?.y ?? 0) ||
      (elkAt[a.id]?.x ?? 0) - (elkAt[b.id]?.x ?? 0),
  );
  for (const n of order) {
    const e = elkAt[n.id] ?? { x: 0, y: 0 };
    const anchor =
      level.edges.find((w) => w?.to?.node === n.id && known(w.from?.node))?.from.node ??
      level.edges.find((w) => w?.from?.node === n.id && known(w.to?.node))?.to.node;
    const a = anchor ? known(anchor) : undefined;
    const ea = anchor ? elkAt[anchor] : undefined;
    const size = nodeSize(n.type);
    const p =
      a && ea
        ? { x: a.x + e.x - ea.x, y: a.y + e.y - ea.y }
        : { x: e.x + shift.x, y: e.y + shift.y };
    for (let i = 0; i < 40 && overlaps(p, size); i++) p.x += size.width + GAP * 2;
    const at = { x: Math.round(p.x), y: Math.round(p.y) };
    out[n.id] = at;
    boxes.push({ ...at, ...size });
  }
  return out;
}

/** Room kept between an auto-placed node and its neighbours. */
const GAP = 24;

/** Where the New Flow template put Start and Done until AFD-23. */
const TEMPLATE: Partial<Record<string, Position>> = {
  start: { x: 0, y: 0 },
  end: { x: 36, y: 160 },
};

/**
 * The layout the canvas shows (AFD-23): the stored one, except that a level whose only positions
 * are the New Flow template's (Start at 0,0 and Done at 36,160), while it has other nodes, is shown
 * with a full auto-layout. Flows made before AFD-23 and then filled by an AI agent look like that.
 * The shown positions are written on the first move or Tidy up, like any auto position.
 */
export function shownLayout(model: FlowModel): Layout | undefined {
  const layout = model.doc.layout;
  if (!layout) return layout;
  let out: Layout | undefined;
  for (const level of model.levels.values()) {
    const nodes = level.nodes.filter((n) => n?.id);
    const placed = nodes.filter((n) => layout[n.id]);
    if (nodes.length <= 2 || placed.length !== 2) continue;
    const template = placed.every((n) => {
      const t = TEMPLATE[n.type];
      const p = layout[n.id];
      return !!t && p?.x === t.x && p?.y === t.y;
    });
    if (!template || placed[0]?.type === placed[1]?.type) continue;
    out ??= { ...layout };
    for (const n of placed) delete out[n.id];
  }
  return out ?? layout;
}

/**
 * Where the canvas shows every node (AFD-24), for the AI tools: `stored` positions (the old
 * template's dropped, as in the view) and `auto` positions for the rest, on every level. Pass the
 * canvas direction (`afd.canvas.direction`) so the layout check sees what the canvas shows (AFD-192).
 */
export async function shownPositions(
  model: FlowModel,
  direction: LayoutDirection = 'TB',
): Promise<{ stored: Layout; auto: Record<Ulid, Position> }> {
  const stored = shownLayout(model) ?? {};
  const auto: Record<Ulid, Position> = {};
  for (const level of model.levels.values())
    Object.assign(auto, await autoPositions(level, stored, direction));
  return { stored, auto };
}

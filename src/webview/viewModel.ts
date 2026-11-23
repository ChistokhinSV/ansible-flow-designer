// What the canvas panels derive from a snapshot besides the level projection: placement helpers,
// readiness, breadcrumbs, inherited settings. No React here, so it is testable.

import { formatOf } from '../core/flow/format';
import { nodeSize } from '../core/flow/geometry';
import type { LevelView } from '../core/flow/levelView';
import { modelOf, ROOT } from '../core/flow/model';
import type { OpenPort } from '../core/flow/openPorts';
import { rollingObstacles } from '../core/flow/rolling';
import type { FlowDocument, FlowNode, NodeStatus, Position, Ulid } from '../core/flow/types';

// The level projection lives in core (AFD-25: the exports draw from it too).
export * from '../core/flow/levelView';

/** Positions of nodes shown at in-memory auto positions: written with the next edit so they stay put. */
export function unplacedPositions(
  view: LevelView,
  layout: FlowDocument['layout'],
): Record<Ulid, Position> {
  const out: Record<Ulid, Position> = {};
  for (const n of view.nodes) {
    if (!layout?.[n.node.id])
      out[n.node.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y) };
  }
  return out;
}

const GAP = 24;

/** First spot at or below `at` where a box of `size` overlaps no node (with a gap). */
export function freeSpot(
  view: LevelView,
  at: Position,
  size: { width: number; height: number },
): Position {
  const hits = (p: Position) =>
    view.nodes.some(
      (n) =>
        p.x < n.position.x + n.width + GAP &&
        p.x + size.width + GAP > n.position.x &&
        p.y < n.position.y + n.height + GAP &&
        p.y + size.height + GAP > n.position.y,
    );
  const spot = { x: Math.round(at.x), y: Math.round(at.y) };
  for (let i = 0; i < 40 && hits(spot); i++) spot.y += 40;
  return spot;
}

/** Room between the rows (and columns) of a placed level: as the auto layout leaves it. */
const ROW_GAP = 56;

/**
 * AFD-360: where a step inserted on a wire goes on a placed level, and what moves to make room.
 * The step goes in line after the wire's source; when the gap to the wire's target is too small,
 * the target and every node at or below it (to its right, for a wire that leaves sideways) move
 * on by the room the step needs, as the layout would place them. Before, the step was put in the
 * first free spot below the middle of the wire: under the target, with the wire looping round it.
 * A wire that runs back up (or left) keeps the old free spot.
 */
export function insertRoom(
  view: LevelView,
  edge: Ulid,
  size: { width: number; height: number } = nodeSize('task'),
): { position: Position; moved: Record<Ulid, Position> } | undefined {
  const e = view.edges.find((x) => x.id === edge);
  const a = view.nodes.find((n) => n.node.id === e?.source);
  const b = view.nodes.find((n) => n.node.id === e?.target);
  if (!e || !a || !b) return undefined;
  const side = a.ports.find((p) => p.name === e.sourcePort)?.side ?? 'bottom';
  const moved: Record<Ulid, Position> = {};
  if (side !== 'right' && b.position.y >= a.position.y + a.height) {
    const top = a.position.y + a.height + ROW_GAP;
    const x = Math.round(a.position.x + a.width / 2 - size.width / 2);
    const short = top + size.height + ROW_GAP - b.position.y;
    if (short <= 0) {
      // Room enough: the step sits in the middle of the gap.
      const y = (a.position.y + a.height + b.position.y - size.height) / 2;
      return { position: { x, y: Math.round(y) }, moved };
    }
    for (const n of view.nodes) {
      if (n === a || n.position.y < b.position.y) continue;
      moved[n.node.id] = { x: Math.round(n.position.x), y: Math.round(n.position.y + short) };
    }
    return { position: { x, y: Math.round(top) }, moved };
  }
  if (side === 'right' && b.position.x >= a.position.x + a.width) {
    const left = a.position.x + a.width + ROW_GAP + 40;
    const y = Math.round(a.position.y + a.height / 2 - size.height / 2);
    const short = left + size.width + ROW_GAP + 40 - b.position.x;
    if (short <= 0) return { position: { x: Math.round(left), y }, moved };
    // Sideways only what the target leads to, so the main column stays where it is.
    const after = downstream(view, b.node.id);
    for (const n of view.nodes) {
      if (n === a || n.position.x < b.position.x || !after.has(n.node.id)) continue;
      moved[n.node.id] = { x: Math.round(n.position.x + short), y: Math.round(n.position.y) };
    }
    return { position: { x: Math.round(left), y }, moved };
  }
  const mid = { x: (a.position.x + b.position.x) / 2 + 40, y: (a.position.y + b.position.y) / 2 };
  return { position: freeSpot(view, mid, size), moved };
}

/** The node and every node its wires lead to on the level. */
function downstream(view: LevelView, from: Ulid): Set<Ulid> {
  const seen = new Set<Ulid>([from]);
  const queue = [from];
  for (let id = queue.shift(); id; id = queue.shift()) {
    for (const e of view.edges) {
      if (e.source !== id || seen.has(e.target)) continue;
      seen.add(e.target);
      queue.push(e.target);
    }
  }
  return seen;
}

/** Where a node attached to a port goes: right of problem ports, below the others (D-12). */
export function besidePort(view: LevelView, node: Ulid, port: string): Position | undefined {
  const source = view.nodes.find((n) => n.node.id === node);
  if (!source) return undefined;
  const side = source.ports.find((p) => p.name === port)?.side ?? 'bottom';
  const size = nodeSize('task');
  const at =
    side === 'right'
      ? { x: source.position.x + source.width + 90, y: source.position.y }
      : { x: source.position.x, y: source.position.y + source.height + 70 };
  return freeSpot(view, at, size);
}

export interface Readiness {
  counts: Record<NodeStatus, number>;
  total: number;
}

/** Status counters over every designable node (start/end excluded), all levels. */
export function readiness(doc: FlowDocument | null): Readiness {
  const counts: Record<NodeStatus, number> = { draft: 0, specified: 0, implemented: 0, tested: 0 };
  let total = 0;
  if (!doc) return { counts, total };
  for (const { node } of modelOf(doc).nodes.values()) {
    if (node.type === 'start' || node.type === 'end') continue;
    counts[node.status ?? 'draft']++;
    total++;
  }
  return { counts, total };
}

/** Top-level banner count: every open fail port that is not open on purpose (bubbling applied). */
export function bannerCount(openPorts: readonly OpenPort[]): number {
  return openPorts.length;
}

export const STATUS_ORDER: readonly NodeStatus[] = ['draft', 'specified', 'implemented', 'tested'];

/** What a node lacks for its next lifecycle stage (mockup 03), or undefined at the last one. */
export function nextRequirement(node: FlowNode): string | undefined {
  switch (node.status ?? 'draft') {
    case 'draft':
      return 'Define at least one input or output to make it specified';
    case 'specified':
      return 'Bind a module, role or playbook to make it implemented';
    case 'implemented':
      return 'A passing real run of this flow version makes it tested';
    default:
      return undefined;
  }
}

/** The walking-skeleton task a draft node compiles to (05, D-03). */
export function skeletonStub(node: FlowNode): string {
  const msg = `TODO: ${node.intent ?? node.title}`.replaceAll('"', '\\"');
  return `- name: "[${node.key}] TODO"\n  ansible.builtin.debug:\n    msg: "${msg}"`;
}

/** Breadcrumb from the top level to `levelId` (D-23). */
export function levelTrail(doc: FlowDocument, levelId: string): { id: string; title: string }[] {
  const model = modelOf(doc);
  const trail: { id: string; title: string }[] = [];
  let id: string | undefined = levelId;
  while (id && id !== ROOT) {
    const entry = model.nodes.get(id);
    if (!entry) break;
    trail.unshift({ id, title: entry.node.title });
    id = entry.level;
  }
  return [{ id: ROOT, title: doc.flow.name }, ...trail];
}

/**
 * Settings of the subflows around a level (D-23 chips), as the generated code treats them
 * (AFD-31): steps inside inherit the inventory target; become, serial, credential and the EE are
 * set on the subflow but not applied to its steps, and the chip says so.
 */
export function inheritedContext(
  doc: FlowDocument,
  levelId: string,
): { label: string; title: string; applied: boolean }[] {
  const model = modelOf(doc);
  const chips: { label: string; title: string; applied: boolean }[] = [];
  const seen = new Set<string>();
  let id: string | undefined = levelId;
  while (id && id !== ROOT) {
    const entry = model.nodes.get(id);
    if (!entry) break;
    const s = entry.node.settings ?? {};
    const by = entry.node.title;
    const add = (key: string, label: string, applied: boolean) => {
      if (seen.has(key)) return;
      seen.add(key);
      chips.push({
        label: applied ? label : `${label} · not applied`,
        title: applied
          ? `From ${by}: every step inside runs on it`
          : `Set on ${by}, but the generated plays of the steps inside do not use it: set it on the steps`,
        applied,
      });
    };
    if (s.inventory_target) add('inventory', `inherits ${s.inventory_target}`, true);
    if (s.credential && formatOf(doc) < 2) add('credential', s.credential, false);
    if (s.execution_environment && formatOf(doc) < 2)
      add('ee', `EE ${s.execution_environment}`, false);
    // Format 2 passes become (and whom) to the steps inside (AFD-52); serial stays per node.
    if (s.become)
      add('become', s.become_user ? `become ${s.become_user}` : 'become', formatOf(doc) >= 2);
    // A shared subflow (AFD-60): its steps are edited in the source flow.
    if (entry.node.ref)
      add(
        'shared',
        `shared from ${entry.node.ref.from} v${entry.node.ref.version} · edit it there`,
        true,
      );
    // A rolling subflow batches its own level only (AFD-55): the steps of a nested one cannot roll.
    if (s.rolling !== undefined && id === levelId)
      add(
        'rolling',
        `rolling, ${s.rolling} at a time`,
        rollingObstacles(model, entry.node).length === 0,
      );
    id = entry.level;
  }
  return chips;
}

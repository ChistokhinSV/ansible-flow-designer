// One picture per flow level (AFD-25): what the canvas shows, as boxes, ports and wires in canvas
// pixels, for the draw.io and SVG writers. The geometry is the canvas's own (levelView), and wires
// take React Flow's smooth-step route, so an export looks like the designer.
import { getSmoothStepPath, Position as Side } from '@xyflow/system';
import { keyPath } from '../ai/refs';
import { type BoundaryView, boundaryView, type LevelView, levelView } from '../flow/levelView';
import { buildModel, type FlowModel, ROOT } from '../flow/model';
import type { OpenPort } from '../flow/openPorts';
import type { PortSide } from '../flow/ports';
import type { FlowDocument, Layout, Position, Ulid } from '../flow/types';
import type { Finding } from '../flow/validate';
import type { Snapshot } from '../protocol';

/** What an export is drawn from: the flow, where the canvas shows its nodes, and its problems. */
export interface ExportSource {
  doc: FlowDocument;
  /** Stored positions and the auto positions of the rest (AFD-24 `shownPositions`). */
  shown: { stored: Layout; auto: Record<Ulid, Position> };
  findings: Finding[];
  openPorts: OpenPort[];
}

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Wire {
  id: string;
  /** SVG path in canvas pixels and where its label sits. */
  path: string;
  label: { x: number; y: number };
}

export interface Scene {
  /** ROOT or the subflow node's ID. */
  level: string;
  /** Key path of the subflow (`fix-ntp`, `upgrade/wait-ha`); empty for the top level. */
  path: string;
  title: string;
  parent?: string;
  view: LevelView;
  boundary?: BoundaryView;
  /** Smooth-step routes of the level's wires and the boundary's entry and exit wires, by ID. */
  wires: Map<string, Wire>;
  /** Everything drawn, wires and port marks included. */
  bounds: Box;
}

/** React Flow handles are 10 px (node ports) and 12 px (frame ports), centred on the border. */
const PORT = 10;
const FRAME_PORT = 12;
const SIDE: Record<PortSide, Side> = {
  top: Side.Top,
  bottom: Side.Bottom,
  left: Side.Left,
  right: Side.Right,
};

/** Centre of a port on a box edge. */
export function portCentre(box: Box, side: PortSide, offset: number): Position {
  if (side === 'top') return { x: box.x + box.width * offset, y: box.y };
  if (side === 'bottom') return { x: box.x + box.width * offset, y: box.y + box.height };
  if (side === 'left') return { x: box.x, y: box.y + box.height * offset };
  return { x: box.x + box.width, y: box.y + box.height * offset };
}

/** Where a wire starts or ends: the handle's face in the direction the wire leaves (React Flow). */
function wireEnd(centre: Position, facing: Side, size: number): Position {
  const h = size / 2;
  if (facing === Side.Top) return { x: centre.x, y: centre.y - h };
  if (facing === Side.Bottom) return { x: centre.x, y: centre.y + h };
  if (facing === Side.Left) return { x: centre.x - h, y: centre.y };
  return { x: centre.x + h, y: centre.y };
}

/** Frame ports face inward: the entry leaves `in` downwards, exits arrive from inside. */
const FACING_IN: Record<string, Side> = { top: Side.Bottom, bottom: Side.Top, right: Side.Left };

/** Levels in drill-down order: the top, then each subflow before the next sibling. */
function levelOrder(model: FlowModel): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    out.push(id);
    for (const n of model.levels.get(id)?.nodes ?? [])
      if (n?.id && n.type === 'subflow' && model.levels.has(n.id)) walk(n.id);
  };
  walk(ROOT);
  return out;
}

/** Scenes of every level, or of one (ROOT or a subflow node ID). */
export function scenesOf(src: ExportSource, only?: string): Scene[] {
  const model = buildModel(src.doc);
  const snapshot: Snapshot = {
    docVersion: 0,
    doc: { ...src.doc, layout: src.shown.stored },
    stale: false,
    findings: src.findings,
    openPorts: src.openPorts,
    autoPositions: src.shown.auto,
  };
  return levelOrder(model)
    .filter((id) => only === undefined || id === only)
    .map((id) => sceneOf(model, snapshot, id));
}

function sceneOf(model: FlowModel, snapshot: Snapshot, id: string): Scene {
  const view = levelView(snapshot, {}, id);
  const boundary = boundaryView(snapshot, view, id);
  const wires = new Map<string, Wire>();
  const boxes = new Map(view.nodes.map((n) => [n.node.id, { ...n.position, ...n }]));
  const portAt = (node: Ulid, port: string) => {
    const n = view.nodes.find((v) => v.node.id === node);
    const p = n?.ports.find((q) => q.name === port);
    const box = boxes.get(node);
    return n && p && box ? { centre: portCentre(box, p.side, p.offset), side: p.side } : undefined;
  };
  const route = (wid: string, a: Position, as: Side, b: Position, bs: Side) => {
    const [path, x, y] = getSmoothStepPath({
      sourceX: a.x,
      sourceY: a.y,
      sourcePosition: as,
      targetX: b.x,
      targetY: b.y,
      targetPosition: bs,
    });
    wires.set(wid, { id: wid, path, label: { x, y } });
  };
  for (const e of view.edges) {
    const s = portAt(e.source, e.sourcePort);
    const t = portAt(e.target, e.targetPort);
    if (!s || !t) continue;
    route(
      e.id,
      wireEnd(s.centre, SIDE[s.side], PORT),
      SIDE[s.side],
      wireEnd(t.centre, SIDE[t.side], PORT),
      SIDE[t.side],
    );
  }
  if (boundary) {
    const framePort = (name: string) => {
      const p = boundary.ports.find((q) => q.name === name);
      if (!p) return undefined;
      const facing = FACING_IN[p.side] ?? Side.Bottom;
      return {
        at: wireEnd(portCentre(boundary.frame, p.side, p.offset), facing, FRAME_PORT),
        facing,
      };
    };
    for (const e of boundary.edges) {
      if (e.kind === 'entry') {
        const s = framePort('in');
        const t = portAt(e.target, e.targetPort);
        if (s && t)
          route(e.id, s.at, s.facing, wireEnd(t.centre, SIDE[t.side], PORT), SIDE[t.side]);
      } else {
        const s = portAt(e.source, e.sourcePort);
        const t = framePort(e.targetPort);
        if (s && t)
          route(e.id, wireEnd(s.centre, SIDE[s.side], PORT), SIDE[s.side], t.at, t.facing);
      }
    }
  }
  const entry = model.nodes.get(id);
  return {
    level: id,
    path: id === ROOT ? '' : keyPath(model, id),
    title: id === ROOT ? model.doc.flow.name : (entry?.node.title ?? id),
    parent: id === ROOT ? undefined : entry?.level,
    view,
    boundary,
    wires,
    bounds: boundsOf(view, boundary, wires),
  };
}

/** Union of node boxes, the frame and the wire routes (sampled from their path numbers). */
function boundsOf(view: LevelView, boundary: BoundaryView | undefined, wires: Map<string, Wire>) {
  const xs: number[] = [];
  const ys: number[] = [];
  const add = (b: Box, pad = 0) => {
    xs.push(b.x - pad, b.x + b.width + pad);
    ys.push(b.y - pad, b.y + b.height + pad);
  };
  for (const n of view.nodes) add({ ...n.position, width: n.width, height: n.height }, PORT);
  if (boundary) add(boundary.frame, FRAME_PORT);
  for (const w of wires.values()) {
    const nums = w.path.match(/-?\d+(\.\d+)?/g)?.map(Number) ?? [];
    for (let i = 0; i + 1 < nums.length; i += 2) {
      xs.push(nums[i] as number);
      ys.push(nums[i + 1] as number);
    }
  }
  if (xs.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** File name part for a level: '' for the top, `--fix-ntp` or `--upgrade--wait-ha` for subflows. */
export function levelSuffix(scene: Pick<Scene, 'path'>): string {
  return scene.path ? `--${scene.path.replaceAll('/', '--')}` : '';
}

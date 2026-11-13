// The op language AI tools edit flows with (AFD-19): nodes and ports named by key, applied in
// order through the same commands as the canvas, all or nothing. A batch first completes any IDs
// the file was written without. Errors say what went wrong and how to fix it, never with IDs.
import { flowLayoutProblems, LAYOUT_FIX } from '../export/layoutCheck';
import { annotationViews, sectionAround, sectionContents, TIE_OFFSET } from '../flow/annotations';
import {
  type AnnotationPatch,
  CommandError,
  type FlowCommand,
  planCommand,
} from '../flow/commands';
import { completeIds } from '../flow/completeIds';
import { flowFromFile } from '../flow/document';
import { formatOf } from '../flow/format';
import { annotationSize, nodeSize } from '../flow/geometry';
import { type IdFactory, SLUG, slugify } from '../flow/ids';
import { mapStrings } from '../flow/jinja';
import { buildModel, type FlowModel, type Level, ROOT } from '../flow/model';
import { PATTERN_IDS, type PatternId } from '../flow/patterns';
import { portDirection } from '../flow/ports';
import type {
  AnnotationColor,
  AnnotationKind,
  ApprovalFields,
  ContractField,
  HandlerKind,
  ImplBinding,
  JoinMode,
  Layout,
  NodeSettings,
  NodeStatus,
  NodeType,
  Position,
  TextSize,
  Ulid,
} from '../flow/types';
import { acceptKey, acceptMatches, type Finding, validateFlow } from '../flow/validate';
import { parseYaml, type YamlFile } from '../yaml/parse';
import { YamlEditError } from '../yaml/transaction';
import {
  keyPath,
  levelName,
  RefError,
  resolveAnnotation,
  resolveNode,
  resolvePort,
  withoutIds,
} from './refs';

/**
 * Where a node goes on its level (AFD-24): the top-left corner in canvas pixels (y grows down), or
 * next to another node of the same level, `gap` pixels away.
 */
export type Place =
  | { x: number; y: number }
  | { below?: string; above?: string; right_of?: string; left_of?: string; gap?: number };

export type Op =
  | {
      op: 'add_node';
      type: NodeType;
      title: string;
      key?: string;
      /** Subflow (key path) whose inner level gets the node; default: the level of `after`, else top. */
      in?: string;
      /** Wire this output port (`node.port`) to the new node. */
      after?: string;
      /** Put the new node on the wire leaving this output port (`node.port`). */
      on_wire?: string;
      /** Wire the new node's failed_hosts to this node. */
      failed_to?: string;
      intent?: string;
      ports?: string[];
      purpose?: HandlerKind;
      /** Format 1 name of purpose, kept for one release. */
      handler?: HandlerKind;
      outcome?: 'success' | 'failed';
      condition?: string;
      branches?: number;
      join_mode?: JoinMode;
      inputs?: Record<string, ContractField>;
      outputs?: Record<string, ContractField>;
      settings?: NodeSettings;
      impl?: ImplBinding;
      position?: Place;
    }
  | {
      op: 'update_node';
      node: string;
      title?: string;
      key?: string;
      intent?: string | null;
      status?: NodeStatus;
      condition?: string | null;
      outcome?: 'success' | 'failed' | null;
      purpose?: HandlerKind | null;
      /** Format 1 name of purpose, kept for one release. */
      handler?: HandlerKind | null;
      join_mode?: JoinMode | null;
      branches?: number | null;
      /** AFD-242 */
      disabled?: boolean | null;
      settings?: { [K in keyof NodeSettings]?: NodeSettings[K] | null };
      keywords?: Record<string, unknown> | null;
      /** AFD-273 */
      approval?: ApprovalFields | null;
    }
  | { op: 'delete'; nodes?: string[]; wires?: string[]; annotations?: string[] }
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; from: string }
  | { op: 'rewire'; from: string; to: string }
  | { op: 'enable_port' | 'disable_port'; node: string; port: string }
  | { op: 'leave_open'; at: string; reason: string }
  | { op: 'reopen'; at: string }
  | { op: 'accept'; at: string | string[]; finding?: string; reason: string }
  | { op: 'unaccept'; at: string | string[]; finding?: string }
  | { op: 'apply_pattern'; at: string; pattern: PatternId; end?: string; position?: Place }
  | {
      op: 'set_io';
      node: string;
      side: 'inputs' | 'outputs';
      name: string;
      field: ContractField | null;
      rename?: string;
    }
  /** AFD-112: a step's retries, delay or timeout given at run time (flow input, node input, setting). */
  | {
      op: 'ask_at_run_time';
      node: string;
      setting: 'retries' | 'delay' | 'timeout';
      name: string;
      description?: string;
      default?: number;
    }
  | {
      op: 'update_flow';
      name?: string;
      key?: string;
      goal?: string | null;
      owner?: string | null;
      maintenance_window?: string | null;
      external_vars?: Record<string, string | null> | null;
    }
  | { op: 'set_entry'; subflow: string; node: string | null }
  | { op: 'add_exit'; from: string; port: string; reason?: string }
  | { op: 'remove_exit'; from: string; port: string }
  | { op: 'extract_subflow'; nodes: string[]; title: string; key?: string; position?: Place }
  | { op: 'dissolve_subflow'; subflow: string }
  | { op: 'rename'; keys: Record<string, string> }
  | {
      op: 'replace_text';
      find: string;
      replace: string;
      regex?: boolean;
      nodes?: string[];
      level?: string;
      in?: 'params' | 'keywords' | 'all';
    }
  | { op: 'regenerate' }
  | { op: 'move'; nodes?: Record<string, Place>; annotations?: Record<string, Place> }
  /** AFD-64: a Note (on a node), a Section or Text. */
  | {
      op: 'annotate';
      text: string;
      kind?: AnnotationKind;
      on?: string;
      in?: string;
      /** AFD-217: a Section drawn around these nodes of one level (and the Notes on them). */
      around?: string[];
      position?: Place;
      width?: number;
      height?: number;
      color?: AnnotationColor;
      size?: TextSize;
      key?: string;
    }
  | {
      op: 'update_annotation';
      annotation: string;
      text?: string;
      on?: string | null;
      position?: Place;
      width?: number | null;
      height?: number | null;
      color?: AnnotationColor | null;
      size?: TextSize | null;
      key?: string;
    }
  | { op: 'unplace'; nodes?: string[]; level?: string }
  | { op: 'bind'; node: string; impl: ImplBinding | null }
  | { op: 'tidy_up'; level?: string }
  | { op: 'upgrade_format' };

export class OpError extends Error {
  constructor(
    readonly index: number,
    message: string,
  ) {
    super(message);
    this.name = 'OpError';
  }
}

export interface OpsContext {
  newId: IdFactory;
  /** Who leaves a port open on purpose (Git user name). */
  author?: () => string | undefined | Promise<string | undefined>;
  /** Auto-layout of a level, for tidy_up (ELK lives outside the core). */
  layout?: (level: Level) => Promise<Record<Ulid, Position>>;
  /** Where the canvas shows every node: stored positions and auto ones (AFD-24). */
  positions?: (model: FlowModel) => Promise<{ stored: Layout; auto: Record<Ulid, Position> }>;
}

export interface OpsResult {
  text: string;
  /** Key paths of the nodes the batch created. */
  created: string[];
  /** Nodes that were tested and changed: implemented again (decision 15). */
  dropped: string[];
  /** What the batch did besides the ops (IDs completed). */
  notes: string[];
}

/** One line about an op for messages: `connect check-ntp.ok_hosts -> fix-ntp`. */
export function opLabel(op: Op): string {
  const o = op as Record<string, unknown>;
  const main = ['node', 'at', 'from', 'subflow', 'title', 'annotation', 'on']
    .map((k) => o[k])
    .find((v) => typeof v === 'string');
  const to = typeof o.to === 'string' ? ` -> ${o.to}` : '';
  return `${op.op}${main ? ` ${main}` : ''}${to}`;
}

interface State {
  text: string;
  file: YamlFile;
  model: FlowModel;
}

function stateOf(text: string, file?: YamlFile): State {
  const f = file && file.text === text ? file : parseYaml(text);
  const doc = flowFromFile(f).doc;
  if (!doc) throw new RefError('The file is not a flow document (it does not parse as one)');
  return { text, file: f, model: buildModel(doc) };
}

/**
 * AFD-191: a find/replace in bindings (params, keywords or both) of the named nodes, of a subflow's
 * steps at any depth, or of the whole flow; one setBinding per node it changes.
 */
function replaceText(
  st: State,
  op: Extract<Op, { op: 'replace_text' }>,
  notes: string[],
): FlowCommand[] {
  if (!op.find) throw new RefError('find is empty');
  let re: RegExp | undefined;
  if (op.regex)
    try {
      re = new RegExp(op.find, 'g');
    } catch (e) {
      throw new RefError(`find is not a regular expression: ${(e as Error).message}`);
    }
  const swap = (s: string) => (re ? s.replace(re, op.replace) : s.split(op.find).join(op.replace));
  const scope = op.level ? subflowOf(st, op.level) : undefined;
  const within = (id: Ulid) => {
    for (
      let at = st.model.nodes.get(id)?.level;
      at && at !== ROOT;
      at = st.model.nodes.get(at)?.level
    )
      if (at === scope) return true;
    return false;
  };
  const targets = op.nodes?.length
    ? op.nodes.map((n) => resolveNode(st.model, n).id)
    : [...st.model.nodes.keys()].filter((id) => !scope || within(id));
  const where = op.in ?? 'all';
  const out: FlowCommand[] = [];
  const changed: string[] = [];
  for (const id of targets) {
    const impl = st.model.nodes.get(id)?.node.impl;
    if (!impl) continue;
    const next: ImplBinding = { ...impl };
    if (where !== 'keywords' && impl.params !== undefined)
      next.params = mapStrings(impl.params, swap) as ImplBinding['params'];
    if (where !== 'params' && impl.keywords !== undefined)
      next.keywords = mapStrings(impl.keywords, swap) as ImplBinding['keywords'];
    if (JSON.stringify(next) === JSON.stringify(impl)) continue;
    out.push({ kind: 'setBinding', id, impl: next });
    changed.push(keyPath(st.model, id));
  }
  if (out.length === 0)
    throw new RefError(
      `"${op.find}" is in no binding${op.nodes?.length ? ' of those nodes' : scope ? ` inside ${op.level}` : ''}`,
    );
  notes.push(
    `replace_text changed ${changed.length} step(s): ${changed.slice(0, 20).join(', ')}${changed.length > 20 ? ', …' : ''}`,
  );
  return out;
}

/** Warnings of the flow as it stands, accepted ones included (AFD-184), once per text. */
const warningsCache = new WeakMap<YamlFile, Finding[]>();
function warningsOf(st: State): Finding[] {
  const hit = warningsCache.get(st.file);
  if (hit) return hit;
  const found = validateFlow({ ...st.model.doc, decisions: [] }).findings.filter(
    (f) => f.severity === 'warning',
  );
  warningsCache.set(st.file, found);
  return found;
}

/** The wire leaving an output port, and the level it is on. */
function wireFrom(st: State, ref: string): { edge: Ulid; label: string; level: string } {
  const { node, port } = resolvePort(st.model, ref);
  const level = st.model.levels.get(node.level);
  const edge = level?.edges.find((e) => e?.from?.node === node.id && e.from.port === port);
  if (!edge) throw new RefError(`${node.path}.${port} has no wire`);
  return { edge: edge.id, label: `${node.path}.${port}`, level: node.level };
}

function outputPort(st: State, ref: string) {
  const r = resolvePort(st.model, ref);
  if (portDirection(r.port) !== 'out')
    throw new RefError(`${r.node.path}.${r.port} is an input; wires start at an output port`);
  return r;
}

function subflowOf(st: State, ref: string): Ulid {
  const sub = resolveNode(st.model, ref);
  if (sub.node.type !== 'subflow')
    throw new RefError(`${sub.path} is a ${sub.node.type}, not a subflow`);
  return sub.id;
}

function levelKeys(st: State, level: string): Set<string> {
  return new Set((st.model.levels.get(level)?.nodes ?? []).map((n) => n?.key).filter(Boolean));
}

/** Default room between placed nodes: ELK's spacing (AFD-24). */
const GAP_BELOW = 56;
const GAP_BESIDE = 48;

type Shown = { stored: Layout; auto: Record<Ulid, Position> };
type Box = { id: Ulid; x: number; y: number; width: number; height: number };

async function shownOf(st: State, ctx: OpsContext): Promise<Shown> {
  if (!ctx.positions) throw new RefError('positions are not available here');
  return ctx.positions(st.model);
}

/** Boxes of a level as the canvas shows them, with positions set earlier in the same op. */
function boxesOf(st: State, shown: Shown, level: string, set: Record<Ulid, Position>): Box[] {
  return (st.model.levels.get(level)?.nodes ?? []).flatMap((n) => {
    const p = set[n.id] ?? shown.stored[n.id] ?? shown.auto[n.id];
    return n?.id && p ? [{ id: n.id, ...p, ...nodeSize(n.type) }] : [];
  });
}

const overlap = (a: Omit<Box, 'id'>, b: Omit<Box, 'id'>) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;

/**
 * The position a Place names for a node of `type` on `level`. Relative places step aside (right of
 * a node below or above, further down beside one) until the spot is free; absolute ones are taken
 * as given, and an overlap is reported after the batch.
 */
function resolvePlace(
  st: State,
  shown: Shown,
  level: string,
  type: NodeType,
  place: Place,
  set: Record<Ulid, Position>,
  self?: Ulid,
  box?: { width: number; height: number },
): Position {
  const size = box ?? nodeSize(type);
  if ('x' in place || 'y' in place) {
    const { x, y } = place as { x: number; y: number };
    if (!Number.isFinite(x) || !Number.isFinite(y))
      throw new RefError(
        'position needs both x and y as numbers, or one of below, above, right_of, left_of',
      );
    return { x: Math.round(x), y: Math.round(y) };
  }
  const rel = place as Exclude<Place, { x: number; y: number }>;
  const sides = (['below', 'above', 'right_of', 'left_of'] as const).filter((k) => rel[k]);
  if (sides.length !== 1)
    throw new RefError('position takes x and y, or exactly one of below, above, right_of, left_of');
  const side = sides[0] as 'below' | 'above' | 'right_of' | 'left_of';
  const ref = resolveNode(st.model, rel[side] as string, level);
  if (ref.level !== level)
    throw new RefError(
      `${ref.path} is on ${levelName(st.model, ref.level)}, not on ${levelName(st.model, level)}: positions are per level`,
    );
  const boxes = boxesOf(st, shown, level, set).filter((b) => b.id !== self);
  const r = boxes.find((b) => b.id === ref.id);
  if (!r) throw new RefError(`${ref.path} has no position yet`);
  const vertical = side === 'below' || side === 'above';
  const gap = rel.gap ?? (vertical ? GAP_BELOW : GAP_BESIDE);
  const p =
    side === 'below'
      ? { x: r.x + (r.width - size.width) / 2, y: r.y + r.height + gap }
      : side === 'above'
        ? { x: r.x + (r.width - size.width) / 2, y: r.y - size.height - gap }
        : side === 'right_of'
          ? { x: r.x + r.width + gap, y: r.y + (r.height - size.height) / 2 }
          : { x: r.x - size.width - gap, y: r.y + (r.height - size.height) / 2 };
  for (let i = 0; i < 40 && boxes.some((b) => overlap({ ...p, ...size }, b)); i++) {
    if (vertical) p.x += size.width + GAP_BESIDE;
    else p.y += size.height + GAP_BELOW;
  }
  return { x: Math.round(p.x), y: Math.round(p.y) };
}

/**
 * The shown positions of a level's nodes that are not stored yet: written with the first placed
 * node, as the canvas does on a drag, so nothing else moves (AFD-24).
 */
function freezeOf(
  st: State,
  shown: Shown,
  level: string,
  except: Ulid[] = [],
): Record<Ulid, Position> {
  const out: Record<Ulid, Position> = {};
  for (const n of st.model.levels.get(level)?.nodes ?? [])
    if (n?.id && !shown.stored[n.id] && shown.auto[n.id] && !except.includes(n.id))
      out[n.id] = shown.auto[n.id] as Position;
  return out;
}

/**
 * Where an annotation goes, in its stored form (AFD-64): a place in canvas pixels, relative to its
 * node for a Note on one. Without a place: right of its node, or right of what the level shows.
 */
function annotationAt(
  st: State,
  shown: Shown,
  level: string,
  box: { width: number; height: number },
  place: Place | undefined,
  tied: Ulid | undefined,
  set: Record<Ulid, Position> = {},
): Position {
  const base = tied ? (set[tied] ?? shown.stored[tied] ?? shown.auto[tied]) : undefined;
  if (!place) {
    if (tied) return TIE_OFFSET;
    const lv = st.model.levels.get(level);
    const boxes = [
      ...boxesOf(st, shown, level, set),
      ...(lv?.annotations ?? [])
        .filter((a) => a && !a.on)
        .map((a) => ({ id: a.id, x: a.x, y: a.y, ...annotationSize(a) })),
    ];
    if (boxes.length === 0) return { x: 0, y: 0 };
    return {
      x: Math.max(...boxes.map((b) => b.x + b.width)) + GAP_BESIDE,
      y: Math.min(...boxes.map((b) => b.y)),
    };
  }
  const at = resolvePlace(st, shown, level, 'task', place, set, undefined, box);
  return base ? { x: at.x - base.x, y: at.y - base.y } : at;
}

/**
 * AFD-217: a Section `around` nodes takes the box the canvas's Add Section Around draws
 * (`sectionAround`): the nodes and the Notes on them wholly inside, room for the title bar. Agents
 * would otherwise work the box out from coordinates and miss a node by a few pixels, and a node
 * not wholly inside is not carried when the Section moves.
 */
function sectionAroundNodes(
  st: State,
  ctx: OpsContext,
  shown: Shown,
  op: Extract<Op, { op: 'annotate' }>,
  kind: AnnotationKind,
  inLevel: string | undefined,
): { level: string; position: Position; width: number; height: number } {
  if (kind !== 'section')
    throw new RefError('around draws a section: leave kind out or set it to section');
  const given = (['position', 'width', 'height'] as const).filter((k) => op[k] !== undefined);
  if (given.length)
    throw new RefError(`around sets the section's place and size: leave out ${given.join(', ')}`);
  if (!ctx.positions)
    throw new RefError(
      'around needs where the canvas shows the nodes; positions are not available here',
    );
  const nodes = (op.around ?? []).map((ref) => resolveNode(st.model, ref, inLevel));
  const level = inLevel ?? nodes[0]?.level ?? ROOT;
  for (const n of nodes)
    if (n.level !== level)
      throw new RefError(
        `${n.path} is on ${levelName(st.model, n.level)}, not on ${levelName(st.model, level)}: a section goes around nodes of one level`,
      );
  const ids = new Set(nodes.map((n) => n.id));
  const boxes = boxesOf(st, shown, level, {}).filter((b) => ids.has(b.id));
  const placed = new Map(boxes.map((b) => [b.id, { x: b.x, y: b.y }]));
  const notes = annotationViews(st.model.levels.get(level) ?? { annotations: [] }, placed).filter(
    (a) => a.kind === 'note' && a.on && ids.has(a.on),
  );
  const box = sectionAround([
    ...boxes.map((b) => ({ position: { x: b.x, y: b.y }, width: b.width, height: b.height })),
    ...notes,
  ]);
  if (!box) throw new RefError('around names no node with a position');
  return { level, ...box };
}

async function shownOrStored(st: State, ctx: OpsContext): Promise<Shown> {
  return ctx.positions ? shownOf(st, ctx) : { stored: st.model.doc.layout ?? {}, auto: {} };
}

/** Position and freeze for a new node of `type` on `level`, when the op gives a place. */
async function placeNew(
  st: State,
  ctx: OpsContext,
  level: string,
  type: NodeType,
  place: Place | undefined,
): Promise<{ position?: Position; freeze?: Record<Ulid, Position> }> {
  if (!place) return {};
  const shown = await shownOf(st, ctx);
  return {
    position: resolvePlace(st, shown, level, type, place, {}),
    freeze: freezeOf(st, shown, level),
  };
}

/** The FlowCommands of one op, planned against the current state. */
async function commandsOf(
  st: State,
  op: Op,
  ctx: OpsContext,
  notes: string[],
  placed: Set<Ulid>,
): Promise<FlowCommand[]> {
  switch (op.op) {
    case 'add_node': {
      if (op.type === 'start')
        throw new RefError('A level has one start node already; add another type');
      let after = op.after ? outputPort(st, op.after) : undefined;
      let wire = op.on_wire ? wireFrom(st, op.on_wire) : undefined;
      // AFD-20: agents build chains with after; on a wired port (a new flow is start -> done) the
      // node goes on that wire instead, so the chain grows and nothing downstream is cut off.
      const taken = after
        ? st.model.levels
            .get(after.node.level)
            ?.edges.find((e) => e?.from?.node === after?.node.id && e.from.port === after.port)
        : undefined;
      if (after && taken) {
        const to = keyPath(st.model, taken.to.node);
        if (op.type === 'end' || wire)
          throw new RefError(
            `${after.node.path}.${after.port} is already wired to ${to}: ${op.type === 'end' ? 'rewire it to the new end node, or add the end node after another port' : 'pass after or on_wire, not both'}`,
          );
        notes.push(
          `${op.key ?? slugify(op.title, op.type)} went on the wire ${after.node.path}.${after.port} -> ${to} (the port was wired already)`,
        );
        wire = {
          edge: taken.id,
          label: `${after.node.path}.${after.port}`,
          level: after.node.level,
        };
        after = undefined;
      }
      // The node goes on the level of the port or wire it attaches to, unless in names a subflow.
      const near = after?.node.level ?? wire?.level;
      const parent = op.in ? subflowOf(st, op.in) : near && near !== ROOT ? near : undefined;
      const level = parent ?? ROOT;
      const key = op.key ?? slugify(op.title, op.type);
      if (!SLUG.test(key))
        throw new RefError(`Key "${key}" must be lowercase letters, digits and dashes`);
      if (levelKeys(st, level).has(key))
        throw new RefError(
          `Key "${key}" is already used on ${levelName(st.model, level)}; pass another key`,
        );
      const failed = op.failed_to ? resolveNode(st.model, op.failed_to, level) : undefined;
      const at = await placeNew(st, ctx, level, op.type, op.position);
      const cmd: FlowCommand = {
        kind: 'addNode',
        ...at,
        ...(parent ? { parent } : {}),
        type: op.type,
        title: op.title,
        key,
        ...(op.intent ? { intent: op.intent } : {}),
        ...(op.ports ? { ports: op.ports } : {}),
        ...((op.purpose ?? op.handler) ? { purpose: op.purpose ?? op.handler } : {}),
        ...(op.outcome ? { outcome: op.outcome } : {}),
        ...(op.inputs ? { inputs: op.inputs } : {}),
        ...(op.impl ? { impl: op.impl } : {}),
        ...(after ? { connectFrom: { node: after.node.id, port: after.port } } : {}),
        ...(wire ? { insertOn: wire.edge } : {}),
        ...(failed ? { wireFailedTo: failed.id } : {}),
      };
      return [cmd];
    }
    case 'update_node': {
      const node = resolveNode(st.model, op.node);
      if (op.status === 'tested')
        throw new RefError('Only a passing run sets tested; set implemented at most');
      const { op: _op, node: _node, handler, ...patch } = op;
      if (handler !== undefined && patch.purpose === undefined) patch.purpose = handler;
      return [{ kind: 'updateNode', id: node.id, patch }];
    }
    case 'delete': {
      const ids = (op.nodes ?? []).map((n) => resolveNode(st.model, n).id);
      const edges = (op.wires ?? []).map((w) => wireFrom(st, w).edge);
      const annotations = (op.annotations ?? []).map((a) => resolveAnnotation(st.model, a).id);
      if (ids.length + edges.length + annotations.length === 0)
        throw new RefError('Name nodes, wires or annotations to delete');
      return [{ kind: 'deleteNodes', ids, edges, ...(annotations.length ? { annotations } : {}) }];
    }
    case 'connect': {
      const from = outputPort(st, op.from);
      const to = resolvePort(st.model, op.to, from.node.level, 'in');
      return [
        {
          kind: 'connect',
          from: { node: from.node.id, port: from.port },
          to: { node: to.node.id, port: to.port },
        },
      ];
    }
    case 'disconnect':
      return [{ kind: 'disconnect', edge: wireFrom(st, op.from).edge }];
    case 'rewire': {
      const wire = wireFrom(st, op.from);
      const from = resolvePort(st.model, op.from);
      const to = resolvePort(st.model, op.to, from.node.level, 'in');
      return [{ kind: 'rewire', edge: wire.edge, to: { node: to.node.id, port: to.port } }];
    }
    case 'enable_port':
    case 'disable_port': {
      const node = resolveNode(st.model, op.node);
      return [
        { kind: 'setPortEnabled', node: node.id, port: op.port, enabled: op.op === 'enable_port' },
      ];
    }
    case 'leave_open': {
      if (!op.reason?.trim()) throw new RefError('Leaving a port open needs a reason');
      const at = outputPort(st, op.at);
      const by = await ctx.author?.();
      return [
        {
          kind: 'setDecision',
          node: at.node.id,
          port: at.port,
          reason: op.reason,
          ...(by ? { by } : {}),
        },
      ];
    }
    case 'accept':
    case 'unaccept': {
      // AFD-211: several places with one reason, as one op each.
      if (Array.isArray(op.at)) {
        if (op.at.length === 0) throw new RefError(`${op.op}: at lists nothing`);
        const all: FlowCommand[] = [];
        for (const at of op.at)
          all.push(...(await commandsOf(st, { ...op, at }, ctx, notes, placed)));
        return all;
      }
      // AFD-51: one op for every decision. No finding (or port:): `at` is a fail port.
      const finding = op.finding?.trim() ?? '';
      const area = finding.slice(0, Math.max(0, finding.indexOf(':')));
      const what = finding.slice(finding.indexOf(':') + 1);
      const accept = op.op === 'accept';
      if (accept && !op.reason?.trim()) throw new RefError('Accepting needs a reason');
      const by = accept ? await ctx.author?.() : undefined;
      const who = by ? { by } : {};
      if (!finding || area === 'port') {
        const at = accept ? outputPort(st, op.at) : resolvePort(st.model, op.at);
        if (area === 'port' && what !== at.port)
          throw new RefError(`finding ${finding} names another port than ${op.at}`);
        return accept
          ? [{ kind: 'setDecision', node: at.node.id, port: at.port, reason: op.reason, ...who }]
          : [{ kind: 'clearDecision', node: at.node.id, port: at.port }];
      }
      const node = resolveNode(st.model, op.at);
      if (area === 'check') {
        const [code, ...rest] = what.split(':');
        const subject = rest.join(':') || undefined;
        if (!code) throw new RefError('Name the check: check:<code>[:<subject>]');
        // AFD-184: an accept that covers no warning was stored and hid nothing; say which keys
        // this node has instead.
        if (accept && formatOf(st.model.doc) >= 2) {
          const own = warningsOf(st).filter(
            (f) => f.node === node.id && f.code !== 'open-fail-port',
          );
          if (!own.some((f) => acceptMatches(what, f))) {
            const keys = [...new Set(own.map(acceptKey))];
            throw new RefError(
              keys.length
                ? `${finding} matches no warning on ${keyPath(st.model, node.id)}; its warnings: ${keys.slice(0, 12).join(', ')}${keys.length > 12 ? ', …' : ''}`
                : `${keyPath(st.model, node.id)} has no warning to accept (${finding})`,
            );
          }
        }
        return accept
          ? [
              {
                kind: 'acceptCheck',
                node: node.id,
                code,
                ...(subject ? { subject } : {}),
                reason: op.reason,
                ...who,
              },
            ]
          : [{ kind: 'clearCheckAccept', node: node.id, code, ...(subject ? { subject } : {}) }];
      }
      if (area === 'drift')
        return accept
          ? [{ kind: 'ignoreDrift', node: node.id, item: what, reason: op.reason, ...who }]
          : [{ kind: 'clearDriftIgnore', node: node.id, item: what }];
      if (area === 'lens')
        return accept
          ? [{ kind: 'acceptFinding', finding: what, node: node.id, reason: op.reason, ...who }]
          : [{ kind: 'clearFindingAccept', finding: what }];
      throw new RefError(`finding must start with port:, check:, drift: or lens: (got ${finding})`);
    }
    case 'reopen': {
      const at = resolvePort(st.model, op.at);
      return [{ kind: 'clearDecision', node: at.node.id, port: at.port }];
    }
    case 'apply_pattern': {
      if (!(PATTERN_IDS as readonly string[]).includes(op.pattern))
        throw new RefError(`Unknown pattern "${op.pattern}"; patterns: ${PATTERN_IDS.join(', ')}`);
      const at = outputPort(st, op.at);
      const end = op.end ? resolveNode(st.model, op.end, at.node.level) : undefined;
      if (end && end.level !== at.node.level)
        throw new RefError(`${end.path} is not on the level of ${at.node.path}`);
      // The place is the handler's (or, for a pattern without one, the new end's).
      const where = await placeNew(st, ctx, at.node.level, 'task', op.position);
      return [
        {
          kind: 'applyPattern',
          pattern: op.pattern,
          from: { node: at.node.id, port: at.port },
          ...(end ? { end: end.id } : {}),
          ...where,
        },
      ];
    }
    case 'set_io': {
      const target = op.node === 'flow' ? 'flow' : resolveNode(st.model, op.node).id;
      return [
        {
          kind: 'setContractField',
          target,
          side: op.side,
          name: op.name,
          field: op.field,
          ...(op.rename ? { rename: op.rename } : {}),
        },
      ];
    }
    case 'ask_at_run_time': {
      const node = resolveNode(st.model, op.node);
      return [
        {
          kind: 'askAtRunTime',
          id: node.id,
          setting: op.setting,
          name: op.name,
          ...(op.description !== undefined ? { description: op.description } : {}),
          ...(op.default !== undefined ? { default: op.default } : {}),
        },
      ];
    }
    case 'update_flow': {
      const { op: _op, ...patch } = op;
      return [{ kind: 'updateFlow', patch }];
    }
    case 'set_entry': {
      const subflow = subflowOf(st, op.subflow);
      const node = op.node === null ? null : resolveNode(st.model, op.node, subflow).id;
      return [{ kind: 'setBoundaryIn', subflow, node }];
    }
    case 'add_exit':
    case 'remove_exit': {
      const from = outputPort(st, op.from);
      if (from.node.level === ROOT)
        throw new RefError(
          `${from.node.path} is on the top level; exits leave from a step inside a subflow (sub/step.port)`,
        );
      const ref = { node: from.node.id, port: from.port };
      return op.op === 'add_exit'
        ? [
            {
              kind: 'connectBoundary',
              subflow: from.node.level,
              from: ref,
              port: op.port,
              ...(op.reason ? { reason: op.reason } : {}),
            },
          ]
        : [{ kind: 'disconnectBoundary', subflow: from.node.level, from: ref, port: op.port }];
    }
    case 'extract_subflow': {
      const nodes = op.nodes.map((n) => resolveNode(st.model, n));
      const where = op.position
        ? await placeNew(st, ctx, nodes[0]?.level ?? ROOT, 'subflow', op.position)
        : {};
      return [
        {
          kind: 'extractSubflow',
          nodes: nodes.map((n) => n.id),
          title: op.title,
          ...(op.key ? { key: op.key } : {}),
          // The extracted nodes leave the level: their positions are not frozen there.
          ...(where.freeze
            ? {
                position: where.position,
                freeze: Object.fromEntries(
                  Object.entries(where.freeze).filter(([id]) => !nodes.some((n) => n.id === id)),
                ),
              }
            : {}),
        },
      ];
    }
    case 'bind': {
      const node = resolveNode(st.model, op.node);
      return [{ kind: 'setBinding', id: node.id, impl: op.impl }];
    }
    case 'dissolve_subflow':
      return [{ kind: 'dissolveSubflow', id: subflowOf(st, op.subflow) }];
    case 'rename': {
      // AFD-196: several keys in one op; a key cannot take a name another one gives up here.
      const entries = Object.entries(op.keys ?? {});
      if (entries.length === 0)
        throw new RefError('Name the keys: {"keys": {"old-key": "new-key"}}');
      const olds = new Set(entries.map(([from]) => from.split('/').pop()));
      const swap = entries.find(([, to]) => olds.has(to));
      if (swap)
        throw new RefError(`${swap[1]} is renamed in the same op: rename through a free key first`);
      return entries.map(([from, to]) => ({
        kind: 'updateNode',
        id: resolveNode(st.model, from).id,
        patch: { key: to },
      }));
    }
    case 'regenerate':
      // AFD-191: no change to the flow; flow_edit writes generated/ after the batch.
      return [];
    case 'replace_text':
      return replaceText(st, op, notes);
    case 'move': {
      const entries = Object.entries(op.nodes ?? {});
      const notes = Object.entries(op.annotations ?? {});
      if (entries.length + notes.length === 0)
        throw new RefError('Name what to move: {"nodes": {"node-key": {x, y}}} or annotations');
      const shown = await shownOf(st, ctx);
      const set: Record<Ulid, Position> = {};
      const levels = new Set<string>();
      for (const [ref, place] of entries) {
        const node = resolveNode(st.model, ref);
        set[node.id] = resolvePlace(st, shown, node.level, node.node.type, place, set, node.id);
        levels.add(node.level);
        placed.add(node.id);
      }
      // AFD-64: a section carries what is wholly inside it, by the distance it moves.
      const moved: Record<Ulid, Position> = {};
      for (const [ref, place] of notes) {
        const a = resolveAnnotation(st.model, ref);
        const box = annotationSize(a.annotation);
        const at = annotationAt(st, shown, a.level, box, place, a.annotation.on, set);
        moved[a.id] = at;
        if ((a.annotation.kind ?? 'note') !== 'section') continue;
        const dx = at.x - a.annotation.x;
        const dy = at.y - a.annotation.y;
        const lv = st.model.levels.get(a.level);
        if (!lv || (dx === 0 && dy === 0)) continue;
        const nodes = boxesOf(st, shown, a.level, {}).map((b) => ({
          node: { id: b.id },
          position: { x: b.x, y: b.y },
          width: b.width,
          height: b.height,
        }));
        const views = annotationViews(lv, new Map(nodes.map((n) => [n.node.id, n.position])));
        const inside = sectionContents({ nodes, annotations: views }, a.id);
        for (const id of inside.nodes) {
          const p = nodes.find((n) => n.node.id === id)?.position;
          if (p && !set[id]) set[id] = { x: p.x + dx, y: p.y + dy };
        }
        for (const id of inside.annotations) {
          const other = st.model.annotations.get(id)?.annotation;
          if (other && !moved[id]) moved[id] = { x: other.x + dx, y: other.y + dy };
        }
        if (inside.nodes.length) levels.add(a.level);
      }
      const freeze = Object.assign(
        {},
        ...[...levels].map((l) => freezeOf(st, shown, l, Object.keys(set))),
      ) as Record<Ulid, Position>;
      return [
        {
          kind: 'moveNodes',
          positions: { ...freeze, ...set },
          ...(Object.keys(moved).length ? { annotations: moved } : {}),
        },
      ];
    }
    case 'annotate': {
      const kind = op.kind ?? (op.around ? 'section' : 'note');
      const inLevel = op.in ? subflowOf(st, op.in) : undefined;
      const on = op.on ? resolveNode(st.model, op.on, inLevel) : undefined;
      if (on && inLevel && on.level !== inLevel)
        throw new RefError(
          `${on.path} is not inside ${op.in}: a note is on a node of its own level`,
        );
      const shown = await shownOrStored(st, ctx);
      const around = op.around ? sectionAroundNodes(st, ctx, shown, op, kind, inLevel) : undefined;
      const level = around?.level ?? on?.level ?? inLevel ?? ROOT;
      const box = annotationSize({ kind, ...op });
      const at = around?.position ?? annotationAt(st, shown, level, box, op.position, on?.id);
      const width = around?.width ?? op.width;
      const height = around?.height ?? op.height;
      return [
        {
          kind: 'addAnnotation',
          level,
          annotation: {
            kind,
            text: op.text,
            x: at.x,
            y: at.y,
            ...(on ? { on: on.id } : {}),
            ...(width !== undefined ? { width } : {}),
            ...(height !== undefined ? { height } : {}),
            ...(op.color !== undefined ? { color: op.color } : {}),
            ...(op.size !== undefined ? { size: op.size } : {}),
            ...(op.key !== undefined ? { key: op.key } : {}),
          },
          // A section drawn around nodes still placed by the canvas keeps them where it drew them.
          ...(kind === 'section' && ctx.positions ? { freeze: freezeOf(st, shown, level) } : {}),
        },
      ];
    }
    case 'update_annotation': {
      const a = resolveAnnotation(st.model, op.annotation);
      const { op: _op, annotation: _a, on, position, ...rest } = op;
      const patch: AnnotationPatch = { ...rest };
      if (on !== undefined) {
        if (on === null) patch.on = null;
        else {
          const node = resolveNode(st.model, on, a.level);
          if (node.level !== a.level)
            throw new RefError(
              `${node.path} is on ${levelName(st.model, node.level)}; ${a.path} is on ${levelName(st.model, a.level)}: a note is on a node of its own level`,
            );
          patch.on = node.id;
        }
      }
      if (position) {
        const shown = await shownOrStored(st, ctx);
        const tied = patch.on === undefined ? a.annotation.on : (patch.on ?? undefined);
        const at = annotationAt(st, shown, a.level, annotationSize(a.annotation), position, tied);
        patch.x = at.x;
        patch.y = at.y;
      }
      return [{ kind: 'updateAnnotation', id: a.id, patch }];
    }
    case 'unplace': {
      if (!op.nodes?.length && !op.level)
        throw new RefError('Name nodes, or a level (top, all or a subflow key), to unplace');
      const ids = (op.nodes ?? []).map((n) => resolveNode(st.model, n).id);
      if (op.level) {
        const levels =
          op.level === 'all'
            ? [...st.model.levels.values()]
            : [st.model.levels.get(op.level === 'top' ? ROOT : subflowOf(st, op.level))];
        for (const l of levels) for (const n of l?.nodes ?? []) if (n?.id) ids.push(n.id);
      }
      return [{ kind: 'unplaceNodes', ids }];
    }
    case 'upgrade_format':
      return [{ kind: 'upgradeFormat' }];
    case 'tidy_up': {
      if (!ctx.layout) throw new RefError('tidy_up is not available here');
      const which = op.level ?? 'top';
      const levels =
        which === 'all'
          ? [...st.model.levels.values()]
          : [st.model.levels.get(which === 'top' ? ROOT : subflowOf(st, which))].filter(
              (l): l is Level => !!l,
            );
      const positions: Record<Ulid, Position> = {};
      for (const level of levels) Object.assign(positions, await ctx.layout(level));
      // AFD-69: the tidied levels get the layout check too (crossings and labels can remain).
      for (const id of Object.keys(positions)) placed.add(id);
      return [{ kind: 'tidyUp', positions }];
    }
  }
  throw new RefError(`Unknown op "${(op as { op?: string }).op}"`);
}

/**
 * Applies ops in order, all or nothing. IDs missing from a file written by hand are completed first.
 * Throws OpError (with the op index) and writes nothing when any op fails.
 */
export async function applyOps(
  text: string,
  ops: readonly Op[],
  ctx: OpsContext,
): Promise<OpsResult> {
  const notes: string[] = [];
  const dropped = new Set<string>();
  let current = text;
  try {
    const done = completeIds(current, ctx.newId);
    if (done.text !== current) {
      current = done.text;
      const f = done.filled;
      notes.push(
        `Completed IDs: ${f.nodes} node(s), ${f.wires} wire(s), ${f.refs} reference(s) by key${f.annotations ? `, ${f.annotations} annotation ID(s) and key(s)` : ''}`,
      );
    }
  } catch (e) {
    throw new OpError(-1, `The file does not parse: ${(e as Error).message}. Nothing was written.`);
  }
  let st = stateOf(current);
  const existing = new Set(st.model.nodes.keys());
  /** Nodes the batch put at a place the agent gave (AFD-24): checked for overlaps at the end. */
  const placed = new Set<Ulid>();
  for (const [i, op] of ops.entries()) {
    try {
      for (const cmd of await commandsOf(st, op, ctx, notes, placed)) {
        const r = planCommand(st.text, cmd, { newId: ctx.newId }, st.file);
        st = stateOf(r.text, r.file);
        notes.push(...(r.notes ?? []));
        if ('position' in cmd && cmd.position && r.created) placed.add(r.created);
        for (const id of r.dropped ?? []) dropped.add(keyPath(st.model, id));
        if (cmd.kind === 'addNode' && r.created) {
          const extra = op.op === 'add_node' ? op : undefined;
          // What addNode does not take is set right after, in the same batch.
          const patch = {
            ...(extra?.condition !== undefined ? { condition: extra.condition } : {}),
            ...(extra?.branches !== undefined ? { branches: extra.branches } : {}),
            ...(extra?.join_mode !== undefined ? { join_mode: extra.join_mode } : {}),
            ...(extra?.settings !== undefined ? { settings: extra.settings } : {}),
          };
          const more: FlowCommand[] = [];
          if (Object.keys(patch).length > 0)
            more.push({ kind: 'updateNode', id: r.created, patch });
          for (const [name, field] of Object.entries(extra?.outputs ?? {}))
            more.push({
              kind: 'setContractField',
              target: r.created,
              side: 'outputs',
              name,
              field,
            });
          for (const c of more) {
            const m = planCommand(st.text, c, { newId: ctx.newId }, st.file);
            st = stateOf(m.text, m.file);
            notes.push(...(m.notes ?? []));
          }
        }
      }
    } catch (e) {
      const why =
        e instanceof RefError || e instanceof CommandError || e instanceof YamlEditError
          ? (e as Error).message
          : String(e);
      throw new OpError(
        i,
        `op ${i + 1} (${opLabel(op)}): ${withoutIds(st.model, why)}. Nothing was written.`,
      );
    }
  }
  if (placed.size > 0 && ctx.positions) notes.push(...(await layoutNotes(st, ctx, placed)));
  // Patterns and extraction add nodes too: report every node the batch made.
  const created = [...st.model.nodes.keys()]
    .filter((id) => !existing.has(id))
    .map((id) => keyPath(st.model, id));
  return { text: st.text, created, dropped: [...dropped], notes };
}

/**
 * The layout check (AFD-69) of each level the batch placed nodes on: overlaps (AFD-24), wires
 * through boxes, labels on boxes and on each other, crossings. The agent never sees the canvas.
 */
async function layoutNotes(st: State, ctx: OpsContext, placed: Set<Ulid>): Promise<string[]> {
  const levels = new Set<string>();
  for (const id of placed) {
    const level = st.model.nodes.get(id)?.level;
    if (level !== undefined) levels.add(level);
  }
  const found = flowLayoutProblems(st.model, await shownOf(st, ctx), levels);
  return [...found].flatMap(([level, problems]) =>
    problems.length
      ? [
          `Layout check of ${levelName(st.model, level)}: ${problems.length} problem(s). ${LAYOUT_FIX}`,
          ...problems.map((p) => `  ${p.text}`),
        ]
      : [`Layout check of ${levelName(st.model, level)}: no problems.`],
  );
}

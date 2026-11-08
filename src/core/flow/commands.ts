// Canvas intent commands → minimal text edits of the flow document (ADR-0001). Commands address
// nodes and edges by ID; each one becomes a single WorkspaceEdit, i.e. one undo step.

import { IMPORTED_FIELDS, type ReimportAdd, type ReimportUpdate } from '../import/reimport';
import type { TextEdit } from '../yaml/edits';
import { deleteKey, insertItem, type OpResult, removeItem, removeItems, setIn } from '../yaml/ops';
import type { Path, YamlFile } from '../yaml/parse';
import { Literal, type YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { annotationValue, nextAnnotationKey, TIE_OFFSET } from './annotations';
import { levelTaken, openOnPurpose, portKey, untakenFailPorts } from './bubbling';
import { parseClip } from './clipboard';
import { enclosing, readerLevel } from './dataRefs';
import {
  acceptedAll,
  acceptedOf,
  checkWhat,
  type DecisionArea,
  decisionItem,
  findAccepted,
  portAccepted,
} from './decisions';
import { ANNOTATION_ORDER, NODE_ORDER, purposeKey, requireFormat } from './format';
import { type IdFactory, SLUG, slugify, uniqueKey } from './ids';
import { mapStrings, renameExprRef, renameRef } from './jinja';
import { existingLift, liftField, liftName } from './lift';
import { CURRENT_FORMAT, FormatError, formatOf, migrate } from './migrate';
import { buildModel, type FlowModel, keyScope, type Level, ROOT } from './model';
import { findEnd, type NodeRecipe, type PatternId, patternFits, recipeFor } from './patterns';
import {
  isFailPort,
  isPortLegal,
  LEGACY_PORTS,
  offeredPortNames,
  optionalPortNames,
  portDirection,
  portsFor,
} from './ports';
import { copySubflow, parseRefFrom, refFor } from './refs';
import { nodeDesigns, testedDropBack } from './semantic';
import { canMarkTested, contentStatus, hasStatus, statusAfterBinding, statusFor } from './status';
import {
  ANNOTATION_COLORS,
  ANNOTATION_KINDS,
  type AnnotationColor,
  type AnnotationKind,
  type BoundaryExit,
  type ContractField,
  type FlowDocument,
  type FlowNode,
  type HandlerKind,
  type ImplBinding,
  type JoinMode,
  type NodeSettings,
  type NodeStatus,
  type NodeType,
  type PortRef,
  type Position,
  type SubflowBody,
  TEXT_SIZES,
  type TestedRecord,
  type TextSize,
  type Ulid,
} from './types';
import { varNameProblem } from './varNames';
import { descendantIds } from './walk';

type Boundary = NonNullable<SubflowBody['boundary']>;

export type FlowCommand =
  | {
      kind: 'addNode';
      /** Subflow node whose inner graph receives the node; omitted for the top level. */
      parent?: Ulid;
      type: NodeType;
      title: string;
      key?: string;
      intent?: string;
      ports?: string[];
      purpose?: HandlerKind;
      outcome?: 'success' | 'failed';
      inputs?: Record<string, ContractField>;
      /** Bound from the start (M6 "Add to subflow": a role task file becomes a step). */
      impl?: ImplBinding;
      position?: Position;
      /** Wire this output port to the new node's `in`. */
      connectFrom?: PortRef;
      /** Wire the new node's failed_hosts to this node's `in` (e.g. an existing Rollback). */
      wireFailedTo?: Ulid;
      /** Put the new node on this edge: the edge now ends at the node, which continues to the old target. */
      insertOn?: Ulid;
      /** Positions of nodes still shown at auto-layout positions, written in the same edit. */
      freeze?: Record<Ulid, Position>;
    }
  | {
      kind: 'applyPattern';
      pattern: PatternId;
      from: PortRef;
      /** Where the handler node (or, without one, the new end node) goes. */
      position?: Position;
      /** The end node to wire to instead of the one the pattern picks (AFD-21). */
      end?: Ulid;
      freeze?: Record<Ulid, Position>;
    }
  | { kind: 'setDecision'; node: Ulid; port: string; reason: string; by?: string }
  | { kind: 'clearDecision'; node: Ulid; port: string }
  | { kind: 'rewire'; edge: Ulid; to: PortRef }
  | { kind: 'updateNode'; id: Ulid; patch: NodePatch }
  | { kind: 'deleteNode'; id: Ulid }
  /**
   * AFD-18: a selection (nodes and wires of one level) goes in one edit, so one undo restores it;
   * AFD-64: with its annotations.
   */
  | { kind: 'deleteNodes'; ids: Ulid[]; edges?: Ulid[]; annotations?: Ulid[] }
  /** AFD-64: annotations move in the same edit (stored form: relative for a Note on a node). */
  | {
      kind: 'moveNodes';
      positions: Record<Ulid, Position>;
      annotations?: Record<Ulid, Position>;
    }
  /** AFD-24: drop stored positions, so the canvas places these nodes again. */
  | { kind: 'unplaceNodes'; ids: Ulid[] }
  | { kind: 'tidyUp'; positions: Record<Ulid, Position>; annotations?: Record<Ulid, Position> }
  /** AFD-64: a Note, Section or Text on a level (format 2); `freeze` as for addNode. */
  | {
      kind: 'addAnnotation';
      level?: string;
      annotation: AnnotationPatch & { text: string; x: number; y: number };
      freeze?: Record<Ulid, Position>;
    }
  /** AFD-64: an annotation's text, look, place or tie (`on: null` unties it). */
  | { kind: 'updateAnnotation'; id: Ulid; patch: AnnotationPatch }
  | { kind: 'connect'; from: PortRef; to: PortRef }
  | { kind: 'disconnect'; edge: Ulid }
  | { kind: 'setPortEnabled'; node: Ulid; port: string; enabled: boolean }
  | {
      kind: 'setContractField';
      /** `flow` for flow inputs, otherwise a node id. */
      target: 'flow' | Ulid;
      side: 'inputs' | 'outputs';
      name: string;
      /** null removes the field. */
      field: ContractField | null;
      /** New name for the field (rename keeps the definition). */
      rename?: string;
    }
  | { kind: 'updateFlow'; patch: FlowPatch }
  /**
   * AFD-112 (round 4: Q4): a step's Timing setting given at run time, in one edit: the flow input
   * (an integer, the field's value its default), the step input reading it, and the setting.
   */
  | {
      kind: 'askAtRunTime';
      id: Ulid;
      setting: RunTimeSetting;
      name: string;
      description?: string;
      /** Without one, the flow input is required. */
      default?: number;
    }
  /** D-23: the inner node that receives the hosts entering the subflow (null clears it). */
  | { kind: 'setBoundaryIn'; subflow: Ulid; node: Ulid | null }
  /** D-23: an inner output leaves the subflow through the parent's `port`. */
  | { kind: 'connectBoundary'; subflow: Ulid; from: PortRef; port: string; reason?: string }
  | { kind: 'disconnectBoundary'; subflow: Ulid; from: PortRef; port: string }
  | { kind: 'setExitReason'; subflow: Ulid; from: PortRef; port: string; reason: string | null }
  /**
   * M5 "Save binding" (mockup 11): the implementation and what came with it (inputs the chips
   * created, outputs from the registered result) in one edit; `impl: null` unbinds. The status
   * follows (AFD-50).
   */
  | {
      kind: 'setBinding';
      id: Ulid;
      impl: ImplBinding | null;
      /** Contract fields to set (null removes one); other fields stay. */
      inputs?: Record<string, ContractField | null>;
      outputs?: Record<string, ContractField | null>;
    }
  /** M6 (D-29): keep a drift item as it is, with a reason; the host adds `by`. */
  | { kind: 'ignoreDrift'; node: Ulid; item: string; reason: string; by?: string }
  | { kind: 'clearDriftIgnore'; node: Ulid; item: string }
  /** M8: keep a lens finding as expected, with a reason; the host adds `by`. */
  | { kind: 'acceptFinding'; finding: string; node?: Ulid; reason: string; by?: string }
  | { kind: 'clearFindingAccept'; finding: string }
  /**
   * AFD-51 (format 2): a validator warning kept as it is, with a reason; the host adds `by`. The
   * warning stops showing for that node (and subject, e.g. the variable a binding reads).
   */
  | { kind: 'acceptCheck'; node: Ulid; code: string; subject?: string; reason: string; by?: string }
  | { kind: 'clearCheckAccept'; node: Ulid; code: string; subject?: string }
  /**
   * Decision 15 (M7): the nodes a passing run of this flow version tested, in one edit. Format 2
   * records the run on each node (AFD-50).
   */
  | {
      kind: 'setStatuses';
      statuses: Record<Ulid, NodeStatus>;
      run?: { id: string; flowVersion?: number; commit?: string };
    }
  /**
   * AFD-44: `tested` set by hand, with the reason, the author and the day (the host adds `by` and
   * `at`): format 2 keeps them on the node (AFD-50), format 1 in the `finding_accepted` record
   * `status:tested|<node>`.
   */
  | { kind: 'markTested'; id: Ulid; reason: string; by?: string; at?: string }
  /** Upgrade Flow Format (AFD-49): the file to the current format, one undo step. */
  | { kind: 'upgradeFormat' }
  /**
   * AFD-60, format 2: a copy of another flow's subflow (`source`, read by the host) on a level,
   * pinned to that flow's `version`; it keeps its source's key.
   */
  | {
      kind: 'addReference';
      parent?: Ulid;
      from: string;
      version: number;
      source: FlowNode;
      position?: Position;
    }
  /** AFD-60: the copy again from a newer version of its source (steps inside start untested). */
  | { kind: 'updateReference'; id: Ulid; version: number; source: FlowNode }
  /** AFD-60: the copy becomes this flow's own subflow, to edit here. */
  | { kind: 'unlinkReference'; id: Ulid }
  /**
   * AFD-61: a re-import's merge, as the host planned it from a fresh import of the source: the
   * steps that take the source's version, the new steps after the step before them, the steps
   * whose task is gone (flagged), and the steps that keep the designer's version: they note the
   * source's fingerprint, so the same change is not offered again.
   */
  | {
      kind: 'reimport';
      updates: ReimportUpdate[];
      adds: ReimportAdd[];
      gone: Ulid[];
      keep?: { node: Ulid; design: string }[];
    }
  /** AFD-17: nodes from clipboard text become new nodes on a level (`root` or a subflow). */
  | {
      kind: 'pasteNodes';
      text: string;
      level?: string;
      position?: Position;
      /** Positions of nodes still shown at auto-layout positions, written in the same edit. */
      freeze?: Record<Ulid, Position>;
    }
  /** AFD-7: move a connected selection of one level into a new subflow node. */
  | {
      kind: 'extractSubflow';
      nodes: Ulid[];
      title: string;
      key?: string;
      position?: Position;
      freeze?: Record<Ulid, Position>;
      /** AFD-64: annotations of the level that go inside too (Notes on the nodes always do). */
      annotations?: Ulid[];
    };

/**
 * What an annotation command writes (AFD-64). `on` ties a Note to a node of its level (null unties);
 * with `x`/`y` absent the Note keeps its place on the canvas as far as the stored positions tell.
 */
export interface AnnotationPatch {
  kind?: AnnotationKind;
  key?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number | null;
  height?: number | null;
  color?: AnnotationColor | null;
  size?: TextSize | null;
  on?: Ulid | null;
}

export interface NodePatch {
  title?: string;
  key?: string;
  intent?: string | null;
  status?: NodeStatus | null;
  condition?: string | null;
  outcome?: 'success' | 'failed' | null;
  purpose?: HandlerKind | null;
  join_mode?: JoinMode | null;
  branches?: number | null;
  /** Merged into `settings`; null removes a setting. */
  settings?: { [K in keyof NodeSettings]?: NodeSettings[K] | null };
  /** Replaces the binding's task keywords (AFD-26); null or {} removes them. */
  keywords?: Record<string, unknown> | null;
  /**
   * AFD-112: merged into the node's inputs; null removes one. A Timing field given an input with
   * @ and the input it reads are one edit, so one undo takes back both.
   */
  inputs?: Record<string, ContractField | null>;
}

/** The settings a step may take at run time (AFD-112). */
export type RunTimeSetting = 'retries' | 'delay' | 'timeout';

export interface FlowPatch {
  name?: string;
  key?: string;
  goal?: string | null;
  owner?: string | null;
  /** The AWX job template the flow launches (M7 "Set up AWX template"); null removes runtime. */
  runtime?: NonNullable<FlowDocument['flow']['runtime']> | null;
  /** Timing lens (M8): `4h`, `2h30m`; null removes it. */
  maintenance_window?: string | null;
}

export interface CommandContext {
  newId: IdFactory;
}

export interface CommandResult {
  edits: TextEdit[];
  text: string;
  /** Parse of `text`, so the caller need not parse the result again. */
  file: YamlFile;
  created?: Ulid;
  /** Every node a paste created (AFD-17). */
  pasted?: Ulid[];
  /** Tested nodes the command changed, now implemented again (decision 15). */
  dropped?: Ulid[];
  /** What the command did besides what was asked (outputs lifted, AFD-21). */
  notes?: string[];
}

export class CommandError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CommandError';
  }
}

/** A format refusal (newer file, already current, needs an upgrade) as the command's error. */
export function formatGuard<T>(run: () => T): T {
  try {
    return run();
  } catch (err) {
    if (err instanceof FormatError) throw new CommandError(err.code, err.message);
    throw err;
  }
}

const FLOW_ORDER = [
  'id',
  'key',
  'name',
  'version',
  'goal',
  'owner',
  'runtime',
  'imported_from',
  'maintenance_window',
  'inputs',
];
const SUBFLOW_ORDER = ['nodes', 'edges', 'annotations', 'layout', 'boundary'];
const ROOT_ORDER = [
  'schema_version',
  'flow',
  'nodes',
  'edges',
  'annotations',
  'layout',
  'decisions',
];

const after = (order: readonly string[], key: string) => order.slice(order.indexOf(key) + 1);

interface State {
  doc: FlowDocument;
  model: FlowModel;
}

function state(tx: YamlTransaction): State {
  const doc = tx.current.doc.toJS() as FlowDocument;
  return { doc, model: buildModel(doc) };
}

function nodeAt(st: State, id: Ulid) {
  const entry = st.model.nodes.get(id);
  if (!entry) throw new CommandError('not-found', `No node ${id}`);
  return entry;
}

function levelOf(st: State, levelId: string): Level {
  const level = st.model.levels.get(levelId);
  if (!level) throw new CommandError('not-found', `No level ${levelId}`);
  return level;
}

function setField(
  tx: YamlTransaction,
  base: Path,
  key: string,
  value: YamlValue | undefined,
  order: readonly string[],
): void {
  if (value === undefined) return;
  const current = tx.current.doc.getIn([...base, key]);
  if (value === null) {
    if (current !== undefined) tx.apply((f) => deleteKey(f, base, key));
    return;
  }
  tx.apply((f) => setIn(f, [...base, key], value, { before: after(order, key) }));
}

function removeEdgeById(tx: YamlTransaction, id: Ulid): void {
  const entry = state(tx).model.edges.get(id);
  if (!entry) throw new CommandError('not-found', `No edge ${id}`);
  tx.apply((f) => removeItem(f, entry.path.slice(0, -1), entry.path.at(-1) as number));
}

function contract(field: ContractField): YamlValue {
  const out: Record<string, YamlValue> = { type: field.type };
  if (field.required !== undefined) out.required = field.required;
  if (field.default !== undefined) out.default = field.default as YamlValue;
  if (field.from !== undefined) out.from = field.from;
  if (field.targets !== undefined) out.targets = field.targets;
  // AFD-100: AFD-95 read descriptions everywhere but this writer never kept one, so the flow
  // panel's box and the flow tools' set_io lost it. An empty one is no description.
  if (field.description) out.description = field.description;
  return out;
}

type Op = (f: YamlFile) => OpResult;

// Builders below return ops computed against one state, so a command can batch them into a single
// re-parse (YamlTransaction.applyAll). Parsing dominates command latency.

function enablePortOps(st: State, id: Ulid, port: string): Op[] {
  const { node, path } = nodeAt(st, id);
  if (portsFor(node).some((p) => p.name === port)) return [];
  if (!optionalPortNames(node.type).includes(port)) {
    throw new CommandError('bad-port', `${node.type} nodes have no port "${port}"`);
  }
  if (LEGACY_PORTS.has(port))
    throw new CommandError(
      'legacy-port',
      `The ${port} port was never built: ${port === 'undo' ? 'apply Rollback on the failure port, which wires an undo step per completed step' : 'a cancelled job routes no host'}`,
    );
  if (node.ports) return [(f) => insertItem(f, [...path, 'ports'], 'end', port)];
  return [(f) => setIn(f, [...path, 'ports'], [port], { before: after(NODE_ORDER, 'ports') })];
}

function ensurePortEnabled(tx: YamlTransaction, id: Ulid, port: string): void {
  tx.applyAll(enablePortOps(state(tx), id, port));
}

function reachable(level: Level, from: Ulid, to: Ulid): boolean {
  const seen = new Set<Ulid>();
  const stack = [from];
  while (stack.length > 0) {
    const n = stack.pop() as Ulid;
    if (n === to) return true;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const e of level.edges) if (e?.from?.node === n) stack.push(e.to.node);
  }
  return false;
}

/** The output exists on the node and is not wired yet (03: one edge per output). */
function checkOutput(st: State, from: PortRef): Level {
  const a = nodeAt(st, from.node);
  if (!isPortLegal(a.node, from.port) || portDirection(from.port) !== 'out') {
    throw new CommandError('bad-port', `"${from.port}" is not an output of ${a.node.type}`);
  }
  const level = levelOf(st, a.level);
  if (level.edges.some((e) => e?.from?.node === from.node && e.from.port === from.port)) {
    throw new CommandError(
      'port-in-use',
      `${from.port} is already wired; use a parallel node to fan out`,
    );
  }
  const exit = exitOf(st, level, from);
  if (exit) {
    throw new CommandError(
      'port-in-use',
      `${from.port} already leaves the subflow through ${exit}; remove that exit first`,
    );
  }
  return level;
}

/** The parent port an inner output leaves through (boundary.outputs), if any. */
function exitOf(st: State, level: Level, from: PortRef): string | undefined {
  const parent = level.parent ? st.model.nodes.get(level.parent)?.node : undefined;
  for (const [port, refs] of Object.entries(parent?.subflow?.boundary?.outputs ?? {}))
    if ((refs ?? []).some((r) => r?.node === from.node && r.port === from.port)) return port;
  return undefined;
}

/** A subflow node with an inner graph, and the YAML path of its `subflow` block. */
function subflowAt(st: State, id: Ulid): { node: FlowNode; level: Level; base: Path } {
  const { node, path } = nodeAt(st, id);
  if (node.type !== 'subflow') throw new CommandError('bad-type', `${node.title} is not a subflow`);
  const level = st.model.levels.get(id);
  if (!level) throw new CommandError('no-inner-graph', 'The subflow has no inner graph yet');
  return { node, level, base: [...path, 'subflow'] };
}

/** Ops that make `boundary` equal `next` (whole-block rewrite; the block is small). */
function boundaryOps(st: State, id: Ulid, next: Boundary | undefined): Op[] {
  const { node, base } = subflowAt(st, id);
  const current = node.subflow?.boundary;
  const outputs = Object.fromEntries(
    Object.entries(next?.outputs ?? {}).filter(([, refs]) => (refs ?? []).length > 0),
  );
  const value: Record<string, YamlValue> = {};
  if (next?.in) value.in = next.in;
  if (Object.keys(outputs).length > 0)
    value.outputs = Object.fromEntries(
      Object.entries(outputs).map(([port, refs]) => [
        port,
        refs.map((r) => ({
          node: r.node,
          port: r.port,
          ...(r.reason ? { reason: r.reason } : {}),
        })),
      ]),
    );
  if (Object.keys(value).length === 0)
    return current === undefined ? [] : [(f) => deleteKey(f, base, 'boundary')];
  return [
    (f) => setIn(f, [...base, 'boundary'], value, { before: after(SUBFLOW_ORDER, 'boundary') }),
  ];
}

function edgeItem(ctx: CommandContext, from: PortRef, to: PortRef): Record<string, YamlValue> {
  return {
    id: ctx.newId(),
    from: { node: from.node, port: from.port },
    to: { node: to.node, port: to.port },
  };
}

function addEdge(tx: YamlTransaction, ctx: CommandContext, from: PortRef, to: PortRef): Ulid {
  const st = state(tx);
  const level = checkOutput(st, from);
  const b = nodeAt(st, to.node);
  if (b.level !== level.id)
    throw new CommandError('cross-level', 'Both ends must be in the same level');
  if (!isPortLegal(b.node, to.port) || portDirection(to.port) !== 'in') {
    throw new CommandError('bad-port', `"${to.port}" is not an input of ${b.node.type}`);
  }
  if (from.node === to.node || reachable(level, to.node, from.node)) {
    throw new CommandError('cycle', 'This edge would create a cycle');
  }
  const edge = edgeItem(ctx, from, to);
  tx.applyAll([
    ...enablePortOps(st, from.node, from.port),
    ...enablePortOps(st, to.node, to.port),
    (f) => insertItem(f, level.edgesPath, 'end', edge),
    // A wired port is no longer open: its open-on-purpose decision goes in the same edit.
    ...decisionRemovalOps(st, from.node, from.port),
  ]);
  return edge.id as Ulid;
}

function decisionRemovalOps(st: State, node: Ulid, port: string): Op[] {
  const decisions = st.doc.decisions ?? [];
  const idx = acceptedAll(st.doc)
    .filter((a) => a.area === 'port' && a.node === node && a.what === port)
    .map((a) => a.index);
  if (idx.length === 0) return [];
  if (idx.length === decisions.length) return [(f) => deleteKey(f, [], 'decisions')];
  return [(f) => removeItems(f, ['decisions'], idx)];
}

function positionOps(st: State, positions: Record<Ulid, Position>): Op[] {
  const rounded = Object.entries(positions).map(
    ([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }] as const,
  );
  if (rounded.length === 0) return [];
  if (st.doc.layout === undefined || st.doc.layout === null) {
    const block: Record<string, YamlValue> = {};
    for (const [id, p] of rounded) block[id] = { x: p.x, y: p.y };
    return [(f) => setIn(f, ['layout'], block, { before: after(ROOT_ORDER, 'layout') })];
  }
  const ops: Op[] = [];
  for (const [id, p] of rounded) {
    const old = st.doc.layout[id];
    if (!old) {
      ops.push((f) => setIn(f, ['layout', id], { x: p.x, y: p.y }));
      continue;
    }
    if (old.x !== p.x) ops.push((f) => setIn(f, ['layout', id, 'x'], p.x));
    if (old.y !== p.y) ops.push((f) => setIn(f, ['layout', id, 'y'], p.y));
  }
  return ops;
}

function setPositions(tx: YamlTransaction, positions: Record<Ulid, Position>): void {
  tx.applyAll(positionOps(state(tx), positions));
}

/** Removes stored positions; the whole block goes when nothing is left in it. */
function unplaceNodes(tx: YamlTransaction, ids: readonly Ulid[]): void {
  const layout = state(tx).doc.layout ?? {};
  const gone = ids.filter((id) => id in layout);
  if (gone.length === 0) return;
  if (gone.length === Object.keys(layout).length) tx.apply((f) => deleteKey(f, [], 'layout'));
  else tx.applyAll(gone.map((id) => (f: YamlFile) => deleteKey(f, ['layout'], id)));
}

interface NodeSpec {
  parent?: Ulid;
  type: NodeType;
  title: string;
  key?: string;
  intent?: string;
  ports?: string[];
  purpose?: HandlerKind;
  outcome?: 'success' | 'failed';
  inputs?: Record<string, ContractField>;
  settings?: NodeSettings;
  impl?: ImplBinding;
}

/** A new node's YAML; `taken` holds the level's keys and receives the new one. */
function nodeItem(
  ctx: CommandContext,
  spec: NodeSpec,
  taken: Set<string>,
  /** The document's name for what the node is for (AFD-52). */
  purpose: 'purpose' | 'handler' = 'handler',
): { id: Ulid; item: Record<string, YamlValue> } {
  const key = spec.key ?? uniqueKey(slugify(spec.title), taken);
  checkKey(key, taken);
  taken.add(key);
  const id = ctx.newId();
  const node: Record<string, YamlValue> = { id, key, type: spec.type, title: spec.title };
  if (spec.type !== 'start' && spec.type !== 'end') node.status = 'draft';
  if (spec.intent) node.intent = spec.intent;
  if (spec.type === 'end') node.outcome = spec.outcome ?? 'success';
  if (spec.purpose) node[purpose] = spec.purpose;
  const offered = offeredPortNames(spec.type);
  const ports = (spec.ports ?? []).filter((p) => offered.includes(p));
  if (ports.length > 0) node.ports = ports;
  if (spec.inputs && Object.keys(spec.inputs).length > 0) {
    node.inputs = Object.fromEntries(Object.entries(spec.inputs).map(([k, v]) => [k, contract(v)]));
  }
  if (spec.settings && Object.keys(spec.settings).length > 0)
    node.settings = spec.settings as Record<string, YamlValue>;
  if (spec.impl) node.impl = implValue(spec.impl);
  return { id, item: node };
}

/** A level and the levels around it, innermost first, up to the top level. */
function levelChain(model: FlowModel, levelId: string): string[] {
  const out = [levelId];
  for (let at = levelId; at !== ROOT; ) {
    const up = model.nodes.get(at)?.level;
    if (up === undefined) break;
    out.push(up);
    at = up;
  }
  return out;
}

/**
 * AFD-143: the keys a new node on `levelId` would take over. keyScope resolves the innermost level
 * first, so a reference that sees this level (from it, or from inside one of its subflows) and now
 * reads a node of that key on an outer level would silently read the new node instead.
 */
export function shadowedKeys(model: FlowModel, levelId: string): Set<string> {
  const out = new Set<string>();
  for (const entry of model.nodes.values())
    for (const side of ['inputs', 'outputs'] as const) {
      const fields = Object.values(entry.node[side] ?? {});
      if (!fields.some((f) => f?.from)) continue;
      const at = readerLevel(model, entry.node, entry.level, side);
      const chain = levelChain(model, at);
      const here = chain.indexOf(levelId);
      if (here < 0) continue;
      const scope = keyScope(model, at);
      for (const field of fields) {
        const head = (field?.from ?? '').split('.')[0] ?? '';
        if (!head || head === 'flow' || head === 'impl' || head.includes('/')) continue;
        const target = scope.get(head);
        const targetLevel = target ? model.nodes.get(target)?.level : undefined;
        if (targetLevel !== undefined && chain.indexOf(targetLevel) > here) out.add(head);
      }
    }
  return out;
}

/** A level's keys plus the ones a new node there would take over (AFD-143). */
class TakenKeys extends Set<string> {
  constructor(
    own: Iterable<string>,
    readonly shadowed: ReadonlySet<string>,
  ) {
    super([...own, ...shadowed]);
  }
}

/** Refuses a key a node cannot take on its level; `taken` from levelKeys. */
function checkKey(key: string, taken: ReadonlySet<string>): void {
  if (!SLUG.test(key)) throw new CommandError('bad-key', `Key "${key}" must be a lowercase slug`);
  if (taken instanceof TakenKeys && taken.shadowed.has(key))
    throw new CommandError(
      'shadowing-key',
      `Key "${key}" would take over the references that read the "${key}" around this level: choose another key`,
    );
  if (taken.has(key))
    throw new CommandError('duplicate-key', `Key "${key}" is already used in this level`);
}

/**
 * The keys a new node on a level cannot take. With the model, also the keys it would take over
 * from outer levels (AFD-143): generated keys pass them by, a key given explicitly is refused.
 */
function levelKeys(level: Level, model?: FlowModel): Set<string> {
  const own = level.nodes.flatMap((n) => (n?.key ? [n.key] : []));
  return model ? new TakenKeys(own, shadowedKeys(model, level.id)) : new Set(own);
}

/**
 * Inserts a new node into its level. The first step of a subflow creates the inner graph and
 * becomes the boundary entry (D-23), in the same edit.
 */
function insertNode(tx: YamlTransaction, ctx: CommandContext, spec: NodeSpec): Ulid {
  const st = state(tx);
  if (!spec.parent) {
    const level = levelOf(st, ROOT);
    const { id, item } = nodeItem(ctx, spec, levelKeys(level, st.model), purposeKey(st.doc));
    tx.apply((f) => insertItem(f, level.nodesPath, 'end', item));
    return id;
  }
  const parent = spec.parent;
  const { node, path } = nodeAt(st, parent);
  if (node.type !== 'subflow') throw new CommandError('bad-type', `${node.title} is not a subflow`);
  const level = st.model.levels.get(parent);
  const { id, item } = nodeItem(
    ctx,
    spec,
    // An empty subflow has no level yet; its outputs may still read through to outer nodes.
    level ? levelKeys(level, st.model) : new TakenKeys([], shadowedKeys(st.model, parent)),
    purposeKey(st.doc),
  );
  const base = [...path, 'subflow'];
  const entry = !node.subflow?.nodes?.length && !node.subflow?.boundary?.in;
  if (!node.subflow) {
    const body: Record<string, YamlValue> = { nodes: [item] };
    if (entry) body.boundary = { in: id };
    tx.apply((f) => setIn(f, base, body, { before: after(NODE_ORDER, 'subflow') }));
    return id;
  }
  const ops: Op[] = [
    node.subflow.nodes
      ? (f) => insertItem(f, [...base, 'nodes'], 'end', item)
      : (f) => setIn(f, [...base, 'nodes'], [item], { before: after(SUBFLOW_ORDER, 'nodes') }),
  ];
  if (entry) ops.push(...boundaryOps(st, parent, { ...node.subflow.boundary, in: id }));
  tx.applyAll(ops);
  return id;
}

/** Output a node continues on when it is inserted on a wire. */
const CONTINUES_ON: Partial<Record<NodeType, string>> = {
  task: 'ok_hosts',
  subflow: 'ok_hosts',
  join: 'ok_hosts',
  decision: 'true',
  approval: 'approved',
  parallel: 'branch_1',
};

function addNode(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'addNode' }>,
  notes: string[],
): Ulid {
  if (cmd.insertOn && cmd.connectFrom)
    throw new CommandError('bad-command', 'Use either insertOn or connectFrom');
  if (cmd.insertOn && !CONTINUES_ON[cmd.type]) {
    throw new CommandError('bad-type', `A ${cmd.type} node cannot be inserted on a wire`);
  }
  const id = insertNode(tx, ctx, cmd);
  liftPathRefs(tx, id, notes);
  setPositions(tx, { ...cmd.freeze, ...(cmd.position ? { [id]: cmd.position } : {}) });
  if (cmd.connectFrom) addEdge(tx, ctx, cmd.connectFrom, { node: id, port: 'in' });
  if (cmd.insertOn) insertOnEdge(tx, ctx, cmd.insertOn, id, CONTINUES_ON[cmd.type] as string);
  if (cmd.wireFailedTo)
    addEdge(tx, ctx, { node: id, port: 'failed_hosts' }, { node: cmd.wireFailedTo, port: 'in' });
  return id;
}

/** The edge keeps its ID and source and now ends at `node`; `node` continues to the old target. */
function insertOnEdge(
  tx: YamlTransaction,
  ctx: CommandContext,
  edgeId: Ulid,
  node: Ulid,
  out: string,
): void {
  const st = state(tx);
  const entry = st.model.edges.get(edgeId);
  if (!entry) throw new CommandError('not-found', `No edge ${edgeId}`);
  if (nodeAt(st, node).level !== entry.level)
    throw new CommandError('cross-level', 'The node and the wire must be in the same level');
  const target = { ...entry.edge.to };
  retarget(tx, entry.path, entry.edge.to, { node, port: 'in' });
  addEdge(tx, ctx, { node, port: out }, target);
}

function retarget(tx: YamlTransaction, edgePath: Path, from: PortRef, to: PortRef): void {
  const ops: ((f: YamlFile) => OpResult)[] = [];
  if (from.node !== to.node) ops.push((f) => setIn(f, [...edgePath, 'to', 'node'], to.node));
  if (from.port !== to.port) ops.push((f) => setIn(f, [...edgePath, 'to', 'port'], to.port));
  tx.applyAll(ops);
}

function rewire(tx: YamlTransaction, edgeId: Ulid, to: PortRef): void {
  const st = state(tx);
  const entry = st.model.edges.get(edgeId);
  if (!entry) throw new CommandError('not-found', `No edge ${edgeId}`);
  const { edge } = entry;
  const target = nodeAt(st, to.node);
  if (target.level !== entry.level)
    throw new CommandError('cross-level', 'Both ends must be in the same level');
  if (!isPortLegal(target.node, to.port) || portDirection(to.port) !== 'in') {
    throw new CommandError('bad-port', `"${to.port}" is not an input of ${target.node.type}`);
  }
  if (edge.to.node === to.node && edge.to.port === to.port) return;
  const level = levelOf(st, entry.level);
  const without = { ...level, edges: level.edges.filter((e) => e?.id !== edgeId) };
  if (to.node === edge.from.node || reachable(without, to.node, edge.from.node)) {
    throw new CommandError('cycle', 'This edge would create a cycle');
  }
  retarget(tx, entry.path, edge.to, to);
  ensurePortEnabled(tx, to.node, to.port);
}

function applyPattern(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'applyPattern' }>,
  notes: string[],
): Ulid | undefined {
  const st = state(tx);
  const source = nodeAt(st, cmd.from.node);
  if (!patternFits(cmd.pattern, source.node, cmd.from.port)) {
    throw new CommandError(
      'pattern-port',
      `"${cmd.pattern}" does not fit ${source.node.type} port ${cmd.from.port}`,
    );
  }
  const level = checkOutput(st, cmd.from);
  const recipe = recipeFor(cmd.pattern, source.node, cmd.from.port, level);
  const chosen = cmd.end ? level.nodes.find((n) => n?.id === cmd.end) : undefined;
  if (cmd.end) {
    if (!recipe.end)
      throw new CommandError(
        'bad-end',
        recipe.reuse
          ? `"${cmd.pattern}" reuses ${recipe.reuse.key} here, which is wired already; it takes no end`
          : `"${cmd.pattern}" wires to no end node`,
      );
    if (chosen?.type !== 'end')
      throw new CommandError('bad-end', 'The end must be an end node on the same level');
    if ((chosen.outcome ?? 'success') !== recipe.end.outcome)
      throw new CommandError(
        'bad-end',
        `"${cmd.pattern}" ends hosts with outcome ${recipe.end.outcome}, and ${chosen.key} has outcome ${chosen.outcome ?? 'success'}`,
      );
  }
  if (recipe.reuse) {
    setPositions(tx, cmd.freeze ?? {});
    addEdge(tx, ctx, cmd.from, { node: recipe.reuse.id, port: 'in' });
    return undefined;
  }
  // Retry adds no step (AFD-52): the source's own task tries again, and the hosts that still fail
  // leave by the same port, which stays open until something handles them.
  if (recipe.source) {
    const have = source.node.settings ?? {};
    const add = Object.fromEntries(
      Object.entries(recipe.source).filter(([k]) => have[k as keyof NodeSettings] === undefined),
    );
    setPositions(tx, cmd.freeze ?? {});
    if (Object.keys(add).length > 0)
      updateNode(tx, { kind: 'updateNode', id: source.node.id, patch: { settings: add } }, notes);
    const s = { ...recipe.source, ...have };
    notes.push(
      `${cmd.pattern}: ${source.node.key} tries again up to ${s.retries} times, ${s.delay ?? 5}${typeof s.delay === 'string' ? '' : ' s'} apart; hosts that still fail leave by ${cmd.from.port}`,
    );
    return undefined;
  }
  // Every new node and edge is computed against this one state and written in one batch.
  const taken = levelKeys(level, st.model);
  const nodes: Record<string, YamlValue>[] = [];
  const edges: Record<string, YamlValue>[] = [];
  const positions: Record<Ulid, Position> = { ...cmd.freeze };
  let handler: Ulid | undefined;
  if (recipe.node) {
    const created = nodeItem(ctx, recipe.node, taken, purposeKey(st.doc));
    if (recipe.steps?.length)
      created.item.subflow = chainBody(ctx, recipe.steps, purposeKey(st.doc));
    nodes.push(created.item);
    handler = created.id;
    if (cmd.position) positions[handler] = cmd.position;
  }
  let end = recipe.end ? (chosen ?? findEnd(level, recipe.end))?.id : undefined;
  if (end) {
    const key = level.nodes.find((n) => n?.id === end)?.key;
    notes.push(`${cmd.pattern}: the hosts end at ${key} (an existing end node)`);
  }
  if (recipe.end && !end) {
    const { title, outcome } = recipe.end;
    const created = nodeItem(ctx, { type: 'end', title, outcome }, taken);
    nodes.push(created.item);
    end = created.id;
    notes.push(`${cmd.pattern}: the hosts end at ${created.item.key} (a new end node)`);
    if (cmd.position) {
      positions[end] = handler
        ? { x: cmd.position.x, y: cmd.position.y + END_BELOW }
        : cmd.position;
    }
  }
  const first = handler ?? end;
  if (!first) throw new CommandError('bad-pattern', `Pattern "${cmd.pattern}" creates nothing`);
  edges.push(edgeItem(ctx, cmd.from, { node: first, port: 'in' }));
  if (handler && end && recipe.end) {
    for (const port of recipe.end.from)
      edges.push(edgeItem(ctx, { node: handler, port }, { node: end, port: 'in' }));
  }
  if (handler && recipe.rejoin) {
    const port = recipe.rejoin.sourcePort;
    const to = level.edges.find((e) => e?.from?.node === cmd.from.node && e.from.port === port)?.to;
    if (to) edges.push(edgeItem(ctx, { node: handler, port: recipe.rejoin.port }, to));
  }
  // Order matters where inserts share an offset: a port added to the last node precedes the new
  // nodes, and new edges precede a layout block created right after the edges.
  tx.applyAll([
    ...enablePortOps(st, cmd.from.node, cmd.from.port),
    ...nodes.map((item) => (f: YamlFile) => insertItem(f, level.nodesPath, 'end', item)),
    ...edges.map((item) => (f: YamlFile) => insertItem(f, level.edgesPath, 'end', item)),
    ...positionOps(st, positions),
    ...decisionRemovalOps(st, cmd.from.node, cmd.from.port),
  ]);
  return first;
}

/**
 * A new subflow's inner level (AFD-54): the steps wired one after another on ok_hosts, the first
 * the entry and the last one's ok_hosts the exit; their failed hosts bubble to the subflow's port.
 */
function chainBody(
  ctx: CommandContext,
  steps: NodeRecipe[],
  purpose: 'purpose' | 'handler',
): Record<string, YamlValue> {
  const taken = new Set<string>();
  const items = steps.map((s) => {
    const { impl, ...spec } = s;
    const made = nodeItem(ctx, spec, taken, purpose);
    if (impl) {
      made.item.status = 'implemented';
      made.item.impl = implValue(impl);
    }
    return made;
  });
  const edges = items
    .slice(1)
    .map((b, i) =>
      edgeItem(ctx, { node: items[i]?.id as Ulid, port: 'ok_hosts' }, { node: b.id, port: 'in' }),
    );
  const first = items[0]?.id as Ulid;
  const last = items[items.length - 1]?.id as Ulid;
  return {
    nodes: items.map((i) => i.item),
    ...(edges.length > 0 ? { edges } : {}),
    boundary: { in: first, outputs: { ok_hosts: [{ node: last, port: 'ok_hosts' }] } },
  };
}

/** Vertical gap between a pattern's handler and the end node created for it. */
const END_BELOW = 150;

function setDecision(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'setDecision' }>,
): void {
  const st = state(tx);
  const { node, level } = nodeAt(st, cmd.node);
  if (!isFailPort(cmd.port) || !portsFor(node).some((p) => p.name === cmd.port)) {
    throw new CommandError('bad-port', `${cmd.port} is not a fail port of ${node.type}`);
  }
  if (
    levelOf(st, level).edges.some((e) => e?.from?.node === cmd.node && e.from.port === cmd.port)
  ) {
    throw new CommandError('port-connected', `${cmd.port} is wired, so it is not open`);
  }
  const reason = cmd.reason.trim();
  if (!reason) throw new CommandError('no-reason', 'Say why the port stays open');
  const decisions = st.doc.decisions ?? [];
  const index = portAccepted(st.doc, cmd.node, cmd.port)?.index ?? -1;
  if (index >= 0) {
    const base: Path = ['decisions', index];
    const old = decisions[index];
    const ops: ((f: YamlFile) => OpResult)[] = [];
    if (old?.reason !== reason)
      ops.push((f) => setIn(f, [...base, 'reason'], reason, { before: ['by'] }));
    if (cmd.by && old?.by !== cmd.by) ops.push((f) => setIn(f, [...base, 'by'], cmd.by as string));
    tx.applyAll(ops);
    return;
  }
  addDecision(tx, decisionItem(st.doc, 'port', cmd.port, cmd.node, reason, cmd.by));
}

/** A decision item at the end of `decisions` (AFD-51: in the document's format). */
function addDecision(tx: YamlTransaction, item: Record<string, YamlValue>): void {
  if (state(tx).doc.decisions) tx.apply((f) => insertItem(f, ['decisions'], 'end', item));
  else tx.apply((f) => setIn(f, ['decisions'], [item], { before: after(ROOT_ORDER, 'decisions') }));
}

/** Removes the decisions at these indexes of `decisions` (the key itself when none is left). */
function removeDecisions(tx: YamlTransaction, idx: readonly number[]): void {
  const count = state(tx).doc.decisions?.length ?? 0;
  if (idx.length === 0) return;
  if (idx.length === count) tx.apply((f) => deleteKey(f, [], 'decisions'));
  else tx.apply((f) => removeItems(f, ['decisions'], idx));
}

/**
 * The same decision again updates its reason and author (AFD-51: any area, either format), else a
 * new one is added.
 */
function recordDecision(
  tx: YamlTransaction,
  area: DecisionArea,
  what: string,
  node: Ulid | undefined,
  reason: string,
  by: string | undefined,
): void {
  const st = state(tx);
  const index = findAccepted(st.doc, area, what, node)?.index ?? -1;
  if (index >= 0) {
    const base: Path = ['decisions', index];
    const ops: ((f: YamlFile) => OpResult)[] = [
      (f) => setIn(f, [...base, 'reason'], reason, { before: ['by'] }),
    ];
    if (by) ops.push((f) => setIn(f, [...base, 'by'], by));
    tx.applyAll(ops);
    return;
  }
  addDecision(tx, decisionItem(st.doc, area, what, node, reason, by));
}

function renameKey(tx: YamlTransaction, id: Ulid, newKey: string): void {
  const st = state(tx);
  const { node, path, level } = nodeAt(st, id);
  if (newKey === node.key) return;
  checkKey(newKey, levelKeys(levelOf(st, level), st.model));
  const oldKey = node.key;
  // `from:` references keys, not IDs: rewrite every reference that resolves to this node.
  const rewrites: { path: Path; value: string }[] = [];
  for (const entry of st.model.nodes.values()) {
    for (const side of ['inputs', 'outputs'] as const) {
      // AFD-142: a subflow's outputs read its inner level, as resolveFrom resolves them.
      const at = readerLevel(st.model, entry.node, entry.level, side);
      if (keyScope(st.model, at).get(oldKey) !== id) continue;
      for (const [name, field] of Object.entries(entry.node[side] ?? {})) {
        const from = field?.from;
        if (from === oldKey || from?.startsWith(`${oldKey}.`)) {
          rewrites.push({
            path: [...entry.path, side, name, 'from'],
            value: newKey + from.slice(oldKey.length),
          });
        }
      }
    }
  }
  tx.applyAll([
    (f) => setIn(f, [...path, 'key'], newKey),
    ...rewrites.map((r) => (f: YamlFile) => setIn(f, r.path, r.value)),
  ]);
}

function updateNode(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'updateNode' }>,
  notes: string[],
): void {
  const { patch } = cmd;
  if (patch.key !== undefined) renameKey(tx, cmd.id, patch.key);
  const { path } = nodeAt(state(tx), cmd.id);
  if (patch.title !== undefined && patch.title.trim() === '') {
    throw new CommandError('bad-title', 'Title must not be empty');
  }
  setField(tx, path, 'title', patch.title, NODE_ORDER);
  // `tested` by hand takes a reason (markTested, AFD-44); another status drops that record.
  if (patch.status === 'tested')
    throw new CommandError('needs-reason', 'Say why it counts as tested');
  for (const k of ['intent', 'condition', 'outcome', 'join_mode', 'branches'] as const) {
    setField(tx, path, k, patch[k] as YamlValue | undefined, NODE_ORDER);
  }
  // Format 1 calls it handler (AFD-52); a format 1 name left in a format 2 node goes with the edit.
  if (patch.purpose !== undefined) {
    const key = purposeKey(state(tx).doc);
    setField(tx, path, key, patch.purpose as YamlValue, NODE_ORDER);
    if (key === 'purpose' && state(tx).model.nodes.get(cmd.id)?.node.handler !== undefined)
      setField(tx, path, 'handler', null, NODE_ORDER);
  }
  // Format 2: the status follows what the node has (AFD-50); the one status to set by hand is the
  // one its content gives, which clears `tested` (Clear Tested). Format 1 sets what it is told.
  if (patch.status) {
    const st = state(tx);
    const now = nodeAt(st, cmd.id).node;
    const content = contentStatus(now);
    if (formatOf(st.doc) >= 2 && patch.status !== content)
      throw new CommandError(
        'status-follows-content',
        `${now.title} is ${content} by what it has: inputs or outputs make a step specified, a binding implemented, and a passing run (or Mark Tested… with a reason) tested`,
      );
    dropTestedRecords(tx, [cmd.id]);
    setField(tx, path, 'status', patch.status, NODE_ORDER);
  }
  if (patch.settings) {
    for (const [k, v] of Object.entries(patch.settings)) {
      const current = state(tx);
      const node = nodeAt(current, cmd.id).node;
      if (v === null) {
        if (node.settings && k in node.settings) {
          if (Object.keys(node.settings).length === 1)
            tx.apply((f) => deleteKey(f, path, 'settings'));
          else tx.apply((f) => deleteKey(f, [...path, 'settings'], k));
        }
      } else if (v !== undefined) {
        if (node.settings) tx.apply((f) => setIn(f, [...path, 'settings', k], v as YamlValue));
        else setField(tx, path, 'settings', { [k]: v as YamlValue }, NODE_ORDER);
      }
    }
  }
  for (const [name, field] of Object.entries(patch.inputs ?? {}))
    setContractField(
      tx,
      { kind: 'setContractField', target: cmd.id, side: 'inputs', name, field },
      notes,
    );
  if (patch.keywords !== undefined) {
    const impl = nodeAt(state(tx), cmd.id).node.impl;
    if (!impl || impl.kind === 'playbook')
      throw new CommandError(
        'no-binding',
        'Task keywords need a module or role binding: bind the node first',
      );
    const keywords = patch.keywords && Object.keys(patch.keywords).length ? patch.keywords : null;
    if (keywords) tx.apply((f) => setIn(f, [...path, 'impl', 'keywords'], keywords as YamlValue));
    else if (impl.keywords) tx.apply((f) => deleteKey(f, [...path, 'impl'], 'keywords'));
  }
}

/** Ops removing the given indexes of a sequence (or emptying it) against one parse. */
function removeIndexes(
  seqPath: Path,
  indexes: number[],
  length: number,
): ((f: YamlFile) => OpResult)[] {
  if (indexes.length === 0) return [];
  if (indexes.length === length) return [(f) => setIn(f, seqPath, [])];
  return [(f) => removeItems(f, seqPath, indexes)];
}

function deleteNode(tx: YamlTransaction, id: Ulid): void {
  // Everything below is computed against one parse: the regions (edges, decisions, layout, the
  // node itself) are disjoint, so one batch replaces a re-parse per removed item.
  const st = state(tx);
  const { level: levelId, path, node } = nodeAt(st, id);
  const level = levelOf(st, levelId);
  const ops: ((f: YamlFile) => OpResult)[] = [];

  const edgeIdx = level.edges
    .map((e, i) => (e && (e.from?.node === id || e.to?.node === id) ? i : -1))
    .filter((i) => i >= 0);
  ops.push(...removeIndexes(level.edgesPath, edgeIdx, level.edges.length));

  // The node, every step of its inner levels, and its place in an enclosing boundary.
  const gone = new Set([id, ...descendantIds(node)]);
  const decisions = st.doc.decisions ?? [];
  const decisionIdx = decisions
    .map((d, i) => (d?.node && gone.has(d.node) ? i : -1))
    .filter((i) => i >= 0);
  if (decisionIdx.length > 0 && decisionIdx.length === decisions.length) {
    ops.push((f) => deleteKey(f, [], 'decisions'));
  } else {
    if (decisionIdx.length) ops.push((f) => removeItems(f, ['decisions'], decisionIdx));
  }

  const layout = st.doc.layout ?? {};
  const layoutIds = [...gone].filter((x) => x in layout);
  if (layoutIds.length > 0 && layoutIds.length === Object.keys(layout).length) {
    ops.push((f) => deleteKey(f, [], 'layout'));
  } else {
    ops.push(...layoutIds.map((lid) => (f: YamlFile) => deleteKey(f, ['layout'], lid)));
  }

  ops.push(...removeIndexes(path.slice(0, -1), [path.at(-1) as number], level.nodes.length));

  // AFD-64: the Notes on the node go with it (those inside it go with its body).
  const tied = level.annotations.filter((a) => a?.on === id || a?.on === node.key);
  ops.push(...removeAnnotationOps(level, new Set(tied.map((a) => a.id))));

  const parent = level.parent ? st.model.nodes.get(level.parent)?.node : undefined;
  const boundary = parent?.subflow?.boundary;
  if (parent && boundary) {
    const outputs = Object.fromEntries(
      Object.entries(boundary.outputs ?? {}).map(([p, refs]) => [
        p,
        (refs ?? []).filter((r) => r?.node !== id),
      ]),
    );
    const changed =
      boundary.in === id ||
      Object.entries(outputs).some(([p, refs]) => refs.length !== boundary.outputs?.[p]?.length);
    if (changed)
      ops.push(
        ...boundaryOps(st, parent.id, {
          in: boundary.in === id ? undefined : boundary.in,
          outputs,
        }),
      );
  }
  tx.applyAll(ops);
}

function setPortEnabled(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'setPortEnabled' }>,
): void {
  const st = state(tx);
  const { node, path, level } = nodeAt(st, cmd.node);
  if (!optionalPortNames(node.type).includes(cmd.port)) {
    throw new CommandError('bad-port', `"${cmd.port}" is not an optional port of ${node.type}`);
  }
  if (cmd.enabled) {
    ensurePortEnabled(tx, cmd.node, cmd.port);
    return;
  }
  const index = node.ports?.indexOf(cmd.port) ?? -1;
  if (index < 0) return;
  const lvl = levelOf(st, level);
  const exits = node.subflow?.boundary?.outputs?.[cmd.port] ?? [];
  if (
    exits.length > 0 ||
    exitOf(st, lvl, { node: cmd.node, port: cmd.port }) ||
    lvl.edges.some(
      (e) =>
        (e?.from?.node === cmd.node && e.from.port === cmd.port) ||
        (e?.to?.node === cmd.node && e.to.port === cmd.port),
    )
  ) {
    throw new CommandError('port-connected', `Disconnect ${cmd.port} before disabling it`);
  }
  if (node.ports?.length === 1) tx.apply((f) => deleteKey(f, path, 'ports'));
  else tx.apply((f) => removeItem(f, [...path, 'ports'], index));
}

/** The binding as stored: fields in data-model order, empty params and register left out. */
function implValue(impl: ImplBinding): YamlValue {
  const out: Record<string, YamlValue> = { kind: impl.kind, ref: impl.ref };
  if (impl.collection_version) out.collection_version = impl.collection_version;
  if (impl.params && Object.keys(impl.params).length > 0) out.params = impl.params as YamlValue;
  if (impl.register) out.register = impl.register;
  if (impl.keywords && Object.keys(impl.keywords).length > 0)
    out.keywords = impl.keywords as YamlValue;
  return out;
}

function setBinding(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'setBinding' }>,
  notes: string[],
): void {
  const { node, path } = nodeAt(state(tx), cmd.id);
  if (node.type !== 'task' && node.type !== 'subflow')
    throw new CommandError('bad-type', `A ${node.type} node has no implementation`);
  if (cmd.impl) {
    if (!cmd.impl.ref.trim())
      throw new CommandError('bad-ref', 'Choose a module, role or playbook');
    const bad = cmd.impl.register ? varNameProblem(cmd.impl.register) : undefined;
    if (bad) throw new CommandError('bad-name', bad);
  }
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [name, field] of Object.entries(cmd[side] ?? {})) {
      const bad = varNameProblem(name);
      if (bad) throw new CommandError('bad-name', bad);
      const current = nodeAt(state(tx), cmd.id).node[side];
      if (field === null) {
        if (!current || !(name in current)) continue;
        if (Object.keys(current).length === 1) setField(tx, path, side, null, NODE_ORDER);
        else tx.apply((f) => deleteKey(f, [...path, side], name));
      } else if (current) tx.apply((f) => setIn(f, [...path, side, name], contract(field)));
      else setField(tx, path, side, { [name]: contract(field) }, NODE_ORDER);
    }
  }
  // A new binding keeps the task keywords unless it brings its own (AFD-26); playbooks take none.
  const kept = node.impl?.keywords;
  const impl =
    cmd.impl && cmd.impl.keywords === undefined && kept && cmd.impl.kind !== 'playbook'
      ? { ...cmd.impl, keywords: kept }
      : cmd.impl;
  setField(tx, path, 'impl', impl ? implValue(impl) : null, NODE_ORDER);
  // Format 2: the status follows in planCommand, as for every writer (AFD-50). Format 1 keeps the
  // rule every writer had (AFD-31): bind → implemented, unbind → specified.
  if (formatOf(state(tx).doc) < 2) {
    const current = node.status ?? 'draft';
    const status = statusAfterBinding(
      current,
      !!impl,
      JSON.stringify(impl ?? null) === JSON.stringify(node.impl ?? null),
    );
    setField(tx, path, 'status', status === current ? undefined : status, NODE_ORDER);
  }
  liftPathRefs(tx, cmd.id, notes);
}

function ignoreDrift(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'ignoreDrift' }>,
): void {
  const st = state(tx);
  nodeAt(st, cmd.node);
  const reason = cmd.reason.trim();
  if (!reason) throw new CommandError('no-reason', 'Say why the code and the design may differ');
  if (!cmd.item.trim()) throw new CommandError('bad-item', 'No drift item');
  recordDecision(tx, 'drift', cmd.item, cmd.node, reason, cmd.by);
}

/**
 * Downstream `from: <key>.<old>[.path]` references to a renamed node output, as rewrites (one
 * edit with the rename, like a key rename).
 */
function outputRefRewrites(
  st: State,
  id: Ulid,
  from: string,
  to: string,
): { path: Path; value: string }[] {
  const { node } = nodeAt(st, id);
  const out: { path: Path; value: string }[] = [];
  const head = `${node.key}.${from}`;
  for (const entry of st.model.nodes.values()) {
    if (entry.node.id === id) continue;
    for (const side of ['inputs', 'outputs'] as const) {
      // AFD-142: a subflow's outputs read its inner level, as resolveFrom resolves them.
      const at = readerLevel(st.model, entry.node, entry.level, side);
      if (keyScope(st.model, at).get(node.key) !== id) continue;
      // Inside a subflow, `<key>.<name>` is its input (AFD-21).
      if (enclosing(st.model, at).some((s) => s.id === id)) continue;
      for (const [name, field] of Object.entries(entry.node[side] ?? {})) {
        const ref = field?.from;
        if (ref === head || ref?.startsWith(`${head}.`))
          out.push({
            path: [...entry.path, side, name, 'from'],
            value: `${node.key}.${to}${ref.slice(head.length)}`,
          });
      }
    }
  }
  return out;
}

/** Inner `from: <subflow>.<old>[.path]` references to a renamed subflow input (AFD-21). */
function inputRefRewrites(
  st: State,
  id: Ulid,
  from: string,
  to: string,
): { path: Path; value: string }[] {
  const { node } = nodeAt(st, id);
  const out: { path: Path; value: string }[] = [];
  const head = `${node.key}.${from}`;
  for (const entry of st.model.nodes.values()) {
    // The subflow's own outputs read its inner level, where `<key>.<name>` is its input too.
    const own = entry.node.id === id;
    if (!own && !enclosing(st.model, entry.level).some((s) => s.id === id)) continue;
    if (!own && keyScope(st.model, entry.level).get(node.key) !== id) continue;
    for (const side of own ? (['outputs'] as const) : (['inputs', 'outputs'] as const))
      for (const [name, field] of Object.entries(entry.node[side] ?? {})) {
        const ref = field?.from;
        if (ref === head || ref?.startsWith(`${head}.`))
          out.push({
            path: [...entry.path, side, name, 'from'],
            value: `${node.key}.${to}${ref.slice(head.length)}`,
          });
      }
  }
  return out;
}

/**
 * AFD-21: `from: sub/step.output` names a step inside another subflow. Each subflow on the way
 * lifts the output (as extract_subflow does, AFD-7), and the reference reads the outermost one, so
 * the file stays encapsulated.
 */
function liftPathRefs(tx: YamlTransaction, id: Ulid, notes: string[]): void {
  const { node } = nodeAt(state(tx), id);
  for (const side of ['inputs', 'outputs'] as const)
    for (const [name, field] of Object.entries(node[side] ?? {})) {
      const from = field?.from;
      if (typeof from !== 'string') continue;
      const [head = '', out, ...rest] = from.trim().split('.');
      if (!head.includes('/') || !out) continue;
      const value = [liftPath(tx, id, side, head, out, notes), ...rest].join('.');
      const at = nodeAt(state(tx), id).path;
      tx.apply((f) => setIn(f, [...at, side, name, 'from'], value));
    }
}

/** Lifts `head` (`sub/…/step`) `.out` up to the level the reader sees; the reference it reads. */
function liftPath(
  tx: YamlTransaction,
  readerId: Ulid,
  side: 'inputs' | 'outputs',
  head: string,
  out: string,
  notes: string[],
): string {
  const st = state(tx);
  const reader = nodeAt(st, readerId);
  const at = side === 'outputs' && st.model.levels.has(readerId) ? readerId : reader.level;
  const scope = keyScope(st.model, at);
  const [first = '', ...more] = head.split('/');
  const top = st.model.nodes.get(scope.get(first) ?? '')?.node;
  if (!top) throw new CommandError('not-found', `${head}.${out}: no node "${first}" here`);
  const chain: FlowNode[] = [top];
  for (const seg of more) {
    const parent = chain.at(-1) as FlowNode;
    const step = (parent.subflow?.nodes ?? []).find((n) => n?.key === seg);
    if (!step) {
      const steps = (parent.subflow?.nodes ?? []).map((n) => n?.key).filter(Boolean);
      throw new CommandError(
        'not-found',
        parent.type === 'subflow'
          ? `${head}.${out}: subflow ${parent.key} has no step ${seg} (steps: ${steps.join(', ') || 'none'})`
          : `${head}.${out}: ${parent.key} is a ${parent.type}, not a subflow`,
      );
    }
    chain.push(step);
  }
  const inner = chain.at(-1) as FlowNode;
  if (!inner.outputs || !(out in inner.outputs)) {
    const has = Object.keys(inner.outputs ?? {});
    throw new CommandError(
      'not-found',
      `${head} has no output ${out} (${has.length ? `it has ${has.join(', ')}` : 'it has none'})`,
    );
  }
  // The deepest node of the path the reader sees directly needs no lifting.
  let start = 0;
  for (let i = chain.length - 1; i > 0; i--)
    if (scope.get((chain[i] as FlowNode).key) === (chain[i] as FlowNode).id) {
      start = i;
      break;
    }
  let name = out;
  for (let i = chain.length - 2; i >= start; i--)
    name = liftOne(tx, (chain[i] as FlowNode).id, chain[i + 1] as FlowNode, name, notes);
  return `${(chain[start] as FlowNode).key}.${name}`;
}

/** The subflow output that lifts `child.name`: an existing one, else a new one. */
function liftOne(
  tx: YamlTransaction,
  subId: Ulid,
  child: FlowNode,
  name: string,
  notes: string[],
): string {
  const { node: sub, path } = nodeAt(state(tx), subId);
  const existing = existingLift(sub, child, name);
  if (existing) return existing;
  const as = liftName(new Set(Object.keys(sub.outputs ?? {})), child.key, name);
  const value = contract(liftField(child, name));
  if (sub.outputs) tx.apply((f) => setIn(f, [...path, 'outputs', as], value));
  else setField(tx, path, 'outputs', { [as]: value }, NODE_ORDER);
  notes.push(`${sub.key} now lifts ${child.key}.${name} as its output ${as}`);
  return as;
}

function setContractField(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'setContractField' }>,
  notes: string[],
): void {
  const st = state(tx);
  let base: Path;
  let current: Record<string, ContractField> | undefined;
  if (cmd.target === 'flow') {
    if (cmd.side !== 'inputs') throw new CommandError('bad-side', 'Flows have inputs only');
    base = ['flow'];
    current = st.doc.flow.inputs;
  } else {
    const { node, path } = nodeAt(st, cmd.target);
    base = path;
    current = (node as FlowNode)[cmd.side];
  }
  const order = cmd.target === 'flow' ? FLOW_ORDER : NODE_ORDER;
  const name = cmd.rename ?? cmd.name;
  const bad = varNameProblem(name);
  if (bad) throw new CommandError('bad-name', bad);
  const exists = current !== undefined && cmd.name in current;
  if (cmd.field === null || (cmd.rename && cmd.rename !== cmd.name)) {
    if (exists) {
      if (Object.keys(current ?? {}).length === 1) setField(tx, base, cmd.side, null, order);
      else tx.apply((f) => deleteKey(f, [...base, cmd.side], cmd.name));
    }
    if (cmd.field === null) return;
  }
  if (cmd.rename && cmd.rename !== cmd.name && current && cmd.rename in current) {
    throw new CommandError('duplicate-name', `"${cmd.rename}" already exists`);
  }
  const value = contract(cmd.field);
  // A renamed node output: downstream inputs read it as `<key>.<name>`.
  if (cmd.target !== 'flow' && cmd.side === 'outputs' && cmd.rename && cmd.rename !== cmd.name) {
    const rewrites = outputRefRewrites(state(tx), cmd.target, cmd.name, name);
    if (rewrites.length > 0)
      tx.applyAll(rewrites.map((r) => (f: YamlFile) => setIn(f, r.path, r.value)));
  }
  // A renamed subflow input: its inner steps read it as `<key>.<name>` (AFD-21).
  if (cmd.target !== 'flow' && cmd.side === 'inputs' && cmd.rename && cmd.rename !== cmd.name) {
    const rewrites = inputRefRewrites(state(tx), cmd.target, cmd.name, name);
    if (rewrites.length > 0)
      tx.applyAll(rewrites.map((r) => (f: YamlFile) => setIn(f, r.path, r.value)));
  }
  // A renamed node input: the binding's parameters read it by name (chips are Jinja, D-26).
  if (cmd.target !== 'flow' && cmd.side === 'inputs' && cmd.rename && cmd.rename !== cmd.name) {
    const params = nodeAt(state(tx), cmd.target).node.impl?.params;
    if (params) {
      const next = mapStrings(params, (s) => renameRef(s, cmd.name, name));
      if (JSON.stringify(next) !== JSON.stringify(params))
        tx.apply((f) => setIn(f, [...base, 'impl', 'params'], next as YamlValue));
    }
    // AFD-112: and Timing given at run time, and until, which read the step's inputs too.
    const settings = nodeAt(state(tx), cmd.target).node.settings;
    for (const key of ['retries', 'delay', 'timeout', 'until'] as const) {
      const v = settings?.[key];
      if (typeof v !== 'string') continue;
      const next =
        key === 'until' ? renameExprRef(v, cmd.name, name) : renameRef(v, cmd.name, name);
      if (next !== v) tx.apply((f) => setIn(f, [...base, 'settings', key], next));
    }
  }
  const after_ = state(tx);
  const side =
    cmd.target === 'flow' ? after_.doc.flow.inputs : nodeAt(after_, cmd.target).node[cmd.side];
  if (side) tx.apply((f) => setIn(f, [...base, cmd.side, name], value));
  else setField(tx, base, cmd.side, { [name]: value }, order);
  if (cmd.target !== 'flow') liftPathRefs(tx, cmd.target, notes);
}

/**
 * AFD-112 (round 4: Q4): nothing tied "a value given at run time" to a step's Timing. One edit
 * makes the flow input (or reuses one of that name that can hold a number), the step input that
 * reads it, and the setting's template; an approval's timeout stays a duration (AWX needs one).
 */
function askAtRunTime(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'askAtRunTime' }>,
  notes: string[],
): void {
  const st = state(tx);
  const { node } = nodeAt(st, cmd.id);
  const plainStep =
    node.type === 'task' || (node.type === 'subflow' && !node.subflow?.nodes?.length);
  if (!plainStep)
    throw new CommandError(
      'bad-setting',
      node.type === 'approval'
        ? "An approval's timeout is a fixed duration: AWX needs a number"
        : `A ${node.type} node runs no task of its own, so it has no ${cmd.setting}`,
    );
  if (cmd.default !== undefined && (!Number.isInteger(cmd.default) || cmd.default < 0))
    throw new CommandError('bad-default', 'The default must be a whole number, 0 or more');
  const numeric = ['integer', 'string', 'any'];
  const flowField = st.doc.flow.inputs?.[cmd.name];
  if (flowField && !numeric.includes(flowField.type))
    throw new CommandError(
      'duplicate-name',
      `Flow input "${cmd.name}" is a ${flowField.type}, which holds no number: choose another name`,
    );
  const nodeField = node.inputs?.[cmd.name];
  if (nodeField && nodeField.from !== `flow.${cmd.name}`)
    throw new CommandError(
      'duplicate-name',
      `${node.title} already has an input "${cmd.name}" that reads ${nodeField.from ?? 'nothing'}: choose another name`,
    );
  if (flowField) notes.push(`Uses the flow input ${cmd.name} that the flow has already`);
  else
    setContractField(
      tx,
      {
        kind: 'setContractField',
        target: 'flow',
        side: 'inputs',
        name: cmd.name,
        field: {
          type: 'integer',
          ...(cmd.default !== undefined ? { default: cmd.default } : { required: true }),
          ...(cmd.description?.trim() ? { description: cmd.description.trim() } : {}),
        },
      },
      notes,
    );
  updateNode(
    tx,
    {
      kind: 'updateNode',
      id: cmd.id,
      patch: {
        settings: { [cmd.setting]: `{{ ${cmd.name} }}` },
        ...(nodeField
          ? {}
          : { inputs: { [cmd.name]: { type: 'integer', from: `flow.${cmd.name}` } } }),
      },
    },
    notes,
  );
}

function updateFlow(tx: YamlTransaction, patch: FlowPatch): void {
  if (patch.key !== undefined && !SLUG.test(patch.key)) {
    throw new CommandError('bad-key', `Key "${patch.key}" must be a lowercase slug`);
  }
  if (patch.name !== undefined && patch.name.trim() === '') {
    throw new CommandError('bad-name', 'Name must not be empty');
  }
  for (const k of ['name', 'key', 'goal', 'owner'] as const) {
    setField(tx, ['flow'], k, patch[k] as YamlValue | undefined, FLOW_ORDER);
  }
  if (patch.runtime !== undefined) {
    const value =
      patch.runtime && Object.keys(patch.runtime).length > 0 ? (patch.runtime as YamlValue) : null;
    setField(tx, ['flow'], 'runtime', value, FLOW_ORDER);
  }
  if (patch.maintenance_window !== undefined) {
    const w = patch.maintenance_window?.trim().toLowerCase().replaceAll(/\s+/g, '') || null;
    if (w !== null && !/^([0-9]+[smhd])+$/.test(w))
      throw new CommandError(
        'bad-window',
        `"${patch.maintenance_window}" is not a duration like 4h or 2h30m`,
      );
    setField(tx, ['flow'], 'maintenance_window', w, FLOW_ORDER);
  }
}

function acceptFinding(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'acceptFinding' }>,
): void {
  const st = state(tx);
  if (cmd.node) nodeAt(st, cmd.node);
  const reason = cmd.reason.trim();
  if (!reason) throw new CommandError('no-reason', 'Say why this is expected');
  if (!cmd.finding.trim()) throw new CommandError('bad-finding', 'No finding');
  // A lens finding is keyed by its id alone (the node may go with it, for Complete IDs).
  const index = findAccepted(st.doc, 'lens', cmd.finding)?.index ?? -1;
  if (index >= 0) {
    const base: Path = ['decisions', index];
    const ops: ((f: YamlFile) => OpResult)[] = [
      (f) => setIn(f, [...base, 'reason'], reason, { before: ['by'] }),
    ];
    if (cmd.by) ops.push((f) => setIn(f, [...base, 'by'], cmd.by as string));
    tx.applyAll(ops);
    return;
  }
  addDecision(tx, decisionItem(st.doc, 'lens', cmd.finding, cmd.node, reason, cmd.by));
}

/** AFD-51: a validator warning accepted with a reason (format 2). */
function acceptCheck(tx: YamlTransaction, cmd: Extract<FlowCommand, { kind: 'acceptCheck' }>) {
  const st = state(tx);
  formatGuard(() => requireFormat(st.doc, 2, 'Accepting a problem'));
  const { node } = nodeAt(st, cmd.node);
  const reason = cmd.reason.trim();
  if (!reason) throw new CommandError('no-reason', `Say why ${node.title} may keep this`);
  recordDecision(tx, 'check', checkWhat(cmd.code, cmd.subject), cmd.node, reason, cmd.by);
}

/** The record of a node marked tested by hand (AFD-44). */
export const testedFinding = (node: Ulid) => `status:tested|${node}`;

function markTested(tx: YamlTransaction, cmd: Extract<FlowCommand, { kind: 'markTested' }>): void {
  const st = state(tx);
  const { node, path } = nodeAt(st, cmd.id);
  if (node.type === 'start' || node.type === 'end')
    throw new CommandError('no-status', 'Start and end nodes have no status');
  // Format 1 takes any node with a reason, as before; format 2 only implemented content.
  if (formatOf(st.doc) >= 2 && !canMarkTested(st.doc, node))
    throw new CommandError(
      'not-implemented',
      (node.subflow?.nodes ?? []).length > 0
        ? 'A subflow is tested when its steps are: mark them'
        : `${node.title} is ${contentStatus(node)}: only an implemented node can be tested`,
    );
  setField(tx, path, 'status', 'tested', NODE_ORDER);
  if (formatOf(st.doc) >= 2) {
    const record: TestedRecord = {
      reason: cmd.reason,
      ...(cmd.by ? { by: cmd.by } : {}),
      ...(cmd.at ? { at: cmd.at } : {}),
    };
    setField(tx, path, 'tested', record as YamlValue, NODE_ORDER);
    return;
  }
  acceptFinding(tx, {
    kind: 'acceptFinding',
    finding: testedFinding(cmd.id),
    node: cmd.id,
    reason: cmd.reason,
    by: cmd.by,
  });
}

/**
 * A node no longer tested loses its evidence (another status, or the design changed): format 2's
 * `tested` record on the node, format 1's decision for tested by hand.
 */
function dropTestedRecords(tx: YamlTransaction, ids: readonly Ulid[]): void {
  for (const id of ids) {
    const entry = state(tx).model.nodes.get(id);
    if (entry?.node.tested !== undefined) tx.apply((f) => deleteKey(f, entry.path, 'tested'));
  }
  const findings = new Set(ids.map(testedFinding));
  const decisions = state(tx).doc.decisions ?? [];
  const idx = decisions
    .map((d, i) => (d?.kind === 'finding_accepted' && findings.has(d.finding) ? i : -1))
    .filter((i) => i >= 0);
  if (idx.length === 0) return;
  if (idx.length === decisions.length) tx.apply((f) => deleteKey(f, [], 'decisions'));
  else tx.apply((f) => removeItems(f, ['decisions'], idx));
}

function clearFindingAccept(tx: YamlTransaction, finding: string): void {
  removeDecisions(
    tx,
    acceptedAll(state(tx).doc)
      .filter((a) => a.area === 'lens' && a.what === finding)
      .map((a) => a.index),
  );
}

function setBoundaryIn(tx: YamlTransaction, cmd: Extract<FlowCommand, { kind: 'setBoundaryIn' }>) {
  const st = state(tx);
  const { node, level } = subflowAt(st, cmd.subflow);
  if (cmd.node !== null) {
    const inner = nodeAt(st, cmd.node);
    if (inner.level !== level.id)
      throw new CommandError('cross-level', 'The entry must be a step inside the subflow');
    if (!isPortLegal(inner.node, 'in'))
      throw new CommandError('bad-port', `${inner.node.title} has no "in" port`);
  }
  const boundary = node.subflow?.boundary ?? {};
  tx.applyAll(boundaryOps(st, cmd.subflow, { ...boundary, in: cmd.node ?? undefined }));
}

function connectBoundary(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'connectBoundary' }>,
): void {
  const st = state(tx);
  const { node, level } = subflowAt(st, cmd.subflow);
  if (nodeAt(st, cmd.from.node).level !== level.id)
    throw new CommandError('cross-level', 'Only a step inside the subflow can leave through it');
  if (!isPortLegal(node, cmd.port) || portDirection(cmd.port) !== 'out')
    throw new CommandError('bad-port', `${node.title} has no output "${cmd.port}"`);
  if (exitOf(st, level, cmd.from) === cmd.port) return;
  checkOutput(st, cmd.from);
  const boundary = node.subflow?.boundary ?? {};
  const exit: BoundaryExit = { node: cmd.from.node, port: cmd.from.port };
  if (cmd.reason?.trim()) exit.reason = cmd.reason.trim();
  const outputs = {
    ...boundary.outputs,
    [cmd.port]: [...(boundary.outputs?.[cmd.port] ?? []), exit],
  };
  tx.applyAll([
    ...enablePortOps(st, cmd.subflow, cmd.port),
    ...enablePortOps(st, cmd.from.node, cmd.from.port),
    ...boundaryOps(st, cmd.subflow, { ...boundary, outputs }),
    // An inner port that leaves the subflow is wired: its open-on-purpose decision goes too.
    ...decisionRemovalOps(st, cmd.from.node, cmd.from.port),
  ]);
}

/** Rewrites one exit (`change` returns the new exit, or null to remove it). */
function editExit(
  tx: YamlTransaction,
  subflow: Ulid,
  from: PortRef,
  port: string,
  change: (exit: BoundaryExit) => BoundaryExit | null,
): void {
  const st = state(tx);
  const { node } = subflowAt(st, subflow);
  const boundary = node.subflow?.boundary ?? {};
  const refs = boundary.outputs?.[port] ?? [];
  const index = refs.findIndex((r) => r?.node === from.node && r.port === from.port);
  if (index < 0) throw new CommandError('not-found', `${from.port} does not leave through ${port}`);
  const next = change(refs[index] as BoundaryExit);
  const list = [...refs.slice(0, index), ...(next ? [next] : []), ...refs.slice(index + 1)];
  tx.applyAll(
    boundaryOps(st, subflow, { ...boundary, outputs: { ...boundary.outputs, [port]: list } }),
  );
}

/** Decision 15: the given tested nodes become implemented again, since their design changed. */
// ---- extract into a subflow (AFD-7, ADR-0010) --------------------------------------------------

/** The subflow port an inner output leaves through: its own name when a subflow has it. */
function exitPort(port: string): string {
  if (isPortLegal({ type: 'subflow' } as FlowNode, port)) return port;
  return isFailPort(port) ? 'failed_hosts' : 'ok_hosts';
}

/**
 * Moves a connected selection of one level into a new subflow node, in one edit. IDs never
 * change. Wires entering the group end at the subflow's `in` (the group has one entry node, its
 * `boundary.in`); wires leaving it start at the subflow port of the same name (boundary exits),
 * merged when they go to the same place. Exits of an enclosing subflow now leave through the new
 * one. Outputs read outside the group are lifted to subflow outputs, and those references are
 * rewritten.
 */
function extractSubflow(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'extractSubflow' }>,
): { id: Ulid; rewritten: Ulid[] } {
  const st = state(tx);
  const picked = new Set(cmd.nodes);
  if (picked.size === 0) throw new CommandError('bad-selection', 'Select the nodes to extract');
  const entries = [...picked].map((id) => nodeAt(st, id));
  const levelId = entries[0]?.level as string;
  if (entries.some((e) => e.level !== levelId))
    throw new CommandError('bad-selection', 'The selected nodes must be on one level');
  const bad = entries.filter((e) => e.node.type === 'start' || e.node.type === 'end');
  if (bad.length > 0)
    throw new CommandError(
      'bad-selection',
      `Start and end nodes stay on their level: ${bad.map((e) => e.node.title).join(', ')}`,
    );
  const level = levelOf(st, levelId);
  const title = (id: Ulid) => st.model.nodes.get(id)?.node.title ?? id;

  // Connected, as one group (undirected).
  const inner = level.edges.filter((e) => picked.has(e.from.node) && picked.has(e.to.node));
  const seen = new Set<Ulid>([entries[0]?.node.id as Ulid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const e of inner)
      if (seen.has(e.from.node) !== seen.has(e.to.node)) {
        seen.add(e.from.node);
        seen.add(e.to.node);
        grew = true;
      }
  }
  if (seen.size !== picked.size)
    throw new CommandError(
      'bad-selection',
      `The selection is not connected: ${[...picked]
        .filter((id) => !seen.has(id))
        .map(title)
        .join(', ')} ${picked.size - seen.size === 1 ? 'is' : 'are'} apart from the rest`,
    );

  // One way in.
  const parent = level.parent ? st.model.nodes.get(level.parent)?.node : undefined;
  const boundary = parent?.subflow?.boundary;
  const incoming = level.edges.filter((e) => !picked.has(e.from.node) && picked.has(e.to.node));
  const entryIds = new Set(incoming.map((e) => e.to.node));
  if (boundary?.in && picked.has(boundary.in)) entryIds.add(boundary.in);
  if (entryIds.size > 1)
    throw new CommandError(
      'bad-selection',
      `A subflow has one way in, but hosts enter the selection at ${[...entryIds]
        .map((id) => `"${title(id)}"`)
        .join(' and ')}`,
    );
  let entry = [...entryIds][0];
  if (!entry) {
    const fed = new Set(inner.map((e) => e.to.node));
    const heads = cmd.nodes.filter((id) => !fed.has(id));
    if (heads.length !== 1)
      throw new CommandError('bad-selection', 'Nothing leads into the selection');
    entry = heads[0] as Ulid;
  }

  // Ways out: one parent wire per subflow port.
  const outgoing = level.edges.filter((e) => picked.has(e.from.node) && !picked.has(e.to.node));
  const enclosing = Object.entries(boundary?.outputs ?? {}).flatMap(([port, refs]) =>
    (refs ?? []).filter((r) => picked.has(r.node)).map((r) => ({ ref: r, leaves: port })),
  );
  const dest = new Map<string, string>();
  const claim = (port: string, where: string, what: string) => {
    const had = dest.get(port);
    if (had !== undefined && had !== where)
      throw new CommandError(
        'bad-selection',
        `The subflow would need two ${port} wires: ${what} leaves for another place than the rest`,
      );
    dest.set(port, where);
  };
  for (const e of outgoing)
    claim(
      exitPort(e.from.port),
      `node:${portKey(e.to.node, e.to.port)}`,
      `${title(e.from.node)}.${e.from.port}`,
    );
  for (const x of enclosing)
    claim(exitPort(x.ref.port), `leave:${x.leaves}`, `${title(x.ref.node)}.${x.ref.port}`);

  // The new node.
  const taken = levelKeys(level, st.model);
  const key = cmd.key ?? uniqueKey(slugify(cmd.title, 'subflow'), taken);
  checkKey(key, taken);
  const id = ctx.newId();

  // Outputs read outside the group are lifted to the subflow (AFD-7 decision).
  const movedIds = new Set(entries.flatMap((e) => [e.node.id, ...descendantIds(e.node)]));
  const keyOf = new Map(entries.map((e) => [e.node.key, e.node]));
  const lifted = new Map<string, { name: string; field: ContractField }>();
  const rewrites: { path: Path; value: string; node: Ulid }[] = [];
  for (const other of st.model.nodes.values()) {
    if (movedIds.has(other.node.id)) continue;
    for (const side of ['inputs', 'outputs'] as const) {
      // AFD-142: a subflow's outputs read its inner level, as resolveFrom resolves them.
      const scope = keyScope(st.model, readerLevel(st.model, other.node, other.level, side));
      for (const [name, field] of Object.entries(other.node[side] ?? {})) {
        const [head, out, ...rest] = (field?.from ?? '').split('.');
        const source = head ? keyOf.get(head) : undefined;
        if (!source || !out || scope.get(head as string) !== source.id) continue;
        const ref = `${head}.${out}`;
        let lift = lifted.get(ref);
        if (!lift) {
          const names = new Set([...lifted.values()].map((l) => l.name));
          lift = { name: liftName(names, source.key, out), field: liftField(source, out) };
          lifted.set(ref, lift);
        }
        rewrites.push({
          path: [...other.path, side, name, 'from'],
          value: [key, lift.name, ...rest].join('.'),
          node: other.node.id,
        });
      }
    }
  }

  // Fail ports nothing takes keep leaving the same way: through the new subflow's port.
  const exits = new Set([...dest.keys()]);
  const usedHere = levelTaken(level.edges, parent);
  const decided = openOnPurpose(st.doc);
  for (const e of entries)
    for (const port of untakenFailPorts(e.node, usedHere))
      if (
        !decided.has(portKey(e.node.id, port)) &&
        isPortLegal({ type: 'subflow' } as FlowNode, port)
      )
        exits.add(port);
  const optional = optionalPortNames('subflow');
  const ports = [...exits].filter((p) => optional.includes(p)).sort();

  // Boundary of the new subflow: its entry, and every exit by its subflow port.
  const outputs: Record<string, BoundaryExit[]> = {};
  const addExit = (port: string, ref: BoundaryExit) => {
    const list = outputs[port] ?? [];
    outputs[port] = list;
    if (!list.some((r) => r.node === ref.node && r.port === ref.port))
      list.push({ node: ref.node, port: ref.port, ...(ref.reason ? { reason: ref.reason } : {}) });
  };
  for (const e of outgoing)
    addExit(exitPort(e.from.port), { node: e.from.node, port: e.from.port });
  for (const x of enclosing) addExit(exitPort(x.ref.port), x.ref);

  const docNodes = level.nodes.filter((n) => n && picked.has(n.id));
  const item: Record<string, YamlValue> = { id, key, type: 'subflow', title: cmd.title };
  // As far along as its least advanced work step; "specified" needs a contract of its own. Format 2
  // settles it from its steps right after (settleStatuses, AFD-50).
  const rank: NodeStatus[] = ['draft', 'specified', 'implemented', 'tested'];
  const work = entries.filter((e) => e.node.type === 'task' || e.node.type === 'subflow');
  const lowest = work.length
    ? rank[Math.min(...work.map((e) => rank.indexOf(e.node.status ?? 'draft')))]
    : 'draft';
  item.status = lowest === 'specified' && lifted.size === 0 ? 'draft' : (lowest ?? 'draft');
  if (ports.length > 0) item.ports = ports;
  if (lifted.size > 0)
    item.outputs = Object.fromEntries([...lifted.values()].map((l) => [l.name, contract(l.field)]));
  const body: Record<string, YamlValue> = {
    nodes: docNodes as unknown as YamlValue,
  };
  if (inner.length > 0)
    body.edges = inner.map((e) => ({
      id: e.id,
      from: { node: e.from.node, port: e.from.port },
      to: { node: e.to.node, port: e.to.port },
    }));
  // AFD-64: the Notes on the extracted nodes and the annotations picked with them go inside,
  // where they stood (positions are in canvas pixels on every level).
  const withThem = new Set(cmd.annotations ?? []);
  const moving = level.annotations.filter(
    (a) => a && (a.on ? picked.has(a.on) : withThem.has(a.id)),
  );
  if (moving.length > 0) body.annotations = moving.map((a) => annotationValue(a));
  const b: Record<string, YamlValue> = { in: entry };
  if (Object.keys(outputs).length > 0)
    b.outputs = Object.fromEntries(
      Object.entries(outputs).map(([port, refs]) => [
        port,
        refs.map((r) => ({
          node: r.node,
          port: r.port,
          ...(r.reason ? { reason: r.reason } : {}),
        })),
      ]),
    );
  body.boundary = b;
  item.subflow = body;

  // One batch on this parse: remove the group and its inner wires, retarget the wires in and out
  // (a merged exit keeps its first wire), the enclosing boundary, the rewritten references.
  const ops: Op[] = [];
  const nodeIdx = level.nodes.map((n, i) => (n && picked.has(n.id) ? i : -1)).filter((i) => i >= 0);
  ops.push(...removeIndexes(level.nodesPath, nodeIdx, level.nodes.length));
  const keptExit = new Set<string>();
  const dropEdge = new Set(inner.map((e) => e.id));
  for (const e of outgoing) {
    const port = exitPort(e.from.port);
    if (keptExit.has(port)) dropEdge.add(e.id);
    else keptExit.add(port);
  }
  const edgeIdx = level.edges
    .map((e, i) => (e && dropEdge.has(e.id) ? i : -1))
    .filter((i) => i >= 0);
  ops.push(...removeIndexes(level.edgesPath, edgeIdx, level.edges.length));
  ops.push(...removeAnnotationOps(level, new Set(moving.map((a) => a.id))));
  level.edges.forEach((e, i) => {
    if (!e || dropEdge.has(e.id)) return;
    const path = [...level.edgesPath, i];
    if (incoming.includes(e)) ops.push((f) => setIn(f, [...path, 'to', 'node'], id));
    if (outgoing.includes(e)) {
      ops.push((f) => setIn(f, [...path, 'from', 'node'], id));
      const port = exitPort(e.from.port);
      if (port !== e.from.port) ops.push((f) => setIn(f, [...path, 'from', 'port'], port));
    }
  });
  if (parent && boundary) {
    const next: Boundary = {
      in: boundary.in && picked.has(boundary.in) ? id : boundary.in,
      outputs: Object.fromEntries(
        Object.entries(boundary.outputs ?? {}).map(([port, refs]) => {
          const kept = (refs ?? []).filter((r) => !picked.has(r.node));
          const moved = (refs ?? []).filter((r) => picked.has(r.node));
          const through = [...new Set(moved.map((r) => exitPort(r.port)))].map((p) => ({
            node: id,
            port: p,
          }));
          return [port, [...kept, ...through]];
        }),
      ),
    };
    ops.push(...boundaryOps(st, parent.id, next));
  }
  for (const r of rewrites) ops.push((f) => setIn(f, r.path, r.value));
  tx.applyAll(ops);

  // Then the node, where the group's first node was, and its position.
  const after1 = state(tx);
  const lv = levelOf(after1, levelId);
  const at = Math.min(nodeIdx[0] ?? lv.nodes.length, lv.nodes.length);
  tx.apply((f) =>
    lv.nodes.length === 0 ? setIn(f, lv.nodesPath, [item]) : insertItem(f, lv.nodesPath, at, item),
  );
  // Nodes shown at auto positions are written too: once the level has a stored position, the
  // others would otherwise be stacked below it (ADR-0002).
  setPositions(tx, { ...cmd.freeze, ...(cmd.position ? { [id]: cmd.position } : {}) });
  return { id, rewritten: [...new Set(rewrites.map((r) => r.node))] };
}

// ---- shared subflows (AFD-60) -------------------------------------------------------------

/** The copy's fields, in node order, and its reference: what Add and Update write. */
function writeCopy(
  tx: YamlTransaction,
  ctx: CommandContext,
  id: Ulid,
  from: string,
  version: number,
  source: FlowNode,
): void {
  if (source.type !== 'subflow' || !source.subflow?.nodes?.length)
    throw new CommandError('bad-type', `${source.title} is not a subflow with steps`);
  const copy = copySubflow(source, ctx.newId);
  const { path } = nodeAt(state(tx), id);
  for (const k of ['intent', 'purpose', 'ports', 'inputs', 'outputs', 'settings'] as const)
    setField(tx, path, k, (copy[k] ?? null) as YamlValue, NODE_ORDER);
  setField(tx, path, 'ref', refFor(from, version, copy) as unknown as YamlValue, NODE_ORDER);
  setField(tx, path, 'subflow', copy.subflow as unknown as YamlValue, NODE_ORDER);
}

function addReference(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'addReference' }>,
): Ulid {
  requireFormat(state(tx).doc, 2, 'A shared subflow');
  if (!parseRefFrom(cmd.from))
    throw new CommandError('bad-ref', `"${cmd.from}" is not <flow file>#<subflow key>`);
  const id = insertNode(tx, ctx, {
    parent: cmd.parent,
    type: 'subflow',
    title: cmd.source.title,
    key: cmd.source.key,
  });
  writeCopy(tx, ctx, id, cmd.from, cmd.version, cmd.source);
  if (cmd.position) setPositions(tx, { [id]: cmd.position });
  return id;
}

function updateReference(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'updateReference' }>,
): void {
  const { node } = nodeAt(state(tx), cmd.id);
  if (!node.ref) throw new CommandError('not-shared', `${node.title} is not a shared subflow`);
  writeCopy(tx, ctx, cmd.id, node.ref.from, cmd.version, cmd.source);
}

// ---- annotations (AFD-64) -------------------------------------------------------------------

/** Ops removing annotations of one level against one parse; the key goes with the last one. */
function removeAnnotationOps(level: Level, ids: ReadonlySet<string>): Op[] {
  const idx = level.annotations.map((a, i) => (a && ids.has(a.id) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return [];
  if (idx.length === level.annotations.length) {
    const base = level.annotationsPath.slice(0, -1);
    return [(f) => deleteKey(f, base, 'annotations')];
  }
  return [(f) => removeItems(f, level.annotationsPath, idx)];
}

/** Removes annotations level by level; how many were there. */
function deleteAnnotations(tx: YamlTransaction, ids: readonly Ulid[]): number {
  const byLevel = new Map<string, Set<Ulid>>();
  for (const id of ids) {
    const entry = state(tx).model.annotations.get(id);
    if (!entry) continue;
    byLevel.set(entry.level, (byLevel.get(entry.level) ?? new Set()).add(id));
  }
  let removed = 0;
  for (const [levelId, set] of byLevel) {
    const level = state(tx).model.levels.get(levelId);
    if (!level) continue;
    tx.applyAll(removeAnnotationOps(level, set));
    removed += set.size;
  }
  return removed;
}

function moveAnnotations(tx: YamlTransaction, positions: Record<Ulid, Position>): void {
  const st = state(tx);
  const ops: Op[] = [];
  for (const [id, p] of Object.entries(positions)) {
    const entry = st.model.annotations.get(id);
    if (!entry) continue;
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    if (entry.annotation.x !== x) ops.push((f) => setIn(f, [...entry.path, 'x'], x));
    if (entry.annotation.y !== y) ops.push((f) => setIn(f, [...entry.path, 'y'], y));
  }
  tx.applyAll(ops);
}

function checkAnnotation(
  st: State,
  levelId: string,
  kind: AnnotationKind,
  patch: AnnotationPatch,
): void {
  if (!ANNOTATION_KINDS.includes(kind))
    throw new CommandError('invalid', `No annotation kind ${kind}`);
  if (patch.color != null && !ANNOTATION_COLORS.includes(patch.color))
    throw new CommandError('invalid', `No color ${patch.color}: ${ANNOTATION_COLORS.join(', ')}`);
  if (patch.size != null && (kind !== 'text' || !TEXT_SIZES.includes(patch.size)))
    throw new CommandError('invalid', 'Only text has a size: s, m or l');
  if (patch.on != null) {
    if (kind !== 'note') throw new CommandError('invalid', 'Only a note can be on a node');
    const entry = st.model.nodes.get(patch.on);
    if (!entry || entry.level !== levelId)
      throw new CommandError('not-found', 'A note can only be on a node of its own level');
  }
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    const v = patch[k];
    if (v != null && !Number.isFinite(v))
      throw new CommandError('invalid', `${k} must be a number`);
  }
  if (patch.key !== undefined && !SLUG.test(patch.key))
    throw new CommandError(
      'invalid',
      `"${patch.key}" is not a key (lowercase letters, digits, dashes)`,
    );
}

function addAnnotation(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'addAnnotation' }>,
): Ulid {
  requireFormat(state(tx).doc, 2, 'Annotations');
  const levelId = cmd.level ?? ROOT;
  const a = cmd.annotation;
  const kind = a.kind ?? 'note';
  checkAnnotation(state(tx), levelId, kind, a);
  if (cmd.freeze) setPositions(tx, cmd.freeze);
  const level = levelOf(state(tx), levelId);
  const taken = level.annotations.map((x) => x?.key);
  if (a.key !== undefined && taken.includes(a.key))
    throw new CommandError('key-taken', `Key "${a.key}" is already used on this level`);
  const id = ctx.newId();
  const value = annotationValue({
    id,
    key: a.key ?? nextAnnotationKey(taken, kind),
    kind,
    ...(a.on ? { on: a.on } : {}),
    x: Math.round(a.x),
    y: Math.round(a.y),
    ...(a.width != null ? { width: Math.round(a.width) } : {}),
    ...(a.height != null ? { height: Math.round(a.height) } : {}),
    ...(a.color != null ? { color: a.color } : {}),
    ...(a.size != null ? { size: a.size } : {}),
    text: a.text,
  });
  const order = levelId === ROOT ? ROOT_ORDER : SUBFLOW_ORDER;
  if (level.annotations.length === 0)
    tx.apply((f) =>
      setIn(f, level.annotationsPath, [value], { before: after(order, 'annotations') }),
    );
  else tx.apply((f) => setIn(f, [...level.annotationsPath, level.annotations.length], value));
  return id;
}

/** A node's stored position, when the file has one (a tie converts through it). */
function storedAt(st: State, id: Ulid | undefined): Position | undefined {
  return id ? st.doc.layout?.[id] : undefined;
}

function updateAnnotation(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'updateAnnotation' }>,
): void {
  const st = state(tx);
  const entry = st.model.annotations.get(cmd.id);
  if (!entry) throw new CommandError('not-found', 'That annotation is no longer in the flow');
  const { annotation: a, path, level: levelId } = entry;
  const p = { ...cmd.patch };
  const kind = p.kind ?? a.kind ?? 'note';
  checkAnnotation(st, levelId, kind, p);
  if (p.key !== undefined && p.key !== a.key) {
    const level = levelOf(st, levelId);
    if (level.annotations.some((x) => x?.key === p.key))
      throw new CommandError('key-taken', `Key "${p.key}" is already used on this level`);
  }
  // Tying, untying or re-tying keeps the Note where it is shown, as far as stored positions tell.
  if (
    p.on !== undefined &&
    (p.on ?? undefined) !== a.on &&
    p.x === undefined &&
    p.y === undefined
  ) {
    const from = storedAt(st, a.on);
    const to = storedAt(st, p.on ?? undefined);
    const shown = a.on
      ? from
        ? { x: from.x + a.x, y: from.y + a.y }
        : undefined
      : { x: a.x, y: a.y };
    if (p.on) {
      const placed = shown && to ? { x: shown.x - to.x, y: shown.y - to.y } : TIE_OFFSET;
      p.x = placed.x;
      p.y = placed.y;
    } else if (shown) {
      p.x = shown.x;
      p.y = shown.y;
    }
  }
  if (kind !== 'note' && a.on) p.on = null;
  for (const k of ANNOTATION_ORDER) {
    if (k === 'id' || !(k in p)) continue;
    const v = p[k as keyof AnnotationPatch];
    if (v === undefined) continue;
    const value =
      k === 'text'
        ? new Literal(String(v))
        : typeof v === 'number'
          ? Math.round(v)
          : (v as YamlValue);
    if (k === 'text') tx.apply((f) => setIn(f, [...path, 'text'], value));
    else setField(tx, path, k, value, ANNOTATION_ORDER);
  }
}

// ---- re-import (AFD-61) --------------------------------------------------------------------

function reimport(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'reimport' }>,
  notes: string[],
): Ulid | undefined {
  for (const u of cmd.updates) {
    const { path } = nodeAt(state(tx), u.node);
    for (const k of IMPORTED_FIELDS)
      setField(tx, path, k, (u.fields[k] ?? null) as YamlValue, NODE_ORDER);
    tx.apply((f) => setIn(f, [...path, 'origin', 'design'], u.design));
  }
  for (const k of cmd.keep ?? []) {
    const { path } = nodeAt(state(tx), k.node);
    tx.apply((f) => setIn(f, [...path, 'origin', 'design'], k.design));
  }
  for (const id of cmd.gone) {
    const { path } = nodeAt(state(tx), id);
    tx.apply((f) => setIn(f, [...path, 'origin', 'gone'], true));
  }
  let first: Ulid | undefined;
  // AFD-148: an add can follow a step added earlier in this plan, named by its ID in the plan.
  const created = new Map<Ulid, Ulid>();
  for (const a of cmd.adds) {
    // On the ok_hosts wire of the step before it; without one, at the end of the top level.
    const st = state(tx);
    const anchor = a.after ? (created.get(a.after) ?? a.after) : undefined;
    const after = anchor ? st.model.nodes.get(anchor) : undefined;
    const level = after ? levelOf(st, after.level) : levelOf(st, ROOT);
    const wire = after
      ? level.edges.find((e) => e?.from?.node === after.node.id && e.from.port === 'ok_hosts')
      : undefined;
    const id = addNode(
      tx,
      ctx,
      {
        kind: 'addNode',
        ...(after && after.level !== ROOT ? { parent: after.level } : {}),
        type: a.step.type,
        title: a.step.title,
        ...(a.step.intent ? { intent: a.step.intent } : {}),
        ...(a.step.impl ? { impl: a.step.impl } : {}),
        ...(wire
          ? { insertOn: wire.id }
          : after
            ? { connectFrom: { node: after.node.id, port: 'ok_hosts' } }
            : {}),
      },
      notes,
    );
    const { path } = nodeAt(state(tx), id);
    for (const k of ['settings', 'ports'] as const)
      if (a.step[k] !== undefined) setField(tx, path, k, a.step[k] as YamlValue, NODE_ORDER);
    if (a.step.origin)
      setField(tx, path, 'origin', a.step.origin as unknown as YamlValue, NODE_ORDER);
    created.set(a.step.id, id);
    first ??= id;
  }
  const kept = cmd.keep?.length ?? 0;
  if (cmd.updates.length + cmd.adds.length + cmd.gone.length + kept > 0)
    notes.push(
      `re-import: ${cmd.updates.length} step(s) took the source's version, ${cmd.adds.length} new, ${cmd.gone.length} flagged as gone, ${kept} kept as designed`,
    );
  return first;
}

// ---- paste nodes (AFD-17) ------------------------------------------------------------------

/**
 * Nodes from the clipboard become new nodes on a level, in one edit. Every node, inner node and
 * wire gets a new ID; keys stay unless the level has them (then `-2`, …) and references between
 * the pasted nodes follow; tested becomes implemented (the copy has not run here). Wires to nodes
 * that were not copied are not created; references to them stay as written. The group keeps its
 * relative layout around `position`; inner levels keep theirs. Start nodes are not pasted.
 */
function pasteNodes(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'pasteNodes' }>,
): Ulid[] {
  const clip = parseClip(cmd.text);
  if (typeof clip === 'string') throw new CommandError('bad-clipboard', clip);
  const source = clip.nodes.filter((n) => n.type !== 'start');
  const st = state(tx);
  // Annotations are format 2 (AFD-64): a format 1 file takes the nodes without them.
  const notes = formatOf(st.doc) >= 2 ? clip.annotations : [];
  if (source.length === 0 && notes.length === 0)
    throw new CommandError('bad-clipboard', 'Nothing to paste: a flow has one start node');
  const levelId = cmd.level ?? ROOT;
  const parent = levelId === ROOT ? undefined : nodeAt(st, levelId);
  if (parent && parent.node.type !== 'subflow')
    throw new CommandError('bad-type', `${parent.node.title} is not a subflow`);
  const level = st.model.levels.get(levelId);
  if (!parent && !level) throw new CommandError('not-found', `No level ${levelId}`);

  // New IDs for every node at every depth, and for every wire.
  const ids = new Map<string, Ulid>();
  const mint = (old: string | undefined): Ulid => {
    const fresh = ctx.newId();
    if (old) ids.set(old, fresh);
    return fresh;
  };
  const remapNode = (n: FlowNode): FlowNode => {
    const copy = structuredClone(n) as FlowNode;
    copy.id = mint(n.id);
    if (copy.status === 'tested') copy.status = 'implemented';
    delete copy.tested;
    if (copy.subflow) {
      copy.subflow.nodes = (copy.subflow.nodes ?? []).map(remapNode);
      const inner = copy.subflow;
      inner.edges = (inner.edges ?? []).map((e) => ({
        id: ctx.newId(),
        from: { node: ids.get(e.from.node) ?? e.from.node, port: e.from.port },
        to: { node: ids.get(e.to.node) ?? e.to.node, port: e.to.port },
      }));
      if (inner.boundary) {
        const b = inner.boundary;
        if (b.in) b.in = ids.get(b.in) ?? b.in;
        for (const refs of Object.values(b.outputs ?? {}))
          for (const r of refs ?? []) r.node = ids.get(r.node) ?? r.node;
      }
      if (inner.annotations)
        inner.annotations = inner.annotations.filter(Boolean).map((a) => ({
          ...a,
          id: ctx.newId(),
          ...(a.on ? { on: ids.get(a.on) ?? a.on } : {}),
        }));
      delete inner.layout;
    }
    return copy;
  };
  const nodes = source.map(remapNode);

  // Keys unique on the target level; references between the pasted nodes follow a new key.
  const taken = level ? levelKeys(level, st.model) : new Set<string>();
  const renamed = new Map<string, string>();
  nodes.forEach((n, i) => {
    const wanted = SLUG.test(n.key ?? '') ? (n.key as string) : slugify(n.title ?? n.type, n.type);
    const key = uniqueKey(wanted, taken);
    taken.add(key);
    const old = source[i]?.key;
    if (old && old !== key) renamed.set(old, key);
    n.key = key;
    n.title ??= key;
  });
  // Inner levels see the pasted keys too, unless they have a node of the same key.
  const follow = (list: FlowNode[], shadow: ReadonlySet<string>) => {
    for (const n of list) {
      for (const side of ['inputs', 'outputs'] as const)
        for (const field of Object.values(n[side] ?? {})) {
          const [head, ...rest] = (field?.from ?? '').split('.');
          const key = head && !shadow.has(head) ? renamed.get(head) : undefined;
          if (field && key) field.from = [key, ...rest].join('.');
        }
      const inner = n.subflow?.nodes ?? [];
      if (inner.length > 0)
        follow(inner, new Set([...shadow, ...inner.flatMap((c) => (c?.key ? [c.key] : []))]));
    }
  };
  if (renamed.size > 0) follow(nodes, new Set());

  const pasted = new Set(source.map((n) => n.id));
  const edges = clip.edges
    .filter((e) => pasted.has(e.from.node) && pasted.has(e.to.node))
    .map((e) => ({
      id: ctx.newId(),
      from: { node: ids.get(e.from.node) as Ulid, port: e.from.port },
      to: { node: ids.get(e.to.node) as Ulid, port: e.to.port },
    }));
  // Ports left open on purpose come along, written in this file's format (AFD-51).
  const target = state(tx).doc;
  const decisions = clip.decisions.flatMap((d, i) => {
    const a = acceptedOf(d, i);
    if (a?.area !== 'port' || !a.node || !ids.has(a.node)) return [];
    return [decisionItem(target, 'port', a.what, ids.get(a.node) as Ulid, a.reason ?? '', a.by)];
  });

  // Annotations: new IDs and keys; a Note stays on its node when that node came along.
  const keysTaken = (level?.annotations ?? []).map((a) => a?.key);
  const annotations = notes.map((a) => {
    const kind = a.kind ?? 'note';
    const key =
      a.key && SLUG.test(a.key) && !keysTaken.includes(a.key)
        ? a.key
        : nextAnnotationKey(keysTaken, kind);
    keysTaken.push(key);
    const tied = a.on ? ids.get(a.on) : undefined;
    // A Note whose node stayed behind keeps its place on the canvas, untied.
    const base = a.on && !tied ? clip.layout[a.on] : undefined;
    return {
      ...a,
      id: ctx.newId(),
      key,
      ...(tied ? { on: tied } : { on: undefined }),
      ...(base ? { x: base.x + a.x, y: base.y + a.y } : {}),
    };
  });

  // Positions: the group keeps its shape around `position`; inner levels keep theirs.
  const positions: Record<Ulid, Position> = {};
  const top = [
    ...source.map((n) => clip.layout[n.id]).filter((p): p is Position => !!p),
    ...annotations.filter((a) => !a.on).map((a) => ({ x: a.x, y: a.y })),
  ];
  const anchor = top.length
    ? { x: Math.min(...top.map((p) => p.x)), y: Math.min(...top.map((p) => p.y)) }
    : undefined;
  source.forEach((n, i) => {
    const at = clip.layout[n.id];
    const id = nodes[i]?.id as Ulid;
    if (cmd.position && at && anchor)
      positions[id] = { x: cmd.position.x + at.x - anchor.x, y: cmd.position.y + at.y - anchor.y };
    else if (cmd.position) positions[id] = { x: cmd.position.x, y: cmd.position.y + i * 120 };
    else if (at) positions[id] = { x: at.x + 40, y: at.y + 40 };
  });
  for (const [old, fresh] of ids)
    if (!source.some((n) => n.id === old) && clip.layout[old])
      positions[fresh] = clip.layout[old] as Position;
  for (const a of annotations) {
    if (a.on) continue;
    const at = { x: a.x, y: a.y };
    const moved =
      cmd.position && anchor
        ? { x: cmd.position.x + at.x - anchor.x, y: cmd.position.y + at.y - anchor.y }
        : cmd.position
          ? cmd.position
          : { x: at.x + 40, y: at.y + 40 };
    a.x = Math.round(moved.x);
    a.y = Math.round(moved.y);
  }
  const annotationItems = annotations.map((a) => annotationValue(a));

  const ops: Op[] = [];
  const append = (path: Path, values: unknown[], order: readonly string[]) => {
    if (values.length === 0) return;
    const items = values as YamlValue[];
    if (tx.current.doc.getIn(path) !== undefined)
      for (const item of items) ops.push((f) => insertItem(f, path, 'end', item));
    else ops.push((f) => setIn(f, path, items, { before: after(order, path.at(-1) as string) }));
  };
  const subflow = parent?.node.subflow;
  const entry = nodes[0]?.id;
  if (parent && !subflow) {
    // A subflow without an inner graph: the pasted nodes are its first level (D-23 entry).
    const body: Record<string, YamlValue> = { nodes: nodes as unknown as YamlValue[] };
    if (edges.length > 0) body.edges = edges as unknown as YamlValue[];
    if (annotationItems.length > 0) body.annotations = annotationItems;
    if (entry) body.boundary = { in: entry };
    ops.push((f) =>
      setIn(f, [...parent.path, 'subflow'], body, { before: after(NODE_ORDER, 'subflow') }),
    );
  } else {
    const level = levelOf(st, levelId);
    const order = parent ? SUBFLOW_ORDER : ROOT_ORDER;
    append(level.nodesPath, nodes, order);
    append(level.edgesPath, edges, order);
    append(level.annotationsPath, annotationItems, order);
    if (entry && parent && !subflow?.nodes?.length && !subflow?.boundary?.in)
      ops.push(...boundaryOps(st, parent.node.id, { ...subflow?.boundary, in: entry }));
  }
  append(['decisions'], decisions, ROOT_ORDER);
  tx.applyAll(ops);
  // Nodes shown at auto positions are written too, or the level would be stacked below the paste.
  setPositions(tx, { ...cmd.freeze, ...positions });
  return nodes.map((n) => n.id);
}

/**
 * AFD-50: every node a command changed, and the subflows around it, takes the status the rule
 * gives it (status.ts), deepest first, so a subflow sees its steps' new statuses. A node that
 * stops being tested loses its evidence. Nodes the command did not touch keep what they have.
 */
function settleStatuses(tx: YamlTransaction, ids: ReadonlySet<Ulid>): void {
  if (ids.size === 0) return;
  const first = state(tx);
  const todo = new Map<Ulid, number>();
  for (const id of ids) {
    let at: Ulid | undefined = id;
    for (let depth = 0; at && at !== ROOT && first.model.nodes.has(at); depth++) {
      todo.set(at, Math.max(todo.get(at) ?? 0, depth));
      at = first.model.nodes.get(at)?.level;
    }
  }
  const levelDepth = (id: Ulid) => {
    let n = 0;
    for (let at = first.model.nodes.get(id)?.level; at && at !== ROOT; n++)
      at = first.model.nodes.get(at)?.level;
    return n;
  };
  const order = [...todo.keys()].sort((a, b) => levelDepth(b) - levelDepth(a));
  for (const id of order) {
    const st = state(tx);
    const entry = st.model.nodes.get(id);
    if (!entry || !hasStatus(entry.node)) continue;
    const want = statusFor(st.doc, entry.node);
    const have = entry.node.status;
    if (have === want || (have === undefined && want === 'draft')) continue;
    if (have === 'tested') dropTestedRecords(tx, [id]);
    setField(tx, nodeAt(state(tx), id).path, 'status', want, NODE_ORDER);
  }
}

export function implementedAgain(tx: YamlTransaction, ids: readonly Ulid[]): void {
  const st = state(tx);
  tx.applyAll(
    ids.map((id) => (f: YamlFile) => setIn(f, [...nodeAt(st, id).path, 'status'], 'implemented')),
  );
  dropTestedRecords(tx, ids);
}

/** Commands that cannot change a node's design (positions, statuses, drift decisions). */
const NO_DESIGN = new Set<FlowCommand['kind']>([
  // The format, not the design: no node goes back to implemented over it.
  'upgradeFormat',
  // Annotations explain the flow; they are not its design (AFD-64).
  'addAnnotation',
  'updateAnnotation',
  'moveNodes',
  'tidyUp',
  'unplaceNodes',
  'setStatuses',
  'ignoreDrift',
  'clearDriftIgnore',
  'acceptFinding',
  'clearFindingAccept',
  'acceptCheck',
  'clearCheckAccept',
  'markTested',
]);

/** `parsed` may carry the caller's existing parse of `text` (saves one parse per command). */
export function planCommand(
  text: string,
  cmd: FlowCommand,
  ctx: CommandContext,
  parsed?: YamlFile,
): CommandResult {
  const tx = new YamlTransaction(text, parsed);
  const before = NO_DESIGN.has(cmd.kind) ? undefined : (tx.current.doc.toJS() as FlowDocument);
  let created: Ulid | undefined;
  let pasted: Ulid[] | undefined;
  /** Nodes whose design a command only re-references (their tested status stays). */
  const rereferenced: Ulid[] = [];
  const notes: string[] = [];
  switch (cmd.kind) {
    case 'addNode':
      created = addNode(tx, ctx, cmd, notes);
      break;
    case 'updateNode':
      updateNode(tx, cmd, notes);
      break;
    case 'askAtRunTime':
      askAtRunTime(tx, cmd, notes);
      break;
    case 'deleteNode':
      deleteNode(tx, cmd.id);
      break;
    case 'deleteNodes': {
      // Wires first; each item is looked up again, so a wire of a deleted node or the child of a
      // deleted subflow is simply gone already.
      let removed = 0;
      for (const edge of cmd.edges ?? [])
        if (state(tx).model.edges.has(edge)) {
          removeEdgeById(tx, edge);
          removed++;
        }
      for (const id of cmd.ids)
        if (state(tx).model.nodes.has(id)) {
          deleteNode(tx, id);
          removed++;
        }
      removed += deleteAnnotations(tx, cmd.annotations ?? []);
      if (removed === 0) throw new CommandError('not-found', 'Nothing to delete');
      break;
    }
    case 'moveNodes':
    case 'tidyUp':
      setPositions(tx, cmd.positions);
      if (cmd.annotations) moveAnnotations(tx, cmd.annotations);
      break;
    case 'addAnnotation':
      created = addAnnotation(tx, ctx, cmd);
      break;
    case 'updateAnnotation':
      updateAnnotation(tx, cmd);
      break;
    case 'unplaceNodes':
      unplaceNodes(tx, cmd.ids);
      break;
    case 'connect':
      created = addEdge(tx, ctx, cmd.from, cmd.to);
      break;
    case 'applyPattern':
      created = applyPattern(tx, ctx, cmd, notes);
      break;
    case 'setDecision':
      setDecision(tx, cmd);
      break;
    case 'clearDecision':
      nodeAt(state(tx), cmd.node);
      tx.applyAll(decisionRemovalOps(state(tx), cmd.node, cmd.port));
      break;
    case 'rewire':
      rewire(tx, cmd.edge, cmd.to);
      break;
    case 'disconnect':
      removeEdgeById(tx, cmd.edge);
      break;
    case 'setPortEnabled':
      setPortEnabled(tx, cmd);
      break;
    case 'setContractField':
      setContractField(tx, cmd, notes);
      break;
    case 'setBinding':
      setBinding(tx, cmd, notes);
      break;
    case 'setStatuses': {
      const v2 = formatOf(state(tx).doc) >= 2;
      if (v2 && !cmd.run && Object.values(cmd.statuses).includes('tested'))
        throw new CommandError('needs-run', 'Tested from a run needs the run (format 2 keeps it)');
      for (const [id, status] of Object.entries(cmd.statuses)) {
        const { path } = nodeAt(state(tx), id);
        setField(tx, path, 'status', status, NODE_ORDER);
        if (v2 && status === 'tested' && cmd.run) {
          const record: TestedRecord = {
            run: cmd.run.id,
            ...(cmd.run.flowVersion !== undefined ? { flow_version: cmd.run.flowVersion } : {}),
            ...(cmd.run.commit ? { commit: cmd.run.commit } : {}),
          };
          setField(tx, path, 'tested', record as YamlValue, NODE_ORDER);
        }
      }
      dropTestedRecords(
        tx,
        Object.entries(cmd.statuses)
          .filter(([, s]) => s !== 'tested')
          .map(([id]) => id),
      );
      break;
    }
    case 'markTested':
      markTested(tx, cmd);
      break;
    case 'upgradeFormat':
      formatGuard(() => migrate(tx));
      notes.push(`Upgraded to flow format ${CURRENT_FORMAT}; one undo step reverts it`);
      break;
    case 'ignoreDrift':
      ignoreDrift(tx, cmd);
      break;
    case 'clearDriftIgnore':
      removeDecisions(
        tx,
        acceptedAll(state(tx).doc)
          .filter((a) => a.area === 'drift' && a.node === cmd.node && a.what === cmd.item)
          .map((a) => a.index),
      );
      break;
    case 'acceptCheck':
      acceptCheck(tx, cmd);
      break;
    case 'clearCheckAccept': {
      const what = checkWhat(cmd.code, cmd.subject);
      removeDecisions(
        tx,
        acceptedAll(state(tx).doc)
          .filter((a) => a.area === 'check' && a.node === cmd.node && a.what === what)
          .map((a) => a.index),
      );
      break;
    }
    case 'updateFlow':
      updateFlow(tx, cmd.patch);
      break;
    case 'acceptFinding':
      acceptFinding(tx, cmd);
      break;
    case 'clearFindingAccept':
      clearFindingAccept(tx, cmd.finding);
      break;
    case 'setBoundaryIn':
      setBoundaryIn(tx, cmd);
      break;
    case 'pasteNodes':
      pasted = pasteNodes(tx, ctx, cmd);
      created = pasted[0];
      break;
    case 'addReference':
      created = addReference(tx, ctx, cmd);
      break;
    case 'updateReference':
      updateReference(tx, ctx, cmd);
      break;
    case 'reimport':
      created = reimport(tx, ctx, cmd, notes);
      break;
    case 'unlinkReference': {
      const { node, path } = nodeAt(state(tx), cmd.id);
      if (!node.ref) throw new CommandError('not-shared', `${node.title} is not a shared subflow`);
      setField(tx, path, 'ref', null, NODE_ORDER);
      break;
    }
    case 'extractSubflow': {
      const r = extractSubflow(tx, ctx, cmd);
      created = r.id;
      rereferenced.push(...r.rewritten);
      break;
    }
    case 'connectBoundary':
      connectBoundary(tx, cmd);
      break;
    case 'disconnectBoundary':
      editExit(tx, cmd.subflow, cmd.from, cmd.port, () => null);
      break;
    case 'setExitReason': {
      const reason = cmd.reason?.trim();
      editExit(tx, cmd.subflow, cmd.from, cmd.port, (e) => ({
        node: e.node,
        port: e.port,
        ...(reason ? { reason } : {}),
      }));
      break;
    }
  }
  let dropped: Ulid[] | undefined;
  // Format 2 settles the statuses of what changed; format 1 files keep theirs (ADR-0025).
  const settle = formatOf(before ?? (tx.current.doc.toJS() as FlowDocument)) >= 2;
  const changed = new Set<Ulid>();
  if (before) {
    // A status the same command sets is the user's choice and stays.
    const keep = new Set<Ulid>();
    if (cmd.kind === 'updateNode' && cmd.patch.status !== undefined) keep.add(cmd.id);
    for (const n of rereferenced) keep.add(n);
    const after = tx.current.doc.toJS() as FlowDocument;
    dropped = testedDropBack(before, after, keep);
    if (dropped.length > 0) implementedAgain(tx, dropped);
    else dropped = undefined;
    if (settle) {
      const was = nodeDesigns(before);
      for (const [id, design] of Object.entries(nodeDesigns(after)))
        if (was[id] !== design) changed.add(id);
      if (created) changed.add(created);
    }
  }
  if (settle) {
    if (cmd.kind === 'setStatuses') for (const id of Object.keys(cmd.statuses)) changed.add(id);
    if (cmd.kind === 'markTested' || cmd.kind === 'updateNode') changed.add(cmd.id);
    settleStatuses(tx, changed);
  }
  return {
    edits: tx.edits(),
    text: tx.text,
    file: tx.current,
    created,
    pasted,
    dropped,
    ...(notes.length ? { notes } : {}),
  };
}

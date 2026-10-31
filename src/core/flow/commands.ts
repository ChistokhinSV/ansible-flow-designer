// Canvas intent commands → minimal text edits of the flow document (ADR-0001). Commands address
// nodes and edges by ID; each one becomes a single WorkspaceEdit, i.e. one undo step.
import type { TextEdit } from '../yaml/edits';
import { deleteKey, insertItem, type OpResult, removeItem, setIn } from '../yaml/ops';
import type { Path, YamlFile } from '../yaml/parse';
import type { YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { levelTaken, openOnPurpose, portKey, untakenFailPorts } from './bubbling';
import { parseClip } from './clipboard';
import { enclosing } from './dataRefs';
import { type IdFactory, SLUG, slugify, uniqueKey } from './ids';
import { mapStrings, renameRef } from './jinja';
import { existingLift, liftField, liftName } from './lift';
import { buildModel, type FlowModel, keyScope, type Level, ROOT } from './model';
import { findEnd, type PatternId, patternFits, recipeFor } from './patterns';
import { isFailPort, isPortLegal, optionalPortNames, portDirection, portsFor } from './ports';
import { testedDropBack } from './semantic';
import { statusAfterBinding } from './status';
import type {
  BoundaryExit,
  ContractField,
  FlowDocument,
  FlowNode,
  HandlerKind,
  ImplBinding,
  JoinMode,
  NodeSettings,
  NodeStatus,
  NodeType,
  PortRef,
  Position,
  SubflowBody,
  Ulid,
} from './types';
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
      handler?: HandlerKind;
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
  /** AFD-18: a selection (nodes and wires of one level) goes in one edit, so one undo restores it. */
  | { kind: 'deleteNodes'; ids: Ulid[]; edges?: Ulid[] }
  | { kind: 'moveNodes'; positions: Record<Ulid, Position> }
  /** AFD-24: drop stored positions, so the canvas places these nodes again. */
  | { kind: 'unplaceNodes'; ids: Ulid[] }
  | { kind: 'tidyUp'; positions: Record<Ulid, Position> }
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
  /** D-23: the inner node that receives the hosts entering the subflow (null clears it). */
  | { kind: 'setBoundaryIn'; subflow: Ulid; node: Ulid | null }
  /** D-23: an inner output leaves the subflow through the parent's `port`. */
  | { kind: 'connectBoundary'; subflow: Ulid; from: PortRef; port: string; reason?: string }
  | { kind: 'disconnectBoundary'; subflow: Ulid; from: PortRef; port: string }
  | { kind: 'setExitReason'; subflow: Ulid; from: PortRef; port: string; reason: string | null }
  /**
   * M5 "Save binding" (mockup 11): the implementation and what came with it (inputs the chips
   * created, outputs from the registered result, the status) in one edit; `impl: null` unbinds.
   */
  | {
      kind: 'setBinding';
      id: Ulid;
      impl: ImplBinding | null;
      /** Contract fields to set (null removes one); other fields stay. */
      inputs?: Record<string, ContractField | null>;
      outputs?: Record<string, ContractField | null>;
      status?: NodeStatus;
    }
  /** M6 (D-29): keep a drift item as it is, with a reason; the host adds `by`. */
  | { kind: 'ignoreDrift'; node: Ulid; item: string; reason: string; by?: string }
  | { kind: 'clearDriftIgnore'; node: Ulid; item: string }
  /** M8: keep a lens finding as expected, with a reason; the host adds `by`. */
  | { kind: 'acceptFinding'; finding: string; node?: Ulid; reason: string; by?: string }
  | { kind: 'clearFindingAccept'; finding: string }
  /** Decision 15 (M7): the nodes a passing run of this flow version tested, in one edit. */
  | { kind: 'setStatuses'; statuses: Record<Ulid, NodeStatus> }
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
    };

export interface NodePatch {
  title?: string;
  key?: string;
  intent?: string | null;
  status?: NodeStatus | null;
  condition?: string | null;
  outcome?: 'success' | 'failed' | null;
  handler?: HandlerKind | null;
  join_mode?: JoinMode | null;
  branches?: number | null;
  /** Merged into `settings`; null removes a setting. */
  settings?: { [K in keyof NodeSettings]?: NodeSettings[K] | null };
  /** Replaces the binding's task keywords (AFD-26); null or {} removes them. */
  keywords?: Record<string, unknown> | null;
}

export interface FlowPatch {
  name?: string;
  key?: string;
  goal?: string | null;
  owner?: string | null;
  /** The AWX job template the flow launches (M7 "Set up AWX template"); null removes runtime. */
  runtime?: { kind?: 'awx_workflow' | 'awx_job' | 'ansible_playbook'; template?: string } | null;
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

const NODE_ORDER = [
  'id',
  'key',
  'type',
  'title',
  'status',
  'intent',
  'condition',
  'outcome',
  'handler',
  'join_mode',
  'branches',
  'ports',
  'inputs',
  'outputs',
  'settings',
  'impl',
  'undo',
  'subflow',
];
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
const SUBFLOW_ORDER = ['nodes', 'edges', 'layout', 'boundary'];
const ROOT_ORDER = ['schema_version', 'flow', 'nodes', 'edges', 'layout', 'decisions'];

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
  const idx = decisions
    .map((d, i) => (d?.node === node && d.port === port ? i : -1))
    .filter((i) => i >= 0);
  if (idx.length === 0) return [];
  if (idx.length === decisions.length) return [(f) => deleteKey(f, [], 'decisions')];
  return idx.map((i) => (f: YamlFile) => removeItem(f, ['decisions'], i));
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
  handler?: HandlerKind;
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
): { id: Ulid; item: Record<string, YamlValue> } {
  const key = spec.key ?? uniqueKey(slugify(spec.title), taken);
  if (!SLUG.test(key)) throw new CommandError('bad-key', `Key "${key}" must be a lowercase slug`);
  if (taken.has(key))
    throw new CommandError('duplicate-key', `Key "${key}" is already used in this level`);
  taken.add(key);
  const id = ctx.newId();
  const node: Record<string, YamlValue> = { id, key, type: spec.type, title: spec.title };
  if (spec.type !== 'start' && spec.type !== 'end') node.status = 'draft';
  if (spec.intent) node.intent = spec.intent;
  if (spec.type === 'end') node.outcome = spec.outcome ?? 'success';
  if (spec.handler) node.handler = spec.handler;
  const optional = optionalPortNames(spec.type);
  const ports = (spec.ports ?? []).filter((p) => optional.includes(p));
  if (ports.length > 0) node.ports = ports;
  if (spec.inputs && Object.keys(spec.inputs).length > 0) {
    node.inputs = Object.fromEntries(Object.entries(spec.inputs).map(([k, v]) => [k, contract(v)]));
  }
  if (spec.settings && Object.keys(spec.settings).length > 0)
    node.settings = spec.settings as Record<string, YamlValue>;
  if (spec.impl) node.impl = implValue(spec.impl);
  return { id, item: node };
}

function levelKeys(level: Level): Set<string> {
  return new Set(level.nodes.flatMap((n) => (n?.key ? [n.key] : [])));
}

/**
 * Inserts a new node into its level. The first step of a subflow creates the inner graph and
 * becomes the boundary entry (D-23), in the same edit.
 */
function insertNode(tx: YamlTransaction, ctx: CommandContext, spec: NodeSpec): Ulid {
  const st = state(tx);
  if (!spec.parent) {
    const level = levelOf(st, ROOT);
    const { id, item } = nodeItem(ctx, spec, levelKeys(level));
    tx.apply((f) => insertItem(f, level.nodesPath, 'end', item));
    return id;
  }
  const parent = spec.parent;
  const { node, path } = nodeAt(st, parent);
  if (node.type !== 'subflow') throw new CommandError('bad-type', `${node.title} is not a subflow`);
  const level = st.model.levels.get(parent);
  const { id, item } = nodeItem(ctx, spec, level ? levelKeys(level) : new Set());
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
  // Every new node and edge is computed against this one state and written in one batch.
  const taken = levelKeys(level);
  const nodes: Record<string, YamlValue>[] = [];
  const edges: Record<string, YamlValue>[] = [];
  const positions: Record<Ulid, Position> = { ...cmd.freeze };
  let handler: Ulid | undefined;
  if (recipe.node) {
    const created = nodeItem(ctx, recipe.node, taken);
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
  const index = decisions.findIndex((d) => d?.node === cmd.node && d.port === cmd.port);
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
  const item: Record<string, YamlValue> = {
    node: cmd.node,
    port: cmd.port,
    kind: 'open_on_purpose',
    reason,
  };
  if (cmd.by) item.by = cmd.by;
  if (st.doc.decisions) tx.apply((f) => insertItem(f, ['decisions'], 'end', item));
  else tx.apply((f) => setIn(f, ['decisions'], [item], { before: after(ROOT_ORDER, 'decisions') }));
}

function renameKey(tx: YamlTransaction, id: Ulid, newKey: string): void {
  const st = state(tx);
  const { node, path, level } = nodeAt(st, id);
  if (newKey === node.key) return;
  if (!SLUG.test(newKey))
    throw new CommandError('bad-key', `Key "${newKey}" must be a lowercase slug`);
  if (levelOf(st, level).nodes.some((n) => n?.key === newKey)) {
    throw new CommandError('duplicate-key', `Key "${newKey}" is already used in this level`);
  }
  const oldKey = node.key;
  // `from:` references keys, not IDs: rewrite every reference that resolves to this node.
  const rewrites: { path: Path; value: string }[] = [];
  for (const entry of st.model.nodes.values()) {
    if (keyScope(st.model, entry.level).get(oldKey) !== id) continue;
    for (const side of ['inputs', 'outputs'] as const) {
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

function updateNode(tx: YamlTransaction, cmd: Extract<FlowCommand, { kind: 'updateNode' }>): void {
  const { patch } = cmd;
  if (patch.key !== undefined) renameKey(tx, cmd.id, patch.key);
  const { path } = nodeAt(state(tx), cmd.id);
  if (patch.title !== undefined && patch.title.trim() === '') {
    throw new CommandError('bad-title', 'Title must not be empty');
  }
  setField(tx, path, 'title', patch.title, NODE_ORDER);
  for (const k of [
    'intent',
    'status',
    'condition',
    'outcome',
    'handler',
    'join_mode',
    'branches',
  ] as const) {
    setField(tx, path, k, patch[k] as YamlValue | undefined, NODE_ORDER);
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
  return indexes.map((i) => (f: YamlFile) => removeItem(f, seqPath, i));
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
    ops.push(...decisionIdx.map((i) => (f: YamlFile) => removeItem(f, ['decisions'], i)));
  }

  const layout = st.doc.layout ?? {};
  const layoutIds = [...gone].filter((x) => x in layout);
  if (layoutIds.length > 0 && layoutIds.length === Object.keys(layout).length) {
    ops.push((f) => deleteKey(f, [], 'layout'));
  } else {
    ops.push(...layoutIds.map((lid) => (f: YamlFile) => deleteKey(f, ['layout'], lid)));
  }

  ops.push(...removeIndexes(path.slice(0, -1), [path.at(-1) as number], level.nodes.length));

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
    if (cmd.impl.register && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(cmd.impl.register))
      throw new CommandError('bad-name', `"${cmd.impl.register}" is not a valid variable name`);
  }
  for (const side of ['inputs', 'outputs'] as const) {
    for (const [name, field] of Object.entries(cmd[side] ?? {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new CommandError('bad-name', `"${name}" is not a valid variable name`);
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
  // Every writer gets the same lifecycle rule (AFD-31): the AI `bind` op sends no status.
  const current = node.status ?? 'draft';
  const status =
    cmd.status ??
    statusAfterBinding(
      current,
      !!impl,
      JSON.stringify(impl ?? null) === JSON.stringify(node.impl ?? null),
    );
  setField(tx, path, 'status', status === current ? undefined : status, NODE_ORDER);
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
  const decisions = st.doc.decisions ?? [];
  const index = decisions.findIndex(
    (d) => d?.kind === 'drift_ignored' && d.node === cmd.node && d.item === cmd.item,
  );
  if (index >= 0) {
    const base: Path = ['decisions', index];
    const ops: ((f: YamlFile) => OpResult)[] = [
      (f) => setIn(f, [...base, 'reason'], reason, { before: ['by'] }),
    ];
    if (cmd.by) ops.push((f) => setIn(f, [...base, 'by'], cmd.by as string));
    tx.applyAll(ops);
    return;
  }
  const item: Record<string, YamlValue> = {
    node: cmd.node,
    kind: 'drift_ignored',
    item: cmd.item,
    reason,
  };
  if (cmd.by) item.by = cmd.by;
  if (st.doc.decisions) tx.apply((f) => insertItem(f, ['decisions'], 'end', item));
  else tx.apply((f) => setIn(f, ['decisions'], [item], { before: after(ROOT_ORDER, 'decisions') }));
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
    if (keyScope(st.model, entry.level).get(node.key) !== id) continue;
    // Inside a subflow, and on its own outputs, `<key>.<name>` is its input (AFD-21).
    if (entry.node.id === id || enclosing(st.model, entry.level).some((s) => s.id === id)) continue;
    for (const side of ['inputs', 'outputs'] as const) {
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
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new CommandError('bad-name', `"${name}" is not a valid variable name`);
  }
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
  }
  const after_ = state(tx);
  const side =
    cmd.target === 'flow' ? after_.doc.flow.inputs : nodeAt(after_, cmd.target).node[cmd.side];
  if (side) tx.apply((f) => setIn(f, [...base, cmd.side, name], value));
  else setField(tx, base, cmd.side, { [name]: value }, order);
  if (cmd.target !== 'flow') liftPathRefs(tx, cmd.target, notes);
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
  const decisions = st.doc.decisions ?? [];
  const index = decisions.findIndex(
    (d) => d?.kind === 'finding_accepted' && d.finding === cmd.finding,
  );
  if (index >= 0) {
    const base: Path = ['decisions', index];
    const ops: ((f: YamlFile) => OpResult)[] = [
      (f) => setIn(f, [...base, 'reason'], reason, { before: ['by'] }),
    ];
    if (cmd.by) ops.push((f) => setIn(f, [...base, 'by'], cmd.by as string));
    tx.applyAll(ops);
    return;
  }
  const item: Record<string, YamlValue> = { kind: 'finding_accepted', finding: cmd.finding };
  if (cmd.node) item.node = cmd.node;
  item.reason = reason;
  if (cmd.by) item.by = cmd.by;
  if (st.doc.decisions) tx.apply((f) => insertItem(f, ['decisions'], 'end', item));
  else tx.apply((f) => setIn(f, ['decisions'], [item], { before: after(ROOT_ORDER, 'decisions') }));
}

function clearFindingAccept(tx: YamlTransaction, finding: string): void {
  const decisions = state(tx).doc.decisions ?? [];
  const idx = decisions
    .map((d, i) => (d?.kind === 'finding_accepted' && d.finding === finding ? i : -1))
    .filter((i) => i >= 0);
  if (idx.length === 0) return;
  if (idx.length === decisions.length) tx.apply((f) => deleteKey(f, [], 'decisions'));
  else tx.applyAll(removeIndexes(['decisions'], idx, decisions.length));
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
  const taken = levelKeys(level);
  const key = cmd.key ?? uniqueKey(slugify(cmd.title, 'subflow'), taken);
  if (!SLUG.test(key)) throw new CommandError('bad-key', `Key "${key}" must be a lowercase slug`);
  if (taken.has(key))
    throw new CommandError('duplicate-key', `Key "${key}" is already used in this level`);
  const id = ctx.newId();

  // Outputs read outside the group are lifted to the subflow (AFD-7 decision).
  const movedIds = new Set(entries.flatMap((e) => [e.node.id, ...descendantIds(e.node)]));
  const keyOf = new Map(entries.map((e) => [e.node.key, e.node]));
  const lifted = new Map<string, { name: string; field: ContractField }>();
  const rewrites: { path: Path; value: string; node: Ulid }[] = [];
  for (const other of st.model.nodes.values()) {
    if (movedIds.has(other.node.id)) continue;
    const scope = keyScope(st.model, other.level);
    for (const side of ['inputs', 'outputs'] as const)
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
  // As far along as its least advanced work step; "specified" needs a contract of its own.
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
  if (source.length === 0)
    throw new CommandError('bad-clipboard', 'Nothing to paste: a flow has one start node');
  const st = state(tx);
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
      delete inner.layout;
    }
    return copy;
  };
  const nodes = source.map(remapNode);

  // Keys unique on the target level; references between the pasted nodes follow a new key.
  const taken = level ? levelKeys(level) : new Set<string>();
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
  const decisions = clip.decisions
    .filter((d) => d?.kind === 'open_on_purpose' && ids.has(d.node ?? ''))
    .map((d) => ({ ...d, node: ids.get(d.node ?? '') as Ulid }));

  // Positions: the group keeps its shape around `position`; inner levels keep theirs.
  const positions: Record<Ulid, Position> = {};
  const top = source.map((n) => clip.layout[n.id]).filter((p): p is Position => !!p);
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

  const ops: Op[] = [];
  const append = (path: Path, values: unknown[], order: readonly string[]) => {
    if (values.length === 0) return;
    const items = values as YamlValue[];
    if (tx.current.doc.getIn(path) !== undefined)
      for (const item of items) ops.push((f) => insertItem(f, path, 'end', item));
    else ops.push((f) => setIn(f, path, items, { before: after(order, path.at(-1) as string) }));
  };
  const subflow = parent?.node.subflow;
  const entry = nodes[0]?.id as Ulid;
  if (parent && !subflow) {
    // A subflow without an inner graph: the pasted nodes are its first level (D-23 entry).
    const body: Record<string, YamlValue> = { nodes: nodes as unknown as YamlValue[] };
    if (edges.length > 0) body.edges = edges as unknown as YamlValue[];
    body.boundary = { in: entry };
    ops.push((f) =>
      setIn(f, [...parent.path, 'subflow'], body, { before: after(NODE_ORDER, 'subflow') }),
    );
  } else {
    const level = levelOf(st, levelId);
    const order = parent ? SUBFLOW_ORDER : ROOT_ORDER;
    append(level.nodesPath, nodes, order);
    append(level.edgesPath, edges, order);
    if (parent && !subflow?.nodes?.length && !subflow?.boundary?.in)
      ops.push(...boundaryOps(st, parent.node.id, { ...subflow?.boundary, in: entry }));
  }
  append(['decisions'], decisions, ROOT_ORDER);
  tx.applyAll(ops);
  // Nodes shown at auto positions are written too, or the level would be stacked below the paste.
  setPositions(tx, { ...cmd.freeze, ...positions });
  return nodes.map((n) => n.id);
}

export function implementedAgain(tx: YamlTransaction, ids: readonly Ulid[]): void {
  const st = state(tx);
  tx.applyAll(
    ids.map((id) => (f: YamlFile) => setIn(f, [...nodeAt(st, id).path, 'status'], 'implemented')),
  );
}

/** Commands that cannot change a node's design (positions, statuses, drift decisions). */
const NO_DESIGN = new Set<FlowCommand['kind']>([
  'moveNodes',
  'tidyUp',
  'unplaceNodes',
  'setStatuses',
  'ignoreDrift',
  'clearDriftIgnore',
  'acceptFinding',
  'clearFindingAccept',
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
      updateNode(tx, cmd);
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
      if (removed === 0) throw new CommandError('not-found', 'Nothing to delete');
      break;
    }
    case 'moveNodes':
    case 'tidyUp':
      setPositions(tx, cmd.positions);
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
    case 'setStatuses':
      for (const [id, status] of Object.entries(cmd.statuses))
        setField(tx, nodeAt(state(tx), id).path, 'status', status, NODE_ORDER);
      break;
    case 'ignoreDrift':
      ignoreDrift(tx, cmd);
      break;
    case 'clearDriftIgnore': {
      const decisions = state(tx).doc.decisions ?? [];
      const idx = decisions
        .map((d, i) =>
          d?.kind === 'drift_ignored' && d.node === cmd.node && d.item === cmd.item ? i : -1,
        )
        .filter((i) => i >= 0);
      if (idx.length === decisions.length && idx.length > 0)
        tx.apply((f) => deleteKey(f, [], 'decisions'));
      else tx.applyAll(idx.map((i) => (f: YamlFile) => removeItem(f, ['decisions'], i)));
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
  if (before) {
    // A status the same command sets is the user's choice and stays.
    const keep = new Set<Ulid>();
    if (cmd.kind === 'updateNode' && cmd.patch.status !== undefined) keep.add(cmd.id);
    if (cmd.kind === 'setBinding' && cmd.status !== undefined) keep.add(cmd.id);
    for (const n of rereferenced) keep.add(n);
    dropped = testedDropBack(before, tx.current.doc.toJS() as FlowDocument, keep);
    if (dropped.length > 0) implementedAgain(tx, dropped);
    else dropped = undefined;
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

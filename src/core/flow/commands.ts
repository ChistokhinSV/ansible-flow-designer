// Canvas intent commands → minimal text edits of the flow document (ADR-0001). Commands address
// nodes and edges by ID; each one becomes a single WorkspaceEdit, i.e. one undo step.
import type { TextEdit } from '../yaml/edits';
import { deleteKey, insertItem, type OpResult, removeItem, setIn } from '../yaml/ops';
import type { Path, YamlFile } from '../yaml/parse';
import type { YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { type IdFactory, SLUG, slugify, uniqueKey } from './ids';
import { buildModel, type FlowModel, keyScope, type Level, ROOT } from './model';
import { findEnd, type PatternId, patternFits, recipeFor } from './patterns';
import { isFailPort, isPortLegal, optionalPortNames, portDirection, portsFor } from './ports';
import type {
  BoundaryExit,
  ContractField,
  FlowDocument,
  FlowNode,
  HandlerKind,
  JoinMode,
  NodeSettings,
  NodeStatus,
  NodeType,
  PortRef,
  Position,
  SubflowBody,
  Ulid,
} from './types';

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
      freeze?: Record<Ulid, Position>;
    }
  | { kind: 'setDecision'; node: Ulid; port: string; reason: string; by?: string }
  | { kind: 'clearDecision'; node: Ulid; port: string }
  | { kind: 'rewire'; edge: Ulid; to: PortRef }
  | { kind: 'updateNode'; id: Ulid; patch: NodePatch }
  | { kind: 'deleteNode'; id: Ulid }
  | { kind: 'moveNodes'; positions: Record<Ulid, Position> }
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
  | { kind: 'setExitReason'; subflow: Ulid; from: PortRef; port: string; reason: string | null };

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
}

export interface FlowPatch {
  name?: string;
  key?: string;
  goal?: string | null;
  owner?: string | null;
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
const FLOW_ORDER = ['id', 'key', 'name', 'version', 'goal', 'owner', 'runtime', 'inputs'];
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
): Ulid {
  if (cmd.insertOn && cmd.connectFrom)
    throw new CommandError('bad-command', 'Use either insertOn or connectFrom');
  if (cmd.insertOn && !CONTINUES_ON[cmd.type]) {
    throw new CommandError('bad-type', `A ${cmd.type} node cannot be inserted on a wire`);
  }
  const id = insertNode(tx, ctx, cmd);
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
  let end = recipe.end ? findEnd(level, recipe.end)?.id : undefined;
  if (recipe.end && !end) {
    const { title, outcome } = recipe.end;
    const created = nodeItem(ctx, { type: 'end', title, outcome }, taken);
    nodes.push(created.item);
    end = created.id;
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
  const gone = new Set([id, ...descendants(node)]);
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

function descendants(node: FlowNode): Ulid[] {
  return (node.subflow?.nodes ?? []).flatMap((n) => (n?.id ? [n.id, ...descendants(n)] : []));
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

function setContractField(
  tx: YamlTransaction,
  cmd: Extract<FlowCommand, { kind: 'setContractField' }>,
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
  const after_ = state(tx);
  const side =
    cmd.target === 'flow' ? after_.doc.flow.inputs : nodeAt(after_, cmd.target).node[cmd.side];
  if (side) tx.apply((f) => setIn(f, [...base, cmd.side, name], value));
  else setField(tx, base, cmd.side, { [name]: value }, order);
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

/** `parsed` may carry the caller's existing parse of `text` (saves one parse per command). */
export function planCommand(
  text: string,
  cmd: FlowCommand,
  ctx: CommandContext,
  parsed?: YamlFile,
): CommandResult {
  const tx = new YamlTransaction(text, parsed);
  let created: Ulid | undefined;
  switch (cmd.kind) {
    case 'addNode':
      created = addNode(tx, ctx, cmd);
      break;
    case 'updateNode':
      updateNode(tx, cmd);
      break;
    case 'deleteNode':
      deleteNode(tx, cmd.id);
      break;
    case 'moveNodes':
    case 'tidyUp':
      setPositions(tx, cmd.positions);
      break;
    case 'connect':
      created = addEdge(tx, ctx, cmd.from, cmd.to);
      break;
    case 'applyPattern':
      created = applyPattern(tx, ctx, cmd);
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
      setContractField(tx, cmd);
      break;
    case 'updateFlow':
      updateFlow(tx, cmd.patch);
      break;
    case 'setBoundaryIn':
      setBoundaryIn(tx, cmd);
      break;
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
  return { edits: tx.edits(), text: tx.text, file: tx.current, created };
}

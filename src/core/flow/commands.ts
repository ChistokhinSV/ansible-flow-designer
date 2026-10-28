// Canvas intent commands → minimal text edits of the flow document (ADR-0001). Commands address
// nodes and edges by ID; each one becomes a single WorkspaceEdit, i.e. one undo step.
import type { TextEdit } from '../yaml/edits';
import { deleteKey, insertItem, type OpResult, removeItem, setIn } from '../yaml/ops';
import type { Path, YamlFile } from '../yaml/parse';
import type { YamlValue } from '../yaml/render';
import { YamlTransaction } from '../yaml/transaction';
import { type IdFactory, SLUG, slugify, uniqueKey } from './ids';
import { buildModel, type FlowModel, keyScope, type Level, ROOT } from './model';
import { isPortLegal, optionalPortNames, portDirection, portsFor } from './ports';
import type {
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
  Ulid,
} from './types';

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
    }
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
  | { kind: 'updateFlow'; patch: FlowPatch };

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

function ensurePortEnabled(tx: YamlTransaction, id: Ulid, port: string): void {
  const st = state(tx);
  const { node, path } = nodeAt(st, id);
  if (portsFor(node).some((p) => p.name === port)) return;
  if (!optionalPortNames(node.type).includes(port)) {
    throw new CommandError('bad-port', `${node.type} nodes have no port "${port}"`);
  }
  if (node.ports) tx.apply((f) => insertItem(f, [...path, 'ports'], 'end', port));
  else setField(tx, path, 'ports', [port], NODE_ORDER);
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

function addEdge(tx: YamlTransaction, ctx: CommandContext, from: PortRef, to: PortRef): Ulid {
  const st = state(tx);
  const a = nodeAt(st, from.node);
  const b = nodeAt(st, to.node);
  if (a.level !== b.level)
    throw new CommandError('cross-level', 'Both ends must be in the same level');
  if (!isPortLegal(a.node, from.port) || portDirection(from.port) !== 'out') {
    throw new CommandError('bad-port', `"${from.port}" is not an output of ${a.node.type}`);
  }
  if (!isPortLegal(b.node, to.port) || portDirection(to.port) !== 'in') {
    throw new CommandError('bad-port', `"${to.port}" is not an input of ${b.node.type}`);
  }
  const level = levelOf(st, a.level);
  if (level.edges.some((e) => e?.from?.node === from.node && e.from.port === from.port)) {
    throw new CommandError(
      'port-in-use',
      `${from.port} is already wired; use a parallel node to fan out`,
    );
  }
  if (from.node === to.node || reachable(level, to.node, from.node)) {
    throw new CommandError('cycle', 'This edge would create a cycle');
  }
  ensurePortEnabled(tx, from.node, from.port);
  ensurePortEnabled(tx, to.node, to.port);
  const id = ctx.newId();
  const edge = {
    id,
    from: { node: from.node, port: from.port },
    to: { node: to.node, port: to.port },
  };
  tx.apply((f) => insertItem(f, level.edgesPath, 'end', edge));
  return id;
}

function setPositions(tx: YamlTransaction, positions: Record<Ulid, Position>): void {
  const rounded = Object.entries(positions).map(
    ([id, p]) => [id, { x: Math.round(p.x), y: Math.round(p.y) }] as const,
  );
  if (rounded.length === 0) return;
  const st = state(tx);
  if (st.doc.layout === undefined || st.doc.layout === null) {
    const block: Record<string, YamlValue> = {};
    for (const [id, p] of rounded) block[id] = { x: p.x, y: p.y };
    tx.apply((f) => setIn(f, ['layout'], block, { before: after(ROOT_ORDER, 'layout') }));
    return;
  }
  const ops: ((f: YamlFile) => OpResult)[] = [];
  for (const [id, p] of rounded) {
    const old = st.doc.layout[id];
    if (!old) {
      ops.push((f) => setIn(f, ['layout', id], { x: p.x, y: p.y }));
      continue;
    }
    if (old.x !== p.x) ops.push((f) => setIn(f, ['layout', id, 'x'], p.x));
    if (old.y !== p.y) ops.push((f) => setIn(f, ['layout', id, 'y'], p.y));
  }
  tx.applyAll(ops);
}

function addNode(
  tx: YamlTransaction,
  ctx: CommandContext,
  cmd: Extract<FlowCommand, { kind: 'addNode' }>,
): Ulid {
  const st = state(tx);
  const level = levelOf(st, cmd.parent ?? ROOT);
  if (cmd.parent && !st.model.nodes.get(cmd.parent)?.node.subflow?.nodes) {
    throw new CommandError('no-inner-graph', 'The subflow has no inner graph yet');
  }
  const taken = new Set(level.nodes.map((n) => n?.key));
  const key = cmd.key ?? uniqueKey(slugify(cmd.title), taken);
  if (!SLUG.test(key)) throw new CommandError('bad-key', `Key "${key}" must be a lowercase slug`);
  if (taken.has(key))
    throw new CommandError('duplicate-key', `Key "${key}" is already used in this level`);

  const id = ctx.newId();
  const node: Record<string, YamlValue> = { id, key, type: cmd.type, title: cmd.title };
  if (cmd.type !== 'start' && cmd.type !== 'end') node.status = 'draft';
  if (cmd.intent) node.intent = cmd.intent;
  if (cmd.type === 'end') node.outcome = cmd.outcome ?? 'success';
  if (cmd.handler) node.handler = cmd.handler;
  const optional = optionalPortNames(cmd.type);
  const ports = (cmd.ports ?? []).filter((p) => optional.includes(p));
  if (ports.length > 0) node.ports = ports;
  if (cmd.inputs && Object.keys(cmd.inputs).length > 0) {
    node.inputs = Object.fromEntries(Object.entries(cmd.inputs).map(([k, v]) => [k, contract(v)]));
  }
  tx.apply((f) => insertItem(f, level.nodesPath, 'end', node));
  if (cmd.position) setPositions(tx, { [id]: cmd.position });
  if (cmd.connectFrom) addEdge(tx, ctx, cmd.connectFrom, { node: id, port: 'in' });
  if (cmd.wireFailedTo)
    addEdge(tx, ctx, { node: id, port: 'failed_hosts' }, { node: cmd.wireFailedTo, port: 'in' });
  return id;
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

  const decisions = st.doc.decisions ?? [];
  const decisionIdx = decisions.map((d, i) => (d?.node === id ? i : -1)).filter((i) => i >= 0);
  if (decisionIdx.length > 0 && decisionIdx.length === decisions.length) {
    ops.push((f) => deleteKey(f, [], 'decisions'));
  } else {
    ops.push(...decisionIdx.map((i) => (f: YamlFile) => removeItem(f, ['decisions'], i)));
  }

  const inner = (node.subflow?.nodes ?? []).map((n) => n?.id);
  const layout = st.doc.layout ?? {};
  const layoutIds = [id, ...inner].filter((x): x is Ulid => !!x && x in layout);
  if (layoutIds.length > 0 && layoutIds.length === Object.keys(layout).length) {
    ops.push((f) => deleteKey(f, [], 'layout'));
  } else {
    ops.push(...layoutIds.map((lid) => (f: YamlFile) => deleteKey(f, ['layout'], lid)));
  }

  ops.push(...removeIndexes(path.slice(0, -1), [path.at(-1) as number], level.nodes.length));
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
  const edges = levelOf(st, level).edges;
  if (
    edges.some(
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
  }
  return { edits: tx.edits(), text: tx.text, file: tx.current, created };
}

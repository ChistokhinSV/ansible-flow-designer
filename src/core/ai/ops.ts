// The op language AI tools edit flows with (AFD-19): nodes and ports named by key, applied in
// order through the same commands as the canvas, all or nothing. A batch first completes any IDs
// the file was written without. Errors say what went wrong and how to fix it, never with IDs.
import { CommandError, type FlowCommand, planCommand } from '../flow/commands';
import { completeIds } from '../flow/completeIds';
import { flowFromFile } from '../flow/document';
import { type IdFactory, SLUG, slugify } from '../flow/ids';
import { buildModel, type FlowModel, type Level, ROOT } from '../flow/model';
import { PATTERN_IDS, type PatternId } from '../flow/patterns';
import { portDirection } from '../flow/ports';
import type {
  ContractField,
  HandlerKind,
  ImplBinding,
  JoinMode,
  NodeSettings,
  NodeStatus,
  NodeType,
  Position,
  Ulid,
} from '../flow/types';
import { parseYaml, type YamlFile } from '../yaml/parse';
import { YamlEditError } from '../yaml/transaction';
import { keyPath, levelName, RefError, resolveNode, resolvePort, withoutIds } from './refs';

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
      handler?: HandlerKind;
      outcome?: 'success' | 'failed';
      condition?: string;
      branches?: number;
      join_mode?: JoinMode;
      inputs?: Record<string, ContractField>;
      outputs?: Record<string, ContractField>;
      settings?: NodeSettings;
      impl?: ImplBinding;
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
      handler?: HandlerKind | null;
      join_mode?: JoinMode | null;
      branches?: number | null;
      settings?: { [K in keyof NodeSettings]?: NodeSettings[K] | null };
    }
  | { op: 'delete'; nodes?: string[]; wires?: string[] }
  | { op: 'connect'; from: string; to: string }
  | { op: 'disconnect'; from: string }
  | { op: 'rewire'; from: string; to: string }
  | { op: 'enable_port' | 'disable_port'; node: string; port: string }
  | { op: 'leave_open'; at: string; reason: string }
  | { op: 'reopen'; at: string }
  | { op: 'apply_pattern'; at: string; pattern: PatternId; end?: string }
  | {
      op: 'set_io';
      node: string;
      side: 'inputs' | 'outputs';
      name: string;
      field: ContractField | null;
      rename?: string;
    }
  | {
      op: 'update_flow';
      name?: string;
      key?: string;
      goal?: string | null;
      owner?: string | null;
      maintenance_window?: string | null;
    }
  | { op: 'set_entry'; subflow: string; node: string | null }
  | { op: 'add_exit'; from: string; port: string; reason?: string }
  | { op: 'remove_exit'; from: string; port: string }
  | { op: 'extract_subflow'; nodes: string[]; title: string; key?: string }
  | { op: 'bind'; node: string; impl: ImplBinding | null }
  | { op: 'tidy_up'; level?: string };

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
  const main = ['node', 'at', 'from', 'subflow', 'title']
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

/** The FlowCommands of one op, planned against the current state. */
async function commandsOf(
  st: State,
  op: Op,
  ctx: OpsContext,
  notes: string[],
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
      const cmd: FlowCommand = {
        kind: 'addNode',
        ...(parent ? { parent } : {}),
        type: op.type,
        title: op.title,
        key,
        ...(op.intent ? { intent: op.intent } : {}),
        ...(op.ports ? { ports: op.ports } : {}),
        ...(op.handler ? { handler: op.handler } : {}),
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
      const { op: _op, node: _node, ...patch } = op;
      return [{ kind: 'updateNode', id: node.id, patch }];
    }
    case 'delete': {
      const ids = (op.nodes ?? []).map((n) => resolveNode(st.model, n).id);
      const edges = (op.wires ?? []).map((w) => wireFrom(st, w).edge);
      if (ids.length + edges.length === 0) throw new RefError('Name nodes or wires to delete');
      return [{ kind: 'deleteNodes', ids, edges }];
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
      return [
        {
          kind: 'applyPattern',
          pattern: op.pattern,
          from: { node: at.node.id, port: at.port },
          ...(end ? { end: end.id } : {}),
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
      const nodes = op.nodes.map((n) => resolveNode(st.model, n).id);
      return [
        { kind: 'extractSubflow', nodes, title: op.title, ...(op.key ? { key: op.key } : {}) },
      ];
    }
    case 'bind': {
      const node = resolveNode(st.model, op.node);
      return [{ kind: 'setBinding', id: node.id, impl: op.impl }];
    }
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
        `Completed IDs: ${f.nodes} node(s), ${f.wires} wire(s), ${f.refs} reference(s) by key`,
      );
    }
  } catch (e) {
    throw new OpError(-1, `The file does not parse: ${(e as Error).message}. Nothing was written.`);
  }
  let st = stateOf(current);
  const existing = new Set(st.model.nodes.keys());
  for (const [i, op] of ops.entries()) {
    try {
      for (const cmd of await commandsOf(st, op, ctx, notes)) {
        const r = planCommand(st.text, cmd, { newId: ctx.newId }, st.file);
        st = stateOf(r.text, r.file);
        notes.push(...(r.notes ?? []));
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
  // Patterns and extraction add nodes too: report every node the batch made.
  const created = [...st.model.nodes.keys()]
    .filter((id) => !existing.has(id))
    .map((id) => keyPath(st.model, id));
  return { text: st.text, created, dropped: [...dropped], notes };
}

// Failure patterns (D-16) and the other ready-made port resolutions of the port menu (04 §3).
// A pattern is a recipe: an optional handler node wired from the source port, plus wires to an
// end node (reused when the level has one with a key the pattern names, AFD-21) and back to the
// happy path. The command
// layer turns a recipe into one WorkspaceEdit; code templates per pattern arrive with M3 codegen.
import type { Level } from './model';
import type { FlowNode, HandlerKind, NodeSettings, NodeType } from './types';

export const PATTERN_IDS = [
  'rollback',
  'notify-stop',
  'exclude',
  'retry',
  'stop',
  'done',
  'escalate',
  'report',
] as const;
export type PatternId = (typeof PATTERN_IDS)[number];

export interface PatternSpec {
  id: PatternId;
  label: string;
  hint: string;
  /** Source ports the pattern attaches to. D-09: rollback never takes unreachable. */
  accepts: readonly string[];
  /** Only for these source node types (default: any). */
  types?: readonly NodeType[];
  /** Offered in the palette's failure pattern group. */
  palette: boolean;
}

export const PATTERNS: Record<PatternId, PatternSpec> = {
  rollback: {
    id: 'rollback',
    label: 'Rollback from backup',
    hint: 'Undo the completed nodes for the failed hosts only (reuses the Rollback of this level)',
    accepts: ['failed_hosts'],
    palette: true,
  },
  'notify-stop': {
    id: 'notify-stop',
    label: 'Notify on-call and stop',
    hint: 'Open a ticket, page on-call, end these hosts as stopped',
    accepts: ['failed_hosts', 'unreachable', 'timeout', 'rejected'],
    palette: true,
  },
  retry: {
    id: 'retry',
    label: 'Retry with backoff',
    hint: 'Run the step again for these hosts, then rejoin the happy path',
    accepts: ['failed_hosts', 'unreachable', 'timeout'],
    types: ['task', 'subflow'],
    palette: true,
  },
  exclude: {
    id: 'exclude',
    label: 'Exclude and report',
    hint: 'Take these hosts out of the run and list them in the report',
    accepts: ['failed_hosts', 'unreachable'],
    palette: true,
  },
  stop: {
    id: 'stop',
    label: 'Stop flow',
    hint: 'End these hosts with a failed outcome',
    accepts: ['failed_hosts', 'unreachable', 'timeout', 'rejected'],
    palette: false,
  },
  done: {
    id: 'done',
    label: 'Connect to Done',
    hint: 'End these hosts with a success outcome',
    accepts: ['ok_hosts', 'unchanged', 'approved', 'true', 'false'],
    palette: false,
  },
  escalate: {
    id: 'escalate',
    label: 'Escalate approval',
    hint: 'Ask the next approver; approved hosts rejoin the happy path',
    accepts: ['rejected', 'timeout'],
    types: ['approval'],
    palette: false,
  },
  report: {
    id: 'report',
    label: 'Send run report',
    hint: 'Send per-host results after the step, whatever the outcome',
    accepts: ['always'],
    palette: false,
  },
};

/** True if the pattern can be attached to this port of this node. */
export function patternFits(id: PatternId, node: Pick<FlowNode, 'type'>, port: string): boolean {
  const spec = PATTERNS[id];
  if (spec.types && !spec.types.includes(node.type)) return false;
  return (
    spec.accepts.includes(port) ||
    (spec.accepts.includes('ok_hosts') && /^branch_[0-9]+$/.test(port))
  );
}

export interface NodeRecipe {
  type: NodeType;
  title: string;
  intent?: string;
  handler?: HandlerKind;
  settings?: NodeSettings;
}

export interface EndRecipe {
  outcome: 'success' | 'failed';
  title: string;
  /** Keys of end nodes to reuse, best first; otherwise a new end is made. */
  prefer: readonly string[];
  /** Ports wired to the end: of the handler node, or the source port itself (`source`). */
  from: readonly string[];
}

export interface Recipe {
  /** Handler node wired from the source port; omitted when the source wires straight to the end. */
  node?: NodeRecipe;
  /** Existing node the source port is wired to instead of creating `node` (e.g. the Rollback). */
  reuse?: FlowNode;
  end?: EndRecipe;
  /** Wire this port of the handler to where the source node's `sourcePort` leads. */
  rejoin?: { port: string; sourcePort: string };
}

// An end is reused only by key: a stop or a failed rollback must not land in "Rolled back" or
// "Not approved" just because that end also has outcome failed (AFD-21).
const FAILED_END = { outcome: 'failed' } as const;

/** A rollback handler: marked `handler: rollback`, or keyed `rollback` as in flows predating the marker. */
export function isRollback(node: FlowNode | undefined): boolean {
  return node?.type === 'task' && (node.handler === 'rollback' || node.key === 'rollback');
}

/** Rollback handler of a level (D-11: one per level walks the undo chain). */
export function findRollback(level: Level, except?: string): FlowNode | undefined {
  return level.nodes.find((n) => n?.id !== except && isRollback(n));
}

export function recipeFor(id: PatternId, source: FlowNode, port: string, level: Level): Recipe {
  const what = `${source.title} · ${port}`;
  switch (id) {
    case 'rollback': {
      const existing = findRollback(level, source.id);
      if (existing) return { reuse: existing };
      return {
        node: {
          type: 'task',
          title: 'Rollback',
          handler: 'rollback',
          intent: 'Run the undo of completed nodes in reverse order, failed hosts only',
        },
        end: { ...FAILED_END, title: 'Failed', prefer: ['failed'], from: ['ok_hosts'] },
      };
    }
    case 'notify-stop':
      return {
        node: {
          type: 'task',
          title: port === 'rejected' ? 'Notify requester' : 'Notify on-call',
          handler: 'notify',
          intent: `Open a ticket and notify ${port === 'rejected' ? 'the requester' : 'on-call'} with the hosts from ${what}`,
        },
        end: {
          ...FAILED_END,
          title: 'Stopped',
          prefer: ['stopped', 'failed'],
          from: ['ok_hosts', 'failed_hosts'],
        },
      };
    case 'exclude':
      return {
        node: {
          type: 'task',
          title: 'Exclude and report',
          handler: 'exclude',
          intent: `Take the hosts from ${what} out of this run and list them in the run report`,
        },
        end: {
          outcome: 'failed',
          title: 'Excluded',
          prefer: ['excluded'],
          from: ['ok_hosts', 'failed_hosts'],
        },
      };
    case 'retry':
      return {
        node: {
          type: 'task',
          title: `Retry ${source.title}`,
          handler: 'retry',
          intent: `Run ${source.title} again for the ${port} hosts, with backoff between attempts`,
          settings: { retries: 3 },
        },
        rejoin: { port: 'ok_hosts', sourcePort: 'ok_hosts' },
      };
    case 'stop':
      return {
        end: { ...FAILED_END, title: 'Stopped', prefer: ['stopped', 'failed'], from: ['source'] },
      };
    case 'done':
      return {
        end: {
          outcome: 'success',
          title: 'Done',
          prefer: ['done'],
          from: ['source'],
        },
      };
    case 'escalate':
      return {
        node: {
          type: 'approval',
          title: 'Escalated approval',
          intent: `Ask the next approver when ${what}`,
        },
        rejoin: { port: 'approved', sourcePort: 'approved' },
        end: { ...FAILED_END, title: 'Stopped', prefer: ['stopped', 'failed'], from: ['rejected'] },
      };
    case 'report':
      return {
        node: {
          type: 'task',
          title: 'Send run report',
          handler: 'notify',
          intent: `Send the per-host results of ${source.title}`,
        },
      };
  }
}

/** End node of the level a recipe reuses, if any. */
export function findEnd(level: Level, end: EndRecipe): FlowNode | undefined {
  const ends = level.nodes.filter(
    (n): n is FlowNode => n?.type === 'end' && (n.outcome ?? 'success') === end.outcome,
  );
  for (const key of end.prefer) {
    const hit = ends.find((n) => n.key === key);
    if (hit) return hit;
  }
  return undefined;
}

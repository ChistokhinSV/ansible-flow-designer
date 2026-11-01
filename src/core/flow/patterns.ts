// Failure patterns (D-16) and the other ready-made port resolutions of the port menu (04 §3).
// A pattern is a recipe: an optional handler node wired from the source port, plus wires to an
// end node (reused when the level has one with a key the pattern names, AFD-21) and back to the
// happy path. The command
// layer turns a recipe into one WorkspaceEdit; code templates per pattern arrive with M3 codegen.

import { purposeOf } from './format';
import type { Level } from './model';
import { isFailPort } from './ports';
import type { FlowNode, HandlerKind, ImplBinding, NodeSettings, NodeType } from './types';

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
  /** Only for steps bound this way, or not bound yet (default: any binding). */
  bindings?: readonly ImplBinding['kind'][];
  /** Offered in the palette's failure pattern group. */
  palette: boolean;
}

export const PATTERNS: Record<PatternId, PatternSpec> = {
  rollback: {
    id: 'rollback',
    label: 'Rollback from Backup',
    hint: 'Undo the completed nodes for the failed hosts only (reuses the Rollback of this level)',
    accepts: ['failed_hosts'],
    palette: true,
  },
  'notify-stop': {
    id: 'notify-stop',
    label: 'Notify On-Call and Stop',
    hint: 'Open a ticket, page on-call, end these hosts as stopped',
    accepts: ['failed_hosts', 'unreachable', 'timeout', 'rejected'],
    palette: true,
  },
  // AFD-52: the step's own task tries again (settings.retries), so the code does what the flow
  // shows. Ansible retries a module task; a role, a playbook, a subflow or an unreachable host
  // cannot be retried that way, so the pattern is not offered there.
  retry: {
    id: 'retry',
    label: 'Retry',
    hint: 'Try the step again, up to 3 more times 10 s apart, before hosts leave by this port',
    accepts: ['failed_hosts', 'timeout'],
    types: ['task'],
    bindings: ['module'],
    palette: true,
  },
  exclude: {
    id: 'exclude',
    label: 'Exclude and Report',
    hint: 'Take these hosts out of the run and list them in the report',
    accepts: ['failed_hosts', 'unreachable'],
    palette: true,
  },
  stop: {
    id: 'stop',
    label: 'Stop Flow',
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
    label: 'Escalate Approval',
    hint: 'Ask the next approver; approved hosts rejoin the happy path',
    accepts: ['rejected', 'timeout'],
    types: ['approval'],
    palette: false,
  },
  report: {
    id: 'report',
    label: 'Send Run Report',
    hint: 'Send per-host results after the step, whatever the outcome',
    accepts: ['always'],
    palette: false,
  },
};

/** True if the pattern can be attached to this port of this node. */
export function patternFits(
  id: PatternId,
  node: Pick<FlowNode, 'type' | 'impl'>,
  port: string,
): boolean {
  const spec = PATTERNS[id];
  if (spec.types && !spec.types.includes(node.type)) return false;
  if (spec.bindings && node.impl && !spec.bindings.includes(node.impl.kind)) return false;
  return (
    spec.accepts.includes(port) ||
    (spec.accepts.includes('ok_hosts') && /^branch_[0-9]+$/.test(port))
  );
}

export interface NodeRecipe {
  type: NodeType;
  title: string;
  intent?: string;
  purpose?: HandlerKind;
  settings?: NodeSettings;
  impl?: ImplBinding;
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
  /** Settings the source step gets instead of a new node; those it has already stay. */
  source?: NodeSettings;
  /** The new node is a subflow running these steps in a chain (AFD-54: Rollback's undo steps). */
  steps?: NodeRecipe[];
}

// An end is reused only by key: a stop or a failed rollback must not land in "Rolled back" or
// "Not approved" just because that end also has outcome failed (AFD-21).
const FAILED_END = { outcome: 'failed' } as const;

/**
 * A rollback handler: marked `purpose: rollback` (format 1 `handler: rollback`), or keyed
 * `rollback` as in flows predating the marker.
 */
export function isRollback(node: FlowNode | undefined): boolean {
  return (
    (node?.type === 'task' || node?.type === 'subflow') &&
    (purposeOf(node) === 'rollback' || node.key === 'rollback')
  );
}

/**
 * What a Rollback from `source` undoes, newest first (AFD-54): the source itself (it may have
 * changed part of a host) and the steps the hosts passed on this level before it, each bound to
 * that step's `undo` binding when it has one, else a step to build.
 */
function undoSteps(level: Level, source: FlowNode): NodeRecipe[] {
  const byId = new Map(level.nodes.filter(Boolean).map((n) => [n.id, n]));
  const order = [source];
  const seen = new Set([source.id]);
  for (let i = 0; i < order.length; i++) {
    const at = order[i]?.id;
    for (const e of level.edges) {
      if (e?.to?.node !== at || isFailPort(e.from?.port ?? '')) continue;
      const prev = byId.get(e.from.node);
      if (!prev || seen.has(prev.id)) continue;
      seen.add(prev.id);
      order.push(prev);
    }
  }
  return order
    .filter((n) => (n.type === 'task' || n.type === 'subflow') && !isRollback(n))
    .map((n) => ({
      type: 'task',
      title: `Undo ${n.title}`,
      intent: `Reverse ${n.title} for the failed hosts`,
      ...(n.undo?.ref ? { impl: n.undo } : {}),
    }));
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
      const steps = undoSteps(level, source);
      const end = { ...FAILED_END, title: 'Failed', prefer: ['failed'], from: ['ok_hosts'] };
      return {
        node: {
          type: steps.length > 0 ? 'subflow' : 'task',
          title: 'Rollback',
          purpose: 'rollback',
          intent: 'Undo the completed steps for the failed hosts only, newest first',
        },
        ...(steps.length > 0 ? { steps } : {}),
        end,
      };
    }
    case 'notify-stop':
      return {
        node: {
          type: 'task',
          title: port === 'rejected' ? 'Notify requester' : 'Notify on-call',
          purpose: 'notify',
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
          title: 'Exclude and Report',
          purpose: 'exclude',
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
      return { source: { retries: 3, delay: 10 } };
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
          purpose: 'notify',
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

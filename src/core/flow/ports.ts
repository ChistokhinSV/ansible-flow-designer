// Port catalog (handoff 03 + ADR-0004). This table is the spec for M1 acceptance check 3.
import type { FlowNode, NodeType } from './types';

export type PortDirection = 'in' | 'out';
/** D-12: top = control in, bottom = normal outcomes, right = problems, left = undo. */
export type PortSide = 'top' | 'bottom' | 'right' | 'left';
/** Color family of a port (04 visual language); resolved to theme tokens by the webview. */
export type PortTone =
  | 'neutral'
  | 'ok'
  | 'failed'
  | 'unreachable'
  | 'decision'
  | 'approval'
  | 'undo';

export interface PortSpec {
  name: string;
  direction: PortDirection;
  side: PortSide;
  tone: PortTone;
  /** Counts toward the open-port banner when unconnected (D-15). */
  fail: boolean;
  /** Enabled per node via `ports:` rather than present by default. */
  optional: boolean;
}

export const FAIL_PORTS: ReadonlySet<string> = new Set([
  'failed_hosts',
  'unreachable',
  'timeout',
  'rejected',
]);

const DEFAULTS: Record<Exclude<NodeType, 'parallel'>, readonly string[]> = {
  start: ['ok_hosts'],
  end: ['in'],
  task: ['in', 'ok_hosts', 'failed_hosts'],
  subflow: ['in', 'ok_hosts', 'failed_hosts'],
  decision: ['in', 'true', 'false'],
  approval: ['in', 'approved', 'rejected'],
  join: ['in', 'ok_hosts'],
};

const TASK_OPTIONAL = ['unreachable', 'unchanged', 'always', 'cancelled', 'timeout', 'undo'];

const OPTIONAL: Record<NodeType, readonly string[]> = {
  start: [],
  end: [],
  task: TASK_OPTIONAL,
  subflow: TASK_OPTIONAL,
  decision: [],
  approval: ['timeout'],
  parallel: [],
  join: ['failed_hosts'],
};

const BRANCH = /^branch_([0-9]+)$/;
export const DEFAULT_BRANCHES = 2;

export function branchCount(node: Pick<FlowNode, 'branches'>): number {
  return node.branches && node.branches >= 2 ? node.branches : DEFAULT_BRANCHES;
}

export function defaultPortNames(node: Pick<FlowNode, 'type' | 'branches'>): string[] {
  if (node.type === 'parallel') {
    const names = ['in'];
    for (let i = 1; i <= branchCount(node); i++) names.push(`branch_${i}`);
    return names;
  }
  return [...DEFAULTS[node.type]];
}

export function optionalPortNames(type: NodeType): readonly string[] {
  return OPTIONAL[type];
}

export function portDirection(name: string): PortDirection {
  return name === 'in' || name === 'undo' || name === 'join' ? 'in' : 'out';
}

export function isFailPort(name: string): boolean {
  return FAIL_PORTS.has(name);
}

function sideOf(name: string): PortSide {
  if (name === 'in' || name === 'join') return 'top';
  if (name === 'undo') return 'left';
  if (FAIL_PORTS.has(name) || name === 'cancelled') return 'right';
  return 'bottom';
}

function toneOf(name: string): PortTone {
  switch (name) {
    case 'ok_hosts':
      return 'ok';
    case 'failed_hosts':
      return 'failed';
    case 'unreachable':
    case 'timeout':
      return 'unreachable';
    case 'true':
    case 'false':
      return 'decision';
    case 'approved':
    case 'rejected':
      return 'approval';
    case 'undo':
      return 'undo';
    default:
      return 'neutral';
  }
}

export function portSpec(name: string, optional = false): PortSpec {
  return {
    name,
    direction: portDirection(name),
    side: sideOf(name),
    tone: toneOf(name),
    fail: FAIL_PORTS.has(name),
    optional,
  };
}

/**
 * Ports a node shows: type defaults plus the optional ports enabled in `ports:`.
 * Names in `ports:` that the type does not support are left out (the validator reports them).
 */
export function portsFor(node: Pick<FlowNode, 'type' | 'branches' | 'ports'>): PortSpec[] {
  const defaults = defaultPortNames(node);
  const allowed = OPTIONAL[node.type];
  const specs = defaults.map((name) => portSpec(name));
  for (const name of allowed) {
    if (node.ports?.includes(name) && !defaults.includes(name)) specs.push(portSpec(name, true));
  }
  return specs;
}

/** True if the node type can carry this port at all (default or optional). */
export function isPortLegal(node: Pick<FlowNode, 'type' | 'branches'>, name: string): boolean {
  if (node.type === 'parallel') {
    const m = BRANCH.exec(name);
    return name === 'in' || (m !== null && Number(m[1]) >= 1 && Number(m[1]) <= branchCount(node));
  }
  return DEFAULTS[node.type].includes(name) || OPTIONAL[node.type].includes(name);
}

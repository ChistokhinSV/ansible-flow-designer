// What the canvas writes on nodes and wires at rest (AFD-42): the sub-line under a node's title,
// and which wires carry their port name without being hovered or selected.
import { NODE_TYPE_LABEL } from '../export/details';
import { purposeOf } from '../flow/format';
import { keywordHint } from '../flow/keywords';
import type { FlowNode } from '../flow/types';

/** The normal path carries no label at rest: hosts that went on as planned. */
const QUIET_PORTS: ReadonlySet<string> = new Set(['ok_hosts', 'approved', 'in']);

/**
 * A wire leaving by this port is labelled at rest: a failure, a branch, a decision's answer, a
 * timeout, `always` or `unchanged`. The others show their label on hover or selection.
 */
export function labelledAtRest(port: string): boolean {
  return !QUIET_PORTS.has(port);
}

/** Under the title: the bound module or role, else what kind of node it is; a decision's test. */
export function subLine(node: FlowNode): string {
  if (node.type === 'decision') return node.condition ? `if ${node.condition}` : 'Decision';
  const what = node.impl?.ref ?? NODE_TYPE_LABEL[node.type];
  const shared = node.ref ? `shared v${node.ref.version}` : undefined;
  return [what, shared, purposeOf(node), keywordHint(node.impl)].filter(Boolean).join(' · ');
}

// A node's status as an icon (AFD-42): on the node with its stripe, and wherever a status is listed.
import type { NodeStatus } from '../../core/flow/types';

const ICON: Record<NodeStatus, string> = {
  draft: 'circle-large-outline',
  specified: 'circle-large-filled',
  implemented: 'pass',
  tested: 'verified-filled',
};

/** `label` false: the status is written next to it, so the icon stays out of the accessible name. */
export function StatusIcon({ status, label = true }: { status: NodeStatus; label?: boolean }) {
  const name = `Status: ${status}`;
  return (
    <span
      className={`afd-status-icon codicon codicon-${ICON[status]} status-${status}`}
      {...(label ? { role: 'img', 'aria-label': name, title: name } : { 'aria-hidden': true })}
    />
  );
}

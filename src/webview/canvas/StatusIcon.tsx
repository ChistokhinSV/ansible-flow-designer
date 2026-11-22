// A node's status as an icon (AFD-42): on the node with its stripe, and wherever a status is listed.
import type { NodeStatus } from '../../core/flow/types';

const ICON: Record<NodeStatus, string> = {
  draft: 'circle-large-outline',
  specified: 'circle-large-filled',
  implemented: 'pass',
  tested: 'verified-filled',
};

/** `label` false: the status is written next to it, so the icon stays out of the accessible name. */
export function StatusIcon({
  status,
  label = true,
  hurt = false,
  errors = false,
}: {
  status: NodeStatus;
  label?: boolean;
  /** AFS-147: the run shown failed hosts at this step: the mark is not green beside "1 failed". */
  hurt?: boolean;
  /** AFD-351: the step has errors: no green check beside them either. */
  errors?: boolean;
}) {
  const name = `Status: ${status}${hurt ? '. Hosts failed here in this run' : ''}${errors ? '. The step has errors' : ''}`;
  return (
    <span
      className={`afd-status-icon codicon codicon-${ICON[status]} status-${status}${hurt || errors ? ' run-hurt' : ''}`}
      {...(label ? { role: 'img', 'aria-label': name, title: name } : { 'aria-hidden': true })}
    />
  );
}

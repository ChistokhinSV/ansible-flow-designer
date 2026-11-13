// AFD-273: a node's approval in the run shown, whoever runs it: the run's own approvals (a server
// that runs segments), else its AWX workflow's. `label` is the word the source uses (AWX says
// "denied"); `status` is the same for every source.
import type { Ulid } from '../core/flow/types';
import type { RunApproval, RunView } from '../core/protocol';

export type ShownApproval = RunApproval & { label: string };

export function approvalOf(run: RunView | null | undefined, node: Ulid): ShownApproval | undefined {
  const own = run?.approvals?.[node];
  if (own) return { ...own, label: own.status };
  const awx = run?.awx?.approvals?.[node];
  if (!awx) return undefined;
  return {
    status: awx.status === 'denied' ? 'rejected' : awx.status,
    url: awx.url,
    label: awx.status,
  };
}

/** The run waits for a decision somewhere. */
export function waitsForApproval(run: RunView | null | undefined): boolean {
  const nodes = new Set([
    ...Object.keys(run?.approvals ?? {}),
    ...Object.keys(run?.awx?.approvals ?? {}),
  ]);
  return [...nodes].some((id) => approvalOf(run, id)?.status === 'waiting');
}

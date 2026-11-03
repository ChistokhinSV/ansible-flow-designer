// What a port means, in a newcomer's words (AFD-72): the canvas keeps the YAML names (ok_hosts,
// failed_hosts, ...), and the tooltips, the port menu, the Ports tab and the Legend explain them.
import type { NodeType } from '../flow/types';

const HINTS: Record<string, string> = {
  in: 'Hosts arrive here',
  ok_hosts: 'Hosts this step succeeded on continue here',
  failed_hosts: 'Hosts that failed this step continue here',
  unreachable: 'Hosts this step could not reach continue here',
  unchanged: 'Hosts this step succeeded on without changing anything continue here',
  always: 'Every host continues here after this step, whatever happened',
  timeout: 'Hosts that ran out of time continue here',
  true: 'Hosts the condition is true for continue here',
  false: 'Hosts the condition is false for continue here',
  approved: 'Hosts a person approved continue here',
  rejected: 'Hosts a person rejected continue here',
};

/** The port's meaning in one sentence; `type` picks the approval's own timeout. */
export function portHint(port: string, type?: NodeType): string | undefined {
  if (port === 'timeout' && type === 'approval')
    return 'Hosts with no answer in time continue here';
  if (port === 'failed_hosts' && type === 'join')
    return 'Hosts that failed on a branch continue here';
  if (/^branch_[0-9]+$/.test(port)) return 'Every host goes down each branch';
  return HINTS[port];
}

/** The Legend's port list: the ports a newcomer meets first. */
export const LEGEND_PORTS = ['in', 'ok_hosts', 'failed_hosts', 'unreachable', 'always'] as const;

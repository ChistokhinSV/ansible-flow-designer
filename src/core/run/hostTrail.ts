// AFD-381: the steps one host went through in a run, and the step it is paused at, for a page that
// picks a host (Ansible Flow Server's debug workbench, `highlightHost`). Pure.
import { type FlowModel, modelOf } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import { shownOn } from '../view/find';
import { arrivals, nodeHosts } from './view';

export interface HostTrail {
  /** The steps the host ran (start and end nodes it passed included), at any level. */
  ran: Ulid[];
  /** The step the live run holds the host at (before it, or after it at a failure pause). */
  at?: Ulid;
}

/** Where `host` went in `run`: the steps it ran and where it waits now. */
export function hostTrail(doc: FlowDocument, run: RunView | null, host: string): HostTrail {
  const s = run?.summary;
  const model = modelOf(doc);
  const ran: Ulid[] = [];
  if (s) {
    for (const { node } of model.nodes.values()) {
      const went =
        node.type === 'start'
          ? s.hosts.includes(host)
          : node.type === 'end' || node.type === 'approval'
            ? arrivals(model, s, node.id).includes(host) ||
              nodeHosts(s, node.id).some((r) => r.host === host)
            : nodeHosts(s, node.id).some((r) => r.host === host);
      if (went) ran.push(node.id);
    }
  }
  const p = run?.state === 'running' && !run.past ? run.step?.paused : undefined;
  const waits = !!p && (p.hosts.includes(host) || !!p.failed?.some((f) => f.host === host));
  return waits && p ? { ran, at: p.node } : { ran };
}

export type HostMark = 'at' | 'ran';

/**
 * How the nodes on `level` show the host's trail: `at` where it waits (or the subflow holding that
 * step), `ran` where it went (or a subflow holding such a step); a node left out it did not reach.
 */
export function hostMarks(
  model: FlowModel,
  trail: HostTrail,
  level: string,
): Record<Ulid, HostMark> {
  const out: Record<Ulid, HostMark> = {};
  for (const id of shownOn(model, trail.ran, level)) out[id] = 'ran';
  if (trail.at) for (const id of shownOn(model, [trail.at], level)) out[id] = 'at';
  return out;
}

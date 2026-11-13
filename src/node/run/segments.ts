// Runs of a flow with top-level approvals outside AWX (AFD-272, ADR-0016). The flow's code comes
// in segments (engine/optionA): `start` runs until the hosts reach an approval and carries the
// host sets in set_stats; after a decision `<gate>-approved` or `<gate>-rejected` restores them
// and goes on; `finish` runs the outcome when no host reached the gate. AWX chains them as a
// workflow; here they are chained step by step:
//
// - `segmentOutcome` reads what a segment's run ended with (its events): the host sets it
//   carried, and whether hosts wait at its gate.
// - `nextSegment` names the segment to run after a decision (or after an empty gate).
// - `segmentInputs` are the next segment's inputs: the run's, the carried sets, the decision.
// - `segmentsSummary` is the run as one: every segment's events, summarized with the flow's routes.
//
// A host that waits for a decision longer than a process should (a server that may restart)
// keeps the carried sets itself and calls these between processes. `runSegments` chains them in
// one call, with a `decide` that waits for each gate's decision.
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SegmentFile } from '../../core/engine/types';
import type { Ulid } from '../../core/flow/types';
import type { RunApproval, RunView } from '../../core/protocol';
import { type RunSummary, summarizeRun } from '../../core/run/events';
import { withoutBookkeeping } from '../awx/awxWorkflow';
import { runsDir } from './pastRuns';
import { type RunFlowHooks, type RunFlowRequest, runFlow } from './runFlow';

/** How a gate was decided. `timeout` takes the approval's timeout port (else rejected's). */
export type GateDecision = 'approved' | 'rejected' | 'timeout';

/** What a segment's run left for the next one. */
export interface SegmentOutcome {
  /** The set_stats data the segment carried (`afd_hostsets`, `afd_gate_empty`); empty if none. */
  carried: Record<string, unknown>;
  /** Hosts wait at the segment's gate: a decision is needed. */
  waiting: boolean;
  /** The gate had no host: the flow goes on with `finish`. */
  empty: boolean;
}

/** The carried data of a segment's run, from its events (the last stats event's `custom`). */
export function segmentOutcome(segment: SegmentFile, events: string): SegmentOutcome {
  let carried: Record<string, unknown> = {};
  for (const line of events.split('\n')) {
    if (!line.includes('"stats"')) continue;
    try {
      const e = JSON.parse(line) as { event?: string; custom?: Record<string, unknown> };
      if (e.event === 'stats' && e.custom) carried = e.custom;
    } catch {}
  }
  const empty = String(carried.afd_gate_empty).toLowerCase() === 'true';
  return { carried, waiting: !!segment.gate && !empty && 'afd_hostsets' in carried, empty };
}

/**
 * The segment after `from`: its approved or rejected continuation for a decision (a timeout runs
 * the rejected one, which then takes the timeout port), `finish` when nobody reached its gate.
 * Undefined when there is none: the run has ended.
 */
export function nextSegment(
  segments: SegmentFile[],
  from: string,
  decision: GateDecision | 'empty',
): SegmentFile | undefined {
  if (decision === 'empty') return segments.find((s) => s.finish);
  const outcome = decision === 'approved' ? 'approved' : 'rejected';
  return segments.find((s) => s.parent === from && s.entry?.outcome === outcome);
}

/** The inputs of the segment after a decision: the run's, the carried host sets, the decision. */
export function segmentInputs(
  inputs: Record<string, unknown>,
  carried: Record<string, unknown>,
  decision?: GateDecision,
): Record<string, unknown> {
  return { ...inputs, ...carried, ...(decision ? { afd_gate_outcome: decision } : {}) };
}

/** The run as one: the events of its segments in order, summarized with the flow's routes. */
export function segmentsSummary(
  events: string[],
  routes: Parameters<typeof summarizeRun>[1],
): RunSummary {
  // The plays that restore and carry host sets run on localhost outside any node.
  return withoutBookkeeping(summarizeRun(events.filter(Boolean).join('\n'), routes));
}

export interface SegmentsHooks extends RunFlowHooks {
  /**
   * The decision for the approval `gate`, when hosts wait there. Called with the run as it is
   * then (state `running`, the gate's approval `waiting`). Rejects to stop the run.
   */
  decide(gate: Ulid, run: RunView): Promise<{ decision: GateDecision } & Partial<RunApproval>>;
}

/**
 * Runs a flow with approval gates segment by segment in one call: each segment is a `runFlow` of
 * its playbook (folder `<id>-<n>`), each gate waits for `decide`. Reports the run as one (id
 * `request.id`), with its approvals; resolves with the finished run. Never rejects.
 */
export async function runSegments(
  request: RunFlowRequest,
  segments: SegmentFile[],
  hooks: SegmentsHooks,
): Promise<RunView> {
  const generated = request.playbook.slice(0, request.playbook.lastIndexOf('/') + 1);
  const approvals: Record<Ulid, RunApproval> = {};
  const events: string[] = [];
  let segment = segments.find((s) => s.name === 'start');
  let inputs = request.inputs;
  let last: RunView | undefined;
  /** The run as one, with what the segments that ended did. */
  const view = (run: RunView): RunView => ({
    ...run,
    id: request.id,
    summary: segmentsSummary(events, request.code.routes),
    ...(Object.keys(approvals).length ? { approvals: { ...approvals } } : {}),
  });
  for (let k = 0; segment; k++) {
    const current = segment;
    const id = `${request.id}-${k}`;
    const run = await runFlow(
      { ...request, id, playbook: `${generated}${current.file}`, inputs },
      {
        ...hooks,
        // While a segment runs: what the ones before did, and what this one does so far.
        report: (r) =>
          hooks.report({
            ...r,
            id: request.id,
            ...(r.summary ? { summary: mergeLive(events, r.summary, request.code.routes) } : {}),
            ...(Object.keys(approvals).length ? { approvals: { ...approvals } } : {}),
          }),
      },
    );
    last = run;
    const text = await readFile(
      join(runsDir(request.storage, request.doc.flow.id), id, 'events.jsonl'),
      'utf8',
    ).catch(() => '');
    events.push(text);
    if (run.state === 'error' && run.errorCode === 'cancelled') break;
    const outcome = segmentOutcome(current, text);
    if (!current.gate) break;
    if (outcome.empty) {
      segment = nextSegment(segments, current.name, 'empty');
      inputs = segmentInputs(request.inputs, outcome.carried);
      continue;
    }
    if (!outcome.waiting) break;
    approvals[current.gate] = { status: 'waiting' };
    const waiting = view({ ...run, state: 'running' });
    hooks.report(waiting);
    let decided: { decision: GateDecision } & Partial<RunApproval>;
    try {
      decided = await hooks.decide(current.gate, waiting);
    } catch {
      approvals[current.gate] = { status: 'waiting' };
      const stopped: RunView = view({
        ...run,
        state: 'error',
        error: 'Stopped while waiting for approval',
        errorCode: 'cancelled',
        finishedAt: new Date().toISOString(),
      });
      hooks.report(stopped);
      return stopped;
    }
    const { decision, ...said } = decided;
    approvals[current.gate] = {
      ...said,
      status:
        decision === 'approved' ? 'approved' : decision === 'timeout' ? 'timed out' : 'rejected',
    };
    segment = nextSegment(segments, current.name, decision);
    inputs = segmentInputs(request.inputs, outcome.carried, decision);
  }
  const done = view(
    last ?? {
      id: request.id,
      mode: request.mode,
      state: 'error',
      startedAt: request.startedAt,
      error: 'The flow has no start segment',
    },
  );
  hooks.report(done);
  return done;
}

/** A live segment's summary added to what the segments before it did. */
function mergeLive(
  before: string[],
  live: RunSummary,
  routes: Parameters<typeof summarizeRun>[1],
): RunSummary {
  if (before.length === 0) return withoutBookkeeping(live);
  const earlier = segmentsSummary(before, routes);
  const nodes: RunSummary['nodes'] = structuredClone(earlier.nodes);
  for (const [node, ports] of Object.entries(live.nodes))
    for (const [port, hosts] of Object.entries(ports)) {
      nodes[node] ??= {};
      const into = nodes[node] as Record<string, string[]>;
      into[port] = [...new Set([...(into[port] ?? []), ...hosts])];
    }
  return withoutBookkeeping({
    ...live,
    nodes,
    hosts: [...new Set([...earlier.hosts, ...live.hosts])],
    failures: [...earlier.failures, ...live.failures],
    outcome: { ...earlier.outcome, ...live.outcome },
    unreachable: [...new Set([...earlier.unreachable, ...live.unreachable])],
  });
}

// Reads the afd_events callback stream of a run and maps it back to flow nodes and ports through
// the routing groups of the generated code (AFD-4 acceptance 5; full Run mode is M7).
import type { Route } from '../engine/types';
import type { Ulid } from '../flow/types';

export interface RunFailure {
  host: string;
  node?: Ulid;
  task: string;
  msg?: string;
}

export interface RunSummary {
  /** Per node, per port: the hosts that left through it. */
  nodes: Record<Ulid, Record<string, string[]>>;
  /** Hosts the outcome play failed, with the reason (open port, failed end). */
  outcome: Record<string, string>;
  /** Failures that were not rescued into a port (the run stopped there or a host dropped out). */
  failures: RunFailure[];
  /** Hosts Ansible dropped as unreachable without a route (role nodes, ADR-0009). */
  unreachable: string[];
  hosts: string[];
  /** The outcome play never ran: the run stopped early (max_fail_percentage, an include error). */
  stoppedEarly: boolean;
}

interface Event {
  event?: string;
  status?: string;
  host?: string;
  task?: string;
  node?: string | null;
  name?: string;
  group?: string;
  added?: { host?: string; groups?: string[] | string };
  msg?: string;
  ignored?: boolean;
  hosts?: Record<string, unknown>;
}

export function summarizeRun(text: string, routes: Record<string, Route>): RunSummary {
  const nodes: RunSummary['nodes'] = {};
  const outcome: Record<string, string> = {};
  const failures: RunFailure[] = [];
  const unreachable = new Set<string>();
  const hosts = new Set<string>();
  const add = (group: string, host: string) => {
    const route = routes[group];
    if (!route) return;
    const ports = nodes[route.node] ?? {};
    nodes[route.node] = ports;
    const list = ports[route.port] ?? [];
    if (!list.includes(host)) list.push(host);
    ports[route.port] = list;
  };
  let outcomePlay = false;
  let sawOutcome = false;
  // A failure inside a block is followed by its rescue routing the host, and an unreachable module
  // result by the route to `unreachable`; only those without a later route for the same host in
  // the same play were lost.
  let pending: RunFailure[] = [];
  let lost = new Set<string>();
  const settle = () => {
    failures.push(...pending);
    for (const h of lost) unreachable.add(h);
    pending = [];
    lost = new Set();
  };
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Event;
    try {
      e = JSON.parse(line) as Event;
    } catch {
      continue;
    }
    if (e.event === 'play') {
      settle();
      outcomePlay = (e.name ?? '').endsWith('] Outcome');
      sawOutcome ||= outcomePlay;
      continue;
    }
    if (e.event !== 'result' || !e.host) continue;
    if (e.host !== 'localhost') hosts.add(e.host);
    if (e.status === 'ok' && e.group) {
      add(e.group, e.host);
      pending = pending.filter((f) => f.host !== e.host);
      lost.delete(e.host);
    }
    if (e.status === 'ok' && e.added?.host) {
      const groups = Array.isArray(e.added.groups) ? e.added.groups : [e.added.groups ?? ''];
      for (const g of groups) add(g, e.added.host);
    }
    if (e.status === 'unreachable') lost.add(e.host);
    if (e.status === 'failed' && !e.ignored) {
      if (outcomePlay) outcome[e.host] = e.msg ?? e.task ?? 'failed';
      else
        pending.push({ host: e.host, node: e.node ?? undefined, task: e.task ?? '', msg: e.msg });
    }
  }
  settle();
  for (const ports of Object.values(nodes)) for (const list of Object.values(ports)) list.sort();
  return {
    nodes,
    outcome,
    failures,
    unreachable: [...unreachable].sort(),
    hosts: [...hosts].sort(),
    stoppedEarly: !sawOutcome && failures.length > 0,
  };
}

// The scenario simulator (AFD-114, ADR-0032): where each host of a scenario goes, computed in a
// few milliseconds instead of an Ansible stub run of minutes. It runs the plan the generator
// records for a scenario build (`GenerateResult.plan`): the plays in run order with the groups each
// port routes into, the generator's own wiring, subflow exits and bubbling. Only how a play treats
// its hosts is here: the stub's forced outcomes, decisions, approvals, branches, joins,
// max_fail_percentage, inventory_target and the outcome play, as the generated YAML does them.
// The result is the RunSummary summarizeRun makes from a real run's events, so judge(), the canvas
// and the run panel read both the same way. Pure.
import { optionA } from '../engine/optionA';
import { resolvePattern } from '../engine/targets';
import type { GenerateResult, PlanStep } from '../engine/types';
import { idGaps } from '../flow/completeIds';
import type { FlowDocument, Ulid } from '../flow/types';
import type { RunFailure, RunProblem, RunSummary } from '../run/events';
import { type Inventory, matchHosts } from './hostPattern';
import {
  judge,
  type Scenario,
  type ScenarioResult,
  scenarioHosts,
  type Unsupported,
} from './scenarios';

export type { Unsupported };

export interface Simulation {
  summary?: RunSummary;
  error?: string;
  /** Empty when the simulation is what Ansible would do; otherwise it is a best effort. */
  needsAnsible: Unsupported[];
  /** The routing groups as the run left them, host lists in inventory order (tests, debugging). */
  groups?: Record<string, string[]>;
}

const builds = new WeakMap<FlowDocument, GenerateResult>();

/** The scenario build of a flow (every step its stub), once per document object. */
export function prepare(doc: FlowDocument): GenerateResult {
  let build = builds.get(doc);
  if (!build) {
    build = optionA.generate(doc, { source: 'scenario.flow.yaml', simulate: true, stubAll: true });
    builds.set(doc, build);
  }
  return build;
}

const JINJA = /\{\{|\{%/;
const PATTERN = /[*?![\]&~]/;

/** Text Ansible renders during a stub run: Jinja there can change what a step does. */
function jinjaText(doc: FlowDocument): Unsupported[] {
  const out: Unsupported[] = [];
  const walk = (nodes: FlowDocument['nodes'] = []) => {
    for (const n of nodes) {
      if (!n) continue;
      const defaults = Object.values(n.outputs ?? {}).map((f) => f?.default);
      if ([n.title, n.intent, ...defaults].some((t) => typeof t === 'string' && JINJA.test(t)))
        out.push({
          code: 'jinja-text',
          node: n.id,
          message: `"${n.title}" has Jinja in its title, intent or output defaults, which a stub run renders`,
        });
      walk(n.subflow?.nodes);
    }
  };
  walk(doc.nodes);
  return out;
}

/** What the generated scenario build does with this scenario, without running it. */
export function simulateRun(doc: FlowDocument, s: Omit<Scenario, 'expect' | 'name'>): Simulation {
  // Nodes and wires without IDs generate no plays (the run would be an empty playbook).
  if (idGaps(doc).length > 0)
    return { error: 'This flow was written by hand: Complete IDs first', needsAnsible: [] };
  const build = prepare(doc);
  const plan = build.plan;
  if (!build.ok || !plan)
    return { error: 'The flow does not generate: fix its errors first', needsAnsible: [] };
  const needs: Unsupported[] = jinjaText(doc);
  const targets = scenarioHosts(doc, { name: '', expect: {}, ...s });
  if (targets.some((h) => PATTERN.test(h)))
    needs.push({
      code: 'start-pattern',
      message: 'The hosts to run on include a pattern; the simulator reads host names',
    });
  const groupHosts = Object.values(s.groups ?? {}).flat();
  const inv: Inventory = {
    hosts: [...new Set([...targets, ...groupHosts])],
    groups: { afd_scenario: targets, ...(s.groups ?? {}) },
  };
  const startValue = plan.start ? s.inputs?.[plan.start] : undefined;
  const startPattern = Array.isArray(startValue) ? startValue.join(',') : String(startValue ?? '');
  const start = matchHosts(startPattern, inv) ?? targets;

  // Groups as Ansible keeps them (group_by), and the summary the events would give.
  const members = new Map<string, Set<string>>();
  const of = (group: string | undefined) =>
    group ? (members.get(group) ?? new Set<string>()) : new Set<string>();
  const nodes: RunSummary['nodes'] = {};
  const seen = new Set<string>();
  const failures: RunFailure[] = [];
  const problems: Record<Ulid, Record<string, RunProblem>> = {};
  const add = (group: string | undefined, host: string) => {
    if (!group) return;
    const set = members.get(group) ?? new Set<string>();
    set.add(host);
    members.set(group, set);
    const route = build.routes[group];
    if (!route) return;
    const ports = nodes[route.node] ?? {};
    nodes[route.node] = ports;
    const list = ports[route.port] ?? [];
    ports[route.port] = list;
    if (!list.includes(host)) list.push(host);
  };
  const problem = (at: Ulid, host: string, p: RunProblem) => {
    const byHost = problems[at] ?? {};
    problems[at] = byHost;
    byHost[host] ??= p;
  };
  // A list that is no list is a file error (checkScenarios); it forces nothing here.
  const forced = (step: PlanStep, outcome: string) => {
    const list = (s.force?.[step.key] as Record<string, unknown> | undefined)?.[outcome];
    return new Set(Array.isArray(list) ? (list as string[]) : []);
  };
  const keyOf = (step: PlanStep) => step.key.split('/').at(-1) as string;
  /** Every host of a play fails without rescue: Ansible stops the playbook there. */
  const abort = (step: PlanStep, hosts: string[], task: string, msg: (h: string) => string) => {
    for (const h of hosts) {
      failures.push({ host: h, node: step.attribute, task, msg: msg(h) });
      problem(step.attribute, h, { task, status: 'failed', msg: msg(h) });
    }
  };

  let aborted = false;
  for (const step of plan.steps) {
    const hosts = inv.hosts.filter((h) =>
      step.hosts.some((t) => ('start' in t ? start.includes(h) : of(t.group).has(h))),
    );
    if (hosts.length === 0) continue;
    for (const h of hosts) seen.add(h);
    const p = step.ports;
    switch (step.kind) {
      case 'task': {
        if (step.serial && step.maxFail)
          needs.push({
            code: 'serial-max-fail',
            node: step.node,
            message: `${step.label} has serial and max_fail_percentage: the limit is checked per batch`,
          });
        const failing = new Set([
          ...forced(step, 'failed'),
          ...(p.timeout ? forced(step, 'timeout') : []),
        ]);
        for (const h of hosts) {
          if (failing.has(h)) {
            problem(step.attribute, h, {
              task: `[${keyOf(step)}] TODO`,
              status: 'failed',
              msg: step.todo,
            });
            add(p.timeout && forced(step, 'timeout').has(h) ? p.timeout : p.failed_hosts, h);
          } else if (p.unreachable && forced(step, 'unreachable').has(h)) add(p.unreachable, h);
          else if (p.unchanged && forced(step, 'unchanged').has(h)) add(p.unchanged, h);
          else add(p.ok_hosts, h);
          if (p.always) add(p.always, h);
        }
        if (step.maxFail) {
          const { limit, groups } = step.maxFail;
          const count = groups.reduce((n, g) => n + of(g).size, 0);
          if (count * 100 > limit * hosts.length) {
            abort(
              step,
              hosts,
              `[${keyOf(step)}] max_fail_percentage ${limit} exceeded`,
              () => `Flow stopped at [${keyOf(step)}]: ${count} of ${hosts.length} hosts failed`,
            );
            aborted = true;
          }
        }
        break;
      }
      case 'decision': {
        const no = forced(step, 'false');
        for (const h of hosts) add(no.has(h) ? p.false : p.true, h);
        break;
      }
      case 'approval': {
        const pick = s.approvals?.[step.key] ?? 'approved';
        const allowed = ['approved', ...['rejected', 'timeout'].filter((x) => p[x])];
        if (!allowed.includes(pick)) {
          abort(
            step,
            hosts,
            `[${keyOf(step)}] afd_approvals outcome`,
            () => `afd_approvals['${step.key}'] must be one of ${allowed.join(', ')}`,
          );
          aborted = true;
          break;
        }
        const rejected = forced(step, 'rejected');
        const timedOut = forced(step, 'timeout');
        for (const h of hosts) {
          const port =
            p.rejected && pick === 'rejected'
              ? 'rejected'
              : p.timeout && pick === 'timeout'
                ? 'timeout'
                : p.rejected && rejected.has(h)
                  ? 'rejected'
                  : p.timeout && timedOut.has(h)
                    ? 'timeout'
                    : 'approved';
          add(p[port], h);
        }
        break;
      }
      case 'parallel':
        for (const [port, group] of Object.entries(p))
          if (port.startsWith('branch_')) for (const h of hosts) add(group, h);
        break;
      case 'join':
        for (const h of hosts) {
          const all = step.mode === 'any' || step.members.every((g) => of(g).has(h));
          if (all) add(p.ok_hosts, h);
          else if (p.failed_hosts) add(p.failed_hosts, h);
        }
        break;
      case 'target': {
        const resolved = resolvePattern(step.pattern, s.inputs ?? {});
        const matched = resolved === undefined ? undefined : matchHosts(resolved, inv);
        if (!matched)
          needs.push({
            code: 'target-pattern',
            node: step.node,
            message: `${step.label} runs on ${step.pattern}, a pattern the simulator cannot read`,
          });
        const target = matched ?? [];
        const failing = new Set([
          ...forced(step, 'failed'),
          ...(p.timeout ? forced(step, 'timeout') : []),
        ]);
        const done = new Set<string>();
        let timedOut = 0;
        for (const t of target) {
          seen.add(t);
          if (!failing.has(t)) done.add(t);
          else {
            problem(step.attribute, t, {
              task: `[${keyOf(step)}] TODO`,
              status: 'failed',
              msg: step.todo,
            });
            if (p.timeout && forced(step, 'timeout').has(t)) timedOut++;
          }
        }
        const missed = target.length - done.size;
        const failed =
          target.length === 0 ||
          (step.maxFail !== undefined ? missed * 100 > step.maxFail * target.length : missed > 0);
        const group = failed
          ? p.timeout && timedOut > 0
            ? p.timeout
            : p.failed_hosts
          : p.ok_hosts;
        for (const h of hosts) {
          add(group, h);
          if (p.always) add(p.always, h);
        }
        break;
      }
    }
    if (aborted) break;
  }

  const outcome: Record<string, string> = {};
  if (!aborted)
    for (const entry of plan.outcome)
      for (const g of entry.groups) for (const h of of(g)) outcome[h] ??= entry.msg;

  const sorted: RunSummary['nodes'] = {};
  for (const [node, ports] of Object.entries(nodes))
    sorted[node] = Object.fromEntries(
      Object.entries(ports).map(([port, list]) => [port, [...list].sort()]),
    );
  return {
    summary: {
      nodes: sorted,
      outcome,
      failures,
      unreachable: [],
      hosts: [...seen].sort(),
      stoppedEarly: aborted && failures.length > 0,
      timings: {},
      problems,
    },
    needsAnsible: dedupe(needs),
    groups: Object.fromEntries(
      [...members].map(([g, set]) => [g, inv.hosts.filter((h) => set.has(h))]),
    ),
  };
}

function dedupe(list: Unsupported[]): Unsupported[] {
  const keys = new Set<string>();
  return list.filter((u) => {
    const k = `${u.code}|${u.node ?? ''}`;
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });
}

/** A scenario judged on the simulation: pass or fail as the Ansible stub run would say. */
export function simulateScenario(doc: FlowDocument, s: Scenario): ScenarioResult {
  const sim = simulateRun(doc, s);
  return {
    ...judge(doc, s, sim.summary, sim.error),
    engine: 'simulated',
    ...(sim.needsAnsible.length ? { needsAnsible: sim.needsAnsible } : {}),
  };
}

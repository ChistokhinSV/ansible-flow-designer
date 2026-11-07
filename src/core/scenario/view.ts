// AFD-84 (wave 8 group E): a scenario's result on the canvas. Run mode reads a RunView, so a
// scenario becomes one (source `scenario`): the canvas shows where its hosts went, and an end node
// lists the hosts the scenario expected there against where they ended. Pure.

import { modelOf } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import { arrivals } from '../run/view';
import { byPath, DROPPED, type ScenarioResult } from './scenarios';

/**
 * Where a scenario's host is, in words (AFD-94: round 2, S9, the panel said `reported` and
 * `stopped`, the ends' keys): an end node's title, "<step>'s open <port>" for an output with no
 * wire, "dropped out of the run", or what the runner says ("not run"). Anything else as it is.
 */
export function endWords(doc: FlowDocument, where: string): string {
  if (where === DROPPED) return 'dropped out of the run';
  const nodes = byPath(doc);
  const node = nodes.get(where);
  if (node) return node.title || node.key;
  const dot = where.lastIndexOf('.');
  const step = dot > 0 ? nodes.get(where.slice(0, dot)) : undefined;
  if (step) return `${step.title || step.key}'s open ${where.slice(dot + 1)}`;
  return where;
}

/**
 * "lab-rt-14 ended at Stopped; the scenario expected Reported to NetOps": AFD-105, the one
 * wording of a miss in the panel, the notification, the log and JUnit. `keys` adds the key a
 * scenario file uses ("Stopped (stopped)"), for the log; without the flow, the keys as they are.
 */
export function missText(
  doc: FlowDocument | undefined,
  m: ScenarioResult['hosts'][number],
  keys = false,
): string {
  const say = (where: string) => {
    const words = doc ? endWords(doc, where) : where;
    return keys && words !== where ? `${words} (${where})` : words;
  };
  const ended =
    m.actual === DROPPED
      ? `${m.host} dropped out of the run`
      : m.actual === 'not run' || m.actual === 'no run'
        ? `${m.host} did not run`
        : `${m.host} ended at ${say(m.actual)}`;
  return `${ended}; the scenario expected ${say(m.expected)}`;
}

/** What each forced outcome does, in words. */
const FORCED_VERB: Record<string, string> = {
  failed: 'fail',
  unreachable: 'be unreachable',
  timeout: 'time out',
  unchanged: 'report no change',
  false: 'decide false',
};

type Forced = { host: string; step: string; outcome: string; port: string };

/**
 * AFD-105 (round 3: R8): a planted outcome in words, "the scenario forces Check the HA pair is in
 * sync to fail for it (force: failed), so it leaves by failed_hosts". The earlier "the scenario
 * fails it here" did not say what it meant.
 */
export function forcedText(doc: FlowDocument | undefined, f: Forced): string {
  const node = doc ? byPath(doc).get(f.step) : undefined;
  const title = node?.title || node?.key || f.step;
  return `the scenario forces ${title} to ${FORCED_VERB[f.outcome] ?? f.outcome} for it (force: ${f.outcome}), so it leaves by ${f.port}`;
}

/** What the scenario forced on `host` at the step with ID `node`, if anything. */
export function forcedAt(
  doc: FlowDocument,
  forced: readonly Forced[] | undefined,
  host: string,
  node: Ulid,
): Forced | undefined {
  if (!forced?.length) return undefined;
  const paths = byPath(doc);
  return forced.find((f) => f.host === host && paths.get(f.step)?.id === node);
}

/** A miss with its reason when the scenario planted one on that host: the panel's and log's line. */
export function missWhy(
  doc: FlowDocument | undefined,
  m: ScenarioResult['hosts'][number],
  forced: readonly Forced[] | undefined,
  keys = false,
): string {
  const why = (forced ?? []).filter((f) => f.host === m.host).map((f) => forcedText(doc, f));
  return `${missText(doc, m, keys)}${why.length ? `, because ${why.join(' and ')}` : ''}`;
}

/** The scenario as a run Run mode can show. */
export function scenarioRun(r: ScenarioResult, at: string): RunView {
  return {
    id: `scenario:${r.name}`,
    mode: 'check',
    state: r.summary ? 'done' : 'error',
    startedAt: at,
    finishedAt: at,
    source: 'scenario',
    rc: r.passed ? 0 : 2,
    ...(r.summary ? { summary: r.summary } : {}),
    ...(r.error ? { error: r.error } : {}),
    scenario: {
      name: r.name,
      passed: r.passed,
      hosts: r.hosts,
      ...(r.error ? { error: r.error } : {}),
      ...(r.forced?.length ? { forced: r.forced } : {}),
    },
  };
}

/** The hosts that did not end where the scenario expected them. */
export function scenarioMisses(r: Pick<ScenarioResult, 'hosts'>): ScenarioResult['hosts'] {
  return r.hosts.filter((h) => h.expected !== h.actual);
}

export interface EndRow {
  host: string;
  /** The scenario expected the host here. */
  expected: boolean;
  /** Where it ended (this end's name when it came here). */
  ended: string;
  ok: boolean;
}

/**
 * An end node in a scenario: every host the scenario expected here and every host that came
 * here, with where each was expected and where it ended.
 */
export function endRows(
  doc: FlowDocument,
  scenario: NonNullable<RunView['scenario']>,
  run: RunView,
  node: Ulid,
): EndRow[] {
  const names = new Set<string>();
  for (const [path, n] of byPath(doc)) if (n.id === node) names.add(path);
  const here = modelOf(doc).nodes.get(node)?.node.key;
  if (here) names.add(here);
  const came = new Set(run.summary ? arrivals(modelOf(doc), run.summary, node) : []);
  const rows = new Map<string, EndRow>();
  for (const h of scenario.hosts) {
    const expected = names.has(h.expected);
    if (!expected && !came.has(h.host)) continue;
    rows.set(h.host, {
      host: h.host,
      expected,
      ended: h.actual,
      ok: h.expected === h.actual,
    });
  }
  for (const host of came)
    if (!rows.has(host)) rows.set(host, { host, expected: false, ended: here ?? 'here', ok: true });
  return [...rows.values()].sort((a, b) => a.host.localeCompare(b.host));
}

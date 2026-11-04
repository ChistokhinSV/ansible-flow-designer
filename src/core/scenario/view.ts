// AFD-84 (wave 8 group E): a scenario's result on the canvas. Run mode reads a RunView, so a
// scenario becomes one (source `scenario`): the canvas shows where its hosts went, and an end node
// lists the hosts the scenario expected there against where they ended. Pure.

import { modelOf } from '../flow/model';
import type { FlowDocument, Ulid } from '../flow/types';
import type { RunView } from '../protocol';
import { arrivals } from '../run/view';
import { byPath, type ScenarioResult } from './scenarios';

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

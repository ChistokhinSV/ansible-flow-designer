// The live scenario check (AFD-115): a flow and its scenarios file, checked and simulated, with
// the last verdicts from Ansible and whether they still hold. The host runs it shortly after the
// flow or the file changes; the designer, Problems and the tools read the same answer. Pure.
import { canonical, fnv1a, routingDesign } from '../flow/semantic';
import type { FlowDocument } from '../flow/types';
import {
  blocking,
  checkScenarios,
  DROPPED,
  hostEnds,
  parseScenarios,
  type Scenario,
  type ScenarioProblem,
  type ScenarioResult,
  scenarioHosts,
} from './scenarios';
import { simulateRun, simulateScenario } from './simulate';

/** A verdict from a stub run in Ansible, kept with what it was made on. */
export interface StoredVerdict {
  result: ScenarioResult;
  /** When the run ran (ISO). */
  at: string;
  /** `routingDesign` of the flow it ran on. */
  design: string;
  /** `scenarioHash` of the scenario as it ran. */
  scenario: string;
}

export interface VerifiedVerdict extends StoredVerdict {
  /** The flow's routing or the scenario changed since the run. */
  stale: boolean;
}

export interface ScenarioCheck {
  /** The flow has a scenarios file. */
  file: boolean;
  /** The file does not read as scenarios. */
  error?: string;
  /** Errors and warnings in the file (scenario index -1: the file). */
  problems: ScenarioProblem[];
  /** The scenarios' names in file order. */
  names: string[];
  /** AFD-116: the scenarios as written, in file order (hosts, forced outcomes, approvals). */
  scenarios: Scenario[];
  /** Simulated verdicts, in file order; empty while the file has errors. */
  results: ScenarioResult[];
  /** The last verdict from Ansible per scenario name. */
  verified: Record<string, VerifiedVerdict>;
}

/** What a verdict is about: one scenario as written (key order does not count). */
export const scenarioHash = (s: Scenario) => fnv1a(JSON.stringify(canonical(s)));

/** A verdict to keep, made now on this flow and scenario. */
export function storedVerdict(
  doc: FlowDocument,
  s: Scenario,
  result: ScenarioResult,
  at: string,
): StoredVerdict {
  return { result, at, design: routingDesign(doc), scenario: scenarioHash(s) };
}

/** `text` undefined: there is no scenarios file. */
export function checkLive(
  doc: FlowDocument,
  text: string | undefined,
  stored: Record<string, StoredVerdict> = {},
): ScenarioCheck {
  if (text === undefined)
    return { file: false, problems: [], names: [], scenarios: [], results: [], verified: {} };
  const parsed = parseScenarios(text);
  if (!parsed.file)
    return {
      file: true,
      error: parsed.error ?? 'Not a scenarios file',
      problems: [],
      names: [],
      scenarios: [],
      results: [],
      verified: {},
    };
  const scenarios = parsed.file.scenarios.filter(
    (s): s is Scenario => !!s && typeof s === 'object',
  );
  const problems = checkScenarios(doc, parsed.file);
  const results = blocking(problems).length ? [] : scenarios.map((s) => simulateScenario(doc, s));
  const design = routingDesign(doc);
  const verified: Record<string, VerifiedVerdict> = {};
  for (const s of scenarios) {
    const v = stored[s.name];
    if (v)
      verified[s.name] = { ...v, stale: v.design !== design || v.scenario !== scenarioHash(s) };
  }
  return {
    file: true,
    problems,
    names: scenarios.map((s) => s.name),
    scenarios,
    results,
    verified,
  };
}

/**
 * Where the simulation sends each host of a scenario, as `expect` writes it (AFD-116): a new
 * scenario starts from them, and Accept New Ends writes them. Hosts it cannot place are left out.
 */
export function simulatedEnds(
  doc: FlowDocument,
  s: Omit<Scenario, 'expect'>,
): Record<string, string> {
  const sim = simulateRun(doc, s);
  if (!sim.summary) return {};
  const ends = hostEnds(doc, sim.summary);
  const out: Record<string, string> = {};
  // A host that dropped out of the run has no place an expectation can name.
  for (const h of scenarioHosts(doc, { ...s, expect: {} }))
    if (ends[h] && ends[h] !== DROPPED) out[h] = ends[h];
  return out;
}

/** One line for the flow's Problems and a status: how the scenarios stand. */
export function checkSummary(c: ScenarioCheck): string | undefined {
  if (!c.file) return undefined;
  if (c.error || blocking(c.problems).length) return 'Scenarios: the file does not fit the flow';
  const failing = c.results.filter((r) => !r.passed).length;
  if (c.results.length === 0) return 'Scenarios: none yet';
  return failing
    ? `Scenarios: ${failing} of ${c.results.length} failing (simulated)`
    : `Scenarios: ${c.results.length} pass (simulated)`;
}

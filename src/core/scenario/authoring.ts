// Scenarios authored on the canvas (AFD-116): what the top-bar chip says, each row of the
// Scenarios tab in words (titles, never keys), and what a step's menu needs to plant outcomes in
// the scenario being edited. Pure, so the webview renders it and tests read it without React.
import type { ScenarioMenu } from '../flow/canvasMenu';
import type { FlowDocument, Ulid } from '../flow/types';
import type { ScenarioCheck, VerifiedVerdict } from './live';
import {
  blocking,
  byPath,
  type Forced,
  type Scenario,
  type ScenarioResult,
  scenarioHosts,
  targetsInput,
} from './scenarios';
import { endWords, scenarioMisses } from './view';

export type ChipTone = 'none' | 'ok' | 'warn' | 'error';

/** The top bar's way in: how the scenarios stand, or an offer to add some. */
export function scenarioChip(check: ScenarioCheck | null): {
  label: string;
  tone: ChipTone;
  title: string;
} {
  if (!check?.file || check.names.length === 0)
    return {
      label: 'Add Scenarios',
      tone: 'none',
      title:
        'Say where each host must end when chosen steps fail, and check it as you change the flow',
    };
  if (check.error || blocking(check.problems).length)
    return {
      label: 'Scenarios · fix the file',
      tone: 'error',
      title: 'The scenarios file does not fit the flow: see the Scenarios tab or Problems',
    };
  const failing = check.results.filter((r) => !r.passed).length;
  if (failing)
    return {
      label: `Scenarios · ${failing} failing`,
      tone: 'warn',
      title: `${failing} of ${check.results.length} scenarios end elsewhere in the simulation`,
    };
  return {
    label: `Scenarios · ${check.results.length} pass`,
    tone: 'ok',
    title: 'Every scenario ends where it should in the simulation',
  };
}

export interface ScenarioRow {
  name: string;
  hosts: string[];
  /** The simulation's verdict; `error` when it could not tell. */
  verdict: 'pass' | 'fail' | 'error';
  /** "host-02 now ends at Stopped; expected Rolled back", one per host that moved. */
  misses: string[];
  error?: string;
  /** What the simulator does not model here: the verdict is a best effort. */
  bestEffort: string[];
  /** The last run in Ansible, and whether the flow or the scenario changed since. */
  verified?: Pick<VerifiedVerdict, 'at' | 'stale'> & { passed: boolean };
  /** What the scenario plants, in words: "Gate fails for h03". */
  planted: string[];
}

const OUTCOME_WORDS: Record<Forced, string> = {
  failed: 'fails',
  unreachable: 'is unreachable',
  timeout: 'times out',
  unchanged: 'changes nothing',
  false: 'takes false',
};

/** "Gate fails for h03", per forced step and outcome; approvals by their choice. */
export function plantedWords(doc: FlowDocument, s: Scenario): string[] {
  const nodes = byPath(doc);
  const title = (path: string) => nodes.get(path)?.title || path;
  const out: string[] = [];
  for (const [step, ports] of Object.entries(s.force ?? {}))
    for (const [outcome, hosts] of Object.entries(ports ?? {}))
      if (Array.isArray(hosts) && hosts.length)
        out.push(
          `${title(step)} ${OUTCOME_WORDS[outcome as Forced] ?? outcome} for ${hosts.join(', ')}`,
        );
  for (const [approval, pick] of Object.entries(s.approvals ?? {}))
    out.push(`${title(approval)} is ${pick === 'timeout' ? 'timed out' : pick}`);
  return out;
}

/** The Scenarios tab's rows, in file order. */
export function scenarioRows(doc: FlowDocument, check: ScenarioCheck): ScenarioRow[] {
  return check.scenarios.map((s, i) => {
    const r: ScenarioResult | undefined = check.results[i];
    const v = check.verified[s.name];
    return {
      name: s.name,
      hosts: scenarioHosts(doc, s),
      verdict: !r || r.error ? 'error' : r.passed ? 'pass' : 'fail',
      misses: r
        ? scenarioMisses(r).map(
            (m) =>
              `${m.host} now ${m.actual === 'not run' ? 'does not run' : `ends at ${endWords(doc, m.actual)}`}; expected ${endWords(doc, m.expected)}`,
          )
        : [],
      ...(r?.error ? { error: r.error } : {}),
      bestEffort: (r?.needsAnsible ?? []).map((u) => u.message),
      ...(v ? { verified: { at: v.at, stale: v.stale, passed: v.result.passed } } : {}),
      planted: plantedWords(doc, s),
    };
  });
}

/** What a step's menu needs to plant outcomes in the scenario being edited; undefined if gone. */
export function scenarioMenu(
  doc: FlowDocument,
  check: ScenarioCheck,
  name: string,
): ScenarioMenu | undefined {
  const s = check.scenarios.find((x) => x.name === name);
  if (!s) return undefined;
  const paths = new Map<Ulid, string>();
  for (const [path, node] of byPath(doc)) paths.set(node.id, path);
  return {
    name,
    hosts: scenarioHosts(doc, s),
    path: (node) => paths.get(node),
    forced: (step, outcome) => {
      const list = (s.force?.[step] as Record<string, unknown> | undefined)?.[outcome];
      return Array.isArray(list) ? (list as string[]) : [];
    },
    approval: (path) => s.approvals?.[path] ?? 'approved',
    expect: s.expect ?? {},
  };
}

/** A new scenario's name: "Scenario N", the first free one. */
export function nextScenarioName(check: ScenarioCheck | null): string {
  const taken = new Set(check?.names ?? []);
  let n = taken.size + 1;
  while (taken.has(`Scenario ${n}`)) n++;
  return `Scenario ${n}`;
}

/** host-01 … host-NN for a new scenario. */
export const newHosts = (count: number) =>
  Array.from(
    { length: Math.max(1, Math.min(count, 50)) },
    (_, i) => `host-${String(i + 1).padStart(2, '0')}`,
  );

/**
 * A new scenario: `count` hosts on the flow's targets input, and an example value for every other
 * required input, as the starter file has them. No expectations: the host writes the simulation's.
 */
export function newScenario(doc: FlowDocument, name: string, count: number): Scenario {
  const targets = targetsInput(doc) ?? 'devices';
  const inputs: Record<string, unknown> = { [targets]: newHosts(count) };
  for (const [input, f] of Object.entries(doc.flow.inputs ?? {}))
    if (input !== targets && f?.required)
      inputs[input] =
        f.default !== undefined
          ? f.default
          : f.type === 'integer'
            ? 1
            : f.type === 'boolean'
              ? false
              : f.type === 'host_list' || f.type === 'list'
                ? []
                : 'example';
  return { name, inputs, expect: {} };
}

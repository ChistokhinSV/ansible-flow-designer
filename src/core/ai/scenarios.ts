// The flow_scenarios tool (AFD-117): scenario tests for AI assistants, by key, as the designer's
// Scenarios tab does them by title: list and check them in the simulation, add, update and delete
// them (expectations from the simulation unless given), and verify them in Ansible where the host
// can. Answers name steps and ends by key with their titles, and never show IDs.
import type { FlowDocument } from '../flow/types';
import { planScenarioEdit, type ScenarioCommand, ScenarioEditError } from '../scenario/edit';
import { checkLive, type ScenarioCheck, simulatedEnds } from '../scenario/live';
import {
  blocking,
  checkScenarios,
  type Forced,
  type Scenario,
  type ScenarioResult,
  scenarioHosts,
  scenariosFileName,
  targetsInput,
} from '../scenario/scenarios';
import { endWords, scenarioMisses } from '../scenario/view';
import type { FlowIO, ToolResult } from './handlers';

export type ScenariosAction = 'list' | 'check' | 'add' | 'update' | 'delete' | 'verify';

export interface ScenariosInput {
  path?: string;
  action?: ScenariosAction;
  name?: string;
  rename?: string;
  hosts?: string[];
  inputs?: Record<string, unknown>;
  groups?: Record<string, string[]>;
  force?: Record<string, Partial<Record<Forced, string[]>>>;
  approvals?: Record<string, 'approved' | 'rejected' | 'timeout'>;
  expect?: Record<string, string>;
  accept_ends?: boolean;
  names?: string[];
}

const fail = (text: string): ToolResult => ({ text, isError: true });

/** `gate.failed_hosts (Gate's open failed_hosts)`: the key the file uses, and what a person reads. */
function where(doc: FlowDocument, at: string): string {
  const words = endWords(doc, at);
  return words === at ? at : `${at} (${words})`;
}

function planted(s: Scenario): string[] {
  const out: string[] = [];
  for (const [step, ports] of Object.entries(s.force ?? {}))
    for (const [outcome, hosts] of Object.entries(ports ?? {}))
      if (Array.isArray(hosts) && hosts.length)
        out.push(`${step} ${outcome} [${hosts.join(', ')}]`);
  for (const [approval, pick] of Object.entries(s.approvals ?? {}))
    out.push(`approval ${approval} ${pick}`);
  return out;
}

function resultLines(doc: FlowDocument, s: Scenario, r: ScenarioResult | undefined): string[] {
  const verdict = !r
    ? 'not simulated'
    : r.error
      ? `cannot tell: ${r.error}`
      : r.passed
        ? 'pass'
        : 'FAILS';
  const lines = [
    `- "${s.name}": ${verdict}. Hosts: ${scenarioHosts(doc, s).join(', ') || 'none'}.`,
  ];
  const plants = planted(s);
  if (plants.length) lines.push(`    Plants: ${plants.join('; ')}.`);
  for (const m of r ? scenarioMisses(r) : [])
    lines.push(
      `    ${m.host} ends at ${m.actual === 'not run' ? 'nothing (it did not run)' : where(doc, m.actual)}; expected ${where(doc, m.expected)}.`,
    );
  for (const u of r?.needsAnsible ?? [])
    lines.push(`    Best effort: ${u.message}. Verify it in Ansible (action verify).`);
  return lines;
}

/** The scenarios of a flow and how they stand, as a tool answer. */
export function describeScenarios(doc: FlowDocument, path: string, c: ScenarioCheck): string {
  const file = scenariosFileName(doc.flow.key);
  if (!c.file)
    return [
      `${path}: no scenarios yet (${file} next to the flow).`,
      'Add one with flow_scenarios action add: a name, hosts, and force to plant failures by step key (failed, unreachable, timeout, unchanged; false on a decision). Expectations default to where the simulation sends each host.',
    ].join('\n');
  if (c.error) return `${path}: ${file} does not read: ${c.error}`;
  const failing = c.results.filter((r) => !r.passed).length;
  const head =
    c.results.length || !blocking(c.problems).length
      ? `${c.scenarios.length} scenario(s) in ${file}: ${failing ? `${c.scenarios.length - failing} pass, ${failing} fail` : 'all pass'} (simulated)`
      : `${c.scenarios.length} scenario(s) in ${file}; not simulated while the file has errors`;
  const lines = [`${path}: ${head}.`];
  c.scenarios.forEach((s, i) => {
    lines.push(...resultLines(doc, s, c.results[i]));
    const v = c.verified[s.name];
    if (v)
      lines.push(
        `    Ansible: ${v.result.passed ? 'passed' : 'failed'} at ${v.at}${v.stale ? ' (out of date: the flow or the scenario changed since)' : ''}.`,
      );
  });
  if (c.problems.length) {
    lines.push('Problems in the file:');
    for (const p of c.problems) {
      const s = p.scenario >= 0 ? `"${c.names[p.scenario] ?? p.scenario}": ` : '';
      lines.push(`- ${p.severity === 'warning' ? 'warning' : 'error'}: ${s}${p.message}`);
    }
  }
  return lines.join('\n');
}

/** One line for flow_describe: how many scenarios, how they stand. */
export function scenariosLine(c: ScenarioCheck): string | undefined {
  if (!c.file) return undefined;
  if (c.error || (blocking(c.problems).length && !c.results.length))
    return 'Scenarios: the file does not fit the flow; flow_scenarios shows why.';
  const failing = c.results.filter((r) => !r.passed).length;
  return `Scenarios: ${c.scenarios.length} (${failing ? `${failing} failing` : 'all pass'}, simulated); flow_scenarios lists them.`;
}

/** What flow_validate adds: the file's problems and the scenarios the simulation fails. */
export function scenarioProblemLines(doc: FlowDocument, c: ScenarioCheck): string[] {
  if (!c.file) return [];
  const out: string[] = [];
  if (c.error) out.push(`- error scenarios: ${c.error}`);
  for (const p of c.problems) {
    const s = p.scenario >= 0 ? `"${c.names[p.scenario] ?? p.scenario}": ` : '';
    out.push(`- ${p.severity === 'warning' ? 'warning' : 'error'} scenarios: ${s}${p.message}`);
  }
  c.results.forEach((r, i) => {
    if (r.passed) return;
    const m = scenarioMisses(r)[0];
    out.push(
      `- warning scenario-miss: "${c.names[i]}" fails in the simulation${m ? `: ${m.host} ends at ${where(doc, m.actual)}, expected ${where(doc, m.expected)}` : r.error ? `: ${r.error}` : ''}. Fix the flow, or the scenario (flow_scenarios update, accept_ends: true).`,
    );
  });
  return out;
}

/** The scenario an add or update writes: the given fields over the old one. */
function scenarioOf(doc: FlowDocument, input: ScenariosInput, old?: Scenario): Scenario | string {
  const name = input.rename?.trim() || input.name?.trim() || old?.name;
  if (!name) return 'Give the scenario a name';
  const inputs: Record<string, unknown> = { ...(old?.inputs ?? {}), ...(input.inputs ?? {}) };
  const targets = targetsInput(doc);
  if (input.hosts) {
    if (!targets)
      return 'The flow has no host-list input for the hosts: add a flow input of type host_list';
    inputs[targets] = input.hosts;
  }
  const s: Scenario = {
    name,
    ...(Object.keys(inputs).length ? { inputs } : {}),
    ...((input.groups ?? old?.groups) ? { groups: input.groups ?? old?.groups } : {}),
    ...((input.force ?? old?.force) ? { force: input.force ?? old?.force } : {}),
    ...((input.approvals ?? old?.approvals)
      ? { approvals: input.approvals ?? old?.approvals }
      : {}),
    expect: input.expect ?? old?.expect ?? {},
  };
  for (const k of ['groups', 'force', 'approvals'] as const)
    if (s[k] && Object.keys(s[k] as object).length === 0) delete s[k];
  if (scenarioHosts(doc, s).length === 0)
    return `Give the hosts (hosts: [host-01, host-02]); they go on the flow input ${targets ?? '(none)'}`;
  // No expectations given (or asked anew): where the simulation sends each host now.
  if ((!old && !input.expect) || input.accept_ends) s.expect = simulatedEnds(doc, s);
  return s;
}

export async function scenariosTool(
  io: FlowIO,
  loaded: { path: string; doc: FlowDocument },
  input: ScenariosInput,
): Promise<ToolResult> {
  const { path, doc } = loaded;
  if (!io.readScenarios) return fail('Scenarios are not available here');
  const key = doc.flow?.key;
  if (!key) return fail(`${path}: the flow has no key`);
  const text = await io.readScenarios(path, key);
  const action = input.action ?? 'list';
  const current = checkLive(doc, text);
  if (action === 'list' || action === 'check')
    return { text: describeScenarios(doc, path, current) };
  if (action === 'verify') {
    if (!io.verifyScenarios)
      return fail('Verifying in Ansible is not available here; run Run Scenarios in VS Code');
    if (!current.file) return fail(describeScenarios(doc, path, current));
    const errors = blocking(current.problems);
    if (current.error || errors.length)
      return fail(
        `${path}: fix the scenarios file first.\n${describeScenarios(doc, path, current)}`,
      );
    const results = await io.verifyScenarios(path, input.names);
    if (typeof results === 'string') return fail(results);
    const lines = [
      `${path}: ${results.filter((r) => r.passed).length} of ${results.length} pass in Ansible (every step its stub).`,
    ];
    for (const r of results) {
      const s = current.scenarios.find((x) => x.name === r.name);
      if (s) lines.push(...resultLines(doc, s, r));
    }
    return { text: lines.join('\n') };
  }
  // Changes to the file.
  if (!io.writeScenarios) return fail('Scenarios cannot be written here');
  const name = input.name?.trim();
  let cmd: ScenarioCommand;
  if (action === 'add') {
    const s = scenarioOf(doc, { ...input, rename: undefined });
    if (typeof s === 'string') return fail(s);
    cmd = { kind: 'add', scenario: s };
  } else if (action === 'update' || action === 'delete') {
    if (!name) return fail('Name the scenario (name)');
    const old = current.scenarios.find((s) => s.name === name);
    if (!old)
      return fail(
        `No scenario "${name}". ${current.names.length ? `There are: ${current.names.map((n) => `"${n}"`).join(', ')}` : 'There are none yet.'}`,
      );
    if (action === 'delete') cmd = { kind: 'delete', name };
    else {
      const s = scenarioOf(doc, input, old);
      if (typeof s === 'string') return fail(s);
      cmd = { kind: 'replace', name, scenario: s };
    }
  } else return fail('action is one of list, check, add, update, delete, verify');
  // A scenario that does not fit the flow is not written: its problems come back instead.
  if (cmd.kind === 'add' || cmd.kind === 'replace') {
    const problems = blocking(checkScenarios(doc, { scenarios: [cmd.scenario] }));
    if (problems.length)
      return fail(
        `Not written; the scenario does not fit the flow:\n${problems.map((p) => `- ${p.message}`).join('\n')}`,
      );
  }
  let plan: ReturnType<typeof planScenarioEdit>;
  try {
    plan = planScenarioEdit(text, cmd, doc);
  } catch (e) {
    if (e instanceof ScenarioEditError) return fail(e.message);
    return fail(`${scenariosFileName(key)} does not read; fix it first`);
  }
  const notes = await io.writeScenarios(path, key, text, plan.text);
  const after = checkLive(doc, plan.text);
  const touched = cmd.kind === 'delete' ? undefined : cmd.scenario.name;
  const i = touched ? after.names.indexOf(touched) : -1;
  const done =
    cmd.kind === 'delete'
      ? `Deleted "${name}".`
      : [
          `${cmd.kind === 'add' ? 'Added' : 'Updated'} "${touched}"${plan.created ? ` (created ${scenariosFileName(key)})` : ''}:`,
          ...resultLines(doc, after.scenarios[i] as Scenario, after.results[i]),
          `    Expect: ${Object.entries((after.scenarios[i] as Scenario).expect ?? {})
            .map(([h, at]) => `${h} → ${where(doc, at)}`)
            .join(', ')}.`,
        ].join('\n');
  const total = after.results.filter((r) => !r.passed).length;
  return {
    text: [
      done,
      `${path}: ${after.scenarios.length} scenario(s), ${total ? `${total} failing` : 'all pass'} (simulated).`,
      ...notes,
    ].join('\n'),
  };
}

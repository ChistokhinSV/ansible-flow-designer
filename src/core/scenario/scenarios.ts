// Scenario tests (AFD-58): `<flow key>.scenarios.yaml` next to a flow says, per scenario, the run
// inputs, the outcomes to force on chosen hosts and steps, and where each host must end. A scenario
// runs the flow's SCENARIO build (every step as its stub, no binding runs) on local-connection
// hosts, and the run's routing events say where each host really ended. Pure: the host or the CLI
// writes the files and runs ansible-playbook.
import { parse } from 'yaml';
import { modelOf } from '../flow/model';
import { portsFor } from '../flow/ports';
import type { FlowDocument, FlowNode, Ulid } from '../flow/types';
import type { RunSummary } from '../run/events';
import { arrivals } from '../run/view';

/** Ports a scenario can send a host down at a step, by what `afd_simulate` understands. */
export const FORCEABLE = ['failed', 'unreachable', 'timeout', 'unchanged', 'false'] as const;
export type Forced = (typeof FORCEABLE)[number];

/** The port a forced outcome sends a host down. */
const PORT_OF: Record<Forced, string> = {
  failed: 'failed_hosts',
  unreachable: 'unreachable',
  timeout: 'timeout',
  unchanged: 'unchanged',
  false: 'false',
};

export interface Scenario {
  name: string;
  /** Run inputs; the flow's targets input lists the hosts. */
  inputs?: Record<string, unknown>;
  /** Inventory groups for patterns the flow uses besides the targets (inventory_target). */
  groups?: Record<string, string[]>;
  /** Per step (key, or path `sub/step` inside subflows): the hosts sent down each port. */
  force?: Record<string, Partial<Record<Forced, string[]>>>;
  /** Per approval key: the outcome a local run takes (default approved). */
  approvals?: Record<string, 'approved' | 'rejected'>;
  /** Per host: the end node it must reach (key or path), or `<step>.<port>` it must stop at. */
  expect: Record<string, string>;
}

export interface ScenarioFile {
  flow?: string;
  scenarios: Scenario[];
}

export interface ScenarioProblem {
  /** Index of the scenario, or -1 for the file. */
  scenario: number;
  /** YAML path inside the file, for the editor. */
  path: (string | number)[];
  message: string;
}

export const scenariosFileName = (flowKey: string) => `${flowKey}.scenarios.yaml`;

export function parseScenarios(text: string): { file?: ScenarioFile; error?: string } {
  let data: unknown;
  try {
    data = parse(text);
  } catch (e) {
    return { error: (e as Error).message };
  }
  const file = data as ScenarioFile | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.scenarios))
    return { error: 'A scenarios file has a `scenarios:` list' };
  return { file };
}

/** Node key paths (`sub/step` inside subflows) of a flow, by path. */
export function byPath(doc: FlowDocument): Map<string, FlowNode> {
  const model = modelOf(doc);
  const out = new Map<string, FlowNode>();
  const path = (id: Ulid): string => {
    const entry = model.nodes.get(id);
    if (!entry) return '';
    const up = model.nodes.get(entry.level);
    return up ? `${path(up.node.id)}/${entry.node.key}` : entry.node.key;
  };
  for (const { node } of model.nodes.values()) out.set(path(node.id), node);
  return out;
}

/** The flow input that lists the hosts a run targets. */
export function targetsInput(doc: FlowDocument): string | undefined {
  return Object.entries(doc.flow.inputs ?? {}).find(
    ([, f]) => f?.targets || f?.type === 'host_list',
  )?.[0];
}

/** The hosts a scenario runs on: the targets input's list. */
export function scenarioHosts(doc: FlowDocument, s: Scenario): string[] {
  const input = targetsInput(doc);
  const value = input ? s.inputs?.[input] : undefined;
  const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  return [...new Set(list.map((h) => String(h).trim()).filter(Boolean))];
}

/** What is wrong with a scenarios file for this flow: names, ports, hosts and ends that do not exist. */
export function checkScenarios(doc: FlowDocument, file: ScenarioFile): ScenarioProblem[] {
  const out: ScenarioProblem[] = [];
  const nodes = byPath(doc);
  const input = targetsInput(doc);
  if (file.flow && file.flow !== doc.flow.key)
    out.push({
      scenario: -1,
      path: ['flow'],
      message: `This file is for flow ${file.flow}; the flow next to it is ${doc.flow.key}`,
    });
  const names = new Set<string>();
  file.scenarios.forEach((s, i) => {
    const at = (...p: (string | number)[]) => ['scenarios', i, ...p];
    const add = (path: (string | number)[], message: string) =>
      out.push({ scenario: i, path, message });
    if (!s?.name) add(at(), 'A scenario needs a name');
    else if (names.has(s.name)) add(at('name'), `Two scenarios are called "${s.name}"`);
    names.add(s?.name);
    const hosts = scenarioHosts(doc, s);
    if (!input) add(at('inputs'), 'The flow has no targets input (a host_list) to list the hosts');
    else if (hosts.length === 0) add(at('inputs'), `Set inputs.${input} to the hosts to run on`);
    const known = new Set([...hosts, ...Object.values(s.groups ?? {}).flat()]);
    for (const [path, ports] of Object.entries(s.force ?? {})) {
      const node = nodes.get(path);
      if (!node) {
        add(at('force', path), `No step ${path}: use a key, or sub/step inside a subflow`);
        continue;
      }
      if (node.type === 'subflow' && node.subflow?.nodes?.length) {
        add(at('force', path), `${path} is a subflow with steps: force its steps (${path}/<step>)`);
        continue;
      }
      for (const [port, list] of Object.entries(ports ?? {})) {
        const name = PORT_OF[port as Forced];
        if (!name)
          add(at('force', path, port), `${port} cannot be forced: use ${FORCEABLE.join(', ')}`);
        else if (!portsFor(node).some((p) => p.name === name))
          add(
            at('force', path, port),
            node.type === 'decision' || port === 'false'
              ? `${path}: force false on a decision, failed on a step`
              : `${path} has no ${name} port: enable it, or force failed`,
          );
        for (const h of list ?? [])
          if (!known.has(h)) add(at('force', path, port), `${h} is not a host of this scenario`);
      }
    }
    for (const key of Object.keys(s.approvals ?? {}))
      if (nodes.get(key)?.type !== 'approval')
        add(at('approvals', key), `No approval ${key} on the top level`);
    if (!s.expect || Object.keys(s.expect).length === 0)
      add(at('expect'), 'Say where each host must end (expect: host: end key)');
    for (const [host, where] of Object.entries(s.expect ?? {})) {
      if (!hosts.includes(host)) add(at('expect', host), `${host} is not in inputs.${input}`);
      const dot = String(where).lastIndexOf('.');
      const end = nodes.get(String(where));
      if (end?.type === 'end') continue;
      const step = dot > 0 ? nodes.get(String(where).slice(0, dot)) : undefined;
      const port = String(where).slice(dot + 1);
      if (!step || !portsFor(step).some((p) => p.name === port && p.direction === 'out'))
        add(
          at('expect', host),
          `${where} is neither an end node nor a step's output port (<step>.<port>)`,
        );
    }
  });
  return out;
}

/** The extra vars of a scenario run: its inputs, the forced outcomes and the approvals. */
export function scenarioVars(s: Scenario): Record<string, unknown> {
  return {
    ...(s.inputs ?? {}),
    afd_simulate: s.force ?? {},
    ...(s.approvals ? { afd_approvals: s.approvals } : {}),
  };
}

/** An INI inventory of local-connection hosts: nothing leaves the machine the scenario runs on. */
export function scenarioInventory(doc: FlowDocument, s: Scenario): string {
  const line = (h: string) =>
    `${h} ansible_connection=local ansible_python_interpreter="{{ ansible_playbook_python }}"`;
  const hosts = scenarioHosts(doc, s);
  const out = ['[afd_scenario]', ...hosts.map(line), ''];
  for (const [group, members] of Object.entries(s.groups ?? {}))
    out.push(`[${group}]`, ...members.map(line), '');
  return out.join('\n');
}

/**
 * Where each host ended, as a scenario names it: the key path of the end node it reached, the
 * `<step>.<port>` it stopped at (an output without a wire), or `stopped` (dropped out of the run).
 */
export function hostEnds(doc: FlowDocument, s: RunSummary): Record<string, string> {
  const model = modelOf(doc);
  const paths = new Map([...byPath(doc)].map(([path, n]) => [n.id, path]));
  const out: Record<string, string> = {};
  for (const { node } of model.nodes.values())
    if (node.type === 'end')
      for (const h of arrivals(model, s, node.id)) out[h] ??= paths.get(node.id) ?? node.key;
  for (const [id, ports] of Object.entries(s.nodes)) {
    const entry = model.nodes.get(id);
    if (!entry) continue;
    const level = model.levels.get(entry.level);
    for (const [port, hosts] of Object.entries(ports)) {
      const wired = level?.edges.some((e) => e?.from?.node === id && e.from.port === port);
      // `always` runs beside the other outputs: a host does not stop there.
      if (wired || port === 'always') continue;
      for (const h of hosts) out[h] ??= `${paths.get(id) ?? entry.node.key}.${port}`;
    }
  }
  for (const h of s.hosts) out[h] ??= 'stopped';
  return out;
}

export interface ScenarioResult {
  name: string;
  passed: boolean;
  /** Per host: where it should and did end. */
  hosts: { host: string; expected: string; actual: string }[];
  /** Why the run itself failed to tell (the process error, no events). */
  error?: string;
  /** AFD-84: what the scenario's run did, for showing it on the canvas like a run. */
  summary?: RunSummary;
}

export function judge(
  doc: FlowDocument,
  s: Scenario,
  summary: RunSummary | undefined,
  error?: string,
): ScenarioResult {
  const ends = summary ? hostEnds(doc, summary) : {};
  const hosts = Object.entries(s.expect ?? {}).map(([host, expected]) => ({
    host,
    expected: String(expected),
    actual: ends[host] ?? (summary ? 'not run' : 'no run'),
  }));
  return {
    name: s.name,
    passed: !error && !!summary && hosts.every((h) => h.expected === h.actual),
    hosts,
    ...(error ? { error } : {}),
    ...(summary ? { summary } : {}),
  };
}

/** A starter file: every host reaches the first success end, with the flow's inputs filled in. */
export function scenarioTemplate(doc: FlowDocument): string {
  const targets = targetsInput(doc) ?? 'devices';
  const end =
    [...modelOf(doc).nodes.values()].find(
      (e) => e.level === 'root' && e.node.type === 'end' && e.node.outcome !== 'failed',
    )?.node.key ?? 'done';
  const inputs = Object.entries(doc.flow.inputs ?? {})
    .filter(([name, f]) => name !== targets && f?.required)
    .map(
      ([name, f]) =>
        `      ${name}: ${f?.default !== undefined ? JSON.stringify(f.default) : f?.type === 'integer' ? '1' : f?.type === 'boolean' ? 'false' : '"example"'}`,
    );
  return [
    `# Scenario tests for flow ${doc.flow.key} (AFD-58). Run them with Ansible Flow: Run Scenarios, or`,
    '# in CI with node afd-scenarios.js. Each scenario runs every step as its stub on local-connection',
    '# hosts (no binding runs, nothing leaves the machine), forces the outcomes you list, and checks',
    '# where each host ends: an end node, or <step>.<port> for an output nobody wired.',
    `flow: ${doc.flow.key}`,
    'scenarios:',
    '  - name: every host reaches the end',
    '    inputs:',
    `      ${targets}: [host-01, host-02]`,
    ...inputs,
    '    # force:',
    '    #   <step key, or subflow/step>:',
    '    #     failed: [host-02]',
    '    expect:',
    `      host-01: ${end}`,
    `      host-02: ${end}`,
    '',
  ].join('\n');
}

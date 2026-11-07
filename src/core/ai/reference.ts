// The flow reference for AI assistants (AFD-19), generated from the code that defines the format:
// schema descriptions, the port catalog, the patterns, the op specs and the problem codes. The
// flow_reference tool returns it, and `just gen-ai` writes it into the skill (a test keeps it fresh).
import schema from '../../../schema/flow.schema.json';
import { FINDING_CODES } from '../flow/findingCodes';
import { PATTERNS } from '../flow/patterns';
import { defaultPortNames, FAIL_PORTS, offeredPortNames, portDirection } from '../flow/ports';
import type { NodeType } from '../flow/types';
import { OP_SPECS } from './specs';

type Json = Record<string, unknown>;
const defs = schema.$defs as Record<string, Json>;

function typeOf(s: Json | undefined): string {
  if (!s) return 'any';
  if (typeof s.$ref === 'string') return s.$ref.replace('#/$defs/', '');
  if ('const' in s) return JSON.stringify(s.const);
  if (Array.isArray(s.enum)) return s.enum.map((v) => String(v)).join(' | ');
  if (Array.isArray(s.anyOf)) return (s.anyOf as Json[]).map(typeOf).join(' | ');
  if (s.type === 'array') return `list of ${typeOf(s.items as Json)}`;
  if (Array.isArray(s.type)) return s.type.join(' | ');
  if (s.type === 'object' && s.additionalProperties && typeof s.additionalProperties === 'object')
    return `map of ${typeOf(s.additionalProperties as Json)}`;
  return typeof s.type === 'string' ? s.type : 'any';
}

function fields(s: Json): string[] {
  const required = new Set((s.required as string[] | undefined) ?? []);
  return Object.entries((s.properties as Record<string, Json> | undefined) ?? {}).map(([name, p]) =>
    `- \`${name}\` (${typeOf(p)}${required.has(name) ? ', required' : ''}): ${p.description ?? ''}`.trimEnd(),
  );
}

function section(title: string, s: Json): string[] {
  return [
    `### ${title}`,
    '',
    ...(s.description ? [String(s.description), ''] : []),
    ...fields(s),
    '',
  ];
}

const props = (s: Json, name: string) => (s.properties as Record<string, Json>)[name] as Json;

const EXAMPLE = `schema_version: 2
flow:
  key: ntp-baseline
  name: NTP baseline
  version: 1
  inputs:
    devices: {type: host_list, required: true, targets: true}
nodes:
- {key: start, type: start, title: Start}
- {key: check-ntp, type: task, title: Check NTP, intent: Compare NTP servers with the standard}
- {key: done, type: end, title: Done, outcome: success}
edges:
- {from: {node: start, port: ok_hosts}, to: {node: check-ntp, port: in}}
- {from: {node: check-ntp, port: ok_hosts}, to: {node: done, port: in}}
decisions:
- {kind: open_on_purpose, node: check-ntp, port: failed_hosts, reason: Read-only check}`;

export function formatReference(): string {
  const root = schema as unknown as Json;
  const node = defs.node as Json;
  const subflow = props(node, 'subflow');
  const decision = props(root, 'decisions').items as Json;
  return [
    '## Flow file format',
    '',
    String(root.description),
    '',
    'A flow is one YAML file named `<key>.flow.yaml`. The top level has one start node where the hosts enter; a subflow node has an inner level that its hosts enter through `subflow.boundary.in` and leave through exits (`boundary.outputs`). Hosts travel along the wires. Nodes are named by key; IDs (ULIDs) are added by tools. When you write YAML by hand, leave every `id:` out and use keys in wires and references, then run Complete IDs (flow_complete_ids, or the quick fix in the editor).',
    '',
    '### Top level',
    '',
    ...fields(root),
    '',
    ...section('flow', props(root, 'flow')),
    ...section('Node (nodes[], subflow.nodes[])', node),
    ...section('settings', props(node, 'settings')),
    ...section('subflow', subflow),
    ...section('subflow.boundary', props(subflow, 'boundary')),
    ...section('Wire (edges[])', defs.edge as Json),
    ...section('Wire end (from, to)', defs.portref as Json),
    ...section('Subflow exit (boundary.outputs.<port>[])', defs.exitref as Json),
    ...section(
      'Input or output field (inputs.<name>, outputs.<name>)',
      (defs.contract as Json).additionalProperties as Json,
    ),
    ...section('Binding (impl, undo)', defs.impl as Json),
    ...section('Annotation (annotations[], subflow.annotations[])', defs.annotation as Json),
    ...section('Decision (decisions[])', decision),
    '### A small flow written by hand',
    '',
    '```yaml',
    EXAMPLE,
    '```',
    '',
  ].join('\n');
}

const TYPES: NodeType[] = [
  'start',
  'end',
  'task',
  'subflow',
  'decision',
  'approval',
  'parallel',
  'join',
];

const PORT_MEANING: Record<string, string> = {
  in: 'hosts enter',
  ok_hosts: 'hosts the step succeeded on',
  failed_hosts: 'hosts it failed on',
  unreachable: 'hosts that could not be reached',
  unchanged: 'hosts it succeeded on without changing anything',
  always: 'every host after the step, whatever the outcome',
  timeout: 'hosts that ran out of time (settings.timeout; approvals: no answer in time)',
  true: 'hosts the condition is true for',
  false: 'hosts it is false for',
  approved: 'hosts a person approved',
  rejected: 'hosts a person rejected',
  'branch_<n>': 'every host, once per branch (parallel)',
};

export function portsReference(): string {
  const rows = TYPES.map((t) => {
    const defaults = defaultPortNames({ type: t }).join(', ');
    const optional = offeredPortNames(t).join(', ') || '-';
    return `| ${t} | ${defaults} | ${optional} |`;
  });
  return [
    '## Ports',
    '',
    'Wires go from an output port to an input port (usually `in`) on the same level, one wire per output port. Optional ports must be enabled (enable_port) before they are wired. Parallel nodes have `branch_1..branch_n` (branches, default 2).',
    '',
    '| Node type | Ports | Optional ports |',
    '| --- | --- | --- |',
    ...rows,
    '',
    ...Object.entries(PORT_MEANING).map(
      ([p, m]) => `- \`${p}\` (${portDirection(p) === 'in' ? 'input' : 'output'}): ${m}`,
    ),
    '- `undo` and `cancelled` (older flows): never built; Upgrade Flow Format removes them and their wires. For undo steps, apply_pattern rollback.',
    '',
    `Fail ports (${[...FAIL_PORTS].join(', ')}) must be handled: wired (often with apply_pattern), or left open on purpose with a reason (leave_open). Unhandled fail ports are warnings; their hosts fail the run.`,
    '',
  ].join('\n');
}

export function patternsReference(): string {
  return [
    '## Failure patterns (apply_pattern)',
    '',
    '| Pattern | What it adds | Fits ports | Node types |',
    '| --- | --- | --- | --- |',
    ...Object.values(PATTERNS).map(
      (p) =>
        `| ${p.id} | ${p.label}: ${p.hint} | ${p.accepts.join(', ')} | ${p.types?.join(', ') ?? 'any'} |`,
    ),
    '',
  ].join('\n');
}

export function opsReference(): string {
  const out = [
    '## Edit ops (flow_edit)',
    '',
    'Ops run in order, all or nothing: when one fails nothing is written and the error names the op. Name nodes by key (`check-ntp`), steps inside a subflow by path (`fix-ntp/push-config`), ports as `node.port`. A node added earlier in the batch can be used by later ops.',
    '',
  ];
  for (const spec of OP_SPECS) {
    const required = new Set(spec.required);
    out.push(`### ${spec.op}`, '', spec.summary, '');
    for (const [name, p] of Object.entries(spec.properties))
      out.push(
        `- \`${name}\` (${typeOf(p)}${required.has(name) ? ', required' : ''}): ${p.description ?? ''}`.trimEnd(),
      );
    out.push('', '```json', JSON.stringify(spec.example), '```', '');
  }
  return out.join('\n');
}

export function problemsReference(): string {
  return [
    '## Problem codes',
    '',
    '| Code | Meaning | Fix |',
    '| --- | --- | --- |',
    ...Object.entries(FINDING_CODES).map(([code, c]) => `| ${code} | ${c.meaning} | ${c.fix} |`),
    '',
  ].join('\n');
}

/** AFD-117: scenario tests, for agents that write and check them with flow_scenarios. */
function scenariosReference(): string {
  return [
    '## Scenario tests',
    '',
    'A scenario says which hosts fail where and the end each host must reach. They live in `<flow key>.scenarios.yaml` next to the flow. The designer shows them in its Scenarios tab, and CI runs them with `node afd-scenarios.js`. flow_scenarios reads and writes them; it never edits the flow.',
    '',
    '- **Hosts:** any names (`host-01`). A run uses them on the local machine with every step as its stub (no module, role or playbook runs). They go on the flow input of type `host_list` (`targets: true`).',
    '- **force:** per step key (`subflow/step` inside a subflow), the hosts sent down a port:',
    '  - `failed` (to failed_hosts), and `unreachable`, `timeout` or `unchanged` when the step has that port;',
    '  - `false` on a decision. A decision sends every other host to true, because the steps that feed its condition are stubs;',
    '  - a subflow with steps is forced through its steps.',
    '- **approvals:** per approval key, `approved` (default), `rejected`, or `timeout` when it has that port, for the whole run.',
    '- **groups:** inventory groups for an `inventory_target` pattern.',
    '- **expect:** per host, the end node it reaches (key, or `subflow/end`), or `<step>.<port>` for an output with no wire, where the host stops. A wired port is no place to stop.',
    '',
    'How to work with them:',
    '',
    '1. `flow_scenarios` (list) shows each scenario, what it plants, and its verdict in the simulation, which works out where hosts go from the generated code in milliseconds. It also shows the last run in Ansible and whether it is out of date.',
    '2. `add` with a name, `hosts` and `force`. Leave `expect` out: it becomes where the simulation sends each host, so the scenario passes and guards that routing. Give `expect` when you know where hosts must end; if the scenario then fails, the flow does not do what it should.',
    '3. After changing the flow, `check`. A failing scenario is either a mistake in the flow (fix the flow) or a routing change you meant (`update` with `accept_ends: true`).',
    '4. `verify` runs them in Ansible, the verdict to trust. A scenario marked *best effort* uses what the simulator does not model: a host pattern, a regex or slice in an inventory_target, Jinja a stub run renders, or serial with max_fail_percentage.',
    '',
    'Renaming a step or moving steps into a subflow with flow_edit renames them in the scenarios file too. Deleting a step leaves its key there, and flow_validate names it.',
    '',
    '```yaml',
    'flow: edge-baseline',
    'scenarios:',
    '  - name: a failed push rolls back that switch only',
    '    inputs:',
    '      devices: [sw-01, sw-02]',
    '      site: lab',
    '    force:',
    '      push-baseline:',
    '        failed: [sw-02]',
    '    expect:',
    '      sw-01: done',
    '      sw-02: failed',
    '```',
    '',
  ].join('\n');
}

export type ReferenceTopic =
  | 'all'
  | 'format'
  | 'ports'
  | 'patterns'
  | 'ops'
  | 'problems'
  | 'scenarios';

export function reference(topic: ReferenceTopic = 'all'): string {
  const parts: Record<Exclude<ReferenceTopic, 'all'>, () => string> = {
    format: formatReference,
    ports: portsReference,
    patterns: patternsReference,
    ops: opsReference,
    problems: problemsReference,
    scenarios: scenariosReference,
  };
  if (topic !== 'all') return parts[topic]();
  return Object.values(parts)
    .map((f) => f())
    .join('\n');
}

const GENERATED =
  '<!-- Generated by `just gen-ai` from the flow schema and src/core. Do not edit. -->';

/** The skill's reference files: references/<name> -> text. */
export function referenceFiles(): Record<string, string> {
  return {
    'format.md': [
      GENERATED,
      '',
      '# Flow format reference',
      '',
      formatReference(),
      portsReference(),
      patternsReference(),
    ].join('\n'),
    'ops.md': [
      GENERATED,
      '',
      '# Edit ops and problems',
      '',
      opsReference(),
      problemsReference(),
    ].join('\n'),
    'scenarios.md': [
      GENERATED,
      '',
      '# Scenario tests',
      '',
      scenariosReference().replace(/^## Scenario tests\n\n/, ''),
    ].join('\n'),
  };
}

/** The user guide's generated reference pages (AFD-22): docs/guide/reference/<name> -> text. */
export function guideReferenceFiles(): Record<string, string> {
  return {
    'problems.md': [
      GENERATED,
      '',
      '# Problem codes',
      '',
      'Every problem the designer reports has a code. It shows in the Problems panel, in the banner, and in the answers of the AI flow tools. The message itself says which node and which name; this table says what the code means and how to fix it. Back to the [guide](../README.md).',
      '',
      problemsReference().replace(/^## Problem codes\n\n/, ''),
    ].join('\n'),
    'flow-format.md': [
      GENERATED,
      '',
      '# Flow file format',
      '',
      'A flow is one YAML file, `<key>.flow.yaml`. The designer writes it for you; this page is for reading it, editing it by hand ([hand-written YAML](../how-to/hand-written-yaml.md)) or reviewing a diff. The AI assistants read the same reference. Back to the [guide](../README.md).',
      '',
      formatReference(),
      portsReference(),
      patternsReference(),
    ].join('\n'),
  };
}

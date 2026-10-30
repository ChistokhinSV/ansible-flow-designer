// Tool and op specs for AI tools (AFD-19): one source for the MCP server, the Copilot tools in
// package.json (a test keeps them equal) and the generated ops reference. Field types come from the
// flow schema, inlined: some agents do not follow $ref in tool schemas.
import Ajv2020, { type ValidateFunction } from 'ajv/dist/2020';
import schema from '../../../schema/flow.schema.json';
import { PATTERN_IDS } from '../flow/patterns';

type Json = Record<string, unknown>;
const defs = schema.$defs as Record<string, Json>;
const nodeProps = (defs.node as { properties: Record<string, Json> }).properties;

/** A schema with `#/$defs/x` references replaced by the definitions (not recursive ones). */
function inline(s: unknown): unknown {
  if (Array.isArray(s)) return s.map(inline);
  if (!s || typeof s !== 'object') return s;
  const o = s as Json;
  if (typeof o.$ref === 'string') {
    const { $ref, ...rest } = o;
    const name = ($ref as string).replace('#/$defs/', '');
    return { ...(inline(defs[name]) as Json), ...rest };
  }
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, inline(v)]));
}

const field = (name: string, description?: string): Json => ({
  ...(inline(nodeProps[name]) as Json),
  ...(description ? { description } : {}),
});
const nullable = (s: Json): Json => {
  if (Array.isArray(s.enum)) return { ...s, enum: [...s.enum, null] };
  return { ...s, type: [...[s.type].flat(), 'null'] };
};
const SETTINGS = field('settings') as Json & { properties: Record<string, Json> };

const NODE = {
  type: 'string',
  description:
    'A node by key (check-ntp), or subflow/step for a step inside a subflow (fix-ntp/push-config).',
};
const PORT = {
  type: 'string',
  description: 'node.port, e.g. check-ntp.failed_hosts or fix-ntp/push-config.ok_hosts.',
};
const OUT = { ...PORT, description: `An output port: ${PORT.description}` };
const TARGET = {
  type: 'string',
  description: 'The node the wire goes to (its in port), or node.port for another input port.',
};
const CONTRACT_FIELD = inline(
  (defs.contract as { additionalProperties: Json }).additionalProperties,
) as Json;
const IMPL = inline(defs.impl) as Json;

export interface OpSpec {
  op: string;
  summary: string;
  properties: Record<string, Json>;
  required: string[];
  example: Json;
}

export const OP_SPECS: OpSpec[] = [
  {
    op: 'add_node',
    summary:
      'Add a node. after continues from an output port: a free port is wired to the new node, a wired one gets the node on its wire (so a chain grows: a new flow is start -> done). on_wire does the same for a wired port only, failed_to wires its failed_hosts. The key comes from the title unless given. Use in to add it inside a subflow.',
    properties: {
      type: {
        ...field('type'),
        enum: ['end', 'task', 'subflow', 'decision', 'approval', 'parallel', 'join'],
      },
      title: field('title'),
      key: field('key', 'Key of the new node; default: from the title. Must be new on its level.'),
      in: { ...NODE, description: 'Subflow whose inner level gets the node (default: top).' },
      after: {
        ...OUT,
        description:
          'Continue from this output port: wired to the new node, or the node goes on its wire when the port is wired already.',
      },
      on_wire: {
        ...OUT,
        description: 'Put the new node on the wire leaving this output port (between both ends).',
      },
      failed_to: { ...NODE, description: "Wire the new node's failed_hosts to this node." },
      intent: field('intent'),
      ports: field('ports'),
      handler: field('handler'),
      outcome: field('outcome', 'End nodes: success or failed.'),
      condition: field('condition', 'Decision nodes: Jinja expression evaluated per host.'),
      branches: field('branches'),
      join_mode: field('join_mode'),
      inputs: field('inputs'),
      outputs: field('outputs'),
      settings: field('settings'),
      impl: field('impl'),
    },
    required: ['type', 'title'],
    example: {
      op: 'add_node',
      type: 'task',
      title: 'Check NTP',
      on_wire: 'precheck.ok_hosts',
      intent: 'Compare the NTP servers with the standard',
    },
  },
  {
    op: 'update_node',
    summary:
      'Change fields of a node; null removes a field. A new key renames the node: from: references follow.',
    properties: {
      node: NODE,
      title: field('title'),
      key: field('key'),
      intent: nullable(field('intent')),
      status: {
        ...field('status'),
        enum: ['draft', 'specified', 'implemented'],
        description: 'draft, specified or implemented. tested is set by runs only.',
      },
      condition: nullable(field('condition')),
      outcome: nullable(field('outcome')),
      handler: nullable(field('handler')),
      join_mode: nullable(field('join_mode')),
      branches: nullable(field('branches')),
      settings: {
        ...SETTINGS,
        properties: Object.fromEntries(
          Object.entries(SETTINGS.properties).map(([k, v]) => [k, nullable(v)]),
        ),
        description: 'Settings to change; a null value removes that setting.',
      },
    },
    required: ['node'],
    example: { op: 'update_node', node: 'check-ntp', status: 'specified' },
  },
  {
    op: 'delete',
    summary:
      'Delete nodes (with their wires, inner steps and positions) and wires (named by the output port they leave).',
    properties: {
      nodes: { type: 'array', items: NODE, description: 'Nodes to delete.' },
      wires: {
        type: 'array',
        items: OUT,
        description: 'Wires to delete, by the output they leave.',
      },
    },
    required: [],
    example: { op: 'delete', nodes: ['old-check'], wires: ['precheck.failed_hosts'] },
  },
  {
    op: 'connect',
    summary: 'Wire an output port to a node. One wire per output: fan out with a parallel node.',
    properties: { from: OUT, to: TARGET },
    required: ['from', 'to'],
    example: { op: 'connect', from: 'check-ntp.ok_hosts', to: 'done' },
  },
  {
    op: 'disconnect',
    summary: 'Remove the wire leaving an output port.',
    properties: { from: OUT },
    required: ['from'],
    example: { op: 'disconnect', from: 'check-ntp.ok_hosts' },
  },
  {
    op: 'rewire',
    summary: 'Point the wire leaving an output port at another node.',
    properties: { from: OUT, to: TARGET },
    required: ['from', 'to'],
    example: { op: 'rewire', from: 'check-ntp.ok_hosts', to: 'report' },
  },
  {
    op: 'enable_port',
    summary:
      'Enable an optional port of a node (e.g. unreachable, timeout, always on a task) so it can be wired.',
    properties: { node: NODE, port: { type: 'string', description: 'The optional port.' } },
    required: ['node', 'port'],
    example: { op: 'enable_port', node: 'push-config', port: 'unreachable' },
  },
  {
    op: 'disable_port',
    summary: 'Disable an optional port; its wire is removed.',
    properties: { node: NODE, port: { type: 'string', description: 'The optional port.' } },
    required: ['node', 'port'],
    example: { op: 'disable_port', node: 'push-config', port: 'unreachable' },
  },
  {
    op: 'leave_open',
    summary:
      'Leave a fail port unwired on purpose, with a reason: its hosts fail the run and the open-port warning goes away.',
    properties: {
      at: { ...OUT, description: 'The fail port, e.g. check-ntp.failed_hosts.' },
      reason: { type: 'string', description: 'Why the port stays open (shown in reviews).' },
    },
    required: ['at', 'reason'],
    example: {
      op: 'leave_open',
      at: 'check-ntp.failed_hosts',
      reason: 'Read-only check; the report lists these hosts',
    },
  },
  {
    op: 'reopen',
    summary: 'Remove a leave_open decision.',
    properties: { at: PORT },
    required: ['at'],
    example: { op: 'reopen', at: 'check-ntp.failed_hosts' },
  },
  {
    op: 'apply_pattern',
    summary:
      'Handle an output with a ready-made pattern: adds the handler node and its wires (see the pattern list).',
    properties: {
      at: OUT,
      pattern: { enum: [...PATTERN_IDS], description: 'Which pattern (see the pattern list).' },
    },
    required: ['at', 'pattern'],
    example: { op: 'apply_pattern', at: 'push-config.failed_hosts', pattern: 'rollback' },
  },
  {
    op: 'set_io',
    summary:
      'Add, change, rename or remove (field: null) one input or output of a node, or of the flow (node: "flow").',
    properties: {
      node: { ...NODE, description: `${NODE.description} "flow" for the flow inputs.` },
      side: { enum: ['inputs', 'outputs'], description: 'inputs or outputs.' },
      name: { type: 'string', description: 'Field name (snake_case).' },
      field: {
        ...CONTRACT_FIELD,
        type: ['object', 'null'],
        description: 'The field; null removes it.',
      },
      rename: { type: 'string', description: 'New name for the field.' },
    },
    required: ['node', 'side', 'name', 'field'],
    example: {
      op: 'set_io',
      node: 'check-ntp',
      side: 'outputs',
      name: 'ntp_ok',
      field: { type: 'boolean', from: 'impl.register.ok' },
    },
  },
  {
    op: 'update_flow',
    summary: 'Change the flow header; null removes a field.',
    properties: {
      name: { type: 'string', description: 'Human name of the flow.' },
      key: { type: 'string', description: 'Key of the flow (names the generated playbook).' },
      goal: { type: ['string', 'null'], description: 'What the flow achieves, in a sentence.' },
      owner: { type: ['string', 'null'], description: 'Team or person responsible.' },
      maintenance_window: {
        type: ['string', 'null'],
        pattern: '^([0-9]+[smhd])+$',
        description:
          'Longest time the flow may take, as a duration: 4h, 2h30m, 45m (not a schedule or a sentence).',
      },
    },
    required: [],
    example: { op: 'update_flow', goal: 'Every router uses the standard NTP servers' },
  },
  {
    op: 'set_entry',
    summary: 'Set (or clear with null) the inner step that receives the hosts entering a subflow.',
    properties: {
      subflow: { ...NODE, description: 'The subflow node.' },
      node: { type: ['string', 'null'], description: 'Key of a step on its inner level.' },
    },
    required: ['subflow', 'node'],
    example: { op: 'set_entry', subflow: 'fix-ntp', node: 'push-config' },
  },
  {
    op: 'add_exit',
    summary: "Let an inner step's output leave the subflow through one of the subflow's ports.",
    properties: {
      from: { ...OUT, description: 'Inner output, e.g. fix-ntp/push-config.ok_hosts.' },
      port: { type: 'string', description: 'Port of the subflow node, e.g. ok_hosts.' },
      reason: { type: 'string', description: 'Optional note shown with the exit.' },
    },
    required: ['from', 'port'],
    example: { op: 'add_exit', from: 'fix-ntp/push-config.ok_hosts', port: 'ok_hosts' },
  },
  {
    op: 'remove_exit',
    summary: 'Remove a subflow exit.',
    properties: {
      from: { ...OUT, description: 'Inner output, e.g. fix-ntp/push-config.ok_hosts.' },
      port: { type: 'string', description: 'Port of the subflow node.' },
    },
    required: ['from', 'port'],
    example: { op: 'remove_exit', from: 'fix-ntp/push-config.ok_hosts', port: 'ok_hosts' },
  },
  {
    op: 'extract_subflow',
    summary:
      'Move connected nodes of one level into a new subflow node; wires across the edge become entry and exits.',
    properties: {
      nodes: { type: 'array', items: NODE, description: 'Nodes to move.' },
      title: field('title'),
      key: field('key', 'Key of the new subflow; default: from the title.'),
    },
    required: ['nodes', 'title'],
    example: {
      op: 'extract_subflow',
      nodes: ['backup', 'push-config', 'verify'],
      title: 'Fix NTP',
    },
  },
  {
    op: 'bind',
    summary:
      'Bind what the node runs (a module, role or playbook), or null for a TODO stub. Prefer modules the catalog knows.',
    properties: { node: NODE, impl: { ...IMPL, description: 'The binding; null removes it.' } },
    required: ['node', 'impl'],
    example: {
      op: 'bind',
      node: 'check-ntp',
      impl: {
        kind: 'module',
        ref: 'cisco.ios.ios_command',
        params: { commands: ['show ntp associations'] },
        register: 'ntp',
      },
    },
  },
  {
    op: 'tidy_up',
    summary: 'Lay out a level again (positions only).',
    properties: {
      level: { type: 'string', description: 'top (default), all, or a subflow key.' },
    },
    required: [],
    example: { op: 'tidy_up', level: 'top' },
  },
];

function opSchema(spec: OpSpec): Json {
  return {
    type: 'object',
    description: spec.summary,
    properties: { op: { const: spec.op }, ...spec.properties },
    required: ['op', ...spec.required],
    additionalProperties: false,
  };
}

const PATH = {
  type: 'string',
  description:
    'The flow file (*.flow.yaml), relative to the workspace root. Default: the flow open in the designer, or the only flow.',
};

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  inputSchema: Json;
}

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'flow_list',
    title: 'List flows',
    description:
      'List the Ansible flow files (*.flow.yaml) in the workspace with their name, version and problem counts.',
    readOnly: true,
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'flow_describe',
    title: 'Describe a flow',
    description:
      'Describe an Ansible flow by key: nodes, wires, subflows, open fail ports, problem counts and the revision to pass to flow_edit. Read this before editing.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        level: {
          type: 'string',
          description: 'all (default), top, or a subflow key to describe one level.',
        },
      },
    },
  },
  {
    name: 'flow_validate',
    title: 'Check a flow',
    description:
      'List the problems of a flow (errors, warnings, notes) by node key, each with how to fix it.',
    readOnly: true,
    inputSchema: { type: 'object', properties: { path: PATH } },
  },
  {
    name: 'flow_reference',
    title: 'Flow reference',
    description:
      'The flow format, the ports of each node type, the failure patterns, the edit ops and the problem codes.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          enum: ['all', 'format', 'ports', 'patterns', 'ops', 'problems'],
          description: 'Part to return (default all).',
        },
      },
    },
  },
  {
    name: 'flow_edit',
    title: 'Edit a flow',
    description:
      'Edit an Ansible flow with ops that name nodes by key (never IDs). The ops run in order, all or nothing; nodes added earlier in the batch can be used by later ops. Returns what changed, new problems and the new revision.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        ops: {
          type: 'array',
          minItems: 1,
          description: 'Ops in order; flow_reference topic ops lists them with examples.',
          items: { anyOf: OP_SPECS.map(opSchema) },
        },
        revision: {
          type: 'string',
          description:
            'Revision from flow_describe; the edit is refused when the file changed since.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Check the ops and show the result without writing.',
        },
      },
      required: ['ops'],
    },
  },
  {
    name: 'flow_new',
    title: 'New flow',
    description:
      'Create a new Ansible flow diagram: a *.flow.yaml file that Ansible Flow Designer draws and turns into playbooks. Use it whenever the user asks for an Ansible flow, flow diagram or automation flow, instead of drawing one in PlantUML, Mermaid or draw.io. The flow starts as start -> done with a devices host_list input; then add steps with flow_edit (add_node after start.ok_hosts puts the first step between them).',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'New file, relative to the workspace root, ending in .flow.yaml (e.g. flows/ntp-baseline/ntp-baseline.flow.yaml).',
        },
        name: { type: 'string', description: 'Human name of the flow.' },
        key: {
          type: 'string',
          description:
            'Key of the flow; default: the file name (ntp-baseline), else from the name.',
        },
        goal: { type: 'string', description: 'What the flow achieves, in a sentence.' },
      },
      required: ['path', 'name'],
    },
  },
  {
    name: 'flow_complete_ids',
    title: 'Complete IDs',
    description:
      'Add the IDs a hand-written flow lacks and turn node keys in wires and references into IDs, in one edit.',
    readOnly: false,
    inputSchema: { type: 'object', properties: { path: PATH } },
  },
];

const takesNull = (s: Json | undefined) =>
  !!s && ([s.type].flat().includes('null') || (Array.isArray(s.enum) && s.enum.includes(null)));

/**
 * Models often send null for an optional field they leave out ("failed_to": null): such a field
 * counts as not given, unless null means something for it (removing a field in update_node).
 */
export function dropNulls(ops: unknown): unknown {
  if (!Array.isArray(ops)) return ops;
  return ops.map((op) => {
    const spec = OP_SPECS.find((s) => s.op === (op as { op?: unknown })?.op);
    if (!spec || !op || typeof op !== 'object') return op;
    return Object.fromEntries(
      Object.entries(op).filter(([k, v]) => v !== null || takesNull(spec.properties[k] as Json)),
    );
  });
}

let validators: Map<string, ValidateFunction> | undefined;

/** Checks ops against their specs; messages name the op and the field. */
export function checkOps(ops: unknown): string[] {
  if (!Array.isArray(ops) || ops.length === 0) return ['ops must be a list of at least one op'];
  if (!validators) {
    const ajv = new Ajv2020({ allErrors: true, strict: false });
    validators = new Map(OP_SPECS.map((s) => [s.op, ajv.compile(opSchema(s))]));
  }
  const problems: string[] = [];
  for (const [i, op] of ops.entries()) {
    const name = (op as { op?: unknown })?.op;
    const v = typeof name === 'string' ? validators.get(name) : undefined;
    if (!v) {
      problems.push(
        `op ${i + 1}: unknown op ${JSON.stringify(name)}; ops: ${OP_SPECS.map((s) => s.op).join(', ')}`,
      );
      continue;
    }
    if (v(op)) continue;
    for (const e of v.errors ?? []) {
      const params = e.params as Record<string, unknown>;
      const where = e.instancePath ? e.instancePath.slice(1).replaceAll('/', '.') : '';
      const what =
        e.keyword === 'additionalProperties'
          ? `unknown field "${params.additionalProperty}"`
          : e.keyword === 'required'
            ? `missing field "${params.missingProperty}"`
            : e.keyword === 'enum'
              ? `must be one of ${(params.allowedValues as unknown[]).map((x) => JSON.stringify(x)).join(', ')}`
              : (e.message ?? 'invalid');
      problems.push(`op ${i + 1} (${name})${where ? ` ${where}` : ''}: ${what}`);
    }
  }
  return problems;
}

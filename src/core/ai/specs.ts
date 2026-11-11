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
/** How the canvas places nodes, for every op that can take a position (AFD-24). */
export const LAYOUT_RULES =
  'Positions are per level (the top level, or the inside of one subflow): x,y is the top-left corner of the node box in canvas pixels, y grows down; start and end nodes are 136x40, all others 208x76; flows read top-down. A node without a position is placed by the canvas (auto-layout next to its neighbours) until the first move or tidy_up stores it, so positions can be left out. Placing a node on a level that is still auto-laid out also stores where the canvas shows the others, so nothing else moves.';

const PLACE = {
  type: 'object',
  additionalProperties: false,
  description: `Where the node goes: {x, y}, or exactly one of below / above / right_of / left_of naming a node of the same level (key, or subflow/step), with an optional gap in pixels (default 56 below/above, 48 beside); a relative place steps aside until it is free. ${LAYOUT_RULES}`,
  properties: {
    x: { type: 'number', description: 'Left edge, canvas pixels.' },
    y: { type: 'number', description: 'Top edge, canvas pixels (y grows down).' },
    below: { type: 'string', description: 'Under this node, centred on it.' },
    above: { type: 'string', description: 'Over this node, centred on it.' },
    right_of: { type: 'string', description: 'Right of this node, level with it.' },
    left_of: { type: 'string', description: 'Left of this node, level with it.' },
    gap: { type: 'number', minimum: 0, description: 'Pixels between the two nodes.' },
  },
};
const placeOf = (what: string) => ({
  ...PLACE,
  description: `Where ${what} goes; leave it out for automatic placement. ${PLACE.description}`,
});

/** AFD-64: Notes, Sections and Text, with their field types from the schema. */
const ANNOTATION = inline(defs.annotation) as Json & { properties: Record<string, Json> };
const note = (name: string, description?: string): Json => ({
  ...(ANNOTATION.properties[name] as Json),
  ...(description ? { description } : {}),
});
const ANNOTATION_REF = {
  type: 'string',
  description:
    'An annotation by key path: note-1 on the top level, fix-ntp/note-1 inside subflow fix-ntp (flow_describe lists them).',
};
const ANNOTATION_PLACE = {
  ...PLACE,
  description: `Where it goes on the canvas: {x, y} (for a note on a node, still canvas pixels: the note keeps that distance to its node), or one of below / above / right_of / left_of naming a node of its level. Default: a note on a node right of it; anything else right of the level.`,
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
      purpose: field('purpose'),
      outcome: field('outcome', 'End nodes: success or failed.'),
      condition: field('condition', 'Decision nodes: Jinja expression evaluated per host.'),
      branches: field('branches'),
      join_mode: field('join_mode'),
      inputs: field('inputs'),
      outputs: field('outputs'),
      settings: field('settings'),
      impl: field('impl'),
      position: placeOf('the new node'),
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
        description:
          'Format 2: the status follows the node (inputs or outputs make it specified, a binding implemented); set here only the status the node already has, which clears tested. Format 1: draft, specified or implemented by hand. tested comes from a passing run only.',
      },
      condition: nullable(field('condition')),
      outcome: nullable(field('outcome')),
      purpose: nullable(field('purpose')),
      join_mode: nullable(field('join_mode')),
      branches: nullable(field('branches')),
      settings: {
        ...SETTINGS,
        properties: Object.fromEntries(
          Object.entries(SETTINGS.properties).map(([k, v]) => [k, nullable(v)]),
        ),
        description: 'Settings to change; a null value removes that setting.',
      },
      keywords: nullable({
        ...((IMPL as { properties: Record<string, Json> }).properties.keywords as Json),
        description:
          'Task keywords of the binding (when, loop, ignore_errors, ...), replacing the ones it has; null removes them. Needs a module or role binding.',
      }),
    },
    required: ['node'],
    example: {
      op: 'update_node',
      node: 'check-ntp',
      intent: 'Compare NTP servers with the standard',
    },
  },
  {
    op: 'delete',
    summary:
      'Delete nodes (with their wires, inner steps and positions) and wires (named by the output port they leave).',
    properties: {
      nodes: {
        type: 'array',
        items: NODE,
        description: 'Nodes to delete (with the notes on them).',
      },
      wires: {
        type: 'array',
        items: OUT,
        description: 'Wires to delete, by the output they leave.',
      },
      annotations: {
        type: 'array',
        items: ANNOTATION_REF,
        description: 'Notes, sections or text to delete.',
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
    op: 'accept',
    summary:
      'Accept something as it is, with a reason recorded in the flow: a fail port left unwired on purpose (at: the port), a warning from the problems (finding: check:<code>[:<subject>], at: the node; needs flow format 2), a drift item (drift:<item>) or a lens finding (lens:<id>).',
    properties: {
      at: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        description:
          'The fail port (node.port) when accepting a port; else the node. A list accepts each with the same finding and reason, e.g. every open fail port of read-only steps.',
      },
      finding: {
        type: 'string',
        description:
          'What is accepted: omit (or port:<port>) for a port; check:<code>[:<subject>] for a problem, e.g. check:binding-unknown-var:ntp_servers; drift:<item>; lens:<finding id>.',
      },
      reason: { type: 'string', description: 'Why it stays as it is (shown in reviews).' },
    },
    required: ['at', 'reason'],
    example: {
      op: 'accept',
      at: 'check-ntp',
      finding: 'check:binding-unknown-var:ntp_servers',
      reason: 'Set in group_vars/edge.yml',
    },
  },
  {
    op: 'unaccept',
    summary: 'Take back an accept (the same at and finding).',
    properties: {
      at: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, minItems: 1 }],
        description: 'The port (node.port), or the node; a list for several.',
      },
      finding: { type: 'string', description: 'As given to accept; omit for a port.' },
    },
    required: ['at'],
    example: { op: 'unaccept', at: 'check-ntp.failed_hosts' },
  },
  {
    op: 'leave_open',
    summary:
      'Same as accept on a port (kept for one release): leave a fail port unwired on purpose, with a reason; its hosts fail the run and the open-port warning goes away.',
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
    summary: 'Same as unaccept on a port (kept for one release): remove a leave_open decision.',
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
      end: {
        ...NODE,
        description:
          'End node (same level) the hosts go to, instead of the one the pattern picks: it reuses an end keyed stopped/failed (excluded, done), else makes a new one.',
      },
      position: placeOf(
        'the handler node the pattern adds (for a pattern without one, its new end node; a new end goes below the handler)',
      ),
    },
    required: ['at', 'pattern'],
    example: { op: 'apply_pattern', at: 'push-config.failed_hosts', pattern: 'rollback' },
  },
  {
    op: 'set_io',
    summary:
      'Add, change, rename or remove (field: null) one input or output of a node, or of the flow (node: "flow"). from: may name a step inside another subflow (precheck/normalize-facts.fos_version): each subflow on the way gets an output that lifts it, and the field reads precheck.fos_version.',
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
    op: 'ask_at_run_time',
    summary:
      'Let whoever runs the flow set a step\'s retries, delay or timeout: adds an integer flow input (or reuses one of that name), a node input reading it (from: flow.<name>), and sets the setting to "{{ <name> }}", in one edit. Delay and timeout are whole seconds. Not for an approval, whose timeout AWX needs as a fixed duration.',
    properties: {
      node: NODE,
      setting: { enum: ['retries', 'delay', 'timeout'], description: 'Which setting.' },
      name: { type: 'string', description: 'The input name (snake_case), e.g. drain_tries.' },
      description: {
        type: 'string',
        description: 'What the value is for, shown to whoever runs the flow.',
      },
      default: {
        type: 'integer',
        minimum: 0,
        description:
          "The flow input's default (retries as a count, delay and timeout in seconds); without one the input is required.",
      },
    },
    required: ['node', 'setting', 'name'],
    example: {
      op: 'ask_at_run_time',
      node: 'wait-drain',
      setting: 'retries',
      name: 'drain_tries',
      description: 'How many more times to check that the pool has drained',
      default: 12,
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
      external_vars: {
        type: ['object', 'null'],
        additionalProperties: { type: ['string', 'null'] },
        description:
          'Variables something outside the flow sets at run time (AWX or Kestra extra vars, inventory, a caller): name -> where it comes from, merged with those already declared; null for a name removes it. Steps read them without an input and without a finding to accept.',
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
    summary:
      "Let an inner step's output leave the subflow through one of the subflow's ports, or through a named exit: a new name (dry_run_done) gives the subflow a port of that name, which the parent wires like ok_hosts. An end node inside a subflow instead ends the host's whole run.",
    properties: {
      from: { ...OUT, description: 'Inner output, e.g. fix-ntp/push-config.ok_hosts.' },
      port: {
        type: 'string',
        description:
          'Port of the subflow node (ok_hosts, failed_hosts, …) or a named exit: lowercase letters, digits and _ (dry_run_done).',
      },
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
      position: placeOf('the new subflow node'),
    },
    required: ['nodes', 'title'],
    example: {
      op: 'extract_subflow',
      nodes: ['backup', 'push-config', 'verify'],
      title: 'Fix NTP',
    },
  },
  {
    op: 'dissolve_subflow',
    summary:
      "Move a subflow's steps up to its level and remove the subflow (the inverse of extract_subflow): wires into it go to its entry step, each exit becomes wires from the inner ports that left by it, and from: references follow. Keys must be free on that level (rename first).",
    properties: { subflow: { ...NODE, description: 'The subflow to dissolve.' } },
    required: ['subflow'],
    example: { op: 'dissolve_subflow', subflow: 'phase-event-preflight-started' },
  },
  {
    op: 'rename',
    summary:
      'Rename several nodes at once: old key (path) -> new key; from: references follow, as with update_node key.',
    properties: {
      keys: {
        type: 'object',
        additionalProperties: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]*$' },
        description: 'Old key or key path -> new key (on the same level).',
      },
    },
    required: ['keys'],
    example: {
      op: 'rename',
      keys: { 'load-saved-credentials-survey-fields-emp': 'load-credentials' },
    },
  },
  {
    op: 'replace_text',
    summary:
      'Find and replace text in the bindings (params, keywords or both) of the named nodes, the steps inside a subflow, or the whole flow. Fails when nothing matches. For mechanical changes such as a path or variable name in many steps.',
    properties: {
      find: {
        type: 'string',
        description: 'Text to find (a regular expression with regex: true).',
      },
      replace: {
        type: 'string',
        description: 'Replacement; with regex, $1 and the like insert groups.',
      },
      regex: { type: 'boolean', description: 'find is a JavaScript regular expression.' },
      nodes: { type: 'array', items: NODE, description: 'Only these nodes.' },
      level: { ...NODE, description: 'Only the steps inside this subflow (at any depth).' },
      in: {
        type: 'string',
        enum: ['params', 'keywords', 'all'],
        description: 'Where to replace (default all).',
      },
    },
    required: ['find', 'replace'],
    example: {
      op: 'replace_text',
      find: '{{ playbook_dir }}/',
      replace: '{{ afd_repo_root }}/',
    },
  },
  {
    op: 'regenerate',
    summary:
      "Write the flow's generated/ code again from the file as it is (after the file was changed outside the tools, or to overwrite hand edits). Changes nothing in the flow.",
    properties: {},
    required: [],
    example: { op: 'regenerate' },
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
    op: 'move',
    summary: `Place or move nodes and annotations (positions only; nothing else changes). Several in one op, in order: a later one may be placed relative to an earlier one. A section carries the nodes and annotations wholly inside it; a note on a node moves with the node. ${LAYOUT_RULES}`,
    properties: {
      nodes: {
        type: 'object',
        description: 'Node (key, or subflow/step) -> where it goes.',
        additionalProperties: PLACE,
      },
      annotations: {
        type: 'object',
        description: 'Annotation (key path) -> where it goes.',
        additionalProperties: ANNOTATION_PLACE,
      },
    },
    required: [],
    example: {
      op: 'move',
      nodes: { 'check-ntp': { x: 320, y: 140 }, 'fix-ntp': { right_of: 'check-ntp' } },
    },
  },
  {
    op: 'unplace',
    summary:
      'Drop stored positions so the canvas places these nodes automatically again (positions only). Name nodes, or a level: top, all, or a subflow key.',
    properties: {
      nodes: { type: 'array', items: NODE, description: 'Nodes to hand back to auto-placement.' },
      level: { type: 'string', description: 'top, all, or a subflow key: every node there.' },
    },
    required: [],
    example: { op: 'unplace', level: 'top' },
  },
  {
    op: 'annotate',
    summary:
      "Add a note, section or text (format 2): words on the canvas that explain the flow and never run, so adding or changing them changes no version. A note on a node (on) moves with the node, is deleted with it, and its text becomes a comment above the node's code. A section is a titled region behind nodes: moving it moves what is inside. Text is words with no background. The text is Markdown: **bold**, *italic*, `code`, - lists, [links](https://...).",
    properties: {
      kind: note('kind'),
      text: note('text'),
      on: {
        ...NODE,
        description: "Notes only: the node this note is about (its level is the note's).",
      },
      in: {
        ...NODE,
        description:
          'Subflow whose inner level gets it (default: the top level, or the level of on).',
      },
      around: {
        type: 'array',
        items: NODE,
        minItems: 1,
        description:
          'A section drawn around these nodes of one level and the notes on them, wholly inside with room for its title, as the canvas draws one around picked nodes; kind defaults to section. It sets the place and size, so leave out position, width and height. Nodes the canvas still places are kept where they are shown, so they stay inside.',
      },
      position: ANNOTATION_PLACE,
      width: note('width'),
      height: note('height'),
      color: note('color'),
      size: note('size'),
      key: note(
        'key',
        'Key of the new annotation; default: note-1, section-1, text-1, ... Must be new on its level.',
      ),
    },
    required: ['text'],
    example: {
      op: 'annotate',
      on: 'precheck',
      text: 'Read-only: **safe** to run again. Runbook: https://wiki.example.net/edge',
    },
  },
  {
    op: 'update_annotation',
    summary:
      'Change a note, section or text: its words, color, size, place, or the node a note is on (on: null unties it and it stays where it is shown). Changes no version.',
    properties: {
      annotation: ANNOTATION_REF,
      text: note('text'),
      on: nullable({
        ...NODE,
        description: 'The node the note is about (same level); null unties it.',
      }),
      position: ANNOTATION_PLACE,
      width: nullable(note('width')),
      height: nullable(note('height')),
      color: nullable(note('color')),
      size: nullable(note('size')),
      key: note('key'),
    },
    required: ['annotation'],
    example: { op: 'update_annotation', annotation: 'note-1', color: 'green' },
  },
  {
    op: 'upgrade_format',
    summary:
      'Move a format 1 flow to the current format (2). Nothing in the design changes; an op that needs format 2 says so. Run it alone, or first in a batch.',
    properties: {},
    required: [],
    example: { op: 'upgrade_format' },
  },
  {
    op: 'tidy_up',
    summary:
      'Lay out a level again with the auto-layout and store every position (positions only). It replaces hand-made positions on that level. Wires then step round the nodes in their way by themselves; read the layout check it reports for what is left (crossings, labels).',
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
    'The flow file (*.flow.yaml), relative to the workspace root (also accepted as flow). Default: the flow open in the designer, or the only flow.',
};

export interface ToolSpec {
  name: string;
  title: string;
  description: string;
  readOnly: boolean;
  /** AFD-126: the tool runs programs beyond reading and writing flow files (MCP openWorldHint). */
  openWorld?: boolean;
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
        layout: {
          type: 'boolean',
          description:
            'Also list where each node is ("at x,y" for a stored position, "auto x,y" where the canvas places it now) and run the layout check: what a person sees on the canvas that you cannot, per level (boxes overlapping, a wire through a box, a wire label on a box or another label, wires crossing). Use it before move, to place new nodes next to existing ones, and after building a flow; the total comes first, and only_problems: true leaves out the nodes and wires. flow_edit runs the same check on the levels it placed nodes on.',
        },
        nodes: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Only these nodes (key paths; a subflow key also covers the steps inside it) and the wires touching them.',
        },
        detail: {
          type: 'string',
          enum: ['full', 'brief'],
          description:
            'brief: one short line per node (key, type, status, title, binding). Default full.',
        },
        only_problems: {
          type: 'boolean',
          description: 'With layout: only the layout check per level, without the nodes and wires.',
        },
        page: { type: 'integer', minimum: 1, description: 'Page of a long answer (default 1).' },
      },
    },
  },
  {
    name: 'flow_validate',
    title: 'Check a flow',
    description:
      'List the problems of a flow (errors, warnings, info) by node key, each with how to fix it and, for a warning, the key an accept op takes. Says whether generated/ matches the flow. On a large flow start with summary: true, then filter by code or node; long lists come in pages.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        summary: {
          type: 'boolean',
          description:
            'Problems grouped by code: how many, the nodes with most of them, what they are about, the fix once.',
        },
        code: {
          type: 'array',
          items: { type: 'string' },
          description: 'Only these problem codes (binding-unknown-var, ref-may-be-undefined, …).',
        },
        node: {
          type: 'string',
          description:
            'Only problems of this node, or of the steps inside this subflow (a key path).',
        },
        severity: { type: 'string', enum: ['error', 'warning', 'info'] },
        page: { type: 'integer', minimum: 1, description: 'Page of a long list (default 1).' },
      },
    },
  },
  {
    name: 'flow_reference',
    title: 'Flow reference',
    description:
      'The flow format, the ports of each node type, the failure patterns, the edit ops, the problem codes and scenario tests.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        topic: {
          enum: ['all', 'format', 'ports', 'patterns', 'ops', 'problems', 'scenarios'],
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
  {
    name: 'flow_export',
    title: 'Export a flow',
    description:
      "Export an Ansible flow as a draw.io diagram (a page per level, wired as on the canvas, with each node's key, type, status, intent, binding, data, settings and problems as draw.io shape data) or as SVG images of its levels that draw.io also opens as diagrams. Use it whenever the user wants a draw.io file, picture or image of a flow, instead of drawing the flow by hand in draw.io, PlantUML or Mermaid. Files go next to the flow unless out says where.",
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        format: {
          type: 'string',
          enum: ['drawio', 'svg'],
          description:
            'drawio (default): one .drawio file, a page per level. svg: an image of a level (.drawio.svg). PNG is only in VS Code (Export as Image).',
        },
        level: {
          type: 'string',
          description: 'svg only: top (default), all (one image per level), or a subflow key.',
        },
        out: {
          type: 'string',
          description:
            "File to write, relative to the workspace root. Default: next to the flow, <key>.drawio or <key>[--subflow].drawio.svg. With level all, the top level's file; the others go next to it.",
        },
      },
    },
  },
  {
    name: 'source_outline',
    title: 'Outline existing automation',
    description:
      'Read existing Ansible automation before turning it into a flow: a playbook (its plays, tasks, blocks with rescue/always, includes, roles, handlers, variables), a folder (its playbooks, the top-level ones first, and roles), a role folder, or an AWX export (.json: workflow and job templates, their nodes and edges, which playbooks are in this repository). Each task line has the exact binding an import writes (impl: module or role, params, register, keywords), to copy into add_node or bind so the flow runs what the playbook ran. Use it whenever the user wants playbooks, roles or AWX templates imported, converted or redesigned as a flow. Secrets show by name only. Long outlines come in pages.',
    readOnly: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description:
            'A playbook (.yml), a folder, a role folder or an AWX export (.json), relative to the workspace root.',
        },
        flow: {
          type: 'string',
          description:
            'The flow you will write (flows/<key>/<key>.flow.yaml). Paths in impl are written from {{ afd_repo_root }}, the repository root its generated plays set.',
        },
        focus: {
          type: 'string',
          description:
            'Tasks to see in full (long parameters uncut): a number "#7", a list "#3,#9" or a range "#25-#37" (up to 60).',
        },
        full: {
          type: 'boolean',
          description:
            'The whole outline with nothing cut; it comes in more pages. Default false (long values cut).',
        },
        page: { type: 'integer', minimum: 1, description: 'Page of a long outline (default 1).' },
      },
      required: ['path'],
    },
  },
  {
    name: 'flow_import',
    title: 'Import automation as is',
    description:
      'Import a playbook, or a workflow or job template of an AWX export, as a new flow one to one: one step per task in source order, plays and imported playbooks as subflows, blocks with rescue/always as a subflow and its failure path, roles as steps, handlers as conditional steps, variables wired as inputs and outputs, secrets by name only. Use it only when the user wants an exact copy. For a design by intent (fewer, purposeful subflows), read the source with source_outline and build the flow with flow_new and flow_edit instead.',
    readOnly: false,
    inputSchema: {
      type: 'object',
      properties: {
        source: {
          type: 'string',
          description:
            'A playbook (.yml) or an AWX export (.json), relative to the workspace root.',
        },
        path: {
          type: 'string',
          description:
            'The new flow file. Default: flows/<name>/<name>.flow.yaml from the source name.',
        },
        template: {
          type: 'string',
          description:
            'AWX export only: the workflow or job template to import, when it has several.',
        },
        name: {
          type: 'string',
          description: 'The flow name. Default: the first play name or the file name.',
        },
      },
      required: ['source'],
    },
  },
  {
    name: 'flow_scenarios',
    title: 'Scenario tests',
    description:
      "Scenario tests of a flow (<key>.scenarios.yaml): which hosts fail where, and the end each host must reach. list (default) and check show each scenario's verdict in a simulation of the generated code, in milliseconds; add, update and delete write the file (expectations default to where the simulation sends each host); verify runs ansible-playbook on this machine or in the execution environment image of the user's settings, with every step as its stub. Name steps by key, or subflow/step inside a subflow.",
    readOnly: false,
    openWorld: true,
    inputSchema: {
      type: 'object',
      properties: {
        path: PATH,
        action: {
          enum: ['list', 'check', 'add', 'update', 'delete', 'verify'],
          description: 'What to do (default list).',
        },
        name: { type: 'string', description: 'The scenario (add, update, delete).' },
        rename: { type: 'string', description: 'update: a new name.' },
        hosts: {
          type: 'array',
          items: { type: 'string' },
          description:
            "Host names to run on (any names: they run on this machine). They go on the flow's host-list input.",
        },
        inputs: {
          type: 'object',
          description: 'Other flow inputs for the run, by name (merged on update).',
        },
        groups: {
          type: 'object',
          description: 'Inventory groups for an inventory_target pattern: {lb: [lb-01, lb-02]}.',
        },
        force: {
          type: 'object',
          description:
            'Per step key (or subflow/step): {failed|unreachable|timeout|unchanged: [hosts]}, or {false: [hosts]} on a decision. Only ports the step has. Replaces the whole map on update; {} clears it.',
        },
        approvals: {
          type: 'object',
          description:
            'Per approval key: approved (default), rejected or timeout, for the whole run.',
        },
        expect: {
          type: 'object',
          description:
            'Per host: the end node key (or subflow/end) it must reach, or <step>.<port> for an output with no wire. Leave it out on add to take the simulated ends.',
        },
        accept_ends: {
          type: 'boolean',
          description: 'update: set the expectations to where the simulation sends each host now.',
        },
        names: {
          type: 'array',
          items: { type: 'string' },
          description: 'verify: only these scenarios (default all).',
        },
      },
    },
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

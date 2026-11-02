// The prompt an import command hands to an AI assistant (AFD-27): design a flow by intent from
// existing automation, with the flow tools. The same text goes to Copilot Chat or the clipboard.

export interface ImportPromptInput {
  /** Playbooks (repository paths), or the sanitized AWX export file. */
  sources: string[];
  /** The flow file to write per source (one for an AWX template). */
  targets: string[];
  /** AWX: the template in the export file. */
  template?: { kind: 'workflow' | 'job'; name: string };
}

export function importPrompt(p: ImportPromptInput): string {
  const awx = p.template;
  const pairs = p.sources.map((s, i) => `- ${s} → ${p.targets[i] ?? p.targets[0]}`);
  const what = awx
    ? `the AWX ${awx.kind === 'job' ? 'job' : 'workflow'} template "${awx.name}", exported to ${p.sources[0]} (secrets are in it by name only), and the playbooks of this repository it runs`
    : p.sources.length > 1
      ? 'these Ansible playbooks'
      : 'this Ansible playbook';
  return [
    `Design an Ansible flow (Ansible Flow Designer, *.flow.yaml) from ${what}, by intent rather than as a one-to-one copy.`,
    '',
    awx ? `Source and flow to write:` : 'Source → flow to write:',
    ...(awx ? [`- ${p.sources[0]} → ${p.targets[0]}`] : pairs),
    '',
    `1. Read the source with the source_outline tool${awx ? ' (the export file, then each playbook it lists as in this repository)' : ''}, passing flow as the file to write, so file paths in impl fit it.`,
    '2. Plan the flow by purpose before editing: a few subflows such as pre-checks, backup, the change, verification, rollback or notification, and steps named by what they achieve. Group related tasks; keep the order the source runs them in.',
    '3. Build it with flow_new, then flow_edit (a batch per level is fine): add_node with the impl from the outline copied as is (module, params, register, keywords), add_node with in: <subflow> or extract_subflow for levels, and set_io for the data later steps read (registered results, loaded variables).',
    awx
      ? "4. Keep what AWX does: success → ok_hosts, failure → failed_hosts, always → both; approvals stay approvals; survey questions and extra vars become flow inputs. Keep the playbooks' behaviour as in 5."
      : '4. Make the flow inputs from the play variables and prompts (secrets without a default); the hosts input (devices, host_list) defaults to a list, e.g. [edge].',
    '5. Keep the playbook\'s behaviour: when, loop and other task keywords stay in impl.keywords. Where the source handles a failure (block/rescue, ignore_errors, retries), handle that fail port the same way (apply_pattern, or a wire to the rescue steps); leave the others open, as the source does, and do not invent handling. Handlers become steps after their play with keywords.when "(<register> | default({})) is changed".',
    // AFD-69: the agent never sees the canvas; the layout check says what a person would see.
    '6. Check the layout: flow_describe with layout: true ends with a layout check per level (a wire through a node, a label on a node or on another label, overlaps, crossings). Fix wires through nodes and labels on nodes with move (put the node in the way beside the wire) and check again; leave crossings no move removes. tidy_up does not help here: it lays out the nodes the way the canvas already does and does not route wires.',
    '7. Finish with flow_validate (no errors). Then report how you grouped the tasks, what you changed, and what you left out or could not map.',
    '',
    'If an exact copy is wanted instead, flow_import makes one in a single call.',
  ].join('\n');
}

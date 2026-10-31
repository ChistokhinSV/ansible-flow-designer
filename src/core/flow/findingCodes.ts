// Every problem the designer reports, with what it means and how to fix it (AFD-19): shown by AI
// tools next to each finding and listed in the skill's generated reference.
export interface FindingCode {
  meaning: string;
  fix: string;
}

export const FINDING_CODES: Record<string, FindingCode> = {
  schema: {
    meaning: 'The file breaks the flow schema (a field of the wrong type or an unknown field).',
    fix: 'Correct the field named in the message; see the format reference.',
  },
  'input-default-type': {
    meaning:
      'A host_list or list flow input has a string default; the generated code joins it letter by letter.',
    fix: 'Write the default as a list: default: [edge] (set_io on flow with field {type: host_list, default: [edge]}).',
  },
  'keyword-reserved': {
    meaning:
      'A task keyword in impl.keywords that the flow models itself (register, tags, become, timeout, retries, until, notify, block) or that is no task keyword.',
    fix: 'Move it where the message says (impl.register, settings, a handler step, a subflow), or remove it.',
  },
  'keyword-ignored': {
    meaning:
      'Task keywords that cannot apply: on a playbook binding, or vars on a role binding (role variables belong in params).',
    fix: 'Remove them, or bind a module or role; move role variables to params.',
  },
  'missing-id': {
    meaning:
      'Written by hand: a node, wire or the flow has no ID, or a reference names a node by key.',
    fix: 'Run Complete IDs (designer banner or quick fix, or flow_complete_ids). Never invent IDs.',
  },
  'unknown-key': {
    meaning: 'A reference names a key no node has (or several nodes have).',
    fix: 'Use an existing key; inside subflows keys are per level.',
  },
  'duplicate-id': {
    meaning: 'Two items share an ID.',
    fix: 'Remove the id of the copy and run Complete IDs.',
  },
  'duplicate-key': {
    meaning: 'Two nodes on one level share a key.',
    fix: 'Rename one (update_node key); from: references follow.',
  },
  'edge-missing-node': {
    meaning: 'A wire names a node that does not exist.',
    fix: 'Delete the wire or point it at an existing node.',
  },
  'edge-cross-level': {
    meaning: 'A wire joins nodes on different levels.',
    fix: 'Wires stay on one level; use the subflow entry (set_entry) or an exit (add_exit).',
  },
  'edge-bad-port': {
    meaning: 'A wire uses a port the node type does not have.',
    fix: 'Use one of the ports of that type (port catalog).',
  },
  'edge-direction': {
    meaning: 'A wire starts at an input or ends at an output.',
    fix: 'Wires go from an output port to an input port (usually in).',
  },
  'edge-port-not-enabled': {
    meaning: 'A wire uses an optional port the node has not enabled.',
    fix: 'enable_port for that node and port.',
  },
  'port-multiple-edges': {
    meaning: 'An output port has more than one wire.',
    fix: 'One wire per output: fan out with a parallel node.',
  },
  'port-not-routable': {
    meaning: 'The generated playbook cannot route this port (e.g. cancelled).',
    fix: 'Keep it for Run mode only, or wire another port.',
  },
  'port-not-supported': {
    meaning: 'The port is enabled on a node type that does not support it.',
    fix: 'disable_port, or change the node type.',
  },
  'port-role-unroutable': {
    meaning: 'A role binding gives no signal for this port (e.g. unchanged).',
    fix: 'Bind a module instead, or do not use the port.',
  },
  'open-fail-port': {
    meaning:
      'A fail port (failed_hosts, unreachable, timeout, rejected) is not wired: its hosts fail the run.',
    fix: 'Wire it to a handler (apply_pattern), or leave_open with a reason.',
  },
  'decision-no-reason': {
    meaning: 'A port is left open on purpose without a reason.',
    fix: 'Give a reason (leave_open again with reason).',
  },
  'decision-not-fail': {
    meaning: 'Only fail ports can be left open on purpose.',
    fix: 'reopen it; wire the port instead.',
  },
  'decision-on-connected': {
    meaning: 'A port marked open on purpose is wired.',
    fix: 'reopen it (the wire decides).',
  },
  'duplicate-decision': {
    meaning: 'The same port has two decisions.',
    fix: 'Keep one: reopen, then leave_open once.',
  },
  'stale-decision': {
    meaning: 'A decision refers to a node, port or item that is gone.',
    fix: 'Remove the decision (reopen).',
  },
  'layout-orphan': {
    meaning: 'A position for a node that does not exist.',
    fix: 'Harmless; tidy_up or a move rewrites positions.',
  },
  'status-overclaim': {
    meaning: 'A status claims more than the node has (e.g. implemented without impl).',
    fix: 'Lower the status, or add what it needs (contract for specified, impl for implemented).',
  },
  'undo-unbound': {
    meaning: 'The undo port is used but the node has no undo binding.',
    fix: 'Bind undo, or remove the wire into undo.',
  },
  'timeout-without-setting': {
    meaning: 'The timeout port is enabled but settings.timeout is not set.',
    fix: 'Set settings.timeout (update_node settings).',
  },
  'inventory-target-ignored': {
    meaning: 'inventory_target is set where it has no effect.',
    fix: 'Remove it, or move it to a task or a subflow without inner steps.',
  },
  'host-list-input': {
    meaning: 'A node-level host_list input is informational: hosts come from the wire.',
    fix: 'Usually nothing; the arriving hosts decide.',
  },
  'no-targets': {
    meaning: 'No flow input seeds the hosts entering the start node.',
    fix: 'Add a host_list flow input with targets: true (set_io flow).',
  },
  'from-unresolved': {
    meaning: 'A from: names nothing this node can read.',
    fix: 'Use <node_key>.<output> of a node that runs before, flow.<input>, or inside a subflow <subflow_key>.<input>; give a path (sub/step.output) to set_io to lift a step inside another subflow.',
  },
  'binding-unknown-var': {
    meaning: 'A binding parameter (assert that included) uses a variable no input provides.',
    fix: 'Add the input the message names (set_io) or fix the name.',
  },
  'condition-unknown-var': {
    meaning:
      'A decision condition or until uses a variable that is not an input (or, for until, the result).',
    fix: 'Add the input the message names (set_io) or fix the name.',
  },
  'subflow-output-unset': {
    meaning:
      'A subflow output names no inner output, and no single inner step has one of that name.',
    fix: 'Set its from to <inner_step>.<output> (set_io).',
  },
  'until-not-module': {
    meaning: 'settings.until on a role or playbook step, where Ansible cannot retry.',
    fix: 'Move the polling into a module step, or remove until.',
  },
  'approval-split': {
    meaning: 'Approval outcomes go to different places in a way AWX cannot express.',
    fix: 'Route rejected and timeout the same way.',
  },
  'awx-segments': {
    meaning: 'Approvals inside subflows, or two that can wait at once, cannot become AWX segments.',
    fix: 'Keep approvals on the top level, one at a time.',
  },
  'runtime-kind': {
    meaning: 'flow.runtime.kind does not fit the flow (e.g. a job for a flow with approvals).',
    fix: 'Use awx_workflow with approvals, awx_job without.',
  },
  'rollback-unreachable': {
    meaning: 'A Rollback node cannot be reached by any failed hosts.',
    fix: 'Wire a fail port to it, or delete it.',
  },
  'boundary-ref': {
    meaning: 'The subflow entry or an exit names something that is not on its inner level.',
    fix: 'set_entry / add_exit with an inner node of that subflow.',
  },
  'boundary-no-entry': {
    meaning: 'A subflow has inner steps but no entry: hosts cannot get in.',
    fix: 'set_entry to its first step.',
  },
  'boundary-port-unfed': {
    meaning: 'A subflow port has wires outside but no inner exit feeds it.',
    fix: 'add_exit from an inner output to that port.',
  },
  'inner-exit-unmapped': {
    meaning: 'An inner output leaves the subflow through a port the subflow lacks.',
    fix: 'Enable the port on the subflow node, or remove the exit.',
  },
  'codegen-cycle': {
    meaning: 'Wires form a cycle; flows run top-down.',
    fix: 'Remove a wire; retries use apply_pattern retry.',
  },
  'codegen-no-input': {
    meaning: 'A node gets no hosts: nothing wires into it.',
    fix: 'Wire an output into its in port, or delete it.',
  },
  'codegen-no-targets': {
    meaning: 'The generated playbook has no hosts to start with.',
    fix: 'Add a host_list flow input with targets: true.',
  },
  'codegen-playbook-ports': {
    meaning: 'A playbook binding cannot route this port.',
    fix: 'Use ok_hosts/failed_hosts, or bind a role or module.',
  },
  'codegen-segments': {
    meaning: 'Approval segments cannot be generated for this flow.',
    fix: 'See awx-segments.',
  },
  'codegen-target-ports': {
    meaning:
      'A node with inventory_target uses a port that cannot be routed for the arriving hosts.',
    fix: 'Use ok_hosts, failed_hosts or timeout.',
  },
  'binding-not-in-ee': {
    meaning: 'The bound module or role is not in the execution environment.',
    fix: 'Pick another, or add its collection to the environment.',
  },
  'binding-removed': { meaning: 'The bound module was removed.', fix: 'Bind its replacement.' },
  'binding-deprecated': {
    meaning: 'The bound module is deprecated.',
    fix: 'Bind its replacement.',
  },
  'binding-redirect': {
    meaning: 'The bound name redirects to another module.',
    fix: 'Use the final name.',
  },
  'binding-unknown-param': {
    meaning: 'A parameter the module does not have.',
    fix: 'Remove or rename it (module docs in the catalog).',
  },
  'binding-missing-param': {
    meaning: 'A required module parameter is missing.',
    fix: 'Add it to impl.params.',
  },
  'binding-no-check-mode': {
    meaning: 'The module does not support check mode: skeleton runs skip it.',
    fix: 'Usually fine; real runs only.',
  },
};

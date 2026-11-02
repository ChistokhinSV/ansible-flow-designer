# ADR-0009 · Option A code generation rules

Status: Accepted · 2026-10-28 · AFD-4 (M3). Amends ADR-0003 (rescue rule).

## Context

The M3 spike (`docs/spikes/m3-option-a.md`, ansible-core 2.19/2.20/2.21) found two Ansible behaviours that break the rule "block/rescue only when a fail port is wired":

- When every host of one play fails or is unreachable, `ansible-playbook` stops the whole playbook. Plays for other branches never run, so a Rollback or Notify wired elsewhere is skipped (s04, s05, s13).
- `rescue` does not catch unreachable hosts, and a host Ansible dropped as unreachable can never be targeted by a later play (s01, s12).

## Decision

**Plays and order.**
- One playbook per flow level.
- Every node except start and end becomes one play, in topological order. Ties keep document order.
- Play name `[<key>] <title>`, tag `node_<ULID>` (plus `settings.tags`), var `flow_node_id`, `gather_facts: false`.
- The first node's `hosts:` is the start's targets: the flow's `host_list` input marked `targets: true`, else the first `host_list` input, rendered as `"{{ <input> | join(',') }}"`. Codegen refuses a flow without one.
- A node with several incoming edges targets the union of their groups. A join targets the union and routes hosts present in every branch group (`join_mode: all`) or in any of them (`any`).

**Routing groups.**
- `flow_<path>_<port>`, where the path is the node key, prefixed by the enclosing subflow keys and `__` inside subflows; hyphens become underscores.
- Every port a node produces is routed with `ansible.builtin.group_by`, also ports that lead to end nodes, so run events always show where a host went.

**No host fails inside a node play.**
- Every task-like node runs its body in `block`/`rescue`.
- An open fail port, and an open-on-purpose one, routes into its own group like a wired port.
- A final **outcome play** fails, with `ansible.builtin.fail` and a message naming the node and port, every host that:
  - took an open port (the message carries the open-on-purpose reason when there is one);
  - reached an end node with `outcome: failed` (its title appears in the message);
  - hit a decision whose condition could not be evaluated.
- The job still ends failed, every branch runs, and nothing is swallowed.

**Bodies.**
- An unbound node, or one whose node type has no binding, runs `ansible.builtin.debug` with `TODO: <intent or title>`.
- Module bindings become the module task, with `register` (the binding's own name, else `<key>_result`) and `ignore_unreachable: true`.
- Role bindings become `ansible.builtin.include_role` with `apply: {tags: [node_<ULID>]}`. Include options in `params` (`tasks_from`, `vars_from`, `defaults_from`, `handlers_from`, `public`, `allow_duplicates`, `rolespec_validate`) stay options; all other params become role vars.
- Playbook bindings need a top-level `import_playbook`, which cannot route host sets. They run the TODO stub with a warning until M5.

**Ports by binding.**
- `unreachable`: module bindings route it per host (their task ignores unreachable and the registered result decides). If the port is not enabled, these hosts are failed in the outcome play like an open port. Role bindings cannot route it: hosts lost inside a role drop out (Ansible's default, rc 4). The validator warns when a role node enables `unreachable`, and suggests a module node or subflow for the connecting step.
- `unchanged`: module bindings, from the registered `changed`. Role nodes: validator warning.
- `timeout`: `settings.timeout` becomes the task `timeout:` keyword (for roles through `apply`, so it is per task). The rescue routes `ansible_failed_result.timedout` to `timeout`, the rest to `failed_hosts`.
- `always`: the block's `always:` section.
- `cancelled`: model only (ADR-0003).

**Other node types and settings.**
- `max_fail_percentage` (D-08) becomes a threshold task after the block. When the node's fail groups exceed the share of the play's hosts, it fails every host of the play, which stops the whole flow (s09). The play keyword is not used: it never sees rescued hosts.
- `serial` and `become` become play keywords.
- `retries` applies to module bindings (`until: <register> is succeeded`).
- A decision routes with its `condition`; without one it is a TODO that sends every host to `true`.
- An approval auto-approves in local and skeleton runs (TODO message). For AWX, top-level approvals split the flow into segment playbooks (`<key>.seg_<segment>.yml`): `add_host` from the `afd_hostsets` artifact rebuilds the carried groups in the next segment (s10, AFD-11, ADR-0016).
- A parallel node puts each host into every `branch_n` group.
- A subflow with an inner graph becomes its own playbook, imported with `import_playbook` at the subflow's place. The inner entry node targets the subflow's input groups. Inner ports listed in `boundary.outputs`, and inner open fail ports that bubble (ADR-0004), route straight into the parent's port groups.

**`inventory_target` (AFD-14, amended 2026-10-29).** A work node (a task, or a subflow without inner steps) with `settings.inventory_target` runs its binding once on that target instead of on the hosts that arrive. Inner steps of a subflow with a target inherit it, unless they have their own. Decisions, approvals, parallels and joins always run on the arriving hosts; the validator warns about a target on them (`inventory-target-ignored`).

The node compiles to three plays, all tagged `node_<ULID>` and carrying `flow_node_id`:
1. `[key] Title: arriving hosts` puts the arriving hosts into `flow_<key>_arriving`.
2. `[key] Title` runs on the target pattern; Jinja such as `{{ lb_group }}` is filled in from the extra vars.
   - It ends at once (`meta: end_play`) when no host arrived.
   - `afd_arriving` lists the arriving hosts.
   - Inputs that come from upstream outputs are read from the first arriving host (`hostvars[afd_arriving | first]`); `flow.*` inputs stay extra vars.
   - The binding runs in a block. Hosts that finish join `flow_<key>_target_done`. Unreachable module results and rescued hosts join `_target_failed`, or `_target_timeout` when the timeout port is enabled and the task timed out.
   - A playbook binding gets `afd_hosts` set to the target (or `afd_no_hosts` when nobody arrived), and a `: target done` play on the target collects the hosts still in the run.
3. `[key] Title: route` runs on the arriving hosts:
   - outputs are copied from the first finished target host (`set_fact` of each output's root variable);
   - they leave together through `ok_hosts`, or through `failed_hosts` (`timeout`) when the target matched no host, or when its unfinished share exceeds `max_fail_percentage` (with none set, when any target host did not finish);
   - `always` takes every arriving host when it is enabled;
   - debug messages name a target that matched nothing and the target hosts that did not finish.

Arriving hosts never take `unreachable` or `unchanged` on such a node, and never take `timeout` with a playbook binding; codegen warns (`codegen-target-ports`). AWX play names map back to the node through the `: arriving hosts`, `: route` and `: target done` suffixes. Real-run and AWX confirmations name every target and its host count, which also feeds the production check. The audit log records the declared patterns and counts, never input values.

**Files.**
- `generated/<flow-key>.yml` next to the flow file, and `generated/<flow-key>.<subflow-key>.yml` per subflow level.
- The flow's line endings are used.
- The header names the source flow and version and carries a checksum of the body.
- Code is written on every save of a flow without errors, and only when the content changed. A generated file whose body no longer matches its checksum was edited by hand: it is not overwritten, and the "Generate Playbook" command asks first.
- Stale level files of the same flow are removed only if they still carry the generated header.
- `examples/generated/` holds the golden files (the handoff's `edge-baseline.skeleton.yml` is superseded).

**Simulation.** A codegen option, used by the engine tests, adds `afd_simulate` hooks to TODO nodes, draft decisions and approvals. A run can then send chosen hosts down failure paths without devices. Generated files on disk never contain it.

## Consequences

- Generated code is longer than the handoff skeleton: every task node has a rescue, and there is one outcome play.
- Happy-path runs warn for routing groups nobody entered ("Could not match supplied host pattern"). Our local runs set `ANSIBLE_HOST_PATTERN_MISMATCH=ignore`.
- Role nodes cannot route `unreachable` or `unchanged` per host. If every host of a role node is unreachable, the run stops.

## Amendment: task keywords (AFD-26, 2026-10-31)

`impl.keywords` (`src/core/flow/keywords.ts`, ADR-0021) holds Ansible task keywords that the flow
does not model, written on the generated task as is:
- **Module bindings:** after the module, before Option A's `register`, `ignore_unreachable`,
  `timeout` and retries.
- **Role bindings:** `when`, `loop`, `loop_control` and `with_*` go on the `include_role` task;
  every other keyword goes into `apply`, so it reaches each task of the role as a static
  `roles:` entry would. Role variables stay params; `vars` is ignored with a warning.
- **Playbook bindings** take none (`keyword-ignored`).

Routing is unchanged:
- a host the task skips (`when` false) leaves through `ok_hosts`, or `unchanged` when enabled (a
  skipped result has `changed: false`);
- a failure `ignore_errors` lets pass is not rescued, so the host leaves through `ok_hosts`;
- a looped result keeps `changed` for the `unchanged` port and for handler conditions.

The schema allow-lists the keywords. A keyword the flow models (register, tags, become, timeout,
retries, delay, until, notify, block, …) is the error `keyword-reserved`, whose message names
where it goes. Variables in keywords are checked like params: `when`, `changed_when` and
`failed_when` are bare tests, and loop variables and the keywords' own `vars` count as known.

## Amendment (AFD-53, 2026-11-01): outputs captured per step

A role, a playbook or a stub sets an output as a fact of the output's own name, and host facts are
global to the run, so two steps naming an output alike overwrote each other for every later reader.
Every task step now copies each output that is not its register into a variable of its own right
after it ran: `set_fact: afd_<key>__<output>: "{{ <output> }}"` with `when: <output> is defined`,
named `[<key>] keep output <output>`.

- **Where:** inside the step's block after the module, role or stub (only hosts that finished
  get it, before the ok route); on the target for an `inventory_target` step, whose copy to the
  arriving hosts reads the captured name; and in the route play after a playbook binding, which
  cannot sit in a block.
- **Names** (`capturedVar` in `core/flow/dataNames.ts`): the step's key, with the keys of the
  enclosing subflows in front only when that key is used on another level too. A step extracted
  into a subflow keeps its name. `outputVar` returns it, so play vars, lifted subflow outputs and
  the validator follow.
- **Registers** stay as they are: a module output `from: impl.register[.path]` reads the register.
  The register is named by the flow, so a reader of a register that another step also registers,
  or that a flow input names, is the error `register-collision` (replacing the warning
  `output-name-collision`, which captured names cannot hit).
- Code sync does not count a capture task as the step's own `set_fact` (`CAPTURE_TASK`).
- Both formats: the flow file does not change. Engine test: two runs of a role setting `version`,
  read by one assert, on 2.19, 2.20 and 2.21.

## Amendment (AFD-55, 2026-11-01): rolling subflows

`settings.rolling` (a number or a percentage) on a subflow compiles its level into one play with
`serial`, so each batch of hosts goes through every step before the next batch starts: the rolling
upgrade the play-per-step level cannot express (`serial` on a node batches only its own play).

- **The play:** `[<key>] <title>: rolling, <batch> at a time`, hosts the subflow's arriving
  pattern, tagged with the subflow node. Each step is a block named and tagged like its play would
  be, with that play's vars (inputs, `flow_node_id`, `afd_sim`) and privilege, and
  `when: inventory_hostname in (groups[...])` over the groups that route hosts to it (none for the
  entry step, where every host of the play arrives). The step's own tasks are unchanged: block,
  rescue, `group_by` routing, captures. Groups persist across batches, so the levels after it read
  the same groups, and every host takes the same ports as without rolling.
- **What fits** (`core/flow/rolling.ts`, shared with the validator): start, end, decision, and tasks
  bound to a module or a role or not bound yet. A nested subflow with steps, an approval, a
  parallel or join, a playbook binding, an `inventory_target` (the step's, the subflow's or an
  enclosing one's), and a step's own `serial` or `max_fail_percentage` need plays of their own:
  `rolling-unsupported` (error), and the engine generates the level play by play. On a node that
  is not a subflow, rolling is a warning.
- **Not covered:** a failure share that stops the remaining batches (rescued hosts never count as
  failed for Ansible's own `max_fail_percentage`), and Ansible handlers inside the play.
- Engine contract: routing-levels with its subflow rolling 2 at a time routes every host the same
  way as play by play, and each batch finishes the subflow before the next starts it (2.19, 2.20,
  2.21).

## Amendment: notes as comments (AFD-66, 2026-11-02)

A Note on a node (ADR-0028) becomes `# Note: <first line>` and `#   <next lines>` above the node's code:
- **Where:**
  - in `result()`, before the play range is taken, so Peek Code and the Details preview still cover only the play;
  - this covers plain plays, inventory_target chunks, playbook nodes, subflow imports and approval segments;
  - rolling levels get comment items before each step's block;
  - start, end and unreached nodes get none.
- **Text:** the Markdown is made plain (`plainText`) and split on every YAML line break (`\r\n`, `\r`, `\n`, U+0085, U+2028, U+2029), so no text can end the comment and become YAML. Unit and engine tests try each one.
- **Not design:** generated files can change while `flow.version` stays, because annotations are not design. Codegen on save compares text and rewrites only what changed; the body checksum covers the comments, so hand-edit protection holds; drift parses YAML and ignores comments.

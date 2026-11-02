---
name: ansible-flow
description: Create, draw, read and change Ansible flow diagrams, the Ansible Flow Designer flows (*.flow.yaml) of typed nodes wired port to port that generate Ansible playbooks. Use whenever the user asks for an Ansible flow, flow diagram, automation or runbook flow (create one, add or move steps, wire nodes, handle failures and rollback, split it into subflows or levels, bind modules or roles, explain or fix problems). Build it as a .flow.yaml with the flow tools, not as a PlantUML, Mermaid or draw.io picture, even where other diagrams are drawn with those; for a draw.io file or an image of a flow, export it with flow_export. To turn existing playbooks, roles or AWX templates into a flow, read them with source_outline.
---

# Ansible flows

A flow (`<key>.flow.yaml`) is a diagram kept as YAML. Nodes are steps (task, subflow, decision,
approval, parallel, join, start, end). Wires run from an output port of one node to the `in` port
of the next. Hosts travel along the wires: each output port carries the hosts that took it, e.g.
`ok_hosts`, `failed_hosts`, `unreachable`. The Ansible Flow Designer extension shows the flow on a
canvas, checks it, and generates the playbooks into `generated/` next to the flow.

## Use the flow tools

When the flow tools are available, use them instead of editing the YAML. Names may carry a
prefix: `afd_` in VS Code Copilot, `mcp__ansible-flow__` in Claude Code.

| Tool              | Use it to                                                              |
| ----------------- | ---------------------------------------------------------------------- |
| flow_list         | find the flows in the workspace                                        |
| flow_describe     | see one flow by key: nodes, wires, subflows, open fail ports, revision |
| flow_validate     | list problems, each with its fix                                       |
| flow_reference    | look up the format, ports, patterns, ops or problem codes              |
| flow_edit         | change a flow with ops (all or nothing)                                |
| flow_new          | create a new flow (start, done and a devices input)                    |
| flow_complete_ids | add the IDs a hand-written flow lacks                                  |
| flow_export       | write a draw.io file (a page per level) or SVG images of a flow        |
| source_outline    | read playbooks, a folder, a role or an AWX export to import            |
| flow_import       | import a playbook or AWX template one to one (exact copy only)         |

Workflow:

1. `flow_list`, then `flow_describe` the flow you will change. Keep its `revision`. For a new
   flow use `flow_new`: it starts as `start -> done`, and `add_node` with
   `after: "start.ok_hosts"` puts the first step between them, `after: "<step>.ok_hosts"` the
   next, and so on.
2. Plan the change in diagram terms. When the user's intent is unclear (what should happen to
   failed hosts? which module?), ask before editing.
3. Send one `flow_edit` batch with the revision. Use `dry_run: true` first for large changes.
4. Read the answer: `Created`, `New problems`, the new revision. Fix new problems in the next
   batch, or tell the user why they stay.
5. Tell the user what changed on the diagram. The designer canvas updates by itself.

When the user wants a picture, a draw.io file or an image of a flow, run `flow_export`
(`format: drawio`, or `svg` with `level: top | all | <subflow>`) instead of drawing it in draw.io,
PlantUML or Mermaid. It keeps the canvas look and puts each node's details into draw.io shape data.

If an op fails, nothing was written: the error names the op and says how to fix it (nearest keys,
the ports a node has). Correct that op and send the whole batch again.

## Import playbooks or AWX templates

Design by intent unless the user asks for an exact copy (then `flow_import` does it in one call).
1. `source_outline` the playbook, folder or AWX export, with `flow` set to the file you will write.
   Each `#n` task has the `impl` (module or role, params, register, keywords) to copy as is.
2. Plan a few subflows by purpose (pre-checks, backup, change, verify, rollback or notify), steps
   named by what they achieve, in the order the source runs them.
3. `flow_new`, then a `flow_edit` batch per level: `add_node` with the copied `impl` (`in:` puts it
   in a subflow), `set_io` for what later steps read (registers, loaded variables). Play vars and
   prompts become flow inputs, secrets without a default.
4. Keep behaviour: task keywords stay in `impl.keywords`; handle a fail port only where the source
   does (rescue, `ignore_errors`, retries), leave the rest open; a handler is a step with
   `keywords.when: "(<register> | default({})) is changed"`.
5. `flow_validate`, then report how you grouped the tasks and what you left out.

## Rules

- Never write or invent IDs (26-character ULIDs). Name nodes by key: `check-ntp`. Steps inside a
  subflow: `subflow/step`, e.g. `fix-ntp/push-config`. Ports: `node.port`.
- Keys are lowercase letters, digits and dashes, unique on their level. add_node derives the key
  from the title unless you pass one.
- One wire per output port. To put a step between two nodes use add_node with `after` (or
  `on_wire`) on the first one's port. To run several things at once use a parallel node
  (branches) and a join node.
- No cycles: flows run top-down. For retries use `apply_pattern` with `retry`.
- Wires stay on one level. Hosts enter a subflow through its entry (`set_entry`) and leave
  through exits (`add_exit`) mapped to the subflow node's ports.
- Optional ports (unreachable, unchanged, always, timeout, cancelled, undo) must be enabled with
  `enable_port` before they are wired.
- Every fail port (failed_hosts, unreachable, timeout, rejected) must be handled: wired to a
  handler (`apply_pattern` rollback, notify-stop, retry, exclude, stop), or left open on purpose
  with `leave_open` and a reason the user agrees with. Do not leave them open silently.
- Patterns that end hosts reuse an end node only by key (stopped, failed, excluded, done), else
  they add one. Pass `end` to `apply_pattern` to choose the end, e.g. a rejected approval to
  `not-approved`; the answer names the end it used.
- `status` goes draft → specified (has inputs or outputs) → implemented (bound to code). Never set
  `tested`: only a passing run sets it.
- Do not edit `flow.version`, IDs or anything under `generated/`: the tools bump the version and
  regenerate code. Positions change only through the layout ops (see Layout).
- Bindings (`bind`): use fully qualified names (`ansible.builtin.command`, `cisco.ios.ios_config`)
  that exist; ask the user when unsure. Without a binding a node runs as a TODO stub, which is fine
  while designing. Task keywords go in `impl.keywords` (`when`, `loop`, `ignore_errors`,
  `delegate_to`, …); register, tags, become, timeout, retries and until have their own fields.
- Use fictional sample values in examples (192.0.2.0/24, example.net); never put secrets in a
  flow. Credentials are AWX credential names (`settings.credential`).

## Data between steps

Values pass through node inputs and outputs, never through variables a step happens to leave on
the host. The designer checks every name a step reads, and the generated code passes inputs in.

- An output: `set_io` on the producer, e.g. `fgt_facts` with `from: impl.register` (the module's
  registered result) or `impl.register.dest`. A `set_fact` step's outputs need no `from`.
- An input: `set_io` on the reader with `from:`
  - `<key>.<output>`: a node that runs before, on this level or around it;
  - `flow.<input>`: a flow input;
  - inside a subflow, `<subflow key>.<input>`: that subflow's own input. Give the subflow the input
    first (`from: backup.backup_file`), then its steps read `rollback.backup_file`.
- Parameters read inputs by name: `{{ fw_blob }}`. So do `assert` `that:` lists and decision
  conditions (no braces): `fos_version == target_version` needs inputs `fos_version` and
  `target_version` on that node.
- From outside a subflow you read what it lifts: an output of the subflow node naming an inner
  step's output (`from: normalize-facts.fos_platform`; without `from`, the inner output of the same
  name). Easier: give the path `precheck/normalize-facts.fos_platform` as the `from` of `set_io`;
  the tool adds the output to `precheck` and stores `precheck.fos_platform`.
- Polling: `settings.retries` with `settings.until`, a test on the step's registered result
  without braces (`wait_ha_result.json.results.ha_members | length == 2`), and `settings.delay`
  seconds between tries. describe shows the register name (`register: wait_ha_result`).
- Approvals approve by themselves in local runs; `-e '{"afd_approvals": {"approve": "rejected"}}'`
  takes another port. AWX workflow runs wait in a real approval node.

## Layout

Leave positions out unless the user asks for an arrangement: the canvas places every node that has
no position next to its neighbours, and lays out a new flow by itself. On a flow the user arranged
by hand, place a new node relative to a neighbour when its spot matters (a handler beside the step
it handles).

- When the user says where things go ("the handler to the right of the push", "notify under the
  rollback"), pass `position` to add_node, apply_pattern or extract_subflow, or `move` nodes later.
  A position is `{x, y}` (top-left corner, canvas pixels, y grows down) or one of `below`, `above`,
  `right_of`, `left_of` naming a node on the same level, with an optional `gap`. Prefer relative
  places: they step aside until the spot is free.
- `flow_describe` with `layout: true` shows each node `at x,y` (stored) or `auto x,y` (shown now)
  and a layout check of what you cannot see: overlaps, a wire through a box, labels on boxes or each
  other, crossings. Wires step round boxes where a gap lets them; one still through a box: `move` it.
- The first position on a level the canvas lays out also stores the others where they are shown,
  so nothing jumps. flow_edit checks every level it placed nodes on. Check before you finish.
- `unplace` (nodes or a `level`) hands nodes back to the canvas; `tidy_up` re-lays a level.

## Notes, sections and text

`annotate` (format 2): a note (`on` a node, it moves with it and becomes a comment in its code), a
`section` (carries what is inside) or `text`. Markdown; never runs; no version change.

## Ops cheat sheet

```json
{"op": "add_node", "type": "subflow", "title": "Pre-checks", "after": "start.ok_hosts"}
{"op": "add_node", "type": "task", "title": "Check NTP", "on_wire": "precheck.ok_hosts"}
{"op": "add_node", "type": "task", "title": "Verify sync", "after": "fix-ntp/push-config.ok_hosts"}
{"op": "connect", "from": "check-ntp.ok_hosts", "to": "backup-config"}
{"op": "rewire", "from": "check-ntp.ok_hosts", "to": "report"}
{"op": "apply_pattern", "at": "push-config.failed_hosts", "pattern": "rollback"}
{"op": "leave_open", "at": "check-ntp.failed_hosts", "reason": "Read-only check"}
{"op": "enable_port", "node": "push-config", "port": "unreachable"}
{"op": "update_node", "node": "check-ntp", "intent": "Compare NTP servers with the standard"}
{"op": "set_io", "node": "check-ntp", "side": "outputs", "name": "ntp_ok", "field": {"type": "boolean"}}
{"op": "set_io", "node": "rollback/restore", "side": "inputs", "name": "backup_file", "field": {"type": "string", "from": "rollback.backup_file"}}
{"op": "set_io", "node": "upgrade/load-image", "side": "inputs", "name": "fos_platform", "field": {"type": "string", "from": "precheck/normalize-facts.fos_platform"}}
{"op": "update_node", "node": "upgrade/wait-ha", "settings": {"retries": 60, "delay": 30, "until": "wait_ha_result.json.results.ha_members | length == 2"}}
{"op": "apply_pattern", "at": "approve.rejected", "pattern": "stop", "end": "not-approved"}
{"op": "bind", "node": "check-ntp", "impl": {"kind": "module", "ref": "cisco.ios.ios_command", "params": {"commands": ["show ntp associations"]}}}
{"op": "extract_subflow", "nodes": ["backup-config", "push-config"], "title": "Change"}
{"op": "add_node", "type": "task", "title": "Notify on-call", "after": "rollback.ok_hosts", "position": {"below": "rollback"}}
{"op": "move", "nodes": {"failed": {"below": "notify-on-call"}, "report": {"x": 480, "y": 640}}}
{"op": "unplace", "level": "top"}
{"op": "delete", "nodes": ["old-step"]}
```

`flow_reference` with topic `ops` lists every op with its fields; `ports` lists the ports of each
node type; `patterns` the failure patterns. See [examples.md](examples.md) for whole batches.

## Scenario tests

A flow can have `<flow key>.scenarios.yaml` next to it: per scenario, `inputs` (the targets input
lists the hosts), `force` (step key or `sub/step` -> `failed`, `unreachable`, `timeout`, `unchanged`,
or `false` on a decision -> hosts), optional `approvals` and `groups`, and `expect` (host -> end node
key, or `<step>.<port>` for an unwired output). Every step runs as its stub on local hosts; decisions
take true unless forced. Write it with your file tools; run it with Ansible Flow: Run Scenarios, or
`node .afd/afd-scenarios.js --image <EE image> flows` (exit 1 when a scenario fails). When you
change a flow's wiring, run its scenarios.

## Without the tools

Edit the YAML directly, by key:

- Leave every `id:` out. Wires and references name nodes by key:
  `{from: {node: check-ntp, port: ok_hosts}, to: {node: done, port: in}}`.
- New nodes need `key`, `type` and `title`; add `intent` in one sentence.
- Follow the rules above (one wire per output, handle fail ports, no `tested`).
- Then ask the user to run **Complete IDs**: the banner in the designer, or the lightbulb quick fix
  in the YAML editor. It adds the IDs in one edit. Until then the designer shows the flow but
  refuses canvas edits, runs and code generation.

The full format is in [references/format.md](references/format.md); ops and problem codes are in
[references/ops.md](references/ops.md).

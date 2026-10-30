---
name: ansible-flow
description: Read, design and change Ansible Flow Designer flows (*.flow.yaml), the diagrams of typed nodes wired port to port that generate Ansible playbooks. Use when the user asks to create or change a flow, add or move steps, wire nodes, handle failures, put steps into a subflow, bind modules or roles, or explain or fix flow problems.
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

Workflow:

1. `flow_list`, then `flow_describe` the flow you will change. Keep its `revision`.
2. Plan the change in diagram terms. When the user's intent is unclear (what should happen to
   failed hosts? which module?), ask before editing.
3. Send one `flow_edit` batch with the revision. Use `dry_run: true` first for large changes.
4. Read the answer: `Created`, `New problems`, the new revision. Fix new problems in the next
   batch, or tell the user why they stay.
5. Tell the user what changed on the diagram. The designer canvas updates by itself.

If an op fails, nothing was written: the error names the op and says how to fix it (nearest keys,
the ports a node has). Correct that op and send the whole batch again.

## Rules

- Never write or invent IDs (26-character ULIDs). Name nodes by key: `check-ntp`. Steps inside a
  subflow: `subflow/step`, e.g. `fix-ntp/push-config`. Ports: `node.port`.
- Keys are lowercase letters, digits and dashes, unique on their level. add_node derives the key
  from the title unless you pass one.
- One wire per output port. To put a step between two nodes use add_node with `on_wire`. To run
  several things at once use a parallel node (branches) and a join node.
- No cycles: flows run top-down. For retries use `apply_pattern` with `retry`.
- Wires stay on one level. Hosts enter a subflow through its entry (`set_entry`) and leave
  through exits (`add_exit`) mapped to the subflow node's ports.
- Optional ports (unreachable, unchanged, always, timeout, cancelled, undo) must be enabled with
  `enable_port` before they are wired.
- Every fail port (failed_hosts, unreachable, timeout, rejected) must be handled: wired to a
  handler (`apply_pattern` rollback, notify-stop, retry, exclude, stop), or left open on purpose
  with `leave_open` and a reason the user agrees with. Do not leave them open silently.
- `status` goes draft → specified (has inputs or outputs) → implemented (bound to code). Never set
  `tested`: only a passing run sets it.
- Do not edit `flow.version`, IDs, `layout` or anything under `generated/`: the tools bump the
  version, keep positions and regenerate code.
- Bindings (`bind`): use fully qualified names (`ansible.builtin.command`, `cisco.ios.ios_config`)
  that exist; ask the user when unsure. Without a binding a node runs as a TODO stub, which is fine
  while designing.
- Use fictional sample values in examples (192.0.2.0/24, example.net); never put secrets in a
  flow. Credentials are AWX credential names (`settings.credential`).

## Ops cheat sheet

```json
{"op": "add_node", "type": "task", "title": "Check NTP", "on_wire": "precheck.ok_hosts"}
{"op": "add_node", "type": "task", "title": "Verify sync", "after": "fix-ntp/push-config.ok_hosts"}
{"op": "connect", "from": "check-ntp.ok_hosts", "to": "backup-config"}
{"op": "rewire", "from": "check-ntp.ok_hosts", "to": "report"}
{"op": "apply_pattern", "at": "push-config.failed_hosts", "pattern": "rollback"}
{"op": "leave_open", "at": "check-ntp.failed_hosts", "reason": "Read-only check"}
{"op": "enable_port", "node": "push-config", "port": "unreachable"}
{"op": "update_node", "node": "check-ntp", "intent": "Compare NTP servers with the standard"}
{"op": "set_io", "node": "check-ntp", "side": "outputs", "name": "ntp_ok", "field": {"type": "boolean"}}
{"op": "bind", "node": "check-ntp", "impl": {"kind": "module", "ref": "cisco.ios.ios_command", "params": {"commands": ["show ntp associations"]}}}
{"op": "extract_subflow", "nodes": ["backup-config", "push-config"], "title": "Change"}
{"op": "delete", "nodes": ["old-step"]}
```

`flow_reference` with topic `ops` lists every op with its fields; `ports` lists the ports of each
node type; `patterns` the failure patterns. See [examples.md](examples.md) for whole batches.

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

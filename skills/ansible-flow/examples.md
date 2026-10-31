# Worked examples

Each example is one `flow_edit` call on this flow (`edge-baseline.flow.yaml`):

```text
start -> precheck -> backup-config -> push-baseline -> validate -> done
push-baseline.failed_hosts -> rollback -> failed
open fail ports: precheck.failed_hosts, validate.failed_hosts, rollback.failed_hosts
```

## Add a step between two nodes and handle its failures

"Check NTP after the pre-checks; if it fails, tell on-call and stop."

```json
{
  "ops": [
    {
      "op": "add_node",
      "type": "task",
      "title": "Check NTP",
      "on_wire": "precheck.ok_hosts",
      "intent": "Compare the NTP servers with the standard"
    },
    { "op": "apply_pattern", "at": "check-ntp.failed_hosts", "pattern": "notify-stop" }
  ]
}
```

## Handle the open fail ports

"Roll back when validation fails; stopping after a failed pre-check is fine."

```json
{
  "ops": [
    { "op": "apply_pattern", "at": "validate.failed_hosts", "pattern": "rollback" },
    {
      "op": "leave_open",
      "at": "precheck.failed_hosts",
      "reason": "Nothing changed yet; stopping is safe"
    },
    { "op": "connect", "from": "rollback.failed_hosts", "to": "failed" }
  ]
}
```

## Run two things at once

"While the pre-checks pass, also read the NTP state; continue when both are done."

```json
{
  "ops": [
    {
      "op": "add_node",
      "type": "parallel",
      "title": "Collect facts",
      "key": "collect",
      "on_wire": "precheck.ok_hosts"
    },
    { "op": "add_node", "type": "join", "title": "Facts ready", "on_wire": "collect.branch_1" },
    { "op": "add_node", "type": "task", "title": "Read NTP", "after": "collect.branch_2" },
    { "op": "connect", "from": "read-ntp.ok_hosts", "to": "facts-ready" },
    {
      "op": "leave_open",
      "at": "read-ntp.failed_hosts",
      "reason": "Read-only; the report lists them"
    }
  ]
}
```

## Give a step its inputs, outputs and code

"Pre-checks should ping the devices and report which are fine."

```json
{
  "ops": [
    {
      "op": "bind",
      "node": "precheck",
      "impl": { "kind": "module", "ref": "ansible.builtin.ping" }
    },
    {
      "op": "set_io",
      "node": "precheck",
      "side": "outputs",
      "name": "reachable",
      "field": { "type": "boolean" }
    },
    { "op": "update_node", "node": "precheck", "status": "implemented" }
  ]
}
```

## Group steps into a subflow

"Make pre-checks and backup one 'Prepare' step."

```json
{ "ops": [{ "op": "extract_subflow", "nodes": ["precheck", "backup-config"], "title": "Prepare" }] }
```

Afterwards the steps are `prepare/precheck` and `prepare/backup-config`.

## Build the inside of a subflow

"Validate should be two steps: compare the config, then check the services."

```json
{
  "ops": [
    {
      "op": "add_node",
      "type": "subflow",
      "title": "Validate all",
      "on_wire": "push-baseline.ok_hosts"
    },
    { "op": "add_node", "in": "validate-all", "type": "task", "title": "Compare config" },
    {
      "op": "add_node",
      "type": "task",
      "title": "Check services",
      "after": "validate-all/compare-config.ok_hosts"
    },
    { "op": "set_entry", "subflow": "validate-all", "node": "compare-config" },
    { "op": "add_exit", "from": "validate-all/check-services.ok_hosts", "port": "ok_hosts" },
    {
      "op": "add_exit",
      "from": "validate-all/compare-config.failed_hosts",
      "port": "failed_hosts"
    },
    {
      "op": "add_exit",
      "from": "validate-all/check-services.failed_hosts",
      "port": "failed_hosts"
    },
    { "op": "apply_pattern", "at": "validate-all.failed_hosts", "pattern": "notify-stop" }
  ]
}
```

## Place nodes where the user wants them

"Tell on-call after a rollback; put that step under the rollback and the failed end under it."

```json
{
  "ops": [
    {
      "op": "add_node",
      "type": "task",
      "title": "Notify on-call",
      "after": "rollback.ok_hosts",
      "position": { "below": "rollback" }
    },
    { "op": "move", "nodes": { "failed": { "below": "notify-on-call" } } }
  ]
}
```

Without `position` the new step goes where the canvas places it, next to its neighbours.
`flow_describe` with `layout: true` shows the coordinates; `unplace` with `level: top` hands the
whole level back to automatic placement, and `tidy_up` stores a fresh layered layout.

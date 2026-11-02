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

## Import a playbook by intent

"Turn site.yml into a flow." After `source_outline` (path `site.yml`, flow
`flows/edge-baseline/edge-baseline.flow.yaml`), two tasks of the pre-checks play become steps of a
`pre-checks` subflow, each with the `impl` the outline showed, copied as is; the second reads the
first one's registered result.

```json
{
  "ops": [
    {
      "op": "add_node",
      "type": "subflow",
      "title": "Pre-checks",
      "after": "start.ok_hosts",
      "intent": "Stop before the change on switches that run an unsupported version"
    },
    {
      "op": "add_node",
      "in": "pre-checks",
      "type": "task",
      "title": "Read the software version",
      "impl": {
        "kind": "module",
        "ref": "ansible.builtin.command",
        "params": { "cmd": "show version | include Version" },
        "register": "version_check",
        "keywords": { "changed_when": false }
      }
    },
    {
      "op": "add_node",
      "type": "task",
      "title": "Check the version is supported",
      "after": "pre-checks/read-the-software-version.ok_hosts",
      "impl": {
        "kind": "module",
        "ref": "ansible.builtin.assert",
        "params": { "that": ["version_check.stdout is version('17.0', '>=')"] }
      }
    },
    {
      "op": "set_io",
      "node": "pre-checks/read-the-software-version",
      "side": "outputs",
      "name": "version_check",
      "field": { "type": "dict", "from": "impl.register" }
    },
    {
      "op": "set_io",
      "node": "pre-checks/check-the-version-is-supported",
      "side": "inputs",
      "name": "version_check",
      "field": { "type": "dict", "from": "read-the-software-version.version_check" }
    }
  ]
}
```

Failures the playbook does not handle stay open; `flow_validate` lists them for the user to decide.

## Explain the flow on the canvas

"Note why the pre-checks are safe to rerun, and mark the change window." (Annotations are format 2,
so this flow is upgraded first; on a format 2 flow leave `upgrade_format` out.)

```json
{
  "ops": [
    { "op": "upgrade_format" },
    {
      "op": "annotate",
      "on": "precheck",
      "text": "Read-only checks: **safe** to rerun.\nRunbook: https://wiki.example.net/edge-baseline"
    },
    {
      "op": "annotate",
      "kind": "section",
      "text": "Change window",
      "position": { "left_of": "backup-config", "gap": 24 },
      "width": 560,
      "height": 380,
      "color": "blue"
    },
    { "op": "annotate", "kind": "text", "text": "Edge baseline", "size": "l", "position": { "above": "precheck" } }
  ]
}
```

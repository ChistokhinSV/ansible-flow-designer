# ADR-0004 · Flow model: additive schema v1, port catalog, subflows, status

Status: Accepted · 2026-10-28 · AFD-1

## Schema (additive, `schema_version` stays 1)

`schema/flow.schema.json` at the repo root is canonical; the handoff copy is kept unchanged. Both examples stay valid.
- Node: optional `join_mode: all|any`, `branches: integer >= 2` (parallel), `handler: rollback|notify|retry|exclude` (amber style, D-11 Rollback discovery, port-menu suggestions).
- Contract item: optional `targets: boolean` (flow inputs).
- Port names match `^[a-z][a-z0-9_]*$`; `ports` also accepts `branch_<n>`.

## Port catalog (`src/core/flow/ports.ts`)

| Type          | Default ports                                   | Optional                                                             |
| ------------- | ----------------------------------------------- | -------------------------------------------------------------------- |
| start         | out `ok_hosts`                                  | none                                                                 |
| end           | in `in`                                         | none                                                                 |
| task, subflow | `in`, `ok_hosts`, `failed_hosts`                | `unreachable`, `unchanged`, `always`, `cancelled`, `timeout`, `undo` |
| decision      | `in`, `true`, `false`                           | none                                                                 |
| approval      | `in`, `approved`, `rejected`                    | `timeout`                                                            |
| parallel      | `in`, `branch_1..n` (n = `branches`, default 2) | none                                                                 |
| join          | `in`, `ok_hosts`                                | `failed_hosts`                                                       |

Fail-type ports (counted by the open-port banner): `failed_hosts`, `unreachable`, `timeout`, `rejected`.

## Semantics

- **Host sets:** the hosts arriving on a node's `in` are its targets. A flow-level `host_list` input seeds start (the first one, or the one marked `targets: true`). Node-level `host_list` inputs are informational (validator: info). `settings.inventory_target` stays the explicit override checked by the Inventory lens.
- **Subflows:** `type: subflow` means the node has an inner graph; `impl: role` optionally names the role that implements it. An inner open fail port bubbles to the parent's port of the same name when that port is enabled and counts once there; only ports that cannot bubble count as inner. A subflow's status is the lowest status of its inner nodes.
- **Status:** stored in the file; actions advance it (contract saved → specified, binding saved → implemented, passing run → tested proposal); the inspector stepper allows manual setting; the validator warns when status overclaims and never rewrites it. The one automatic change is the `tested` drop-back below (decided 2026-10-29, AFD-12; it takes precedence over decision 24).
- **`tested`:** a passing non-check run of the current `flow.version`. A change to the node's design drops it back to implemented, so `tested` always means "this design ran":
  - the design is the node's entry without its status, inner nodes included and positions left out; wiring is the flow's, not the node's;
  - canvas commands drop it in the same edit, and a save drops it for hand edits made since the file on disk;
  - a status set by the same command stays;
  - a key rename also changes the nodes whose `from:` references it rewrites, so they drop too;
  - a run keeps each node's design fingerprint from its start, and nodes changed since then are not proposed.
- **Open on purpose:** anyone may set it; a reason is required; `by` comes from git `user.name`, falling back to the OS user.
- **Data ports:** shown in the Data lens only; data wires are derived from contract `from:` references and never stored as edges.
- **Key renames** rewrite every `from: <oldkey>.*` reference in the same edit (one undo step), because `from:` references keys while edges reference IDs.

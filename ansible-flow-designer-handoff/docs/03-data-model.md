# 03 · Data model

The flow document is the single source of truth. It is stored as YAML in Git next to the Ansible code it describes. The formal schema is `schema/flow.schema.json`; examples are in `examples/`.

## Top level

```yaml
schema_version: 1
flow:
  id: 01JB8Z3K7QH2X9WFA4M6TP0R8C   # ULID, immutable
  key: edge-baseline               # slug, editable
  name: Edge baseline
  version: 3                       # bumped on each saved change
  goal: >-
    All edge switches at a site get the NTP, AAA and syslog baseline...
  owner: netops
  runtime: { kind: awx_workflow, template: "[AWX TEMPLATE NAME]" }
  inputs:                          # JSON-Schema-like contract
    site:    { type: string, required: true }
    devices: { type: host_list, required: true }
    dry_run: { type: boolean, default: false }
nodes: [ ... ]
edges: [ ... ]
layout: { ... }                    # UI only, see D-30
decisions: [ ... ]                 # recorded "open on purpose" choices
```

## Node

| Field | Type | Notes |
|---|---|---|
| `id` | ULID | Immutable (D-06). |
| `key` | slug | Unique within the flow, editable. Used in generated task names. |
| `type` | enum | `task`, `subflow`, `decision`, `approval`, `parallel`, `join`, `start`, `end`. |
| `title` | string | Display name. |
| `intent` | string | One or two sentences. Used for skeleton TODO text and module search ranking. |
| `status` | enum | `draft`, `specified`, `implemented`, `tested` (D-04). Not used for start/end. |
| `inputs` | map | Contract inputs: name → `{type, required, from?}`. |
| `outputs` | map | Contract outputs: name → `{type, from?}` (`from` may reference a module return). |
| `ports` | list | Enabled optional ports (defaults come from the type, see port catalog). |
| `impl` | object or null | Binding, see below. |
| `subflow` | object | For `type: subflow`: inner `nodes`, `edges`, `layout`, and `boundary` mapping. |
| `settings` | object | `max_fail_percentage`, `serial`, `timeout`, `retries`, `become`, `tags`, `execution_environment`, `credential`, `inventory_target`. |
| `undo` | object or null | Compensation binding for the `undo` port (D-11). |

### Implementation binding (`impl`)

```yaml
impl:
  kind: module            # module | role | playbook
  ref: cisco.ios.ios_config
  collection_version: "9.0.3"
  params:
    lines: ["boot system flash:{{ target_image }}"]   # chips serialize to Jinja (D-26)
    save_when: modified
  register: boot_result
```

## Port catalog

| Port | Direction | Kind | Default on types | Meaning |
|---|---|---|---|---|
| `in` | in | control | all except start | Hosts entering the node. |
| `ok_hosts` | out | control | task, subflow | Hosts that finished without failure. |
| `failed_hosts` | out | control | task, subflow | Hosts that failed. |
| `unreachable` | out | control | task, subflow (optional) | Hosts Ansible marked unreachable. |
| `unchanged` | out | control | task, subflow (optional) | Hosts with `changed == false`. |
| `always` | out | control | task, subflow (optional) | Fires after the node regardless of outcome. |
| `cancelled` | out | control | task, subflow (optional) | Job cancelled while the node ran. |
| `timeout` | out | control | task, subflow, approval (optional) | Node exceeded its timeout. |
| `undo` | in | control | task, subflow (optional) | Compensation entry point. |
| `true` / `false` | out | control | decision | Branch on a condition, per host. |
| `approved` / `rejected` | out | control | approval | Approval result (whole host set). |
| `branch_n` / `join` | out / in | control | parallel / join | Fan-out and fan-in; join has `mode: all | any`. |
| data ports | in / out | data | any | One per contract input or output; hidden by default. |

Every output control port carries a host set. A port that receives zero hosts is "not taken" for that run.

### Port state on a node

`connected`, `open`, `open_on_purpose` (with a recorded reason in `decisions`). Open fail-type ports (`failed_hosts`, `unreachable`, `timeout`, `rejected`) count toward the open-port warning.

## Edge

```yaml
- id: 01JB8Z5C2RNW...
  from: { node: 01JB8Z4A1XKM..., port: ok_hosts }
  to:   { node: 01JB8Z4B9MPT..., port: in }
```

Several edges may enter the same input port (merge). An output port may have one edge; use a `parallel` node to fan out.

## Subflow boundary

```yaml
subflow:
  boundary:
    in: 01JB...STAGE           # inner node receiving the parent's in
    outputs:
      ok_hosts:     [{ node: 01JB...VERIFY, port: ok_hosts }]
      failed_hosts: [{ node: 01JB...VERIFY, port: failed_hosts }]
      unreachable:  [{ node: 01JB...WAITSSH, port: unreachable }]
```

Validation: every enabled parent output port must be fed by at least one inner exit; every inner open fail port is reported at the parent level too.

## Layout

```yaml
layout:
  01JB8Z4A1XKM...: { x: 120, y: 160 }
```

Kept separate so that dragging nodes does not touch semantic fields (D-30). The UI may store it in a sibling file `<flow>.layout.yaml`.

## Run data (not stored in the flow document)

Run mode reads AWX job events and the engine's host-set ledger: per node, per port, the hosts that took the path, timings, and errors. Keyed by node ID.

## Drift record (computed, not stored)

```yaml
- kind: contract_mismatch | code_without_design | design_without_code
  node: 01JB...
  detail: "design expects validation_result, code registers diff_report"
```

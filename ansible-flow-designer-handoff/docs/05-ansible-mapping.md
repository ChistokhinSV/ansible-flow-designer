# 05 · Ansible and AWX mapping

How the flow document becomes Ansible content, how runs and code map back to nodes, and where Ansible or AWX semantics force engine design choices.

## Granularity

| Flow concept | Ansible / AWX artifact |
|---|---|
| Flow (top level) | One generated playbook per flow level, or an AWX workflow job template |
| Subflow node | Role, or a separate playbook / job template |
| Task node | One play (generated) that runs a module task, an `include_role`, or an `import_playbook` |
| Decision node | Play on the incoming hosts that evaluates a condition per host and routes |
| Approval node | AWX workflow approval node, or an engine-side approval gate |
| Start inputs | Survey / extra vars; validated against the flow input contract |

Tasks inside a role are never modeled as nodes (D-05).

## Generated code conventions

- Repository layout suggestion:
  ```
  flows/<flow-key>/flow.yaml
  flows/<flow-key>/flow.layout.yaml
  flows/<flow-key>/generated/playbook.yml   # do not edit by hand
  roles/...                                  # hand-written, bound by nodes
  ```
- Every generated play and task name starts with `[<node-key>]`.
- Every generated play carries tag `node_<ULID>` and the variable `flow_node_id`.
- Flow inputs become extra vars; node inputs that reference upstream outputs are passed explicitly as vars.
- Role bindings use `ansible.builtin.include_role` with `apply: { tags: [node_<ULID>] }` so tags reach the role's tasks.
- Role contracts should be backed by `meta/argument_specs.yml`; the designer can generate it from the node's input contract, and Ansible validates inputs at run time.

## Walking skeleton (D-03)

A draft node compiles to:

```yaml
- name: "[validate] TODO"
  ansible.builtin.debug:
    msg: "TODO: Compare running config with desired state"
```

The whole flow can be launched in check mode (`--check`). Bound nodes must declare whether their module supports check mode; the properties panel shows it, and the validator warns when a bound node does not.

See `examples/edge-baseline.skeleton.yml` for a generated skeleton.

## Ports and host sets

This is the most important engine decision.

**Ansible behavior to design around**

- Within one playbook run, a host that fails a task is removed from the rest of the run unless the failure is handled (`block`/`rescue`, `ignore_errors`).
- `rescue` does not catch unreachable hosts. `ignore_unreachable: true` exists as a task keyword. Hosts that became unreachable can be computed in a later play from the difference between `ansible_play_hosts_all` and `ansible_play_hosts`, minus hosts already recorded as failed.
- `changed` is per task per host and can be registered.

**AWX behavior to design around**

- Workflow edges are `success`, `failure`, `always` per job, not per host.
- Approval nodes exist; both denial and timeout follow the failure path, so `rejected` and `timeout` cannot be told apart by AWX edges alone.
- `set_stats` artifacts from one job become extra vars for downstream workflow nodes. Inventory `limit` is not templated from artifacts, but a play's `hosts:` can be templated from a variable.

**Option A, recommended for v1: compile each flow level into one playbook with host-set routing**

Each node becomes a play. Its tasks run inside `block`/`rescue`. The block's last task adds the host to a dynamic group `flow_<key>_ok_hosts` with `ansible.builtin.group_by`; the rescue adds it to `flow_<key>_failed_hosts`. A small router play on `localhost` derives `unreachable` and `unchanged` groups from `hostvars` and registered results. Downstream plays target the group of the port they are wired to, for example `hosts: flow_precheck_ok_hosts`. Merges target a union of groups (`hosts: "flow_a_failed_hosts:flow_b_failed_hosts"`).

Pros: true per-host semantics, single AWX job, works with plain `ansible-playbook`. Cons: one long job per flow level; approval gates must split the playbook (one job before, one after).

**Option B: AWX workflow with engine-carried host sets**

Each node is a job template whose play uses `hosts: "{{ flow_hosts }}"`. Each job publishes per-port host lists with `set_stats`. Because AWX edges cannot select by port, the designer's backend orchestrates: it launches node jobs through the AWX API, reads artifacts, decides which ports fired, and launches the next jobs with `flow_hosts` set.

Pros: per-node jobs, native approvals, per-node retries. Cons: the backend becomes a workflow engine.

**Option C: plain AWX workflow export (compatibility)**

When a flow uses only whole-job semantics, export to an AWX workflow template: `ok_hosts` → success edge, `failed_hosts` → failure edge, `always` → always edge. The exporter must refuse or warn when a flow uses per-host splits, `unreachable`, `unchanged`, or distinct `rejected`/`timeout` handling.

The choice between A and B is an open question (06). Mockups assume per-host semantics either way.

## Compensation (`undo`)

Nodes with an `undo` binding compile an extra play or role call that is skipped in the normal path. The Rollback handler receives the failed host set and runs, in reverse execution order, the `undo` of every node those hosts completed. The engine needs a per-host ledger of completed nodes (a fact set per host, or engine-side state in Option B).

## Run mapping

- Option A: AWX job events carry play and task names; the `[node-key]` prefix plus `node_<ULID>` tag identifies the node. A small callback plugin that emits node ID, port, host and outcome makes this robust and is recommended.
- Option B: each job maps to one node directly.

Run mode reads these events to color nodes, label wires with host counts, and list per-host results.

## Code to design (sync and drift)

A sync job scans the repository at a commit:

1. Parse generated and hand-written playbooks; find `node_<ULID>` tags and `[key]` prefixes; match to nodes.
2. For role bindings, read `meta/argument_specs.yml` and compare with the node input contract; read registered variables and `set_stats` keys for outputs.
3. Report drift (D-29): `contract_mismatch`, `code_without_design` (tasks or plays without a node), `design_without_code` (nodes with no binding).

## Module documentation source

Use the execution environment the node runs in, so docs match what will actually run: `ansible-doc --json -t module <fqcn>` returns description, options (types, choices, defaults, required), return values, examples and attributes such as check mode support. Listing: `ansible-doc --list --json -t module`. Run these inside the EE image (for example through `ansible-navigator` or a container) and cache per EE image digest.

> Measured in the predecessor project (07 §2): for a whole catalog, `ansible-doc --metadata-dump --no-fail-on-errors <collection>` run per collection in parallel is far faster (37 s for 93 collections / 9,656 plugins, against 257 s for one dump). Module binding also needs the collection routing tables (redirects, deprecations, tombstones) to resolve short and removed names.

## Import

AWX workflow templates can be imported through the AWX API: workflow nodes become nodes, success/failure/always edges map to `ok_hosts`/`failed_hosts`/`always`, job template references become bindings. Positions are auto-laid out top-down.

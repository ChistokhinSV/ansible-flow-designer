# ADR-0015 · Import of AWX workflow templates

Status: Accepted · 2026-10-29 · AFD-15 (M9)

## Context

D-31 lets teams import the AWX workflow templates they already have. Those templates already have nodes and success/failure/always edges, and are auto-laid out on import. 05 §Import maps workflow nodes to flow nodes, the three edge kinds to `ok_hosts`/`failed_hosts`/`always`, and job template references to bindings. The ELK layout exists since M1 (Tidy up, ADR-0002).

AWX edges work per job, while flow ports work per host. AWX also counts an `always` edge as a failure handler: a workflow fails only when a node fails with no `failure` and no `always` edge.

Decisions by the user at the start of M9:
1. Sources: the AWX API (the M7 connection) and an `awx export` JSON file.
2. A one-time copy. The flow records its source for reference only; importing again makes a second flow.
3. A job template node always binds the template's playbook. Its status is implemented when that playbook is in this repository, otherwise draft.
4. An imported flow launches like any other flow (AFD code, AFD's job template, M7). The source workflow is never changed.

## Decision

**Command.** _Ansible Flow: Import AWX Workflow…_:
- picks the source: AWX (the workflow job templates of `afd.awx.url`, with the stored token) or an export file (`awx export --workflow_job_templates --job_templates`);
- picks the workflow, the repository (multi-root) and the flow key (default: the workflow name as a slug; an existing `flows/<key>/` is refused);
- writes `flows/<key>/<key>.flow.yaml` with ELK positions for every level, and opens it in the designer;
- shows how many steps were imported (implemented and draft), and the notes about what did not map one to one.

AWX is only read.

**One source shape.** `core/awx/workflow.ts` normalizes both sources into `WorkflowSource`: nodes by identifier, the template kind and name, job template details (playbook, project, credentials, EE, timeout, become, limit), node prompts (limit, tags, extra data, credentials), convergence, the approval timeout, the survey, extra vars and limit.
- **API:** one request each for the workflow, its survey (when enabled) and its nodes; one request per job template (cached), plus one per node only when its template prompts for credentials. An approval's timeout comes from the node summary.
- **Export file:** approvals appear as `create_approval_template`. A job template or nested workflow missing from the file is noted.
- Nested workflows are followed recursively. A cycle, or nesting deeper than four, stops with a note.

**Mapping** (`core/awx/import.ts`, pure).

| AWX                                        | Flow                                                                                                                                                                                                                       |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job template node                          | Task bound to the template's playbook (`impl.kind: playbook`); extra data become `params`, node limit (or the template's) `inventory_target`, tags `tags`; the machine credential, EE, become and timeout go to `settings` |
| Nested workflow                            | Subflow with the inner workflow as its level; entry `boundary.in`; open outcomes leave through `ok_hosts`                                                                                                                  |
| Approval                                   | Approval node; the timeout goes to `settings.timeout`; the `timeout` port is enabled on the same path as `rejected` when that path exists                                                                                  |
| Project or inventory sync, system job      | Draft task, intent "AWX project sync: …"                                                                                                                                                                                   |
| Node without a template                    | Draft task "Missing template" (AWX treats it as failed)                                                                                                                                                                    |
| `success` edge                             | `ok_hosts` (`approved`)                                                                                                                                                                                                    |
| `failure` edge                             | `failed_hosts` (`rejected`, and `timeout` when set)                                                                                                                                                                        |
| `always` edge                              | Both of the above                                                                                                                                                                                                          |
| Several children on one edge               | A parallel node (`after-<key>`) with one branch per child                                                                                                                                                                  |
| Several root nodes                         | Start → parallel (inside a subflow: the parallel is the entry)                                                                                                                                                             |
| Convergence "all" with two or more parents | A join (`join_mode: all`) in front of the node                                                                                                                                                                             |
| Convergence "any"                          | Several wires into `in`                                                                                                                                                                                                    |
| Outcome with no edge                       | A shared end `done` (inside a subflow: an exit to `ok_hosts`)                                                                                                                                                              |
| Failure with no edge                       | Stays open, so the banner shows it, because AWX fails the workflow there too. Inside a subflow, `failed_hosts` bubbles to the parent; an approval's `rejected` and `timeout` need an explicit exit                         |
- **Keys:** a node's key is its AWX identifier when the author set one. Generated UUIDs are replaced by the template name. Keys are made unique per level.
- **`always` on both ports:** wiring AWX `always` to the flow's `always` port would leave `failed_hosts` open. The banner would then flag a failure that AWX handles.
- **Status:**
  - a job node is implemented when its playbook exists in the repository (checked through `vscode.workspace.fs`), otherwise draft, with a note: the generated play cannot load until the playbook is added or the binding changes, and drift (M6) shows the missing file;
  - approvals and syncs are drafts;
  - a subflow's status follows its inner steps.

**Flow inputs.**
- A `host_list` input `devices` (`targets: true`) seeds start. Its default is the workflow's limit, when it has one.
- Survey questions become typed inputs: text, textarea, password and multiple choice are strings, integer is integer, multiselect is a list, and float is `any`.
- Extra vars become inputs with their values as defaults.

**Secrets.** These are imported by name only and listed in a note:
- values containing `$encrypted$`;
- survey passwords;
- variables whose names look secret (password, secret, token, API or private key, vault) in the survey, the extra vars or node extra data.

Nothing is decrypted, and no value reaches the file, logs or messages.

**Schema (additive, v1).** `flow.imported_from: {kind: awx_workflow, template, id?}` is shown read-only in the flow description. `id` is the AWX id; an export file has none.

**Lab.** `just awx-lab --fixtures` creates the fixture workflows in the snow_AWX AWX:
- seven job templates on the AFD lab project's `awx-e2e` playbook, and the Demo Job Template, whose playbook is not in the repository;
- `AFD fixture · upgrade steps` (project sync, convergence);
- `AFD fixture · edge upgrade` (approval with timeout, nested workflow, fan-out, `always`, a node without an identifier, a survey with a password).

`--record-import <file>` records the API answers the import reads, trimmed to the fields it uses. No Alpine or SSH target is needed.

**Tests.**
- **Unit:**
  - the API answers and the export file normalize to the same source;
  - the mapping on the fixture: nodes and wires per level, boundary, parallel and join nodes, statuses, settings, inputs, secrets, banner;
  - schema and validator clean, text round-trip, Option A codegen without errors;
  - ELK top-down without overlaps;
  - a golden file with fixed ids;
  - edge cases: several roots, UUID keys, self-nesting, missing templates, secret-looking names.
- **Integration (`just test-import`):**
  - the export file import opens clean in the designer (10 nodes, 15 wires, banner 3, no error diagnostics; the subflow shows 6 steps, the entry and an exit);
  - importing the same key again is refused;
  - with `AFD_TEST_IMAGE`, the imported flow runs as a skeleton with exit 0;
  - with the lab AWX, the API import gives the same flow as the file.

## Consequences

- An imported flow is a design to refine. AWX's per-job edges become per-host ports, and every node gets an `ok_hosts`/`failed_hosts` split it did not have before.
- AWX runs parallel children at the same time; the flow runs branches one after another (decision 16).
- A playbook binding routes only `ok_hosts` (ADR-0011). Hosts that fail inside an imported job template's playbook stop there until the node is rebound to a module or role.
- Since AFD-14, a node limit imported as `inventory_target` is applied: the node's playbook runs on that pattern, and the arriving hosts leave together (ADR-0009).
- Re-import does not merge. Keeping a flow in step with a changing AWX workflow needs a new import and a diff.

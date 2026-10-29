# Ansible Flow Designer

A VS Code extension for designing Ansible automation top-down. You sketch a flow as a graph of typed nodes and ports, run it as a walking skeleton, and then bind each node to a module, role or playbook. The flow document (`*.flow.yaml`) stays the source of truth: Ansible code is generated from it, and drift is detected in both directions.

**Status: M6 done.** The designer edits flows on a canvas (port menus, failure patterns, open-on-purpose decisions, subflows with a drill-down boundary view). It binds nodes to modules, roles and playbooks found in your execution environment's catalog, generates Ansible code that passes data between nodes on every save, and runs it as a walking skeleton or for real, mapping the results back to the nodes. Implementation mode compares the design with the code it runs and lists drift both ways. Run mode comes in M7 (plan: `docs/adr/`, handoff `docs/06`). Tracking: YouTrack project AFD (epic AFD-1, M1 = AFD-2, M2 = AFD-3, M3 = AFD-4, M4 = AFD-6, M5 = AFD-8, M6 = AFD-9), knowledge base AFD-A-1.

## What the designer does

- `*.flow.yaml` opens in the **Ansible Flow Designer** custom editor; _Open as Text_ (editor title bar) shows the YAML. Both views edit the same document, so save, dirty state, undo/redo, Git diff and hot exit are VS Code's own.
- **Canvas (Design mode):** nodes by type (task, subflow, decision, approval, parallel, join, start, end) and lifecycle status (draft, specified, implemented, tested); ports placed by role (control in on top, outcomes at the bottom, problems on the right, undo on the left); wires colored by port, dashed for problem paths; far zoom shows titles only.
- **Editing:** drag to move, drag from a port to another node to wire it, release on empty canvas to add a node there (Quick add), Delete/Backspace to remove, palette click or drag to add. The inspector edits title, key, intent, status, contract (inputs and outputs), optional ports and type-specific fields. The flow panel edits name, key, goal, owner and flow inputs and shows readiness counters.
- **Every canvas action is one minimal text edit** made by the extension host with a byte-preserving YAML engine: comments, quoting and formatting outside the edited lines never change, and one Ctrl+Z undoes one action.
- **Validation:** JSON Schema (`schema/flow.schema.json`) plus semantic checks (IDs, keys, ports, edges, references, decisions, subflow boundary, status) go to the Problems panel; open fail ports also show in the canvas banner. The schema is also registered with the Red Hat YAML extension for `*.flow.yaml` (`contributes.yamlValidation`), so _Open as Text_ gets completion and validation from it, and SchemaStore's unrelated Estuary Flow schema, which claims the same file pattern, no longer applies.
- **Layout** lives in one `layout:` block of the flow file. Flows without positions are auto-laid out (ELK) in memory and only written on the first move or _Tidy up_.
- **`flow.version`** is bumped once per commit on save when the semantic content changed (compared with Git HEAD), never for layout-only changes.
- **Ports appear when needed (M2):** at rest a node shows only wired ports, open fail ports (amber) and ports left open on purpose (gray). Hovering or selecting a node shows every port its type supports, with names; dragging a wire shows every input.
- **Port menus (M2):** click any port. An open port offers suggestions for its kind, for example `failed_hosts`: Rollback (existing), Notify on-call and stop, Exclude and report, Retry with backoff, Stop flow, Leave open on purpose. `unreachable` never offers Rollback. A wired port offers Insert node on this wire, Rewire to another node and Disconnect. The inspector lists every port with the same menu and quick fixes for open fail ports.
- **Failure patterns (M2):** drag Rollback from backup, Notify on-call and stop, Retry with backoff or Exclude and report from the palette onto an open fail port (or a node), or click one with a node selected. The handler node, its end node (reused when the flow has one) and all wires are created in one undo step.
- **Open on purpose (M2):** a reason is required; the decision records your Git user name in the flow's `decisions:` block and silences the warning. Wiring the port later removes the decision in the same edit.
- **Generated code (M3, ADR-0009):** saving a flow without errors writes `generated/<flow-key>.yml` next to it, plus `generated/<flow-key>.<subflow-key>.yml` per subflow level.
  - Plays come in graph order. Each one is named `[key] Title` and tagged `node_<ULID>`.
  - Hosts are routed between plays with `group_by`. Every task node rescues its failures, and a final **outcome play** fails the hosts left on open ports or failed end nodes. The job still ends red, but no branch is skipped.
  - Unbound nodes run a `TODO` debug message; role and module bindings run for real.
  - Files are written only when their content changed. A generated file edited by hand is never overwritten without asking.
  - The inspector shows each node's generated play.
- **Run as skeleton (M3):** the top bar button generates the code, asks for the flow inputs (remembered per flow), and runs `ansible-playbook --check` in a terminal, in your Ansible environment.
  - An event callback maps the run back to the flow: the top bar shows hosts, failures and the exit code, and the inspector lists the hosts that left each port.
  - _Run for real…_ first shows a confirmation naming the inventory, host count, hosts missing from the inventory and production-looking groups.
  - The vault password is asked per run when vault data is present, and is passed through an environment variable only.
  - Every launch is written to a local audit log (_Show Run Audit Log_), without input values.
- **Syntax check (M3):** _Check Generated Code (Syntax)_ runs `ansible-playbook --syntax-check` inside the environment. Errors land on the generated files in the Problems panel.
- **Subflows (M4, ADR-0010):** double-click a subflow (or press Enter, or use _Open subflow_) to open its inner steps.
  - The view shows a _Back_ button, a breadcrumb and chips for the context it inherits (inventory target, credential, EE, become, serial).
  - A dashed **boundary frame** carries the subflow's ports: `in` on top, outcomes below, problems on the right.
  - Drag from the frame's `in` to a step to make it the entry. Drag from an inner port to a frame port to make it an exit; an optional port is enabled on the subflow when needed.
  - Select an exit wire to give it a reason (shown on the wire, e.g. _SSH timeout_) or remove it.
  - The first step added to an empty subflow becomes its entry.
  - Everything inside works as on the top level, and each edit is one undo step.
  - The validator reports a missing entry, outer ports no inner step feeds, and inner outcomes that lead nowhere.
- **Preview card (M4, D-22):** pause about 400 ms on a subflow or a bound node.
  - The card shows its binding and status, the inner steps in order with their exits and last-run results, the undo binding and the settings.
  - _Peek code_ opens the generated play; _Open subflow_ drills in.
- **Node properties and binding (M5, ADR-0011):** the gear in the inspector (or _Bind module, role or playbook…_) opens a full page over the canvas with the tabs General, Implementation, Inputs and outputs, Ports and Execution.
  - **Find:** Module, Role or Playbook. Module search runs over the environment's catalog, starting from the node's intent. Results are ranked by the words, ansible.builtin, the collections the repository uses and the inventory's platform (`ansible_network_os`), and carry badges: in EE, check mode, diff, read-only, other platform (dimmed), deprecated. Roles come from `roles_path` with their `meta/argument_specs.yml`; playbooks from the repository.
  - **Understand:** the module's docs as text, its parameter table, the returns (click one to make it a node output) and an example; a role's entry points and argument spec; a playbook's plays and the hosts they target.
  - **Configure:** a form from the argument spec (choices, booleans, one line per list item, YAML for dicts), required and set parameters first. Values are Jinja: `{{ name }}` shows as a purple **input chip**, and typing `@` (or the @ button) offers node inputs, flow inputs and outputs of upstream nodes. Choosing one that is not an input yet adds it with its `from:`. Then the register name, a checklist (required parameters, where each variable comes from, check mode support, deprecation) and the generated task.
  - **Save binding** writes the binding, the inputs and outputs it added and the status (`implemented`) as one edit, one undo step. Renaming a node input later rewrites the parameters that read it.
- **Module catalog (M5):** the first search in a folder asks the probe to dump every collection's docs in the environment (`ansible-doc --metadata-dump`, about 30 s for a full EE, only new versions later) into VS Code's global storage. A worker builds an SQLite FTS5 index per collection set (about 3 s), so searches take milliseconds. _Rebuild Module Catalog_ re-dumps. The last index also checks bindings when the probe is not running: modules missing from the EE, removed or deprecated, redirected names, missing or unknown parameters, no check mode.
- **Data between nodes (M5):** an input `from: <node-key>.<output>` is passed to the node's play as a variable read from the upstream output. A module output `from: impl.register[.path]` reads the registered result; `from: flow.<input>` reads the flow input. Unbound nodes with outputs set placeholder facts, so skeleton runs carry data through. A playbook binding imports the playbook with `afd_hosts` set to the arriving hosts; its plays should target `"{{ afd_hosts }}"`.
- **Implementation mode (M6, mockup 04, ADR-0012):** the Implementation toggle in the top bar shows the same graph against the code.
  - **Re-sync from git** compiles, in your Ansible environment, the flow's generated playbook, every bound role entry point and every bound playbook (`Playbook.load` + `compile`, not regex). It labels them with the branch, the HEAD commit and its time, and counts the uncommitted files of the flow, its roles and playbooks. It runs on the first visit and again after each save.
  - **Nodes** show what they run (`role: netops_validate`, `module: …`, `playbook: …`) and "N tasks · drift: outputs differ" (or TODO stub, last run, open subflow). Select one to see its tasks with file and line; click to open them.
  - **Design vs code** lists the nodes matched by ID (`node_<ULID>` tags) and the drift items, each with an action on both sides. Nothing is resolved automatically.
    - **Contract mismatch:** outputs the role does not set ("Design expects `validation_result`, code registers `diff_report`": _Update design_ renames the output and its downstream references, _Open code_); required role arguments the node does not pass; module result keys that do not exist.
    - **Code without design:** a role task file the subflow does not cover (_Add to subflow_ adds it as an unwired step, or _Ignore_); generated plays for nodes that are gone.
    - **Design without code:** an unbound node (_Generate stub_ writes `roles/<node_key>/` with a TODO task, output facts and `meta/argument_specs.yml` from the inputs, and binds the node in one edit; or _Bind role_); missing roles and playbooks; nodes without a play.
    - Roles without argument specs and dynamic includes (not expanded) are notes. *Write argument_specs* creates the specs from the node contract.
    - **Ignore…** asks for a reason and records a `drift_ignored` decision in the flow with your Git user; ignored items stay listed with _Stop ignoring_.
- **Run mode with AWX (M7, ADR-0013):** _Set Up AWX Template_ picks the AWX project, inventory, execution environment and credentials. It creates or updates the job template `AFD · <flow key>` for the generated playbook and writes its name to `flow.runtime`.
  - _Launch in AWX_ (Implementation and Run modes, or the Command Palette) asks for the flow inputs and shows a confirmation with the targets and the commit, then launches the template with the inputs as extra vars. It follows the job's events until the job ends.
  - AWX runs the commit its project checks out. When that is not your HEAD (unpushed or uncommitted changes) you get a warning.
  - The token is checked against AWX before it is stored, in VS Code's secret storage only.
  - **Run mode** shows the last run (AWX or local) on the same canvas, read-only:
    - nodes show "3 hosts · 1 failed · 2.1 s", colored ok, warn (some hosts took a fail port), failed (a failure was not routed) or dimmed when not reached;
    - wires show how many hosts took them;
    - select a wire to list its hosts, or a node to see each host, the port it left through and why it failed;
    - with nothing selected the run panel shows the job, status, commit, flow version, failed hosts and _Open in AWX_.
  - **Tested:** after a passing real run of the current flow version (exit 0, every failure routed, no failed end), the run panel offers _Mark N nodes tested_ for the implemented nodes it ran: one edit you save.
- **Engine limits the validator reports (M3):** `unreachable` and `unchanged` on role nodes (Ansible gives no per-host signal for a role), and a `timeout` port without `settings.timeout`.

## Install

From a VSIX (Marketplace and Open VSX publishing follows later):

```bash
just package
```

```bash
code --install-extension out/ansible-flow-designer-0.7.0.vsix
```

Requires VS Code 1.140 or later. Designing needs no Ansible installation. Runs and syntax checks need an Ansible environment with ansible-core 2.19 or later:

- an execution environment image through Docker or Podman (the only option on native Windows);
- or VS Code Remote (WSL, SSH, Dev Container), or a local venv.

`docker/afd-ee.Dockerfile` builds a minimal one (`just ee-build 2.19`).

### Settings

| Setting                            | Default | Meaning                                                                                                                                                  |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afd.codegen.onSave`               | `true`  | Write `generated/` whenever a flow without errors is saved                                                                                               |
| `afd.environment.kind`             | `auto`  | `container` when an image is set, else `local`                                                                                                           |
| `afd.environment.image`            | (empty) | EE image, e.g. `registry.example.net/ee/netops:2.19`; empty uses the Red Hat Ansible extension's `ansible.executionEnvironment.image` when it is enabled |
| `afd.environment.containerEngine`  | `auto`  | `docker` or `podman` (auto: the Red Hat Ansible setting, else docker)                                                                                    |
| `afd.environment.containerOptions` | `[]`    | Extra `docker run` arguments, e.g. `["-v", "/home/jane/.ssh:/home/ansible/.ssh:ro"]`                                                                     |
| `afd.environment.python`           | (empty) | Interpreter for local mode; empty uses `ansible.python.interpreterPath`, else `python3`                                                                  |
| `afd.run.inventory`                | (empty) | Inventory relative to the repository root; empty uses the `ansible.cfg` default                                                                          |
| `afd.run.askVaultPassword`         | `auto`  | `auto` asks when the inventory or repository vars contain vault data                                                                                     |
| `afd.awx.url`                      | (empty) | AWX address for _Launch in AWX_, e.g. `https://awx.example.net`; the token is kept in VS Code's secret storage (_Set AWX Token_), never in settings      |
| `afd.awx.verifyTls`                | `true`  | Verify AWX's TLS certificate; turn off only for a lab AWX with a self-signed certificate                                                                 |

Example `.vscode/settings.json` for a Windows machine with Docker Desktop:

```json
{
  "afd.environment.image": "afd-ee:2.19",
  "afd.run.inventory": "inventories/lab/hosts.yml"
}
```

## Usage

- **New flow:** Command Palette → _Ansible Flow: New Flow…_ creates `flows/<key>/<key>.flow.yaml` in the workspace with a start and an end node.
- **Open:** click any `*.flow.yaml` file. _Ansible Flow: Validate Design_, _Tidy Up Layout_ and _Open as Text_ are in the Command Palette and the top bar.
- **Compare with the code:** switch the top bar to _Implementation_; _Re-sync from git_ refreshes. Each drift item's buttons fix the design or open the code.
- **Bind:** select a node, then the gear or _Bind module, role or playbook…_ in the inspector. Search, pick, fill in the parameters (`@` inserts inputs), _Save binding_. _Rebuild Module Catalog_ in the Command Palette re-reads the environment's docs.
- **Run in AWX:** set `afd.awx.url`, run _Ansible Flow: Set AWX Token_ and _Set Up AWX Template_ once per flow, commit and push, then _Launch in AWX_. Switch the top bar to _Run_ to see the results; select nodes and wires for hosts.
- **Run:** _Run as skeleton_ in the top bar (or the play button in the editor title bar) runs the flow in check mode. The button next to it runs it for real after a confirmation. Other commands: _Generate Playbook_, _Check Generated Code (Syntax)_, _Show Run Audit Log_.

A minimal flow document (all values fictional):

```yaml
schema_version: 1
flow:
  id: 01JC5Z8V2B3N4M5P6Q7R8S9T0V
  key: ntp-baseline
  name: NTP baseline
  version: 1
  inputs:
    devices:
      type: host_list
      required: true
      targets: true
nodes:
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0W
    key: start
    type: start
    title: Start
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0X
    key: push-ntp
    type: task
    title: Push NTP servers
    status: draft
    intent: Configure ntp1.example.net and ntp2.example.net
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0Y
    key: done
    type: end
    title: Done
    outcome: success
edges:
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0Z
    from: { node: 01JC5Z8V2B3N4M5P6Q7R8S9T0W, port: ok_hosts }
    to: { node: 01JC5Z8V2B3N4M5P6Q7R8S9T0X, port: in }
```

Opened in the designer, `push-ntp` shows an amber `failed_hosts` port and the banner says _1 open fail port_. Click the port and pick _Notify on-call and stop_, and the flow gains (one undo step):

```yaml
- id: 01JC5Z9A1B2C3D4E5F6G7H8J9K
  key: notify-on-call
  type: task
  title: Notify on-call
  status: draft
  intent: Open a ticket and notify on-call with the hosts from Push NTP servers · failed_hosts
  handler: notify
- id: 01JC5Z9A1B2C3D4E5F6G7H8J9M
  key: stopped
  type: end
  title: Stopped
  outcome: failed
```

plus three edges (`push-ntp.failed_hosts → notify-on-call`, and its `ok_hosts` and `failed_hosts` to `stopped`). Choosing _Leave open on purpose…_ instead adds:

```yaml
decisions:
  - node: 01JC5Z8V2B3N4M5P6Q7R8S9T0X
    port: failed_hosts
    kind: open_on_purpose
    reason: Read-only change window; stopping is safe
    by: Jane Example
```

Saved, the flow generates `generated/ntp-baseline.yml`. The open-on-purpose port is rescued like any other and fails its hosts at the end, with the reason:

```yaml
- name: "[push-ntp] Push NTP servers"
  hosts: "{{ devices | join(',') }}"
  gather_facts: false
  tags: [node_01JC5Z8V2B3N4M5P6Q7R8S9T0X]
  vars:
    flow_node_id: 01JC5Z8V2B3N4M5P6Q7R8S9T0X
  tasks:
    - block:
        - name: "[push-ntp] TODO"
          ansible.builtin.debug:
            msg: "TODO: Configure ntp1.example.net and ntp2.example.net"
        - name: "[push-ntp] route ok_hosts"
          ansible.builtin.group_by:
            key: flow_push_ntp_ok_hosts
      rescue:
        # failed_hosts is open on purpose: these hosts stop in the outcome play
        - name: "[push-ntp] route failed_hosts"
          ansible.builtin.group_by:
            key: flow_push_ntp_failed_hosts

# Hosts left on open ports or failed end nodes fail here, after every branch ran (ADR-0009).
- name: "[ntp-baseline] Outcome"
  hosts: flow_push_ntp_failed_hosts
  gather_facts: false
  tags: [flow_01JC5Z8V2B3N4M5P6Q7R8S9T0V]
  tasks:
    - name: "[push-ntp] failed_hosts open on purpose"
      ansible.builtin.fail:
        msg: "Stopped at [push-ntp] Push NTP servers: failed_hosts open on purpose (Read-only change window; stopping is safe)"
      when: inventory_hostname in groups['flow_push_ntp_failed_hosts'] | default([])
```

More complete examples: `examples/edge-baseline.flow.yaml` and `examples/os-upgrade.flow.yaml`, with their generated code in `examples/generated/` (the golden files of the engine tests).

Port catalog per node type (ADR-0004):

| Type          | Default ports                    | Optional                                                             |
| ------------- | -------------------------------- | -------------------------------------------------------------------- |
| start         | `ok_hosts`                       | none                                                                 |
| end           | `in`                             | none                                                                 |
| task, subflow | `in`, `ok_hosts`, `failed_hosts` | `unreachable`, `unchanged`, `always`, `cancelled`, `timeout`, `undo` |
| decision      | `in`, `true`, `false`            | none                                                                 |
| approval      | `in`, `approved`, `rejected`     | `timeout`                                                            |
| parallel      | `in`, `branch_1..n`              | none                                                                 |
| join          | `in`, `ok_hosts`                 | `failed_hosts`                                                       |

## Repository

| Path                             | What                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `ansible-flow-designer-handoff/` | Design bundle (product docs 01–08, mockups, original schema and examples). Reference only, never edited.                               |
| `schema/flow.schema.json`        | Canonical flow document schema (v1 plus additive fields, ADR-0004).                                                                    |
| `examples/`                      | Example flows, byte-identical copies of the handoff examples; `generated/` holds their golden generated code.                          |
| `src/core/`                      | Pure TypeScript: YAML edit engine, flow model, validation, commands, port menus, failure patterns, host⇄webview protocol.              |
| `src/core/engine/`               | Option A code generation (ADR-0009), generated-file checksums, the inspector's play preview.                                           |
| `src/core/run/`                  | Environment resolution, probe and run command lines, run-event summary.                                                                |
| `src/core/drift/`                | Code sync and drift: scan types, `computeDrift` (D-29 kinds and actions), role stubs and argument specs (M6).                          |
| `src/core/awx/`                  | AWX API types and AWX job events → `afd_events` lines (M7).                                                                            |
| `src/extension/awx/`             | AWX client, token, Set Up AWX Template, Launch in AWX with event polling (M7).                                                         |
| `lab/`                           | GNS3 lab: Git server on ops1, Docker suites on the GNS3 VM, setup notes (`lab/README.md`, M7).                                         |
| `src/core/catalog/`              | Catalog types, search ranking, repository context, the binding draft (form, checklist, `@` choices) (M5).                              |
| `src/extension/sync/`            | Re-sync (probe compile, roles, Git state, catalog returns) and the drift actions that write code (M6).                                 |
| `src/extension/catalog/`         | SQLite FTS5 catalog index, its build worker, the catalog service, catalog-backed binding checks (M5).                                  |
| `src/extension/`                 | Extension host: custom editor, sessions, diagnostics, version bump, auto-layout, codegen on save, probe client, runs, audit, test API. |
| `probe/`                         | Python probe (`afd_probe`, stdlib only) and the `afd_events` callback; pytest contract tests (uv).                                     |
| `docker/afd-ee.Dockerfile`       | Minimal execution environment image for tests and runs; `afd-awx-ee.Dockerfile` adds ansible-runner for AWX (M7).                      |
| `src/webview/`                   | React + React Flow canvas and panels; `harness/` is a dev-only page with a fake host.                                                  |
| `test/`                          | Vitest unit/component tests, VS Code integration and perf tests, fixtures.                                                             |
| `docs/adr/`, `docs/spikes/`      | Architecture decisions; the M3 Option A spike (playbooks and results).                                                                 |

## Development

Requires Node 24+, npm, Git and [just](https://github.com/casey/just).

```bash
just install
```

| Recipe                           | Does                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `just build` / `just build-prod` | Build extension host (esbuild) and webview (Vite); production is minified            |
| `just watch`                     | Rebuild on change                                                                    |
| `just check`                     | Type-check (TypeScript 7) and lint/format check (Biome)                              |
| `just fmt`                       | Apply Biome formatting and safe fixes                                                |
| `just test [args]`               | Unit and component tests (Vitest); `AFD_FUZZ_STEPS=3000` deepens the fuzzer          |
| `just test-int [version]`        | Integration tests inside VS Code (`stable`, `insiders` or e.g. `1.140.0`)            |
| `just perf [version]`            | Performance suite on the production bundle                                           |
| `just test-yaml [version]`       | With the Red Hat YAML extension installed: flows are validated by our schema (AFD-5) |
| `just test-engine [images]`      | Generated code runs with simulated outcomes in each Ansible image (Docker)           |
| `just probe-test [images]`       | Probe contract tests (pytest via uv) in each image                                   |
| `just test-catalog dir`          | Search quality and latency gates on a full catalog dump (`<cache>/<core-minor>`)     |
| `just ee-build [core]`           | Build `afd-ee:<core>` from `docker/afd-ee.Dockerfile`                                |
| `just awx-ee-build [core]`       | Build `afd-awx-ee:<core>` (adds ansible-runner) for AWX                              |
| `just awx-lab [--sync]`          | Create the lab AWX objects (EE, project, inventory); `--sync` updates the project    |
| `just test-awx [version]`        | Run mode against the lab AWX (needs `AFD_AWX_URL`, `AFD_AWX_TOKEN`; see `lab/`)      |
| `just test-docker-lab [suites]`  | Engine, probe and Docker integration suites in a container on the GNS3 VM            |
| `just codegen [--check] flows…`  | Generate (or check) `generated/` for flow files from the command line                |
| `just harness`                   | Webview harness on http://localhost:5178/harness/index.html?flow=os-upgrade          |
| `just package`                   | Build the VSIX into `out/`                                                           |

`AFD_TEST_IMAGE=afd-ee:2.19 just test-int` also runs the integration tests that need the image: real skeleton runs (M3), the real catalog dump (M5) and a real Re-sync (M6); they are skipped without it. The engine and probe suites default to the `ps-probe-env:2.19/2.20/2.21` stand-in images. Pass `afd-ee:<core>` images to use the ones built here.

Press F5 in VS Code to start an Extension Development Host with `examples/` open. The harness runs the real webview against an in-page fake host (`?flow=edge-baseline|os-upgrade`, `&theme=light|dark|hc`) for visual checks without VS Code.

## License

MIT, see `LICENSE`. Bundled third-party packages and their licenses: `THIRD_PARTY_NOTICES.md`.

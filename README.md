# Ansible Flow Designer

A VS Code extension for designing Ansible automation top-down. You sketch a flow as a graph of typed nodes and ports, run it as a walking skeleton, and then bind each node to a module, role or playbook. The flow document (`*.flow.yaml`) stays the source of truth: Ansible code is generated from it, and drift is detected in both directions.

**Status: M6 done.** The designer edits flows on a canvas (port menus, failure patterns, open-on-purpose decisions, subflows with a drill-down boundary view). It binds nodes to modules, roles and playbooks found in your execution environment's catalog, generates Ansible code that passes data between nodes on every save, and runs it as a walking skeleton or for real, mapping the results back to the nodes. Implementation mode compares the design with the code it runs and lists drift both ways. Run mode comes in M7 (plan: `docs/adr/`, handoff `docs/06`). Tracking: YouTrack project AFD (epic AFD-1, M1 = AFD-2, M2 = AFD-3, M3 = AFD-4, M4 = AFD-6, M5 = AFD-8, M6 = AFD-9), knowledge base AFD-A-1.

## What the designer does

- `*.flow.yaml` opens in the **Ansible Flow Designer** custom editor; _Open as Text_ (editor title bar) shows the YAML. Both views edit the same document, so save, dirty state, undo/redo, Git diff and hot exit are VS Code's own.
- **Canvas (Design mode):** nodes by type (task, subflow, decision, approval, parallel, join, start, end) and lifecycle status (draft, specified, implemented, tested); ports placed by role (control in on top, outcomes at the bottom, problems on the right, undo on the left); wires colored by port, dashed for problem paths; far zoom shows titles only.
- **Editing:** drag to move, drag from a port to another node to wire it, release on empty canvas to add a node there (Quick add), Delete/Backspace to remove (a whole selection is one undo step), palette click or drag to add. The inspector edits title, key, intent, status, contract (inputs and outputs), optional ports and type-specific fields. The flow panel edits name, key, goal, owner and flow inputs and shows readiness counters.
- **Every canvas action is one minimal text edit** made by the extension host with a byte-preserving YAML engine: comments, quoting and formatting outside the edited lines never change, and one Ctrl+Z undoes one action.
- **Validation:** JSON Schema (`schema/flow.schema.json`) plus semantic checks (IDs, keys, ports, edges, references, decisions, subflow boundary, status) go to the Problems panel; open fail ports also show in the canvas banner. The schema is also registered with the Red Hat YAML extension for `*.flow.yaml` (`contributes.yamlValidation`), so _Open as Text_ gets completion and validation from it, and SchemaStore's unrelated Estuary Flow schema, which claims the same file pattern, no longer applies.
- **Layout** lives in one `layout:` block of the flow file. Flows without positions are auto-laid out (ELK) in memory and only written on the first move or _Tidy up_.
- **`flow.version`** is bumped once per commit on save when the semantic content changed (compared with Git HEAD), never for layout-only changes.
- **Ports appear when needed (M2):** at rest a node shows only wired ports, open fail ports (amber) and ports left open on purpose (gray). Hovering or selecting a node shows every port its type supports, with names; dragging a wire shows every input.
- **Port menus (M2):** click any port. An open port offers suggestions for its kind, for example `failed_hosts`: Rollback (existing), Notify on-call and stop, Exclude and report, Retry with backoff, Stop flow, Leave open on purpose. `unreachable` never offers Rollback. A wired port offers Insert node on this wire, Rewire to another node and Disconnect. The inspector lists every port with the same menu and quick fixes for open fail ports.
- **Failure patterns (M2):** drag Rollback from backup, Notify on-call and stop, Retry with backoff or Exclude and report from the palette onto an open fail port (or a node), or click one with a node selected. The handler node, its end node (reused only when the level has one with the pattern's key, such as `stopped`, `failed` or `excluded`; otherwise a new one, AFD-21) and all wires are created in one undo step.
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
- **Right-click menu (AFD-18):** right-click a node, a group, a wire, a port or the empty canvas for what you can do there, with the keyboard shortcut next to each item. The menu replaces VS Code's own (Cut/Copy/Paste) on the canvas; text fields keep VS Code's.
  - **Node:** Open subflow, Properties…, Bind implementation…, Rename, Status ▸, one submenu per open fail port with its suggestions (Rollback, Notify on-call and stop, Leave open on purpose…), Add next node…, Cut, Copy, Duplicate, Show in text, Peek code, Delete.
  - **Group** (also a right-click on the Shift+drag selection box): Cut, Copy, Duplicate, Extract into subflow…, Delete.
  - **Wire:** Insert node on this wire, Rewire to another node…, Disconnect. Entry and exit wires of a subflow: Remove entry, Edit reason…, Remove exit.
  - **Port:** the port menu. **Empty canvas:** Paste here, Add node here…, Select all, Tidy up, Fit view, Up to parent.
  - Implementation mode offers the same edits as Design (except Rename and Extract, whose panels are Design's). Run mode only reads.
  - Shift+F10 or the Menu key opens the menu for the selection.
- **Keyboard shortcuts (AFD-18):** press `?` for the list (also in the top bar's "…" menu). Ctrl stands for ⌘ on macOS.

  | Keys                     | Action                                                    |
  | ------------------------ | --------------------------------------------------------- |
  | Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, paste nodes (as YAML text)                     |
  | Ctrl+D                   | Duplicate the selection, next to it                       |
  | Delete / Backspace       | Delete the selection, in one undo step                    |
  | F2                       | Rename: the cursor goes to the inspector's Title          |
  | Enter / Alt+↑            | Open the selected subflow / back to the parent level      |
  | Arrow keys               | Nudge the focused node; the move is saved when you stop   |
  | Esc                      | Close the menu or dialog on top; else clear the selection |
  | Shift+F10                | Context menu for the selection                            |

- **Copy and paste nodes (AFD-17):** select one or more nodes and press Ctrl+C (Cmd+C), or use _Copy_ in the inspector or the selection panel, or _Ansible Flow: Copy Nodes_. The clipboard holds plain YAML: the nodes with their inner levels, the wires between them, their layout and their open-on-purpose decisions. Press Ctrl+V on any flow canvas (or _Ansible Flow: Paste Nodes_) to paste them on the open level, at the pointer, in one undo step. Or paste the text into any text file and keep it as a snippet.
  - In the right-click menu, _Copy_ takes the node you right-clicked (a selected group stays selected), and _Paste here_ puts the nodes where you right-clicked. From the Edit menu or the palette, they go to your last click on the canvas.
  - Every pasted node, inner node and wire gets a new ID. A key the level already has gets `-2`, `-3`, …, and `from:` references between the pasted nodes follow it. References to nodes that were not copied stay as written.
  - Status `tested` becomes `implemented`: the copy has not run here. Wires to nodes that were not copied are dropped. Start nodes are not pasted.
  - Pasted into a subflow without inner steps, the first pasted node becomes its entry.
  - A snippet written by hand pastes too: one node, a list of nodes, or a `nodes:` mapping, for example `- {type: task, title: Check NTP}`.
- **Extract into subflow (AFD-7):** Ctrl/Cmd+click or Shift+drag several connected nodes, then _Extract into subflow_ in the right panel. The nodes and the wires between them move into a new subflow with their IDs, in one undo step.
  - Wires in must reach one node; wires out leave through the subflow's ports.
  - Outputs read outside become subflow outputs, and those references are rewritten.
  - It works inside subflows too.
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
  - **Configure:** a form from the argument spec (choices, booleans, one line per list item, YAML for dicts), required and set parameters first. Values are Jinja: `{{ name }}` shows as a purple **input chip**, and typing `@` (or the @ button) offers node inputs, flow inputs, outputs of upstream nodes, the enclosing subflow's inputs, and outputs of steps inside earlier subflows (AFD-21). Choosing one that is not an input yet adds it with its `from:`; a step inside another subflow is lifted to that subflow's outputs in the same edit. Then the register name, a checklist (required parameters, where each variable comes from, check mode support, deprecation) and the generated task.
  - **Save binding** writes the binding, the inputs and outputs it added and the status (`implemented`) as one edit, one undo step. Renaming a node input later rewrites the parameters that read it.
- **Module catalog (M5):** the first search in a folder asks the probe to dump every collection's docs in the environment (`ansible-doc --metadata-dump`, about 30 s for a full EE, only new versions later) into VS Code's global storage. A worker builds an SQLite FTS5 index per collection set (about 3 s), so searches take milliseconds. _Rebuild Module Catalog_ re-dumps. The last index also checks bindings when the probe is not running: modules missing from the EE, removed or deprecated, redirected names, missing or unknown parameters, no check mode.
- **Data between nodes (M5):** an input `from: <node-key>.<output>` is passed to the node's play as a variable read from the upstream output. A module output `from: impl.register[.path]` reads the registered result; `from: flow.<input>` reads the flow input. Unbound nodes with outputs set placeholder facts, so skeleton runs carry data through. A playbook binding imports the playbook with `afd_hosts` set to the arriving hosts; its plays should target `"{{ afd_hosts }}"`.
- **Data across subflows (AFD-21):**
  - inside a subflow, `from: <subflow-key>.<input>` reads the subflow's own input; the generated code follows it to where the input comes from;
  - a subflow output names the inner output it lifts (`from: <step>.<output>`); without `from` it lifts the inner output of the same name, and the validator warns (`subflow-output-unset`) when nothing inside sets it;
  - renaming a subflow input rewrites the inner reads;
  - the validator checks every name a step reads: parameters, `assert` `that:`, `debug` `var`, decision conditions and `until`. Each warning says where the value could come from.
- **Polling (AFD-21):** `settings.until` (a Jinja test without braces on the step's registered result) with `settings.retries` and `settings.delay` (seconds) makes a module step poll until a state is reached. Without `until`, retries stop on the first success.
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
  - **Approvals (AFD-11, ADR-0016):** a flow with top-level approvals runs in AWX as a workflow.
    - _Set Up AWX Template_ creates a job template per segment playbook (`generated/<key>.seg_<segment>.yml`, written on save) and the workflow `AFD · <flow key>`: the segments, an approval node at each gate (timeout from `settings.timeout`), and a finish path for when nobody reaches a gate.
    - Approving continues with the hosts waiting at the gate. Denying or a timeout sends them to `rejected`.
    - Hosts are failed only in the last segment, and a node on both sides of a gate runs once per host.
    - In Run mode the approval node shows waiting, approved, denied or timed out, with a link to decide it in AWX.
    - Approvals inside subflows, or two waiting at once, run only locally and as skeletons (auto-approved); the validator says why.
  - **Local runs (AFD-21)** approve by themselves; the extra var `afd_approvals` takes another outcome per approval, by key path: `-e '{"afd_approvals": {"change-approval": "rejected"}}'`. A value the approval has no port for stops the run with an error. The generated playbook's header names the approvals.
  - _Launch in AWX_ (Implementation and Run modes, or the Command Palette) asks for the flow inputs and shows a confirmation with the targets and the commit, then launches the template with the inputs as extra vars. It follows the job's events until the job ends.
  - AWX runs the commit its project checks out. When that is not your HEAD (unpushed or uncommitted changes) you get a warning.
  - The token is checked against AWX before it is stored, in VS Code's secret storage only.
  - **Run mode** shows the last run (AWX or local) on the same canvas, read-only:
    - nodes show "3 hosts · 1 failed · 2.1 s", colored ok, warn (some hosts took a fail port), failed (a failure was not routed) or dimmed when not reached;
    - wires show how many hosts took them;
    - select a wire to list its hosts, or a node to see each host, the port it left through and why it failed;
    - with nothing selected the run panel shows the job, status, commit, flow version, failed hosts and _Open in AWX_.
  - **Tested:** after a passing real run of the current flow version (exit 0, every failure routed, no failed end), the run panel offers _Mark N nodes tested_ for the implemented nodes it ran: one edit you save. A tested node whose design changes later (anything but its status, position and wires) is implemented again, at once on the canvas or on save after a hand edit, with a message naming it.
- **Top bar (AFD-18):** the breadcrumb, the mode toggle, one _Lens_ dropdown, the mode's primary action (Design: _Run as skeleton_, with _Run for real…_ under its chevron; Implementation: _Re-sync from git_ and _Launch in AWX_; Run: both runs), and a "…" menu with _Tidy up_, _Show as text_, _Validate design_ and _Keyboard shortcuts_.
- **Lenses (M8, ADR-0014):** the top bar's _Lens_ dropdown (None, Inventory, Data, Code, Access, Timing; ✕ clears it) works in every mode. A lens fills the node chips across the flow (two at most) and adds a browser on the left and findings on the right; hovering a row highlights its nodes. A lens never edits the flow.
  - **Inventory** reads the local environment's inventory through the probe when you open the lens. Chips show each node's target and host count; groups a node adds beyond the flow targets show as `+ core_spines · 2`; wires show last-run host counts. _Set targets…_ picks the flow targets, remembered for runs too. Findings: a handler that targets more than it receives (Rollback on `all`), groups that are not flow inputs, patterns that match nothing, production groups.
  - **Data** shows inputs and outputs and draws dotted data wires from `from:` references. Findings: unresolved inputs, outputs nothing reads.
  - **Code** shows each binding with its collection version and the execution environment. Findings: not in the environment, removed or deprecated, versions that do not meet `collections/requirements.yml`.
  - **Access** shows credentials, the inventory's connection user, become and vaulted variables (by name and file:line, never the value). Findings: a credential unlike the one its neighbours share, become alone, node credentials outside AWX.
  - **Timing** shows serial, timeout and average durations from the last 20 real runs started from VS Code. Findings: the slowest path does not fit `flow.maintenance_window` (set in the flow description), a node runs close to its timeout.
  - _Mark expected_ keeps a finding with a required reason, recorded in the flow with your Git user (`finding_accepted`); _Reopen_ removes it.
- **Semantic zoom (D-19):** zoomed out, nodes show titles only. At default zoom they show the status dot and two chips. From 1.4× the box lists summary rows. A selected node opens a summary card (hosts, limit, inputs, outputs, binding, credential, limits, duration) with Open subflow, Properties and Peek code.
- **AWX workflow import (M9, ADR-0015):** _Import AWX Workflow…_ turns a workflow job template, read from AWX or from an `awx export` file, into a new flow laid out top-down at every level. It is a one-time copy: AWX is only read, and the flow description shows where it came from.
  - Job template nodes become tasks bound to the template's playbook: implemented when the playbook is in this repository, otherwise draft. Node limit, tags, extra data, the machine credential, EE, become and timeout carry over.
  - Nested workflows become subflows; approvals stay approvals, with their timeout; project and inventory syncs become draft tasks.
  - `success` goes to `ok_hosts`, `failure` to `failed_hosts`, and `always` to both, because AWX counts it as a failure handler. Several children get a parallel node, several roots start in parallel, and convergence "all" gets a join.
  - A failure with no AWX path stays open, so the banner shows what AWX would fail on.
  - Survey questions and extra vars become flow inputs. Passwords, `$encrypted$` values and secret-looking names are imported by name only.
- **Run on another target (`inventory_target`, AFD-14):** a task (or a subflow, whose inner steps inherit it) with `settings.inventory_target` runs its work once on that pattern instead of on the hosts that arrive. For example, drain traffic on `edge_switches,core_spines`, or update the load balancers in `{{ lb_group }}`.
  - The arriving hosts leave together: `ok_hosts` when the target finished, `failed_hosts` when a target host failed. `max_fail_percentage` tolerates that share of the target. A pattern that matches no host also fails them.
  - The work gets `afd_arriving` (the arriving hosts) and reads upstream outputs from the first of them; its outputs come back from the first target host that finished.
  - Real-run and AWX confirmations name every target and its host count.
- **Engine limits the validator reports (M3):** `unreachable` and `unchanged` on role nodes (Ansible gives no per-host signal for a role), and a `timeout` port without `settings.timeout`.

## Install

From a VSIX (Marketplace and Open VSX publishing follows later):

```bash
just package
```

```bash
code --install-extension out/ansible-flow-designer-0.12.1.vsix
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

- **New flow:** Command Palette → _Ansible Flow: New Flow…_ creates `flows/<key>/<key>.flow.yaml` in the workspace with a start and an end node. Or create an empty `*.flow.yaml` file anywhere: it opens in the designer with _Create a flow here_, which writes the same start (named after the file) in one undo step. A `*.flow.yaml` that does not parse shows why, with _Open as text_.
- **Import from AWX:** Command Palette → _Ansible Flow: Import AWX Workflow…_, then _From AWX_ (uses `afd.awx.url` and the stored token) or _From an export file…_ (`awx export --workflow_job_templates --job_templates > awx-export.json`). Pick the workflow and the flow key; the new flow opens, and _Show notes_ lists what did not map one to one.
- **Open:** click any `*.flow.yaml` file. _Ansible Flow: Validate Design_, _Tidy Up Layout_ and _Open as Text_ are in the Command Palette and the top bar.
- **Compare with the code:** switch the top bar to _Implementation_; _Re-sync from git_ refreshes. Each drift item's buttons fix the design or open the code.
- **Bind:** select a node, then the gear or _Bind module, role or playbook…_ in the inspector. Search, pick, fill in the parameters (`@` inserts inputs), _Save binding_. _Rebuild Module Catalog_ in the Command Palette re-reads the environment's docs.
- **Review with a lens:** pick a lens in the top bar. For Inventory and Access, _Set targets…_ in the left panel enters the flow targets; the refresh button reads the inventory again. Hover a row to see its nodes, use a finding's fix button, or _Mark expected_.
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

## AI assistants

The extension teaches AI assistants the flow format and gives them tools that edit flows by key, so they never write IDs, wire ports a node does not have, or leave failures unhandled (AFD-19, ADR-0017).

**Copilot (VS Code):** nothing to set up.
- The `ansible-flow` skill and the instructions for `*.flow.yaml` load when they are relevant.
- Seven tools are in agent mode and can be referenced with `#`: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`, `#flowNew`, `#flowCompleteIds`.
- An edit asks for confirmation and is one undo step. It is saved when the file had no unsaved changes, so the version bump and `generated/` follow as on any save.

**Other agents** (Claude Code, Codex, Gemini CLI, OpenCode, ZCode, GitHub Copilot CLI, Cursor) need the skill copied and the tools registered once (AFD-20):
- **Offered once:** after VS Code starts, the extension looks for these agents: a program on PATH, their config folder, an installed app or their VS Code extension. Agents found without the setup get one notice: _Set Up_ (all of them, for every repository, in one click), _Choose…_, _Not Now_ or _Don't Ask Again_. An agent is asked about again only if it is new.
- **By hand:** Command Palette → _Ansible Flow: Set Up AI Assistants…_
  1. Pick the agents. Each is marked as found (and why) or "not found: config only".
  2. Choose where the skill goes: _This repository_ (commit the copies to share them with the team) or _Just me_.
  3. Check the preview of every file and registration, then apply. Restart running agents.
- **Any other agent:** pick _Other agent…_. A guide opens with the MCP config for this machine (JSON and command line), and buttons to copy the skill to a folder you choose and the config to the clipboard.

| Agent                                       | Skill copy                                        | Flow tools (MCP server `ansible-flow`)         |
| ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Claude Code (CLI and its VS Code extension) | `.claude/skills/` or `~/.claude/skills/`          | `claude mcp add -s user` (run for you)         |
| Codex (CLI, app, VS Code extension)         | `.agents/skills/` or `~/.agents/skills/`          | marked block in `~/.codex/config.toml`         |
| Gemini CLI                                  | `.agents/skills/` or `~/.gemini/skills/`          | `mcpServers` in `~/.gemini/settings.json`      |
| OpenCode                                    | `.agents/skills/` or `~/.agents/skills/` (shared) | `mcp` in `~/.config/opencode/opencode.json(c)` |
| ZCode                                       | `.agents/skills/` or `~/.agents/skills/` (shared) | `mcpServers` in `~/.agents/mcp.json`           |
| GitHub Copilot CLI                          | `.github/skills/` or `~/.copilot/skills/`         | `mcpServers` in `~/.copilot/mcp-config.json`   |
| Cursor                                      | `.claude/skills/` or `~/.claude/skills/` (shared) | `mcpServers` in `~/.cursor/mcp.json`           |
- The server runs on `node` when Node 20+ is on PATH, else on VS Code's own runtime. No Node install is needed.
- Config files get a one-time `.afd-backup` copy before the first change. Entries you wrote yourself are left alone.
- After an extension update the setup offers to update itself once.
- _Ansible Flow: Remove AI Assistant Setup…_ removes only what setup wrote.
- Gemini enables MCP servers only in trusted folders: accept its trust prompt for the repository.
- A config file that does not parse is left alone and reported in the preview.
- Without the claude CLI on PATH, setup offers the `claude mcp add …` command to copy.

**What the tools do:**
- `flow_describe` shows a flow by key: nodes, wires `precheck.ok_hosts -> check-ntp`, subflows as `fix-ntp/push-config`, open fail ports and a revision.
- `flow_edit` takes a batch of ops in order, all or nothing, e.g.:

  ```json
  {"ops": [
    {"op": "add_node", "type": "task", "title": "Check NTP", "on_wire": "precheck.ok_hosts"},
    {"op": "apply_pattern", "at": "check-ntp.failed_hosts", "pattern": "notify-stop"}
  ]}
  ```

  Errors name the op and how to fix it ("No node "chek-ntp"; did you mean check-ntp?"), and nothing is written. The answer lists the nodes created and the problems the edit added or solved, counted one by one.
- `set_io` takes a path into another subflow as `from:` (`precheck/normalize-facts.fos_platform`): the subflow gets an output that lifts it, the field reads `precheck.fos_platform`, and the answer says so (AFD-21).
- `apply_pattern` takes an `end` to choose the end node; the answer names the end it used.
- `flow_new` starts a flow as `start -> done`, keyed by its file name. `add_node` with `after: "start.ok_hosts"` puts the first step between them, and each next `after` grows the chain: on a port that is already wired, the new node goes on that wire.
- A terminal agent's edit acts like a save in the designer:
  - `flow.version` moves once per commit;
  - tested nodes that changed drop back to implemented;
  - `generated/` is refreshed, keeping files edited by hand.
- Tools touch only `*.flow.yaml` inside the workspace (Copilot) or the agent's roots, else its working folder (MCP).

**Hand-written YAML:**
- An assistant without the tools, or you, can write a flow or a snippet without `id:` lines and name nodes by key in wires and references.
- The designer shows it with a _Written by hand_ banner. The Problems panel lists each gap (`missing-id`).
- _Complete IDs_ (the banner button, the lightbulb quick fix, or the command) adds the IDs in one edit, which one undo reverts.
- Paste does the same for snippets.

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
| `src/core/awx/`                  | AWX API types, AWX job events → `afd_events` lines (M7); workflow import sources and the mapping to a flow (M9).                       |
| `src/core/lens/`                 | The five lenses, semantic zoom summary rows, requirements specs, run history statistics (M8).                                          |
| `src/extension/lens/`            | Lens facts: the inventory through the probe, the catalog's view of each binding, requirements pins (M8).                               |
| `src/extension/awx/`             | AWX client, token, Set Up AWX Template, Launch in AWX with event polling (M7), Import AWX Workflow (M9), approval workflows (AFD-11).  |
| `lab/`                           | GNS3 lab: Git server on ops1, Docker suites on the GNS3 VM, setup notes (`lab/README.md`, M7).                                         |
| `src/core/ai/`                   | AI tool core: key references, the op language, flow descriptions, tool specs and handlers, the generated reference (AFD-19).           |
| `src/mcp/`                       | The MCP server for terminal agents (`dist/mcp.js`) and its file-system IO (AFD-19).                                                    |
| `src/extension/ai/`              | Copilot tools, Complete IDs quick fix, Set Up / Remove AI Assistants (skill copies, MCP registrations, launcher) (AFD-19).             |
| `skills/`, `instructions/`       | The `ansible-flow` skill (`references/` generated by `just gen-ai`) and Copilot instructions for `*.flow.yaml` (AFD-19).               |
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
| `just awx-lab --fixtures`        | Also the M9 import fixture workflows; `--record-import f` records their API answers  |
| `just test-awx [version]`        | Run mode against the lab AWX (needs `AFD_AWX_URL`, `AFD_AWX_TOKEN`; see `lab/`)      |
| `just test-lens [version]`       | The lens suite inside VS Code (its inventory test needs `AFD_TEST_IMAGE`)            |
| `just test-extract [version]`    | Extract into subflow inside VS Code (AFD-7)                                          |
| `just test-clipboard [version]`  | Copy and paste of nodes inside VS Code (AFD-17); restores your clipboard afterwards  |
| `just test-edit [version]`       | One undo step per selection edit inside VS Code (AFD-18)                             |
| `just test-ai [version]`         | AI assistants inside VS Code: Complete IDs, Copilot tools, setup (AFD-19)            |
| `just test-mcp`                  | The MCP server end to end over stdio on the production bundle (AFD-19)               |
| `just gen-ai`                    | Regenerate the skill references and the Copilot tool entries in `package.json`       |
| `just test-import [version]`     | AWX workflow import inside VS Code (skeleton run: `AFD_TEST_IMAGE`; API: lab AWX)    |
| `just test-docker-lab [suites]`  | Engine, probe and Docker integration suites in a container on the GNS3 VM            |
| `just codegen [--check] flows…`  | Generate (or check) `generated/` for flow files from the command line                |
| `just harness`                   | Webview harness on http://localhost:5178/harness/index.html?flow=os-upgrade          |
| `just package`                   | Build the VSIX into `out/`                                                           |

`AFD_TEST_IMAGE=afd-ee:2.19 just test-int` also runs the integration tests that need the image: real skeleton runs (M3), the real catalog dump (M5) and a real Re-sync (M6); they are skipped without it. The engine and probe suites default to the `ps-probe-env:2.19/2.20/2.21` stand-in images. Pass `afd-ee:<core>` images to use the ones built here.

Press F5 in VS Code to start an Extension Development Host with `examples/` open. _Run Extension (other extensions off)_ starts faster: only this extension runs. The debugger reads the host bundles' source maps only, so the first start under the debugger stays well within VS Code's 10-second limit (AFD-18 follow-up). The harness runs the real webview against an in-page fake host (`?flow=edge-baseline|os-upgrade`, `&theme=light|dark|hc`) for visual checks without VS Code.

## License

MIT, see `LICENSE`. Bundled third-party packages and their licenses: `THIRD_PARTY_NOTICES.md`.

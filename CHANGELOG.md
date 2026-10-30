# Changelog

## 0.13.2 — AFD-17 follow-up

- Paste and _Extract into subflow_ no longer rearrange a flow that is shown by auto layout. Before, they stored only the new node's position, and the other nodes were then stacked in one column below it, so the flow seemed to shift down (product-owner report).
  - Like a move or Quick add, both now also write the positions the canvas shows for nodes that have none stored (`freeze`), in the same undo step.

## 0.13.1 — AFD-17 follow-up

- VS Code's context menu on the canvas (Cut, Copy, Paste) now does what it says, from product-owner feedback:
  - A right-click selects the node under it, unless that node is part of the selected group. _Copy_ copied the earlier selection before.
  - _Paste_ lands where the menu was opened. It went to the middle of the view before, because reaching the menu takes the pointer off the canvas.
  - Paste from the Edit menu or the palette goes to the last click on the canvas, else the middle of the view. Ctrl+V goes to the pointer, as before.
- Text selected on the canvas (a right-click can select a word of a node title) no longer stops Copy from taking the nodes.

## 0.13.0 — AFD-17

- Copy and paste of nodes through the system clipboard (ADR-0001 amendment).
  - Ctrl+C (Cmd+C) on the canvas, _Copy_ in the inspector or the selection panel, or _Ansible Flow: Copy Nodes_ copies the selected nodes of one level as plain YAML in the shape of a flow file. The text holds the nodes with their inner levels, the wires between them, their layout and their open-on-purpose decisions (drift and lens acceptances stay behind).
  - Ctrl+V on a flow canvas or _Ansible Flow: Paste Nodes_ pastes on the open level (top or a subflow) at the pointer, else in the middle of the view, in one undo step. The pasted nodes are selected. Pasting again at the same spot steps aside.
  - New IDs for every node, inner node and wire. Keys taken on the level get `-2`, `-3`, …, and `from:` references between the pasted nodes follow. Other references stay as written.
  - Status `tested` becomes `implemented`. Wires to nodes that were not copied are dropped, and start nodes are skipped. A subflow without inner steps gets the paste as its first level, with the first node as its entry.
  - Hand-written snippets paste too: one node, a list of nodes, or a `nodes:` mapping. Text that is not nodes is refused with a reason. Run mode is read-only.
- Command `pasteNodes` (`src/core/flow/clipboard.ts`: `copyNodes`, `parseClip`); the ack carries `pasted` IDs. Host messages `clipboard`, webview message `copyText`.
- Test API `reveal(uri, node)`. Harness: copy writes `window.harnessClip`.

## 0.12.1 — AFD-16

- An empty `*.flow.yaml` (whitespace or comments only) opens on an Ansible Flow Designer page with _Create a flow here_: the New Flow template named after the file, in one undo step, with existing comments kept on top. An empty file is no longer reported as a problem.
- A `*.flow.yaml` that does not parse names the Ansible Flow Designer, says why the file opened there (`*.flow.yaml` files open in the designer), shows the error and offers _Open as text_. It never offers to overwrite content.
- Harness: `?flow=empty` and `?flow=broken`.

## 0.12.0 — AFD-7

- _Extract into subflow_ (ADR-0010 amendment): select several connected nodes (Ctrl/Cmd+click, Shift+drag), and the right panel offers to move them into a new subflow in one edit.
  - IDs, inner wires and positions are kept.
  - Wires into the group end at the subflow's `in`; its `boundary.in` is the node they reached, and two ways in are refused.
  - Wires out leave through the subflow's ports as boundary exits. Exits to the same place merge, and two different places on one port are refused.
  - It works on any level: exits of an enclosing subflow leave through the new one, and open fail ports keep bubbling.
  - Outputs read outside the group are lifted to subflow outputs, and the references are rewritten. Codegen and the validator resolve subflow outputs through to the inner step.
  - The subflow's status follows its least advanced step.
- Webview: group selection (`selection.nodes`), the selection panel; summary cards stay closed for a group.
- Engine contract tests run flows before and after an extraction (a `transform` per scenario): same ports, same outcome, same data.
- The webview harness exposes its store as `afdUi`, for group selections in the browser pane (dev only).

## 0.11.0 — AFD-11

- AWX approval segments (ADR-0016). A flow with top-level approvals runs in AWX as a workflow of segment playbooks with real approval nodes.
  - `generated/<key>.seg_<segment>.yml` is written on save next to the single playbook, which local and skeleton runs keep using (auto-approved).
  - Each segment carries the hosts waiting at its gate and those bound for the outcome (`set_stats` `afd_hostsets`), and the next restores them with `add_host`.
  - Hosts are failed only in leaf segments; a node on both sides of a gate runs once per host. When nobody reaches a gate, the segment stops and `finish` ends the workflow without asking for approval.
- _Set Up AWX Template_ creates the segment job templates and the workflow `AFD · <key>`: approval nodes with the approval's timeout, success and failure edges, and finish paths. It writes `runtime: {kind: awx_workflow}`.
- _Launch in AWX_ follows the workflow job and its segment jobs. Approval nodes show waiting, approved, denied or timed out, and open the approval in AWX. The run panel lists the segment jobs.
- Validator `awx-segments`: an approval inside a subflow, or two that can wait at once. A warning, or an error for an `awx_workflow` runtime. The runtime kind is inferred from the plan.
- The `afd_events` callback reports `set_stats` data in its `stats` event. The engine harness chains segment runs as AWX does.
- `examples/generated/` gains the os-upgrade segments. New fixtures: `test/fixtures/engine/approval-segments.flow.yaml`, `test/fixtures/awx/repo/flows/awx-gate/`.

## 0.10.0 — AFD-14

- Codegen applies `settings.inventory_target` (ADR-0009 amended, ADR-0004).
  - A task, or a subflow without inner steps, runs its binding once on the target instead of the arriving hosts. Inner steps of a subflow with a target inherit it.
  - Three plays: arriving hosts, the work on the target (ends at once when no host arrived), and route.
  - The arriving hosts leave together. They take `ok_hosts` when the target finished. They take `failed_hosts` (or `timeout`) when a target host failed beyond `max_fail_percentage` (any failure when it is not set), or when the pattern matched no host.
  - The work gets `afd_arriving` and upstream outputs from the first arriving host. Outputs come back from the first finished target host.
  - Playbook bindings run on the target through `afd_hosts`.
- Validator: `inventory-target-ignored` on decisions, approvals, parallels and joins. Codegen: `codegen-target-ports` for ports arriving hosts can never take.
- Real-run and AWX confirmations name every target and its host count; override hosts count toward the production check. The audit log records the declared patterns and counts.
- Inventory lens: the M8 finding "inventory_target is declared but not applied" is removed.
- AWX events map a node's extra plays (`: arriving hosts`, `: route`, `: target done`) back to it.
- `examples/generated/os-upgrade-edge.yml`: Drain traffic now runs on `edge_switches,core_spines`. The engine fixture inventory gains `lb`, `edge_switches` and `core_spines`.
- Engine contract tests: `test/fixtures/engine/inventory-target.flow.yaml`, 5 scenarios × 2.19–2.21.

## 0.9.0 — M9 (AFD-15)

- _Import AWX Workflow…_ (ADR-0015, D-31): a workflow job template from the AWX API or an `awx export` file becomes a new flow at `flows/<key>/<key>.flow.yaml`, laid out top-down with ELK at every level, and opens in the designer. A one-time copy: AWX is only read.
  - Job template nodes become tasks bound to the template's playbook (implemented when it is in the repository, otherwise draft), with limit, tags, extra data, machine credential, EE, become and timeout.
  - Nested workflows become subflows (recursive, cycle-safe); approvals keep their timeout (`timeout` port on the rejected path); syncs and system jobs become draft tasks.
  - `success` maps to `ok_hosts`, `failure` to `failed_hosts`, and `always` to both. Fan-out gets a parallel node, several roots a parallel start, and convergence "all" a join.
  - Unhandled failures stay open (banner).
  - Survey and extra vars become flow inputs; the workflow limit becomes the targets default. Encrypted, password and secret-looking values are imported by name only.
- Schema (additive, v1): `flow.imported_from {kind, template, id?}`, shown in the flow description.
- Lab: `just awx-lab --fixtures` creates the import fixture workflows; `--record-import` records their API answers for the unit tests. `just test-import` is the M9 suite.
- Fixtures: `test/fixtures/awx/import/` (API answers, export file, golden flow); the harness shows it as `?flow=awx-import`.

## 0.8.0 — M8 (AFD-13)

- Lenses (ADR-0014, D-18): a lens toggle in the top bar (None, Inventory, Data, Code, Access, Timing), independent of mode. Each lens fills the node chips (two at most), adds a browser panel whose rows highlight their nodes on hover, and lists findings with one-edit fixes.
  - Inventory: the probe method `inventory_lens` counts the flow targets, each declared target and its parts. It returns the hosts outside the targets, access variables with file:line origins, and vaulted variable names; values are never decrypted. Read on demand. Findings: broad targets on handler or fail paths, groups that are not flow inputs, patterns without hosts, production groups, `inventory_target` declared but not applied (AFD-14). _Set targets…_ stores the targets with the run inputs.
  - Data: in/out chips, derived data wires from `from:` references (decision 14), unresolved inputs and unused outputs.
  - Code: binding and collection version, execution environment. Findings: not in the EE, removed, deprecated; versions against `collections/requirements.yml`.
  - Access: credential, inventory user, become, vault references. Findings: a credential unlike the neighbours', become alone, node credentials outside AWX, vaulted variables.
  - Timing: serial, timeout, average and p95 from a local run history (last 20 real runs per flow). Findings: the slowest path against `flow.maintenance_window`, p95 near a timeout.
- _Mark expected_ / _Reopen_: the commands `acceptFinding` and `clearFindingAccept`; decision kind `finding_accepted` with a reason and the Git author.
- Semantic zoom (D-19): titles only below 0.45, two chips at default zoom, summary rows from 1.4×, and a summary card under a selected node.
- Schema (additive, v1): `flow.maintenance_window`; decisions `finding_accepted` (`node` optional). The flow description edits the window.
- Lens chip colors per theme (04 §9), contrast-tested for light, dark and high contrast.
- Probe tests import `afd_probe` from the folder (`pythonpath`), so non-Docker tests run too.
- Test fixture `test/fixtures/lens/`: a flow with something for each lens to find, a fictional inventory with a vaulted variable, and requirements pins.

## 0.7.1 — AFD-12

- A `tested` node whose design changes is implemented again (decision 15; it takes precedence over decision 24):
  - in the same edit for canvas commands, and on save for hand edits since the file on disk;
  - the design is the node's entry without its status, inner nodes included and positions left out; wiring is not part of it;
  - a message names the nodes that dropped back.
- Runs keep each node's design fingerprint from their start; _Mark N nodes tested_ leaves out nodes changed since then.

## 0.7.0 — M7 (AFD-10)

- Run mode with AWX (ADR-0013):
  - Settings `afd.awx.url` and `afd.awx.verifyTls`.
  - Commands: _Set AWX Token_ (checked against `/api/v2/me/`, kept in SecretStorage only), _Clear AWX Token_, _Set Up AWX Template_, _Launch in AWX_.
- _Set Up AWX Template_:
  - picks the project, inventory, execution environment and credentials;
  - checks that the project has the generated playbook (updates the project once if not);
  - creates or updates `AFD · <flow key>` (variables and limit asked on launch, credentials synced);
  - writes `flow.runtime` (`kind: awx_job`, `template`) in one edit.
- _Launch in AWX_:
  - asks for the inputs and shows a confirmation with the targets and the commit or uncommitted files;
  - launches with the inputs as extra vars;
  - polls the job and its events every 2 s and maps them to nodes and ports through the generated routes;
  - records the launch and the finish in the audit log;
  - warns when AWX ran another commit than HEAD.
- AWX job events (`playbook_on_play_start`, `runner_on_*` with `add_group`) are converted to the `afd_events` stream, so local and AWX runs share one summary. Plays map to nodes by `[key] Title`. The summary gained per-node timings and per-host problems (first failure or unreachable, rescued or not).
- Run mode (04 §10):
  - the mode toggle enables Run. Nodes show hosts, failed hosts and time with a run state; wires show host counts, dimmed when no host took them;
  - selecting a wire lists its hosts; selecting a node lists each host's port and failure;
  - the run panel shows the job, status, commit, flow version, revision warning, failed hosts and _Open in AWX_;
  - read-only: no wiring, port menus or deletes;
  - _Launch in AWX_ is also in Implementation mode.
- `tested` proposals (decision 15): after a passing real run of the current `flow.version`, _Mark N nodes tested_ sets the implemented nodes it ran to tested. This uses the new command `setStatuses` (one edit).
- Lab (GNS3 `snow_AWX`):
  - AWX 24.6.1 on ops1;
  - `afd-awx-ee:2.19` (`docker/afd-awx-ee.Dockerfile`);
  - a `git daemon` server (`lab/ops1-git-daemon.sh`);
  - `just awx-lab` for the EE, project and inventory;
  - `just test-awx` (lab suite in VS Code);
  - `just test-docker-lab` (engine, probe and Docker integration suites in a throwaway container on the GNS3 VM);
  - `lab/README.md`.

## 0.6.0 — M6 (AFD-9)

- Implementation mode (mockup 04, ADR-0012): the mode toggle now switches between Design and Implementation.
  - Nodes keep their place. Each shows the artifact it runs and "N tasks · state": drift, TODO stub, last run, open subflow.
  - The right panel is _Design vs code_:
    - the sync source: branch @ commit · time, uncommitted files, environment;
    - "N / M nodes matched by ID";
    - drift items with design-side and code-side actions, notes, ignored items;
    - the last run summary.
  - A selected node lists its tasks with file:line links.
- _Re-sync from git_ (working tree):
  - The new probe method `compile` loads the flow's generated playbook with `Playbook.load` + `compile()` and compiles each bound role entry point through a synthetic `import_role`. It returns tasks with origin (file, line), tags, registers, facts and stats.
  - It flags dynamic includes and ignores `validate_argument_spec`.
  - Bound playbooks are compiled on their own.
  - Git state comes from `vscode.git`.
  - It re-syncs after each save while a scan is shown.
- Drift (`core/drift`, D-29):
  - contract mismatch: outputs, required and unknown role arguments, module result keys;
  - code without design: role task files a subflow does not cover, plays for deleted nodes;
  - design without code: unbound nodes, missing roles and playbooks, nodes without a play, missing generated code, bindings not scanned yet.
  - Info items are notes.
- Actions:
  - Update design (output rename with downstream references, add or remove inputs, read another result key);
  - Open code;
  - Add to subflow (an unwired inner step bound to the role's task file);
  - Generate stub (role scaffold and binding in one WorkspaceEdit);
  - Write argument_specs (new file, or a byte-preserving merge into an existing one);
  - Bind…; Ignore… with a reason / Stop ignoring; Regenerate; Re-sync.
- Commands:
  - new `ignoreDrift` and `clearDriftIgnore`; `addNode` takes `impl`;
  - renaming a node output rewrites downstream `from:` references in the same edit.
- Schema (additive, v1): a decision of kind `drift_ignored` with `item` (and no port). The validator checks its node and reason.

## 0.5.0 — M5 (AFD-8)

- Node properties page (mockup 11, ADR-0011): a full page over the canvas with General, Implementation, Inputs and outputs, Ports and Execution. It opens from the inspector's gear or _Bind module, role or playbook…_.
  - **Find** modules in the environment's catalog (search starts from the node's intent), roles from `roles_path`, and playbooks from the repository. Results carry badges: in EE, check mode, diff, read-only, other platform, deprecated.
  - **Understand**: docs as text, the parameter table, returns that can be toggled as node outputs, an example; role entry points with argument specs; a playbook's plays.
  - **Configure**:
    - a form from the argument spec;
    - input chips: `{{ name }}` in Jinja; typing `@` offers node inputs, flow inputs and upstream outputs, and adds missing ones as node inputs;
    - the register name, optionally exposed as a node output;
    - a checklist and the generated task.
  - **Save binding**: one `setBinding` command (impl, inputs, outputs, status) in one edit and one undo step.
  - Roles without argument specs and playbooks take free-form variables.
- Module catalog:
  - The probe's `catalog` method dumps every collection's docs and routing into global storage, only for versions it has not dumped before. `roles` reads argument specs.
  - The cache is mounted read-write into the container as `/afd-cache`.
  - A worker thread builds an SQLite FTS5 index (`node:sqlite`, verified on VS Code 1.140 and 1.144, desktop and Remote server) per collection set.
  - Search ranking: bm25 weights; common-word pruning; name, compound-name and abbreviation candidates ("ip address" finds `ipaddr`); coverage; context (collections in use, inventory platforms, other platforms dimmed); a deprecated penalty.
  - Resolver: redirects up to 5 hops, tombstones as removed.
  - Gates on a full ps-probe-env:2.19 dump (93 collections, 10,065 plugins): 20/20 intents, p95 29 ms (`just test-catalog <dir>`).
  - New command: _Rebuild Module Catalog_.
- Code generation:
  - Inputs from upstream outputs become play variables. Module outputs read the registered result (`from: impl.register[.path]`).
  - Unbound nodes with outputs set placeholder facts.
  - Playbook bindings import the playbook with `afd_hosts`, then route its surviving hosts to ok_hosts.
  - Golden files are regenerated (stub facts). A new engine scenario runs the data passing for real.
- Validator:
  - `binding-unknown-var`: params read a variable that is not a node input.
  - With the catalog: `binding-not-in-ee`, `binding-removed`, `binding-redirect`, `binding-deprecated`, `binding-no-check-mode`, `binding-missing-param`, `binding-unknown-param`.
  - `from:` may point into an output (`key.output.path`).
- Commands: new `setBinding`. `setContractField` renames of node inputs rewrite the binding's Jinja reads in the same edit.

## 0.4.0 — M4 (AFD-6)

- Subflow levels (D-23, ADR-0010):
  - Open a subflow by double-click, Enter, the inspector or the preview card.
  - _Back_, a breadcrumb, inherited-context chips, and a viewport per level.
  - Reveal (banner, diagnostics) opens the right level.
- Boundary frame:
  - the subflow's ports on its edges (`in` on top, outcomes below, problems right);
  - the entry and exit wires, editable by dragging, deleting, or from the exit panel with a reason;
  - optional parent ports enabled on demand.
- New commands `setBoundaryIn`, `connectBoundary`, `disconnectBoundary`, `setExitReason`.
  - `addNode` into an empty subflow creates its inner graph with the new step as the entry.
  - `deleteNode` cleans boundary references and the decisions and positions of inner steps.
- Schema (additive): optional `reason` on boundary exits.
- Validator: `boundary-no-entry`, `boundary-port-unfed`, `inner-exit-unmapped`; `boundary-ref` also checks exit ports.
- Preview card (D-22) after about 400 ms on subflows and bound nodes. It shows inner steps with exits and last-run results, the undo binding and settings. Actions: _Peek code_ (the generated play) and _Open subflow_.
- Auto-layout and _Tidy up_ for inner levels.
- Not in M4: extract selection into a subflow (AFD-7).

## 0.3.1 (AFD-5)

- Fixed: with the Red Hat YAML extension installed, `*.flow.yaml` was validated against SchemaStore's Estuary Flow Catalog schema (Estuary uses `flow.yaml`), which produced false "Property … is not allowed" errors. The extension now contributes `schema/flow.schema.json` for `*.flow.yaml` (`contributes.yamlValidation`), which outranks SchemaStore. The text view also gets completion and validation from the real flow schema. Checked by `just test-yaml`, which installs redhat.vscode-yaml 2.0.0.

## 0.3.0 — M3 (AFD-4)

- Spike of Option A semantics on ansible-core 2.19, 2.20 and 2.21 (`docs/spikes/m3-option-a.md`). Findings:
  - when every host of one play fails or is unreachable, the whole playbook stops;
  - `rescue` does not catch unreachable hosts;
  - role outcomes are invisible to the play;
  - the `max_fail_percentage` keyword never sees rescued hosts.
- Code generation behind an `Engine` interface (ADR-0009):
  - one playbook per flow level (`generated/<flow-key>.yml`, plus `<flow-key>.<subflow-key>.yml` per subflow level, run through `import_playbook`);
  - plays in graph order, `[key]` names, `node_<ULID>` tags and `flow_node_id`; routing with `group_by`;
  - every task node rescues, and an outcome play fails hosts on open ports and failed ends;
  - module bindings route `unreachable`, `unchanged` and `timeout`;
  - decisions, approvals (auto-approved locally), parallel and join (all/any), subflow bubbling, and a `max_fail_percentage` threshold task.
- Codegen on save (`afd.codegen.onSave`):
  - writes only changed files and never overwrites hand edits (checksum in the header);
  - removes stale level files;
  - _Generate Playbook_ command.
  - The golden files are `examples/generated/`; the handoff skeleton is superseded.
- Probe `afd_probe` (Python stdlib, JSON-lines session) with `inventory` and `syntax_check`, plus the `afd_events` callback. Both ship in the VSIX under `dist/probe`.
- Environments: Docker or Podman EE image, or a local interpreter. Our settings win, then the redhat.ansible settings. Native Windows needs a container.
- Run as skeleton (check mode) and _Run for real…_:
  - flow inputs remembered per flow;
  - the real-run confirmation names the inventory, host count, unknown names and production-looking groups;
  - the vault password is asked per run and passed through an environment variable only;
  - each launch is written to a local audit log;
  - the results are mapped back to the nodes (top bar status, last run in the inspector).
- _Check Generated Code (Syntax)_ runs `--syntax-check` in the environment. Errors go to the Problems panel on the generated files.
- New validator warnings: `port-role-unroutable`, `timeout-without-setting`, `no-targets`.
- The inspector shows each node's generated play.
- `docker/afd-ee.Dockerfile`, `just ee-build`, `just test-engine` (simulated outcomes in Docker), `just probe-test`, `just codegen`.

## 0.2.0 — M2 (AFD-3)

- Progressive port disclosure (D-14): at rest only wired, open-fail and open-on-purpose ports; hover (with a margin zone), selection or an open menu reveals every port of the type with labels; dragging a wire reveals inputs. Ports keep fixed slots.
- Port menus (04 §3, mockup 07): suggestions per port kind for open ports, Insert / Rewire / Disconnect for wired ones, Connect from/to another node by clicking it; same items in the inspector with quick fixes for open fail ports.
- Failure patterns (D-16): Rollback from backup (reuses the level's Rollback), Notify on-call and stop, Retry with backoff (rejoins the happy path), Exclude and report, plus Stop flow, Connect/Skip to Done, Escalate approval, Send run report. One command, one undo step; palette drag onto a port or node.
- Open on purpose: reason required, `by` from Git user.name (fallback OS user), edit reason, reopen; wiring a port removes its decision in the same edit.
- New commands: `applyPattern`, `setDecision`, `clearDecision`, `rewire`, `addNode.insertOn`, `addNode.freeze`. Edge IDs survive rewire and insert.
- Validator: `rollback-unreachable` (D-09), `duplicate-decision`, `decision-not-fail`.
- Fixed: selecting a node created from code (Quick add, patterns) while another node was selected looped the canvas (React Flow selection echo).
- ADR-0008.

## 0.1.0 — M1 (AFD-2)

- Custom editor for `*.flow.yaml` (`CustomTextEditorProvider`): the extension host is the only writer; every canvas action is one minimal `WorkspaceEdit`, so undo, dirty state and save are VS Code's.
- Byte-preserving YAML edit engine (`src/core/yaml`): path ops, style detection (EOL, indent, sequence indentation), YAML 1.1/1.2-safe quoting, anchor/alias guards; seeded fuzz harness.
- Flow model, port catalog, semantic validation and open fail ports with subflow bubbling; findings in the Problems panel.
- Schema v1 with additive fields: `join_mode`, `branches`, `handler`, `targets`, port names with digits.
- Design canvas (React Flow 12): node types and statuses, ports by side and state, wires by tone, far LOD; palette, Quick add, inspector, flow description, open-port banner.
- Layout in one flat `layout:` block; in-memory ELK auto-layout for flows without positions; Tidy up.
- `flow.version` bumped once per commit relative to Git HEAD.
- Theme tokens for light, dark and high-contrast themes with contrast tests; strict webview CSP.
- Tests: Vitest (core, webview), VS Code integration and performance suites; `just` recipes for everything.
- Decisions recorded in `docs/adr/0001`–`0007`.

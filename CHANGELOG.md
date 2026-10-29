# Changelog

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

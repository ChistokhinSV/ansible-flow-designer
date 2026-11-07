# ADR-0014 · Lenses and semantic zoom

Status: Accepted · 2026-10-29 · AFD-13 (M8)

## Context

D-18 adds a lens toggle (None, Inventory, Data, Code, Access, Timing), independent of mode. The lens picks which category fills the node chips across the canvas; each lens may add a side panel and findings. D-19 sets a budget of two chips at default zoom, titles only when zoomed out, and a summary card when zoomed in or selected. D-20 puts variable names on wires in the Data lens. 04 §7 lists the chips, wires and findings per lens; mockup 09 shows the Inventory lens: an inventory browser on the left, findings on the right, and hover highlighting. Decision 14 keeps data wires derived, never stored. ADR-0004 named `settings.inventory_target` as the override the Inventory lens checks.

Decisions by the user at the start of M8:
1. Inventory source: the local environment's inventory, read by the probe inside the EE (`afd.run.inventory` or `ansible.cfg`), with file:line origins. AWX-bound flows get a note.
2. Durations: a local run history of the last 20 runs started from VS Code (local and AWX), per flow, in global storage.
3. Maintenance window: the additive flow field `flow.maintenance_window`.
4. "Mark expected": a `finding_accepted` decision with a required reason and the Git author.
5. Outdated collections: offline, against `collections/requirements.yml`; no Galaxy calls.
6. Codegen ignored `inventory_target` in M8. The lens showed it as declared, with a finding; AFD-14 applies it in codegen and removed that finding.

Docker Desktop stays off while GNS3 runs, so Docker-backed suites run on the GNS3 VM (ADR-0013).

## Decision

**Shape.**
- The lenses are pure functions in `src/core/lens/`: `lensView(lens, doc, facts, run)` returns chips per node (two at most), optional wire labels, derived data wires, stats, panel sections and findings.
- The webview computes the view from the snapshot, the run and the facts the host sends (`lensFacts`), like drift in M6. A lens never edits the flow.
- Findings have stable ids (`inventory:broad-target:<node>`). A fix is one canvas command, or a jump to the node's properties. _Mark expected_ writes `finding_accepted` (one edit, the reason is required, `by` is the Git user). _Reopen_ removes it.
- Accepted findings stay listed, last, with their reason.

**Facts (host).**
- **Inventory**: the probe method `inventory_lens(inventory, targets, patterns)`, read only when the Inventory or Access lens opens, and again when the targets or the declared patterns change. For each pattern it returns the count, the hosts outside the flow targets and a sample. It also returns the scope's groups, production-looking groups, and the access variables per pattern (`ansible_user`, `ansible_become`, `ansible_become_user`, `ansible_connection`, with file:line origins). Vaulted variables come back by name and origin only: ansible-core 2.19+ keeps them as `EncryptedString`, which the probe checks by type and never reads. Plugin configs and scripts are reported as dynamic sources.
- **Targets**: the flow targets input as last entered for a run, or through _Set targets…_ in the panel. Both are stored with the remembered run inputs.
- **Code**: the cached catalog index only (opening a flow never starts the probe). For each binding: the FQCN, the collection and its version, and the state (ok, not in the EE, removed, deprecated); for playbooks, the imported plays' `hosts:`. Also the `requirements.yml` pins.
- **Timing**: `history/<flow id>.json` in global storage. Each finished real run adds per-node seconds (no hosts, inputs or output). Skeleton runs are not kept. Average and nearest-rank p95 are computed over the last 20.

**Lenses.**
- **Inventory**:
  - chips show the target and its host count. The count is the last run's hosts at the node when there is a run, otherwise the flow targets; declared groups outside the targets show as `+ core_spines · 2`;
  - wires show last-run host counts;
  - the browser lists the groups used (with node counts) and the hosts excluded in the last run;
  - findings: a handler or fail-path node whose declared target reaches beyond the flow targets (fix: _Limit to arriving hosts_); a declared group not covered by the targets or a flow input default (fix: _Add to flow inputs_); a declared pattern matching no host; production groups in scope. (M8 also had "`inventory_target` declared but not applied"; removed when AFD-14 applied it in codegen.)
- **Data**:
  - chips show `in:` and `out:` names;
  - derived data wires run from producer to consumer. `flow.*` references start at Start. A reference into a subflow is drawn to the subflow node on the producer's level;
  - control wires dim;
  - findings: an unresolved or missing required input; an output nothing reads.
- **Code**:
  - chips show the binding with its collection version, and the EE;
  - findings: not in the EE; removed or deprecated; a collection that does not meet `requirements.yml`; a node EE that differs from the flow's.
- **Access**:
  - chips show the credential, else the inventory user, then become or vault references;
  - findings: a credential unlike the one shared by at least two wired neighbours; become where no neighbour has it; node credentials on a flow that is not run in AWX (decision 22); nodes reading vaulted variables.
- **Timing**:
  - chips show serial and timeout, then the average (or the last run's time);
  - the estimate is the slowest path from start through the DAG, summing node averages, or for subflows the slowest inner path;
  - findings: the estimate exceeds `maintenance_window`; p95 exceeds it; a node's p95 is above 80 % of its timeout.

**Semantic zoom (D-19).**
- Below 0.45 a node shows only its title.
- At default zoom it shows the status dot and the mode line, or the lens chips.
- From 1.4 the box lists summary rows.
- A selected node opens a summary card under itself: hosts, limit, inputs, outputs, binding and collection, credential, become, serial and timeout, duration. It offers Open subflow, Properties and Peek code.
- Node sizes never change, so a lens or zoom never moves the layout.

**Schema (additive, v1).**
- `flow.maintenance_window` (`^([0-9]+[smhd])+$`).
- Decision kind `finding_accepted` with `finding` (`node` optional).

**Tests.**
- Unit tests cover the five lenses on the `lens-e2e` fixture, with inventory facts matching the probe contract; the fixes, which are one edit each and clear their finding; requirements specs; history statistics; summary rows; and the examples under every lens.
- Component tests cover the toggle, chip swapping without moving nodes, hover highlighting, the fix and accept commands, and the card.
- Integration: the Data, Code and Timing lenses render without editing; _Mark expected_ records the Git author; with Docker on the GNS3 VM, the Inventory and Access lenses read the fixture inventory and the vault value never leaves the container.
- A probe contract test checks the counts, origins and vault names on ansible-core 2.19, 2.20 and 2.21.

## Consequences

- Inventory facts are as good as the local inventory. A flow launched in AWX may target another inventory; the panel says so.
- The history holds only runs started from VS Code; jobs started elsewhere in AWX do not count.
- `inventory_target` was informational until AFD-14; codegen now runs the node's work on it (ADR-0009).
- The slowest-path estimate assumes every host may take any port and that branches run one after another (decision 16). It errs on the long side.

## Amendment: canvas readability (AFD-42, 2026-11-01)

Improvement program wave 3. The AFD-33 baseline opened large levels at zoom 0.5–0.63, so titles were 6–8 px on screen, and labelled every wire with its port name (88 labels on 88 wires over the four measured flows).

- **Type:** node titles 14 px, sub-lines 12 px (`--afd-font-node-title`, `--afd-font-node-sub`).
- **Opening view** (`core/view/fit.ts`, `readableViewport`): a level that fits whole at zoom 0.8 or more (titles ≥ 11 px) opens whole, at 100% at most. Otherwise it fits its width, aligned to the top, never below 0.8. A level wider than that centres its top node, without showing empty space past either edge. It runs once, after React Flow has measured the pane; a viewport the user left on the level wins. **Fit View** and the zoom controls still show the whole level (`FULL_FIT`, at 100% at most).
- **Wire labels** (`core/view/nodeFace.ts`, `labelledAtRest`): wires leaving by `ok_hosts`, `approved` (and entries) have no label at rest; every other port (failures, branches, decisions, timeout, `always`, `unchanged`) keeps its label. Hovering or selecting a wire shows its label. Run mode keeps host counts and lenses keep their wire labels.
- **Status, once:** a stripe on the node's left and an icon in its head (`StatusIcon`: circle for draft, filled circle for specified, check for implemented, verified for tested); the readiness list uses the same icons. No status fills or dashed draft borders: fills belong to run and lens overlays, borders to types (subflow double, decision, approval, handler). In Run mode the run bar replaces the stripe.
- **Sub-line** (`subLine`): the bound module or role (monospace), else the kind of node; a decision shows its condition; handler and keyword hints follow.
- **Shapes:** parallel and join are fork and merge bars 36 px high (`BAR_HEIGHT` in `core/flow/geometry.ts`, also used by ELK); decision and approval have a header band in their colour.
- **Minimap** (React Flow's `MiniMap`, bottom left, pannable and zoomable) while part of the level is out of view.
- **Test mode** (VS Code's integration tests and the harness) draws every node: with part of a large level now off screen at the opening zoom, culling (`onlyRenderVisibleElements`) would hide nodes the structural checks read. Production keeps culling.
- **Direction:** the user setting `afd.canvas.direction` (`TB`, `LR`) drives ELK for unplaced nodes and Tidy Up (`layoutLevel`/`autoPositions` take the direction); it is never written to the flow. MCP and the AI tools lay out top to bottom.
- **Not done:**
  - **Near zoom:** `NEAR_ZOOM` stays 1.4, not 1.0. Levels now open at up to 100%, so 1.0 would put every small level in the summary-row view, and three rows do not fit the 76 px node at the new type sizes. The sub-line carries the module, which was the reason to show detail sooner.
  - **Exports:** draw.io and SVG/PNG keep the status fills of ADR-0020 until they are brought in line.

**Measured** (`just ux-baseline`, 1280×800):
- every title on screen at the opening zoom is 13.5–14 px;
- firewall-upgrade's top level opens at 1.0 (was 0.63), the imported "Edge baseline" play at 1.0 (was 0.5);
- labelled wires at rest went from 88 to 24 (−73%).

## Amendment (AFD-51, 2026-11-01): format 2 decisions

In a format 2 flow an accepted lens finding is an `accepted` decision with
`finding: lens:<finding id>` (ADR-0025). Lenses read both formats through `core/flow/decisions.ts`.

## Amendment (AFD-57, 2026-11-01): the Changes lens

A sixth lens compares the flow with another version of it, for review: HEAD by default, another
local branch, or one of the last 15 commits that touched the file (product-owner decision).

- **Facts:** the host reads the versions and the file's text at the chosen ref through the
  vscode.git API (`log` with the path, `show`), parses it, and sends it as `facts.compare`; the
  webview's `compareWith` message picks another ref. The base is read when the lens opens or the
  ref changes, not on every edit: unsaved edits compare against the same base.
- **Diff** (`core/flow/semanticDiff.ts`, pure): nodes match by ID, then unmatched ones by key path
  and type; a node's reviewable fields are its entry without the ID, inner level and `tested`
  evidence, plus the subflow boundary and the decisions about it, with format 1 `handler` read as
  `purpose`. Wires compare by their ends in current IDs. The flow's own fields and the format are
  compared too; the version is not.
- **View** (`core/lens/changes.ts`): chips (`changed: <fields>`, `added`, `N changes inside` on a
  subflow), labels on added wires, `ghosts` for removed nodes (their stored position, else a column
  beside the level), sections Changed, Added, Removed, Wires and Flow. No findings: a change is not
  a problem to accept.
- **Details** shows the selected node's field changes, before → after.

## Amendment: annotations in the Changes lens (AFD-66, 2026-11-02)

- `FlowDiff.annotations` matches annotations by ID, else by key on the matched level. It compares kind, text, color, size and the node a note is on (by key); a move is no change.
- The lens adds `LensView.annotations` (added or changed, outlined on the canvas and not faded), an **Annotations** stat and section when there are any, and counts them in "No changes since …".

## Amendment: a lens says what it shows, and why it is empty (AFD-83, 2026-11-04)

Wave 8 group I, added by usability round 1. The participant turned the Inventory and Data lenses on
and read the result as the canvas emptying (P10). A lens chips only the steps it has something for,
and the Inventory lens without flow targets has nothing for any step.

- **A caption over the canvas** (`panels/CanvasCaption.tsx`) names the lens and what it shows (the
  `LENSES` hint), with a reason (`core/lens/caption.ts` `lensCaption`) when no step on the level
  has a chip. The lens's own note (inventory not read, no runs) is used first, else one sentence
  per lens. The Inventory lens without targets says so and offers Set Targets….
- **The lens tab** starts with the same description.
- The caption also names Code and Run mode with what each is for and that the graph only reads
  there (P11: the switch read as stages of designing). Design without a lens shows no caption, so
  the first screen keeps its 35 controls.

## Amendment: findings where the step is (AFD-87, 2026-11-04)

A lens's findings also show in the Details of the steps they are about (ADR-0024's AFD-87
amendment). The lens still never edits the flow by itself: the fixes are the same one-command
fixes, and an acceptance is the same `accepted` record.

## Amendment: the Changes lens compares with the flow before outside changes (AFD-104, 2026-11-07)

A change pulled with Git is in HEAD, so the Changes lens, comparing with HEAD, showed none of it
(usability round 3, R9). While the flow has outside marks (ADR-0001), the compare list starts with
"the flow as you last had it open (time)", or "the flow before the outside changes (time)" for
marks made while it was open, from the session's `outsideBase`; it is the default until the person
picks another version. Clear, or marks that go, return a lens left on the default to HEAD.

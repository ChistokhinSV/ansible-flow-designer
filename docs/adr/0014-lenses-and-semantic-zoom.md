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
6. Codegen ignores `inventory_target` today. M8 shows it as declared, with a finding; applying it in codegen is AFD-14.

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
  - findings: a handler or fail-path node whose declared target reaches beyond the flow targets (fix: _Limit to arriving hosts_); a declared group not covered by the targets or a flow input default (fix: _Add to flow inputs_); a declared pattern matching no host; production groups in scope; `inventory_target` declared but not applied (AFD-14).
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
- `inventory_target` stays informational until AFD-14 changes codegen.
- The slowest-path estimate assumes every host may take any port and that branches run one after another (decision 16). It errs on the long side.

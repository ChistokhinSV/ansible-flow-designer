# 06 · Implementation plan

Suggestions, not requirements. Confirm with the product owner before committing to them.

> **Update 2026-10-28:** the target is now a VS Code extension. The "Suggested architecture" section below is superseded by `08-vscode-extension-target.md`; the milestones, M1 acceptance checks and open questions still apply. See `07-lessons-from-playbook-studio.md` for what is already proven.

## Suggested architecture

- **Frontend:** TypeScript, React, React Flow (`@xyflow/react`) for the canvas (custom node components, handles as ports, edge labels). State in a store keyed by node ID. Auto-layout with ELK (`elkjs`) for imports and "tidy up".
- **Backend:** Python (Ansible tooling is Python). FastAPI or similar. Responsibilities: load and validate flow documents, code generation, Git sync and drift detection, module docs from EEs, AWX API integration, run event ingestion.
- **Storage:** flow documents and layout files in Git (source of truth). A small database only for caches (EE module docs, run summaries, sync state).
- **Validation:** `schema/flow.schema.json` on both sides, plus semantic checks (port compatibility, open fail ports, boundary completeness, unresolved inputs).

## Milestones

| # | Scope | Mockups |
|---|---|---|
| M1 | Flow document load/save, schema validation, Design-mode canvas: nodes by type and status, ports with placement and visual rules, edges, palette, quick add, inspector, flow description, open-port banner, layout stored separately | 01, 02, 03, 05 |
| M2 | Port disclosure on hover, port menus, failure patterns, "open on purpose" decisions | 07, 06 |
| M3 | Skeleton code generation (Option A layout), node ID tags, run as skeleton in check mode | 03 |
| M4 | Subflows: create, preview card, drill-down with boundary, boundary validation | 10 |
| M5 | Node properties: module search and docs from EE, generated forms, input chips, role and playbook binding, real code generation | 11 |
| M6 | Implementation mode: Git sync, ID matching, drift panel with two-way actions | 04 |
| M7 | Run mode: AWX launch, event ingestion, host counts on wires, per-host results | 05 |
| M8 | Lenses (Inventory first, then Access, Data, Timing, Code) with side panels and findings; semantic zoom | 08, 09 |
| M9 | Import of AWX workflow templates with auto-layout | — |

## Acceptance checks for M1

- Creating, renaming and moving nodes never changes any ID; edges survive renames.
- Moving a node changes only the layout file.
- A node of each type shows exactly the default ports from the port catalog.
- The banner count equals the number of open fail-type ports not marked "open on purpose".
- `examples/*.flow.yaml` load, render and round-trip without changes.

## Open questions

1. Per-host engine: Option A (single playbook with routing) or Option B (backend-orchestrated AWX jobs)? See 05. Affects M3, M7.
2. Repository strategy: one repo with many flows, or flows living in each automation repo?
3. Definition of `tested`: any passing run, a passing run in a specific environment, or a passing Molecule test?
4. Parallel and join semantics with host sets: does `join: all` wait for every branch per host or per branch?
5. Approvals: AWX approval nodes (cannot distinguish rejected from timeout) or engine-side approvals?
6. Who may mark a port "open on purpose", and does it require a reason?
7. Data ports: visible on canvas behind a toggle, or only in the Data lens?
8. Access control and audit for launching flows from the designer versus from AWX directly.

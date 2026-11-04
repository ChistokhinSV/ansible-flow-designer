# ADR-0012 · Implementation mode: code sync and two-way drift

Status: Accepted · 2026-10-29 · AFD-9 (M6)

## Context

D-28 puts the node ID into generated code (`node_<ULID>` tags, `[key]` name prefixes) so code can be mapped back to nodes. D-29 asks for drift in three kinds (contract mismatch, code without design, design without code), shown both ways and never resolved automatically. Mockup 04 shows the Implementation mode: same canvas, nodes with their bound artifact and task count, and a side panel "Design vs code" with the sync source, the nodes matched by ID, drift items with two actions each, and the last run. 07 §5 warns against regex-parsing YAML: `Playbook.load` + `play.compile()` + `task._origin` is the reliable way; the automatic `validate_argument_spec` task must be ignored; dynamic includes are not expanded.

Decisions by the user:
1. Sync source: the working tree, labelled with branch @ HEAD commit and time, plus the uncommitted changes that matter.
2. Ignore: a `decisions` entry (kind `drift_ignored`) with a required reason and the Git user, shared through Git.
3. Generate stub: a role scaffold with argument specs for an unbound node; "Write argument_specs" for a bound role without them.
4. Add to subflow: the uncovered role task file becomes an unwired inner step, selected so the user wires it.

## Decision

**Probe `compile(playbooks, roles)`.**
- Playbooks:
  - `Playbook.load(...).get_plays()` and `play.compile()`;
  - per play: name, hosts, tags, origin;
  - per task: name, action, tags, origin (path relative to the repository, line), registered variables, `set_fact` and `set_stats` keys, role, block section, dynamic (`include_*`), auto (`validate_argument_spec`).
  - Implicit `meta` tasks without an origin are dropped.
  - `import_playbook` levels and playbook bindings arrive as plays of the root file; their tags carry the importing node's ID.
- Roles: a synthetic play with `import_role` (and `tasks_from`) per bound role entry point.
- Errors are reported per item, so one broken role never stops the scan.
- `register` comes as a string up to 2.20 and as a mapping in 2.21; both are normalised to a list. Checked on 2.19, 2.20 and 2.21.

**Sync (host).** Re-sync from git:
- compiles the flow's root generated playbook, every bound playbook (on its own, because a missing one breaks the import), and every bound role entry point;
- reads `roles` (argument specs, task files);
- takes branch, commit, commit time and the uncommitted paths of the flow folder, bound roles and bound playbooks from `vscode.git` (after `repository.status()`, which the Git extension otherwise runs late);
- reads bound modules' return keys from the catalog's last index.

The scan goes to the webview. It runs on the first visit to Implementation mode, on Re-sync, and after each save while a scan is shown.

**Drift (pure, `core/drift`).** `computeDrift(doc, scan)` runs in the webview on every snapshot, so design-side fixes show at once without a new scan. It produces:
- **matching:** a node matches when a generated play carries its tag. "N / M nodes matched by ID" counts every node except start and end.
- **contract mismatch:**
  - a role node output that the role neither registers nor sets ("Design expects `validation_result`, code registers `diff_report`"). Update design renames the output, rewriting downstream `from:` references in the same edit; Open code goes to the producing task.
  - a required role argument the node does not pass. Update design adds the input, from the flow input of the same name when there is one.
  - a node input the role spec does not know (info).
  - no argument spec for the entry point (info). Write argument_specs.
  - a module output read from a result key the module does not return (catalog). Read `<key>` instead.
- **code without design:**
  - role task files a subflow bound to the role does not cover with its inner steps (`main` excepted): Add to subflow / Ignore;
  - generated plays tagged for a node that is gone: Regenerate / Open code.
- **design without code:**
  - unbound task nodes ("Designed and wired to a fail port, but nothing is bound."): Generate stub / Bind role;
  - missing roles: Create role / Bind;
  - missing playbooks;
  - nodes without a play ("not in generated code"; info when nothing leads to them);
  - no generated code at all;
  - a binding added after the last scan ("not scanned yet": Re-sync).
- Every item with a node can be ignored. Ignored items stay listed with the reason and a "Stop ignoring".
- Warnings are drift. Info items are notes, listed apart.
- Dynamic includes are reported (task lists say "dynamic include, not expanded"). The role output check then turns into a note.

**Actions.** Design-side actions are flow commands, each one edit and one undo step:
- `setContractField` (with the output rename),
- `addNode` with `impl` (new),
- `ignoreDrift` and `clearDriftIgnore` (new).

Code-side actions:
- Open code opens the file at the line.
- Generate stub creates `roles/<node_key>/tasks/main.yml` (a TODO debug, `set_fact` for each output) and `meta/argument_specs.yml` (from the inputs), plus the binding, all in one WorkspaceEdit. An existing role is never overwritten.
- Write argument_specs creates the file, or adds the entry point to an existing one through the byte-preserving YAML engine.

**Schema (additive, v1).** A decision is either `open_on_purpose` (requires `port`) or `drift_ignored` (requires `item`), chosen with `if/then/else` on `kind`. The validator checks that ignored items have a node and a reason.

**UI.**
- The mode toggle enables Implementation. In that mode the top bar shows Re-sync from git instead of the run and validate actions (04 §1).
- Nodes keep their geometry. Their second and third lines show the artifact (`role: netops_validate`) and "N tasks · state" (drift, TODO stub, last run, open subflow, matched).
- The right panel is "Design vs code". A selected node shows its tasks with file:line links and its drift.

## Consequences

- The scan needs the environment (probe), so the first Implementation view of a session starts it. Drift itself is recomputed locally.
- Role outputs are compared by name, which follows ADR-0011's convention (a fact of the output's name). Roles that publish through other means show as a note to ignore.
- Uncovered task files are judged against `main` as the role's own entry. A role whose `main` includes every file shows the others as drift until a step covers them or the item is ignored.
- Undo of Generate stub is VS Code's multi-file undo: it may ask before deleting the created files.
- M7 (Run mode) reuses the matching (node tags) for run events.

## Amendment (AFD-51, 2026-11-01): format 2 decisions

In a format 2 flow an ignored drift item is an `accepted` decision with `finding: drift:<item>`
(ADR-0025). Drift reads both formats through `core/flow/decisions.ts`.

## Note: the Flows view's code state is not drift (AFD-86, 2026-11-04)

The Flows view shows "code out of date" or "edited by hand" from the write plan alone (the
generated files' checksums against what the flow generates). It cannot run Code mode's drift
check, which compiles the code in the environment, for every flow of a repository. So it never
says "drift"; Code mode stays the place for that.

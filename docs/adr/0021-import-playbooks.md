# ADR-0021 · Import playbooks and AWX templates, as is

Status: Accepted · 2026-10-31 · AFD-26 (as is); the AI-assisted import follows in AFD-27

## Context

Only AWX workflow templates imported (ADR-0015), and each job template node in them was one opaque
playbook step. That step routes hosts only when its playbook targets `{{ afd_hosts }}`. Teams also
have plain playbooks, folders with roles, task files, handlers and variables, and AWX job
templates. The product owner asked for import from AWX and from local playbooks or folders, both
as is (a deterministic 1:1 flow) and with an AI assistant (an intent-based flow with subflows).

Decisions (product owner, 2026-10-31):
1. Task keywords go on the binding: `impl.keywords`, written on the generated task as is, edited on
   the Execution tab, Jinja checked like params. Handlers become steps at the end of their play,
   run with `when: <notifier> is changed`.
2. Roles: one step bound to the role. A role whose `tasks/main.yml` only includes other task files
   becomes a subflow bound to the role, with one step per file (`tasks_from`). Role tasks are never
   expanded into module steps: their templates, files, defaults and handlers are role-relative.
3. Unhandled failures stay open (the banner shows them), as in the AWX import.
4. AI: the import command opens Copilot Chat with a ready prompt; other agents get it copied
   (AFD-27).
5. AWX: job templates import; the workflow import expands playbooks of the repository into
   subflows; AI over AWX uses a sanitized export file (AFD-27).
6. A job template playbook not in the repository is a draft playbook step, with a note naming the
   project and its SCM URL.
7. A folder offers its playbooks (top-level ones selected); each becomes its own flow, and
   `import_playbook` becomes a subflow.
8. Agents get an outline tool and the as-is import as a tool (AFD-27).

## Decision

**Reader** (`src/core/import/source.ts`, `read.ts`, `builtins.ts`).
- Pure and IO-injected (`SourceIO`): the same code reads `workspace.fs` in the extension, files
  inside the roots in the MCP server, and memory in tests.
- Ansible's own loader (the probe's `compile`, ADR-0012) was not used. It needs an environment,
  flattens blocks, and drops arguments, `when` and `loop`.
- YAML is read with Ansible's tags. `!vault` becomes an opaque marker and its ciphertext is
  dropped; `!unsafe` is a plain string. Merge keys apply, and every mapping keeps its line.
- **Tasks:**
  - the module is the one key that is not a task keyword;
  - `action:` and `local_action:` (which becomes `delegate_to: localhost`), k=v text (unquoted and
    unescaped as Ansible's `parse_kv` does), free-form commands (`cmd`, `_raw_params`) and `args:`
    are put in one form;
  - `with_items` and `with_list` become `loop`;
  - play and block keywords are handed down as Ansible does: `when` ANDed, tags joined, become
    and the connection keywords inherited;
  - short builtin names get `ansible.builtin.`. Other short names are resolved by the folder's
    catalog when one is loaded (play `collections:` first); otherwise they are kept as written.
- **Includes:**
  - literal `include_tasks` / `import_tasks` are read in (next to the including file, then the
    playbook);
  - templated or looped ones are not;
  - depth is capped at 8, and a file that includes itself is stopped;
  - `import_playbook` is followed, and cycles are stopped.
- **Roles:**
  - looked up in the repository `ansible.cfg` `roles_path`, `roles/` next to the playbook, the
    repository `roles/`, and collections;
  - a role is split when `main` holds only literal includes;
  - what its tasks register or `set_fact` is read statically, so later steps can read it;
  - `onRolesPath` tells whether generated playbooks find it (runs use the repository's
    `ansible.cfg`).
- **Local files** (template, copy, script, unarchive sources, `include_vars`) are found where
  Ansible looks (`templates/`, `files/`, `vars/` next to the task file or the playbook). The keys
  of `vars_files` are read.
- **Folders:** playbooks are found by a regex pre-filter, then parsed. Entries are those no other
  playbook imports.

**As-is mapper** (`src/core/import/playbook.ts`). One step per task, in source order:
- **Plays:** one play is the top level; several plays (or an imported playbook) are a subflow
  each. The first play's hosts become the `devices` default. A later play on other hosts gets
  `inventory_target` on its subflow. `gather_facts` (on by default) becomes an
  `ansible.builtin.gather_facts` step.
- **Blocks with rescue or always** become a subflow:
  - its `failed_hosts` lead to the rescue steps;
  - the subflow's and the rescue's `ok_hosts` meet at the always steps;
  - hosts that fail in the rescue (or the block, with no rescue) run a copy of the always steps
    (`<key>-after-failure`), then fail: an end with outcome failed, or inside a subflow an exit to
    its `failed_hosts` with the reason;
  - plain blocks are inlined.
- **Handlers** run at every flush point (after pre_tasks, after roles and tasks, after post_tasks,
  `meta: flush_handlers`) with `when: (<reg> | default({})) is changed or …` over the registers of
  the steps that notified them (`listen` resolved). Notifying steps get a register when they had
  none.
- **Data:** after the tree is built, every variable a step reads is wired:
  - in params and keywords, from the latest earlier producer (a register, set facts, a vars file,
    what a role sets): an output on the producer, lifted through the subflows in between, and an
    input on the reader;
  - flow inputs read directly get `from: flow.<name>`;
  - inputs keep the variable's name, so the generated code passes nothing extra.
- **Variables:** play vars and prompts become flow inputs. A name with different values in
  different plays keeps the first as the input default; the other plays' steps get their own in
  `keywords.vars`. Secrets are imported by name only: vault values, private prompts, secret-looking
  names, and vault values inside params.
- **Paths:** local files become `{{ playbook_dir }}/<path from flows/<key>/generated>`.
- **No one-to-one form:**
  - draft steps: dynamic includes, `meta` (other than `flush_handlers`), unknown short module
    names;
  - an approval: `pause` with a prompt;
  - play `serial`, `any_errors_fatal` (as `max_fail_percentage: 0`) and `max_fail_percentage`
    apply to each step;
  - left out: `strategy` and `order`.

  Each is in the notes.
- **The result:** 0 errors, and code generation runs. The file stores no positions, as a new flow
  does (AFD-23).

**Commands.**
- _Import Ansible Playbooks…_ (`afd.importPlaybooks`) is in the Command Palette and on the
  Explorer's right-click (folders, and `*.yml`/`*.yaml` that are not flows). It takes a playbook
  (key asked) or a folder (multi-select, keys derived). Shared helpers are in
  `src/extension/import/common.ts`.
- _Import AWX Workflow…_ became _Import from AWX…_ (same command ID). It lists workflow templates
  and job templates. Playbooks of the repository are read and passed to the importer, which expands
  them (ADR-0015 amendment).

**Schema** (additive, v1):
- `impl.keywords`, an allow-list (ADR-0009 amendment);
- `flow.imported_from.kind` adds `awx_job_template` and `playbook`, with `path`; `template` is no
  longer required.

## Consequences

- **A faithful copy.** The engine suite runs the fictional netops repository's `site.yml` and its
  imported flow side by side in ansible-core 2.19, 2.20 and 2.21: every host writes the same files
  with the same contents, and the same hosts end failed. The repository has roles (one split),
  block/rescue/always, a loop, handlers with `listen`, `include_tasks`, `vars_files`, a vault
  value, a prompt and an unreachable host.
- **Imports are large:** Option A runs one play per step, so an imported playbook generates long
  code. The AI-assisted import (AFD-27) is the way to an intent-based design.
- **Semantics that differ, all noted:**
  - `serial` and `max_fail_percentage` apply per step;
  - a role's `when` is evaluated once;
  - `ansible_failed_task` is undefined in rescue steps, which run in their own plays;
  - group_vars and role defaults read in params stay unknown variables (warnings).
- **Roles need roles_path:** a role outside the repository's `roles_path` is bound by name, and
  the notes say to add its folder.

## Amendment: AI-assisted import (AFD-27, 2026-10-31)

Decisions 4, 5 (AI over AWX) and 8, as designed:
- **Tools** (`src/core/ai/handlers.ts`, `src/core/import/outline.ts`):
  - `source_outline {path, flow?, focus?, page?}` outlines a folder (playbooks, entries first, roles), a playbook (plays and a numbered tree of tasks; each with `impl:` exactly as the as-is import writes it, paths rewritten for `flow`), a role folder, or an AWX export (templates, nodes, edges, which playbooks are in this repository). It ends with what an as-is import would note. Pages of about 24,000 characters; `focus: "#n"` shows one task in full. Secrets show as `<secret name>`.
  - `flow_import {source, path?, template?, name?}` runs the deterministic import (a playbook, or a workflow or job template of an AWX export, expanding playbooks of the repository) and creates the file through `FlowIO.create`, so it is a save (generated code written).
- **Reading:** `FlowIO.source(path)` returns the reader of the root that holds the path:
  - **MCP** (`FsSourceIO`): realpath and inside-root checks; reads `.yml`, `.yaml`, `.json` and `ansible.cfg` only, at most 2 MB; existence of other files may be asked, never their content;
  - **Copilot:** `workspace.fs` (open editors win), paths that leave the folder refused, the same file kinds;
  - both: multi-root by the root's name, and the catalog resolves short module names where it is loaded (Copilot).
- **The prompt** (`src/core/import/prompt.ts`) names the source and the flow to write. It asks for `source_outline`, intent-based subflows, copied `impl`, `set_io` for data, failures handled only where the source handles them, handlers as `when: (<register> | default({})) is changed` steps, `flow_validate`, and a report; `flow_import` is for an exact copy.
- **Commands:** after the source and keys, a mode pick (As is / With an AI assistant). The AI mode checks the keys, writes nothing but (for AWX) the sanitized export, and hands the prompt over (`src/extension/import/aiStart.ts`):
  - the prompt always goes to the clipboard;
  - with Copilot Chat installed, a pick offers it: `workbench.action.chat.open {query, mode: 'agent', isPartialQuery: true}` fills the chat without sending;
  - on any failure, the clipboard message offers _Set Up AI Assistants_.
- **Sanitized export** (`src/core/awx/sanitize.ts`): built from the normalized `WorkflowSource` only. Extra vars and node extra data with secret values become `$encrypted$`; password and secret survey defaults are dropped; credentials are kept by name and kind; projects keep their SCM URL without credentials. It is written to `flows/<key>/source/awx-export.json`, and importing it gives the same flow as the source it came from (tested).
- **Bundle:** `mcp.js` grows to 926 KB. The budget is raised to 960 KB (ADR-0017 amendment) rather than splitting a lazy chunk, which would carry its own copy of `yaml` and the flow model.

## Amendment: re-import merge (AFD-61, 2026-11-01)

Product-owner decision: "Merge, keep designer edits". An as-is playbook import was a one-time copy; a flow imported from a playbook can now take the playbook's later changes.
- **Identity** (`src/core/import/playbook.ts`): every task step gets `origin: {task, design}`.
  - `task` is `<repository path of the file>#<task name>#<occurrence>` (the n-th task of that name in that file, in import order), so it survives reordering and edits to the task body.
  - `design` is an FNV-1a fingerprint of the step's imported fields (`title`, `intent`, `impl`, `settings`, `ports`), taken when the import is done (`stepDesign`, `src/core/import/reimport.ts`).
  - Schema: `origin` with `task`, `design` and `gone`. Steps the import makes for plays, blocks and split roles have no origin: their structure is not merged.
- **Merge** (`planReimport(current, fresh)`): the source is imported again with the same key, then matched by `origin.task`:
  - fresh design = recorded design: the source did not change it (`same`);
  - otherwise, the step's own fingerprint = recorded design: only the source changed (`updates`); different: both changed (`conflicts`). Fields that are equal anyway count as `same`;
  - a task only in the fresh import: `adds`, after the step of the previous matched task;
  - a step whose task is not in the fresh import: `gone` (once; a flagged step is not listed again).
- **Command** `reimport {updates, adds, gone, keep}` (`src/core/flow/commands.ts`), one transaction:
  - updates replace the imported fields and record the fresh design;
  - adds go through `addNode`, inserted on the previous step's `ok_hosts` wire (else connected from it), with settings, ports and origin;
  - gone sets `origin.gone` (validator warning `import-gone`): never deleted;
  - keep records the fresh design without touching the fields, so a change not taken is not offered again until the source changes that task again.
- **VS Code** (`src/extension/import/reimport.ts`, `afd.import.reimport` Re-import from Source): reads `imported_from.path` through the workspace source (open editors win) with the catalog's module resolution, plans, and shows a multi-select preview (conflicts unpicked, the rest picked). Unpicked updates and conflicts become `keep`. Tests pass `{take}` instead of picking.
- **Limits:** wires, inputs, outputs and decisions are never merged; a new step brings its own data contract, and wiring `from:` to it is left to the designer and the validator. Flows imported before 0.39 have no origins and are refused with a message. AWX and AI-assisted imports are not re-imported.

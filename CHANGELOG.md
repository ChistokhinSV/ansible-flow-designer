# Changelog

## 0.25.1 — AFD-42

- **A readable canvas** (improvement program, wave 3):
  - **Levels open readable:** whole when titles stay at least 11 px on screen (at 100% at most), else fitted to their width from the top, with a **minimap** while part of the level is out of view. Fit View still shows everything. The firewall sample's top level now opens at 100% instead of 63%.
  - **Bigger type:** node titles 14 px, the line under them 12 px.
  - **Fewer labels:** wires on the normal path (`ok_hosts`, `approved`) have no label at rest; failures, branches, decisions, timeouts, `always` and `unchanged` keep theirs. Hover or select a wire to see its port. Over the sample flows, 73% fewer labels.
  - **Status once:** a stripe and an icon instead of a fill colour and a dashed border; the readiness list uses the same icons.
  - **The module under the title:** the bound module or role, else the kind of node; a decision shows its condition.
  - **Shapes:** parallel and join are fork and merge bars; decisions and approvals have a coloured header.
- **`afd.canvas.direction`** (TB or LR): the direction of the automatic layout for unplaced nodes and Tidy Up, a setting of yours that is never written to the flow.

## 0.25.0 — AFD-41

- **One word per thing** (improvement program, wave 3): a [glossary](docs/guide/reference/glossary.md) fixes the words the designer, the Command Palette and the guide use, and a test keeps them so.
  - **Implementation mode is Code mode**, and its tab in the node page is **Binding**; the node page is **Details**.
  - **Accept with Reason…** replaces Leave open on purpose…, Mark expected and Ignore…; **Reopen** takes it back.
  - **Open in Text Editor** replaces Open as text, Show as text and Show in text; **Tidy Up**, **Generate Code**, **Import AWX Workflow or Job Template…**.
  - Actions are in Title Case in every menu and button, as in VS Code.
- **Check Flow** replaces Validate Design and Check Generated Code: it checks the design and, when the design has no errors, the generated code in your Ansible environment. It is in the designer's "…" menu in every mode.
- **Command ids** are now `afd.<area>.<verb>` (`afd.flow.check`, `afd.run.skeleton`, …). The old ids keep working until 0.27 for your keybindings and links, but are no longer in the Command Palette ([commands](docs/guide/reference/commands.md)).
- **Keys in the designer:** Ctrl+F5 Run as Skeleton, Shift+F5 Stop Run, Ctrl+Shift+B Generate Code, Shift+Alt+F Tidy Up, F7 Check Flow; the `?` sheet lists them.
- The MCP server's size budget is now 1,088 KB (it is 954 KB).

## 0.24.6 — AFD-40

- **Core, one rule in one place** (improvement program, wave 2; no visible change, generated code byte-identical):
  - **Subflow bubbling** is one module (`core/flow/bubbling.ts`) for the open-port banner, the generated routing, the subflow frame, the boundary check and Extract into Subflow; output lifting is one (`core/flow/lift.ts`) for Extract into Subflow and references into subflows.
  - **Walking and building:** one node walker (`core/flow/walk.ts`); the AWX and playbook importers build levels with one `LevelBuilder` (`core/flow/builder.ts`).
  - **Layers:** the variable names a flow's data lives in (`core/flow/dataNames.ts`) and the approval segments (`core/flow/segments.ts`) moved out of the engine, so the validator no longer imports it (Biome now refuses it); `engineFor(doc)` picks the engine for every caller.
- **Fixed:** Extract into Subflow could give two lifted outputs the same name when the prefixed name was taken too (`q.a_b_c`, `z.c` and `a-b.c` all read outside lifted two `a_b_c`); the second is now `a_b_c_2`.

## 0.24.5 — AFD-39

- **Stop a run** (improvement program, wave 2): while a run goes, the top bar shows **Stop**, and the Command Palette has **Ansible Flow: Stop Run**. A local run's terminal task ends and the run shows as stopped (not failed); an AWX job or workflow is cancelled in AWX and followed until AWX reports it canceled.
- **Check Generated Code** runs with a progress notification you can cancel; a cancelled probe call leaves the queue, or restarts the probe for the calls behind it when it was running.
- Every timeout the extension uses is in one module (`src/node/timeouts.ts`).

## 0.24.4 — AFD-38

- **Flow sessions** (improvement program, wave 2):
  - **No stale problems:** a flow's problems are set as soon as it is validated, and only for the text the document still has; a slower, older build can no longer overwrite them (or the snapshot) after a newer one.
  - **Typing in the text editor** settles for 150 ms before the designer parses, validates, generates and lays out again; the designer's own edits and undo still show at once.
  - The lens facts and the code sync each have their own controller (`session/lensController.ts`, `session/syncController.ts`), and requests a designer answers later (the PNG drawing, the test summaries) share one tracker.

## 0.24.3 — AFD-37

- **Host architecture** (improvement program, wave 2):
  - **Layers:** the modules that run without VS Code moved to `src/node/` (layout, AWX client, catalog index, probe client, agent setup writers, run storage); Biome now refuses `vscode` in the core, node, MCP, CLI and webview layers, and file or process access in the core. The flow file text writer moved to `core/flow/text.ts`.
  - **Commands** live in per-area modules (`src/extension/commands/`); `activate()` only composes (654 → 102 lines). A command run without an open flow now says "Open a flow first" with _New Flow…_ instead of doing nothing.
  - **Errors** carry a code: a missing AWX address, token or template comes with the button that fixes it, and cancelled prompts are never shown as errors. _Set Up AI Assistants_ now logs to the one _Ansible Flow_ output channel.
  - **Runs** share one preamble (save, generate, read) and audit header; the inputs helpers have their own module.
  - **Import sources:** Copilot's tools and the MCP server read the same kinds of files, skip the same folders and refuse files over 2 MB; Copilot's tools also refuse a symlink that leads out of the folder, and in a multi-root workspace resolve module names with the folder the playbooks come from.
  - **Startup:** after an AI setup, the extension no longer hashes the MCP server (about 2.4 MB) at every start; it compares size and time.
  - **Bundle budgets** for the extension (768 KB) and the webview (1,088 KB) next to the MCP server's (960 KB).

## 0.24.2 — AFD-36

- **Styles** (improvement program, wave 2; nothing changes on screen in the usual themes):
  - The 2,400-line stylesheet is split into one file per area (`src/webview/styles/`, imported in cascade order).
  - Every font size comes from a type scale token (`--afd-fs-*`, the sizes in use), with role tokens for node titles and sub-lines; the side panel widths are variables, so the error toast follows the right panel instead of a hard-coded 336 px.
  - **Reduced motion:** with the system's reduce-motion setting, the designer does not animate.
  - **Windows contrast themes:** ports, status dots and legend swatches keep their state colours, and focus uses the system highlight.
  - A unit test keeps literal pixel font sizes out and every area file imported.

## 0.24.1 — AFD-35

- **Webview foundations, part 2** (improvement program, wave 2; nothing changes on screen):
  - Overlays (menus, dialogs, the pick bar, the hover card, the properties page) follow one declared table of what opening each one closes, and Escape closes them in one declared order (`webview/overlays.ts`), instead of resets spread over the store and the keyboard handler.
  - _Leave open on purpose_, _Ignore this drift_ and _Mark as expected_ share one reason dialog.
  - The right panel is chosen by one tested rule (`rightPanelFor`); its accessible name now also says "Selected nodes" and "Subflow boundary" for those panels.
  - The test-only DOM summaries moved out of `App.tsx` into `webview/inspect.ts`.

## 0.24.0 — AFD-34

- **Webview foundations, part 1** (improvement program, wave 2; nothing changes on screen):
  - The designer builds the flow model once per update instead of six times: `modelOf(doc)` caches it per document, and the webview and the views derived from a snapshot (level view, run view, lenses, drift) read the cached one. Commands and the validator still build from what they edit.
  - Hooks `useModel`, `useNode` and `useLevelView` for components; node code state (`core/view/codeState.ts`) and the Execution settings table (`core/view/settings.ts`) moved out of components and are unit-tested; shared labels, drag types and `ago` live in `webview/constants.ts`.
  - Measured with `just ux-baseline`: 1 model build per snapshot (was 6); the Design, Code and Run screenshots are byte-identical to the baseline.

## 0.23.4 — AFD-33

- **UX baseline** (improvement program, wave 1; development only, nothing changes in the designer):
  - `just ux-baseline [label]` writes `docs/ux/<label>/`: four flows (empty, branching, with subflows, imported) in Design, Code, Run and with a lens, at 1280×800 and 1920×1080, plus canvas metrics per level (effective title size at the zoom a level opens with, readable nodes, wire labels, overlaps) and model builds per snapshot.
  - The baseline: the subflow-heavy sample opens at zoom 0.63 (titles 7.8 px, none readable), the imported play at 0.5 (6.2 px); 18 wire labels on the sample's top level; 6 model builds per snapshot.
  - `docs/ux/baseline/tasks.md`: the steps of eight core tasks today and which ones work with the keyboard only (finding a step and wiring to a picked node do not). `docs/ux/a11y-checklist.md`: the accessibility checks per surface with the baseline results.
  - The screenshot scripts share their harness helpers (`scripts/harness-lib.mjs`).

## 0.23.3 — AFD-32

- **The Ansible probe is more resilient** (improvement program, wave 1):
  - Calls wait their turn in the extension, so a call's timeout counts from when it is sent. Before, a lens or Re-sync call could time out while it was still waiting behind a long catalog dump, and its timeout then stopped the probe, failing the dump and every other call.
  - A call that times out fails alone: the probe restarts for the calls behind it.
  - Reading the collection docs for the module catalog runs in a probe of its own, stopped when it is done.
  - An environment whose ansible-core is older than 2.19 is refused with a message naming the version found and what to change.
  - Changing the environment settings makes the module catalog read the new environment on the next search.
  - New _Ansible Flow_ output channel: the probe's start, ansible-core version, timeouts and (at Debug level) every stderr line.
- **AWX:** a GET that hits a socket the server or tunnel closed while idle is tried once more, instead of failing with "read ECONNRESET".

## 0.23.2 — AFD-31

- **One lifecycle rule for every writer** (improvement program, wave 1): binding a step makes it _implemented_ and unbinding it _specified_, whether the binding comes from the properties page, an AI assistant or an import. Before, a step an assistant bound stayed _draft_.
- **New warnings that keep the design honest about the generated code:**
  - `success-port-unwired`: a success port on the top level that leads nowhere (inside subflows this was already `inner-exit-unmapped`, whose description now says what it checks).
  - `output-name-collision`: `from: a.result` reads a host variable that another step, or a flow input, also sets; the reader gets whichever ran last (a flow input always wins).
  - `ref-may-be-undefined`: the step a `from:` reads does not run for every host that gets there (a path goes around it, or its failures are wired on). Reads guarded with `| default(…)`, as imported handlers are, are fine.
- **Level chips tell the truth:** inside a subflow, only the inventory target is inherited by the steps; become, serial, credential and the execution environment set on the subflow now show as _not applied_.
- The example `os-upgrade` flow shows the new warning on _Notify on-call_ (its `ok_hosts` leads nowhere).

## 0.23.1 — AFD-30

- **Fixed in the designer** (improvement program, wave 1):
  - **Esc no longer loses a staged binding.** On the properties page, Esc with an unsaved binding change asks: _Keep editing_, _Discard_ or _Save binding_. Esc in a field reverts that field only; before, it could also commit what it reverted and close the page.
  - **Read-only while the text is broken:** the inspector, the flow panel and the properties page show their fields read-only while the file has YAML errors or missing IDs, instead of accepting edits that were then refused.
  - **Inside a subflow,** the right panel with nothing selected describes that subflow, not the whole flow. The breadcrumb starts at the flow (the "Flows" label that led nowhere is gone).
  - **Inner steps by name:** the "Click the node…" bar and the _Leave open on purpose_ dialog named steps inside subflows by their ID.
  - **Delete from the inspector** goes through the same delete as the canvas (boundary wires, one undo step).
  - **One run verdict:** the top bar and the run panel agree; a failure routed to a handler is not shown as ok. A run that stopped after it started says _Run interrupted_, not _Run not started_.
  - **Wording:** no milestone or decision codes in the UI ("(M5)", "decision 23"); the _Inventory target_ help says what the setting does; the undo port says binding an undo task is not supported; the copy tooltip shows the macOS keys on a Mac; the sample flows name a real AWX template (`AFD · <key>`) instead of a placeholder.

## 0.23.0 — AFD-29

- **Security and run data** (improvement program, wave 1):
  - **Secret run inputs never touch the disk.** Before, `runs/<flow>/<run>/vars.json` in the extension storage held every run input in plain text, secret-looking ones included, and was never deleted. Secret inputs now travel in an environment variable, like the vault password, into a temporary file that lives inside the run's environment as long as the run. The other inputs are written for the run and deleted when it ends. At startup, `vars.json` files left by earlier versions are deleted.
  - **The AWX token stays with the configured AWX.** A request to another origin is refused, and a page link pointing elsewhere is followed on the configured AWX.
  - **Retention:** each flow keeps the event logs of its last 30 runs (`afd.runs.keep`), and the audit log rotates at 1 MB, keeping two older files.
  - **Restricted Mode:** the extension now works in untrusted workspaces with limited features. You can design, edit and generate flows; local runs and the Ansible probe (catalog, lenses, Re-sync) need trust, and the workspace's `afd.environment.*` and `afd.awx.*` values are ignored until then.
  - **AWX runs can be stopped:** following a job or workflow shows a cancellable notification and stops after 12 hours at most. Stopping leaves the job running in AWX and offers to cancel it there or open it.

## 0.22.0 — AFD-28

- **Tutorial 5: bring existing playbooks into flows** (25 minutes): import a sample repository as is, find its plays, block with rescue/always, roles, handler and variables on the canvas, look at a step's task keywords, run it as a skeleton, then let an AI assistant redesign it by intent and compare.
- **Sample playbooks to import:** **Open Sample Flow…** now also offers _Playbooks to import: edge-baseline_. It is a small fictional repository: `site.yml` importing two playbooks, a role and a split role, a block with rescue and always, a loop, a handler with `listen`, a prompt, and simulated switches. It copies into an empty folder only, never over an `ansible.cfg` or inventory, and offers **Import Ansible Playbooks…** right after.
- **Walkthroughs:** "Design your first Ansible flow" has a step **Or import playbooks you already have**; "Build flows with an AI assistant" has **Import playbooks with an assistant**. Both check off when you import.
- **Guide:** the import how-to links Tutorial 5. Tutorials 3 and 4 have import sections (Tutorial 4 lists the ten tools), and troubleshooting has an _Imports_ section. Two new screenshots: an imported play and a step's task keywords.
- **Fixed:**
  - Secret-looking run inputs (an imported prompt or vault value, such as `enable_secret`) are now typed hidden and never remembered between runs. Before, every prompted input was kept in the workspace state.
  - The import looks for a role in `roles/` next to the playbook before `roles_path`, as Ansible does.
  - A step with task keywords no longer shows unsaved changes on its Implementation tab, and its generated-task preview shows the keywords.

## 0.21.0 — AFD-27

- **Import with an AI assistant:** _Import Ansible Playbooks…_ and _Import from AWX…_ now ask **As is** or **With an AI assistant**. An assistant designs the flow by intent: a few subflows by purpose (pre-checks, backup, the change, verification, rollback), steps named by what they achieve, and the same modules, parameters and keywords as the source.
  - **Copilot Chat** opens in agent mode with the prompt filled in (you send it). For **Claude Code, Codex and other assistants** the prompt is on the clipboard to paste. It is always on the clipboard too.
  - **AWX:** the extension writes `flows/<key>/source/awx-export.json` for the assistant, built from what the import read with every secret value left out (names only, as `$encrypted$`). The AWX token never leaves VS Code.
- **New AI tools** (Copilot and the MCP server, ten in all):
  - `source_outline` reads a playbook, a folder, a role or an AWX export: plays, tasks, blocks with rescue/always, includes, roles (split ones marked), handlers and variables. Each task carries the exact binding an import writes (`impl`), with template and file paths rewritten for the flow to write, ready to copy into `add_node`. Secrets show by name only; long outlines come in pages; `focus` shows one task in full.
  - `flow_import` runs the as-is import (AFD-26) for an exact copy.
  - They read only YAML, JSON and `ansible.cfg` inside the workspace (the MCP server resolves symlinks and stays inside its roots, 2 MB per file).
- The skill has an "Import playbooks or AWX templates" section and a worked example; the MCP server's and Copilot's instructions send import requests to `source_outline`.
- The MCP server's size budget is now 960 KB (it is 926 KB with the import code).

## 0.20.0 — AFD-26

- **Import Ansible playbooks:** **Ansible Flow: Import Ansible Playbooks…**, or right-click a playbook or a folder in the Explorer.
  - A playbook becomes a new flow at `flows/<key>/<key>.flow.yaml`, one step per task, in the playbook's order.
  - A folder lists its playbooks with the top-level ones selected (those no other playbook imports, like `site.yml`); each becomes its own flow.
  - Several plays and `import_playbook` become subflows; a later play on other hosts runs there; facts are gathered where the play gathered them.
  - Blocks with rescue and always become a subflow whose failures lead to the rescue steps, with the always steps after both paths. A role is a step bound to the role; a role whose `main.yml` only includes task files is a subflow with one step per file. `include_tasks` files become subflows. Handlers become steps that run when a notifying step changed something.
  - Registered variables, `set_fact`, `vars_files` and what roles set become outputs, and the steps that read them get inputs. Play vars and prompts become flow inputs; vault values and prompted secrets are imported by name only, never copied.
  - Template and copy sources are rewritten so the generated playbooks find them.
  - Failures the playbook does not handle stay open on the banner, as Ansible stops those hosts too. _Show notes_ lists what has no one-to-one form.
  - Checked by running a fictional repository's `site.yml` and its imported flow side by side in ansible-core 2.19, 2.20 and 2.21: the same files on every host, and the same hosts failed.
- **Import from AWX** (was _Import AWX Workflow…_) also lists **job templates**: the limit is where the flow runs, the survey and extra vars are inputs, the credential and EE are settings.
  - A job template node, in a workflow or on its own, whose playbook is in this repository becomes a subflow of that playbook's steps, with the node's extra vars, become and timeout on each step.
  - A playbook that is not here stays one draft playbook step; the notes name the project and its SCM URL. A playbook the designer generated stays one step.
- **Task keywords:** a binding can carry Ansible task keywords (`impl.keywords`): `when`, `loop`, `ignore_errors`, `changed_when`, `failed_when`, `delegate_to`, `run_once`, `no_log`, `become_user`, `environment` and more.
  - Edited on the Execution tab as YAML; written on the generated task as is (a role keeps `when` and `loop` and applies the rest to its tasks).
  - Variables in them are checked like parameters. Keywords the flow models itself (register, tags, become, timeout, retries, until, notify, block) are refused with where they go instead.
  - Node cards show "when" / "loop"; the AI tools, `flow_describe` and the draw.io details carry them.

## 0.19.0 — AFD-25

- **Export as draw.io:** _Export as draw.io…_ in the designer's "…" menu, **Ansible Flow: Export as draw.io Diagram…**, or right-click a `*.flow.yaml` in the Explorer.
  - One page per level: the top level first, then each subflow. A subflow node links to its page, and each subflow page's title links back.
  - It looks like the canvas (light theme): status fills, dashed drafts, double subflow borders, ports and wires coloured by port and labelled.
  - Ports are small shapes the wires attach to, so moving a node in draw.io keeps its wires.
  - Every node carries its details as draw.io shape data (Edit Data, Ctrl+M) and a hover summary: key, path, type, status, intent, handler/outcome/condition, binding and parameters, inputs and outputs with `from:`, settings, subflow entry and exits, open fail ports, ports open on purpose with the reason, and problems. The page background holds the flow's name, version, goal, inputs and problem counts.
- **Export as image:** _Export as image…_ for the open level, or **Ansible Flow: Export as Image (SVG, PNG)…** for the top level or every level (one file each, `<key>--<subflow>`).
  - SVG, or PNG at twice the size. PNG is drawn by the designer, which opens for it.
  - Always the light theme.
  - The images are `.drawio.svg` / `.drawio.png`: they embed the draw.io diagram, so draw.io opens them as editable diagrams.
- **AI tool `flow_export`** (Copilot and the MCP server) writes a draw.io file or SVG images next to the flow, or where `out` says inside the workspace. The skill and the agents' instructions send requests for a picture or a draw.io file of a flow there, instead of a drawing by hand.
- The canvas's level geometry and colour palette moved to `src/core` (no behaviour change), so exports and the canvas draw from the same code. `@xyflow/system` 0.0.83 is now a direct dependency, for React Flow's wire routes; its d3 parts stay out of the host and MCP bundles (the host grows by about 40 KB).

## 0.18.0 — AFD-24

- **AI agents can place nodes.** Until now only _Tidy up_ wrote positions, so an agent could not follow "put the notify step under the rollback".
  - `add_node`, `apply_pattern` and `extract_subflow` take a `position`: `{x, y}` (top-left corner, canvas pixels), or `below` / `above` / `right_of` / `left_of` a node on the same level with an optional `gap`. A relative place steps aside until the spot is free.
  - New ops: `move` places or moves nodes later (several in order, each may be relative to the one before); `unplace` hands nodes, or a whole level, back to automatic placement.
  - The first position on a level the canvas lays out also stores the other nodes where the canvas shows them, as a drag on the canvas does, so nothing jumps.
  - A position that overlaps another node is applied, and the answer says so.
- **The tools explain layout.** Every place-taking op, `move`, `unplace` and `tidy_up` describes the coordinate system, the node sizes and what happens to nodes without a position (the canvas places them next to their neighbours). `flow_describe` with `layout: true` lists each node `at x,y` (stored) or `auto x,y` (where the canvas puts it now).
- The skill, the MCP server's instructions and the Copilot instructions tell agents to leave positions out unless the user asks for an arrangement; the skill has a worked example, and the user guide's AI page explains what to ask for.

## 0.17.1 — AFD-23

- **Agent-built flows no longer stand in one column.** New flows stored positions for Start and Done only. The canvas then skipped its auto-layout and put every other node straight below the step before it, so siblings sat on top of each other (product-owner report). Earlier agent-built flows looked right only because those agents ran _Tidy up_ at the end.
  - New flows (_New Flow_, `flow_new`, _Create a flow here_) store no positions: the canvas lays them out until the first move or _Tidy up_.
  - A level whose only positions are the old template's is shown fully auto-laid out. Flows made with 0.17.0 or earlier look right without changes.
  - On a level where only some nodes have positions, the others go where the auto-layout puts them next to their placed neighbours, overlapping nothing.
- `just docs-shots` exits when it started the harness itself (on Windows, Vite outlived `npx`).

## 0.17.0 — AFD-22

User documentation, inside VS Code and in the repository.
- **Walkthroughs on the Welcome page:** _Design your first Ansible flow_ (8 steps, featured in folders with flows), _Build flows with an AI assistant_ and _Run your flows in AWX_. Steps check themselves off as you go: designer edits set `afd.tour.*` context keys. **Ansible Flow: Get Started** opens them again.
- **The user guide** in `docs/guide/`, shipped in the extension and opened in the Markdown preview by **Ansible Flow: Open User Guide** or _User guide_ in the designer's "…" menu:
  - four end-to-end tutorials (your first flow, from design to production, AWX end to end, with an AI assistant), each followed for real while writing it;
  - eighteen how-to pages, the reference (commands, settings, problem codes and flow format, the last two generated by `just gen-ai`) and troubleshooting.
- **Samples:** **Ansible Flow: Open Sample Flow…** copies `firewall-upgrade` (new: subflows, data across levels, polling, an approval, rollback; 0 problems) or `edge-baseline` into `flows/<key>/` and opens it; a copy already there is opened as it is.
- **Screenshots** of the designer in light and dark come from the webview harness: `just docs-shots` (playwright-core with the installed Edge) regenerates them and renders the new extension **icon**.
- **Fixed:** clicking a wired port or an `in` port did nothing. React Flow turns pointer events off for handles that cannot start a wire, so their menus (Insert node on this wire, Rewire, Disconnect) were unreachable by click. Every shown port now opens its menu; a wired port still starts no second wire.
- The unit tests of the AI setup writers get 20 s (they ran past 5 s twice in loaded full-suite runs).

## 0.16.0 — AFD-21

Second real use of the AI assistants: an agent built a FortiGate upgrade flow and listed what got in its way.
- **Data crosses subflow boundaries.**
  - Inside a subflow, `from: <subflow>.<input>` reads the subflow's input; the generated code follows it to the source.
  - A subflow output without `from` lifts the inner output of the same name. `subflow-output-unset` warns when nothing inside sets it: before, such an output silently read an unset variable at runtime.
  - `set_io` and the @ picker lift a step inside another subflow (`precheck/normalize-facts.fos_platform`) to that subflow's outputs in the same edit.
  - Renaming a subflow input rewrites the inner reads; renaming an output no longer touches them.
  - Warnings about unknown names say where the value could come from (the subflow's input, an upstream output, a step to lift).
- **Polling.** New settings `until` (a test on the registered result) and `delay` (seconds between tries). describe shows the register name; the Properties page has Until and Delay fields.
- **Bare expressions are checked:** `assert` `that:`, `debug` `var`, decision conditions (`condition-unknown-var`) and `until`.
- **Pattern ends.** `stop`, `notify-stop`, `escalate` and `rollback` reuse an end node only by key (stopped, failed), not any end with outcome failed. `apply_pattern` takes an `end`; the answer names the end used.
- **The problem count in `flow_edit` answers** counts every finding (several on one node used to count once) and splits it by severity.
- **Local approvals.** `afd_approvals` chooses an approval's outcome in local runs; the playbook header says how. The stale "AWX approval node in M7" message is gone.
- **Data lens:** outputs a subflow lifts are no longer reported as unread, and readers are counted per node (keys repeat across levels).

## 0.15.1 — AFD-20

First real use of the AI assistants: Copilot's first edit failed, and Claude Code drew PlantUML.
- **Building a flow step by step works on the first try.**
  - `add_node` with `after` on a port that is already wired puts the new node on that wire, and the answer says so. A new flow is `start -> done`, so `after: "start.ok_hosts"` now adds the first step instead of failing.
  - `on_wire` inside a subflow adds the node there.
  - `null` for an optional op field counts as not given.
  - `flow_new` keys the flow by its file name and says how to add the first step.
  - The `maintenance_window` field says it takes a duration (`4h`).
  - The error for an edit against an old revision shows the current flow again.
- **Every installed agent gets offered the setup.**
  - After VS Code starts (the extension now also activates on `onStartupFinished`), agents found without the setup get one notice with _Set Up_ (all of them, just me, one click), _Choose…_, _Not Now_ or _Don't Ask Again_.
  - Setup now also covers OpenCode, ZCode, GitHub Copilot CLI and Cursor, besides Claude Code, Codex and Gemini CLI. Agents that read another agent's skill folder share its copy.
  - _Other agent…_ opens a guide with this machine's MCP config and copies the skill to a folder you choose.
  - A config file that does not parse is left alone.
- **"Ansible flow diagram" means a flow.** The skill description, the MCP server instructions and `flow_new` say to build Ansible flows with the tools, not as PlantUML, Mermaid or draw.io pictures. Checked with Claude Code against a user preference for PlantUML.
- **Startup cost.** The flow schema compiles on first use (activation 160 ms → 7 ms). Where flows exist it is compiled right after activation.

## 0.15.0 — AFD-19

- **AI assistants edit flows by key** (ADR-0017):
  - Copilot gets the `ansible-flow` skill, instructions for `*.flow.yaml` and seven tools (`#flowDescribe`, `#flowEdit`, …) with no setup. An edit asks first and is one undo step. It is saved when the file had no unsaved changes.
  - Claude Code, Codex CLI and Gemini CLI get the same skill and tools through _Ansible Flow: Set Up AI Assistants…_:
    - the agents to set up, then the skill's place (this repository or just me), and a preview of every change;
    - the flow tools come from a bundled MCP server that runs on Node or on VS Code's own runtime;
    - config files are backed up once; _Remove AI Assistant Setup…_ takes back only what setup wrote.
  - The tools describe a flow by key (`precheck.ok_hosts -> check-ntp`, `fix-ntp/push-config`) and edit it with batches of ops: add, connect, rewire, patterns, ports, inputs and outputs, bindings, subflows. A batch is all or nothing.
    - Errors name the op and the fix ("did you mean check-ntp?", the node's ports).
    - The answer lists the problems the edit added or solved.
    - `tested` is refused.
  - A terminal agent's edit acts like a save: version bump once per commit, and `generated/` refreshed without overwriting hand edits.
  - The skill's format and ops references are generated from the schema, the port catalog, the patterns and the problem codes (`just gen-ai`). Its worked examples run in the tests.
- **Flows written by hand:** a flow or a snippet may leave out `id:` lines and name nodes by key in wires, subflow entries and exits, decisions and positions.
  - The designer shows it with a _Written by hand_ banner and lists each gap in Problems.
  - _Complete IDs_ (banner, lightbulb quick fix, command) adds the IDs in one edit that keeps the rest of the text byte for byte.
  - Canvas edits, runs and code generation wait for it. Paste completes hand-written snippets with their wires.
- **Schema:**
  - every property has a description (YAML hovers, AI assistants);
  - `id` is optional;
  - references may be keys.
- Every problem code has a one-line meaning and fix, shown by the tools.
- Generated-code writing is shared between the extension and the MCP server.

## 0.14.1 — AFD-18 follow-up

- _Show in text_ (the context menu, the inspector) selects the whole node in the text editor, from its `- id:` line to its last line, including what is inside it. It selected only the first line before. The Problems panel still underlines one line.
- **Faster start:** ELK, the auto-layout library, is three quarters of the extension's code. It now loads at the first auto-layout, from its own file `dist/elk.js`, instead of at activation.
  - The extension bundle shrinks from 1.9 MB to 460 KB (production) and loads in about 100 ms.
  - In development, `extension.js` shrinks from 4.2 MB with a 6.1 MB source map to 0.9 MB with a 1.8 MB one.
- **F5 debugging:** the launch configuration gives the debugger only the host bundles' source maps; before, it also read the webview's 3.7 MB map. A second configuration starts with the other extensions off. This addresses "Extension host did not start in 10 seconds" on the first debug start.

## 0.14.0 — AFD-18

- **Right-click menu on the canvas**, instead of VS Code's Cut/Copy/Paste (text fields keep VS Code's). Its items depend on the target:
  - a node, a group (including the Shift+drag selection box), a wire, a subflow's entry or exit wire, a port (its port menu), or the empty canvas;
  - codicons, shortcut hints, disabled items with their reason ("Fix the YAML errors first");
  - one submenu per open fail port with its suggestions;
  - Implementation mode offers the edits Design does (except Rename and Extract); Run mode only reads.
- **Keyboard shortcuts**, with a `?` sheet built from the same table as the menu hints:
  - Delete/Backspace deletes a selection in one undo step (new command `deleteNodes`);
  - Ctrl+X cuts; Ctrl+D duplicates next to the original (one paste, no clipboard);
  - F2 renames in the inspector; Alt+↑ goes up a level;
  - Shift+F10 or the Menu key opens the menu;
  - arrow-key nudges are saved once the keys rest (they were lost before);
  - Escape closes the innermost menu or dialog only, else clears the selection. A field keeps its own Escape, and the Properties page closes itself.
  - Keys handled by the designer no longer reach VS Code's keybindings. Ctrl+C/X/V/Z/Y always do.
- **Calmer top bar:**
  - the six lens buttons are one _Lens_ dropdown with a ✕;
  - _Run for real…_ moves under _Run as skeleton_'s chevron;
  - _Tidy up_, _Show as text_, _Validate design_ and _Keyboard shortcuts_ are in a "…" menu.
- **One shared menu component:** the port menu uses it too. Menus sit above the Properties page.
- **Fixes:**
  - dialogs and the toast no longer open behind the Properties page;
  - a dialog's Escape no longer also closes the page behind it;
  - Delete on a focused menu item no longer deletes the selection;
  - the palette is locked and nodes cannot be dragged in Run mode;
  - the summary card stays closed while a menu is open.

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

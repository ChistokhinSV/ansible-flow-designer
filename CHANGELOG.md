# Changelog

## Unreleased — AFD-254 (the Inventory view: switches, files in sync, editing; agents)

After setting up an SSH host there was no way back to WSL or a container except running the setup again from the Command Palette, and the inventory could be changed only in the settings. See [Switch between environments](docs/guide/how-to/runs-and-environments.md#switch-between-environments) and [The Inventory view](docs/guide/how-to/runs-and-environments.md#the-inventory-view).

- **Switch Ansible Environment… (AFD-255):** the Inventory view's title has a button that lists the environments your settings describe (an image for this machine, each WSL distribution, the SSH host), the one in use marked, and **Set Up Another…**. A pick switches at once and asks nothing: the host, the distribution and the images stay, so you can switch back. The view's title line names the environment and the inventory.
- **The image on an SSH host is its own setting, `afd.environment.sshImage`:** `afd.environment.image` is the image for a container on this machine only, so neither is carried into the other by a switch. A workspace set up with 0.83 keeps working: with `sshImage` not set, `image` still runs on the host.
- **Switch Inventory… (AFD-256):** lists the inventories found in the repository (a `hosts` or `inventory` file at the root, `inventory/` and its files, one folder or file for each environment under `inventories/`), the default of `ansible.cfg`, and **Browse…**. The pick is the workspace's `afd.run.inventory`.
- **In the launch dialog (AFD-257):** "Runs in: … · Inventory: …", each with **Change**, which opens the same switch and then the dialog again with what the new one answers.
- A switch is this workspace's: it writes the workspace settings.
- **Limit:** `afd.environment.containerEngine` is still one setting for this machine and the SSH host.

**Wave 2 (AFD-258): the Inventory view and the inventory's files stay together.** The view showed Ansible's merged result and nothing of where it came from.

- **Open at the line:** a click on a host, or **Open in Editor** on a host or a group, goes to the line it is written on, in YAML and INI inventories. A host of a range (`sw[01:10]`) opens at the range, a host in several groups under the group you opened it from.
- **Sources:** the view lists the files the inventory is read from and what each is: YAML, INI, or dynamic (an inventory plugin, a script) and read-only.
- **Reads again on save:** saving an inventory file, a file under `group_vars/` or `host_vars/`, or `ansible.cfg` refreshes the view.
- **New Inventory…:** a YAML inventory with no hosts yet, made the workspace's inventory and opened.
- **Not done:** a change made outside VS Code (git, another editor) still needs Refresh Inventory; hosts of a dynamic source have no line to open.

**Wave 3 (AFD-259, AFD-260): edit the inventory from the view.** Until now the inventory was edited in its files only.

- **Hosts and groups:** right-click to add a host, add a group or a child group, rename, move a host to another group, delete. Each change is the smallest edit of the YAML or INI file that says it: comments, order and layout stay; the file is saved and the view reads it again.
- **Variables:** a host and a group show their own variables, each with where it is written (the inventory file, `host_vars/`, `group_vars/`); a click opens it there. **Add Variable…**, **Edit Value…** and **Delete…** change them. A value is typed as in YAML.
- **Where a new variable goes:** `host_vars/` or `group_vars/` when the repository has that folder, the inventory file otherwise; asked when the host or group has variables in both.
- **A move takes the host's variables with it; a rename renames its variables file.**
- **Not edited here** (they open as text): a host of a range (its variables go to a variables file), hosts of a dynamic source, vault-encrypted values and files, YAML with anchors, and Ansible's groups `all` and `ungrouped`. A file with unsaved changes is not touched.
- **Checked in Ansible:** inventories changed this way read in `ansible-inventory` as asked (INI, YAML, a variables file).

**Wave 4 (AFD-261): AI assistants list and edit the inventory.** A new tool, `inventory` (Copilot's `#inventory`, and in the MCP server for terminal agents). See [AI assistants](docs/guide/how-to/ai-assistants.md#the-inventory).

- **list:** the inventory's files and what each is, its groups and hosts as written; with a host or a group, its variables and where each is written.
- **edit:** ops in order, all or none: `add_host`, `remove_host`, `rename_host`, `move_host`, `add_group`, `remove_group`, `rename_group`, `set_var`, `remove_var`. The same engine and the same read-only rules as the Inventory view; a new variable goes where the view puts it.
- **What an agent does not see:** vault-encrypted values, and the value of a variable whose name contains `password`, `passwd`, `secret`, `token` or `key`. Other values reach the agent's model as written.
- **Copilot** asks before a change and lists each op, without the values. The MCP server reads and writes inside the repository only.

## 0.83.2 — AFD-252 (agents verify scenarios on an SSH host)

**Fix (AFD-252): terminal agents could not verify scenarios on an SSH host.** `flow_scenarios` with action `verify` through the MCP server answered "Set afd.environment.sshHost" with an SSH environment set: the server did not read `afd.environment.sshHost` and `sshDir` from the settings. It now does, from your user settings, and from the workspace's only with `AFD_MCP_WORKSPACE_ENVIRONMENT=1`, as for the other environment settings. Copilot and Run Scenarios in VS Code were not affected. See [Scenario tests](docs/guide/how-to/scenario-tests.md).

## 0.83.1 — AFD-250 (the setup and an environment the workspace sets)

**Fix (AFD-250): Set Up Ansible Environment… and an environment the workspace sets.** Found by driving the SSH setup in VS Code.

- **An image in the user settings no longer runs on the SSH host unasked:** with an image in your user settings (the Docker setup writes it there), choosing an SSH host that has Ansible on its PATH said "the ansible-playbook of … on the host" and then ran in that image there. The setup now writes an empty image for the workspace, so the host's own Ansible runs. A host without Ansible is offered your image before the public one.
- **Docker, Podman or a WSL distribution chosen in a workspace that has an SSH host:** the setup wrote the user settings, which the workspace's hid, so it said one environment was set and runs went on using the other. It now writes the workspace settings there.
- **The message names the folder:** `~/.afd/<your workspace>` as it is on the host, not a placeholder.
- **Tests:** `just test-ssh-setup <host>` drives the setup and Copy a File to the SSH Host… in VS Code.

## 0.83.0 — AFD-247 (a remote Linux host over SSH)

Flows could run in a container image, in WSL or on this machine, and in AWX. A team's shared Linux host was out of reach unless the repository lived there and was opened with VS Code Remote. See [A remote Linux host over SSH](docs/guide/how-to/runs-and-environments.md#a-remote-linux-host-over-ssh).

- **A new environment:** `afd.environment.kind: ssh` with `afd.environment.sshHost` runs Ansible on a remote Linux host, with the repository on your machine. **Set Up Ansible Environment…** offers it, lists the hosts of your SSH config and checks what the host has.
- **What runs is what you have now:** before a run the repository is copied to the host as it is on disk (tracked files and untracked ones no `.gitignore` names), so uncommitted work runs; after the first copy only changes travel.
- **Two ways to run there:** the `ansible-playbook` on the account's PATH, or an execution environment image with the host's Docker or Podman (`afd.environment.image`).
- **Everything a local environment does:** skeleton and real runs with live results on the canvas, Stop Run, the launch dialog's host counts, lenses, the module catalog, runs of part of a flow, and scenarios verified from the designer.
- **Your own SSH:** your config, keys or agent; no password is asked for or stored. A vault password and secret inputs travel on the connection's input, never as arguments.
- **Copy a File to the SSH Host…:** copies one file to the host, readable by the account alone, for what the repository does not hold (a vault password file).
- **Limits:** this machine needs `ssh` and `tar` (Windows 10 1803 or later has both); one environment per workspace, no choice at launch; the command-line scenario runner has no SSH option.

**Fix (AFD-248):** in Code mode a role task file that only the role's `main` includes was never reported as "task not in design", also when the subflow's steps each run a task file of their own and none runs `main`, so the file does not run. It is reported again; a file a step's own task file includes still counts as covered (0.74.3 had widened that to `main` in every case).

## 0.82.0 — AFD-230 (flow editing, from other flow editors)

Editing changes taken from other flow editors (n8n, Node-RED, Logic Apps, the AWX visualizer), in four waves. See [Add, wire, move, delete](docs/guide/how-to/canvas-basics.md#add-wire-move-delete), [Subflows](docs/guide/how-to/subflows.md) and [Runs](docs/guide/how-to/runs-and-environments.md).

**Wave 1 (add and wire faster):**

- **+ where the path stops (AFD-231):** a step whose main output is still open shows a **+** under it; one click opens Quick Add wired from that output. It shows at rest, not on hover only. The port keeps its own menu. A hovered or selected wire shows a **+** beside its label that adds a step on that wire.
- **Quick Add finds what the step runs (AFD-232):** the Title field lists, as you type, the step types, catalog modules and roles that match, and while it is empty what the flow already runs. A pick adds the step bound to that module or role. Enter alone still adds a step with the title typed. A double-click on empty canvas opens Quick Add there.
- **Drag a wire's end (AFD-233):** either end of a wire drags to another node or port; released on empty canvas the wire is disconnected. Before, a wire's target could be changed only from a menu, and its source not at all.
- **Drop a step into a wire (AFD-234):** a step that stands free of any path, dragged over a wire, goes into it on release. Before, only a new step from the palette could.
- **Delete closes the path (AFD-235):** deleting a step re-points the wire that came into it to where the step went on, in the same undo step, and says so. It happens only when there is one answer; Shift+Delete leaves the gap. **Detach from Path** takes steps out of their path and keeps them.
- **Not done:** the palette has no filter (it holds 15 fixed items; the search went where the catalog is). Failure patterns and shared subflows are not in Quick Add's list.

**Wave 2 (see and navigate):**

- **Problems on the canvas (AFD-236):** a step with errors or warnings shows their count in its corner; a click opens the Details tab of the first one. A subflow counts the problems of the steps inside it. Before, a problem showed only in the Details and in the Problems panel.
- **Rename on the canvas (AFD-237):** F2, or a double-click on a title, edits it in place. Before, F2 moved to the Title field of the Details.
- **Move along the flow (AFD-238):** Ctrl+↓ and Ctrl+↑ follow a wire to the next step or the one before; **Select Upstream** and **Select Downstream** take the whole path; Shift+2 zooms to the selection.
- **Undo says what it did (AFD-239):** after an undo or a redo a message names the change ("Undid: removed Validate, added 1 wire").
- **Outline (AFD-240):** a flow open as text has an Outline and breadcrumbs: its nodes, a subflow holding the nodes inside it. A symbol or a problem chosen in the text shows its node on the canvas when the designer is open.
- **Dissolve Subflow (AFD-241):** on a subflow's menu, the reverse of Extract into Subflow: its steps move up to its level, where the subflow stood, and it goes. Before, only AI assistants could do it.

**Wave 3 (model changes):**

- **Disable a step (AFD-242, ADR-0035):** **D**, or Disable in a step's menu, switches a step off and keeps it. The hosts that reach it pass straight to the next step, and no code is generated for it; scenarios simulate the same. A decision with both branches wired cannot be passed through, and a step that reads a disabled step's output is warned. AI assistants set it with `update_node` (`disabled: true`). Find: `has:disabled`. Before, the only way to try a flow without a step was to delete it and wire the gap by hand.
- **Expand a subflow in place (AFD-243):** a subflow node has an arrow that grows it into a frame showing its inner steps and wires on its own level, with the entry wire and each exit joined to the subflow's ports. For reading; nothing is written to the flow file. The setting `afd.canvas.expandSubflows` (on by default) takes the arrow away.

**Wave 4 (run and debug):**

- **Run part of a flow (AFD-244):** a top-level step's menu has **Run from Here (Skeleton)** and **Run This Step (Skeleton)**. The run starts the hosts at that step, on a trimmed copy of the flow generated for the run only; the flow's own code is not touched. A bound step that reads a step left out runs as its stub, and the Run panel says which. Skeleton runs only: a real run on part of a flow could act on data that was never made.
- **Earlier runs (AFD-245):** the Run panel lists the local runs kept of the flow; choose one and the canvas shows it again, with each host's output. A run of an earlier version of the flow says so. Before, only the last run could be seen.

## 0.81.0 — AFD-221 (Jinja in fields)

Fields that take Jinja showed it as plain text, with no help to write it. A value like `{{ now(utc=true).strftime('%Y%m%d_%H%M%S') }}` had to be typed from memory. See [Jinja in fields](docs/guide/how-to/binding-and-catalog.md#jinja-in-fields).

- **Colours:** parameter values, list items, variables and facts, the Timing fields, the Task keywords box, a decision's Condition and Until show their Jinja in VS Code's default colours for the theme (dark, light, high contrast): delimiters, variables, functions and filters, strings, numbers, keywords, and the `%` codes of a date format.
- **Completion as you type:** inside `{{ }}`, `{% %}` or a test without braces, a list opens with what fits there: the step's variables and Ansible's (`inventory_hostname`, `hostvars`…), `now()`, `lookup()` and the other functions; filters after `|`; tests after `is`; after `.` a result's fields, a string's methods or a date's `strftime`, with ready formats; date codes inside `strftime('`; lookups inside `lookup('`. Filters, tests and lookups of the collections in the catalog are offered too. Ctrl+Space opens the list anywhere; Enter or Tab puts the choice in, Ctrl+Z takes it back.
- **Inline help:** the chosen entry's signature and what it does under the list; a date format's result now (`'%Y%m%d_%H%M%S'` → `20261112_101530`); with the cursor in a call, its arguments under the field, the current one in bold; a function, filter, test or date code shows its help on hover.
- **Tests without braces:** a decision's Condition, Until, `assert` `that` and `debug` `var` are completed as tests, and `@` puts in a name without braces. A variable picked that is not an input of the step yet becomes one in the same edit.
- **set_fact:** its facts show under **Facts**, one row each; a list or a dict is edited as YAML. Before, with the module's docs loaded, the facts were hidden, `key_value` was asked for, and each fact was reported as an unknown parameter.
- **Fixes:** typing `!` in a parameter field fitted the canvas instead (Shift+1), so `!=` could not be typed. The YAML box ended a string at `''` or `\"` and coloured the rest wrongly.
- **Smaller webview:** its script is minified fully (1,200 KB to about 950 KB with all of the above).

## 0.80.0 — AFD-219 (agents group long chains into subflows)

AI agents could always group steps into a subflow with `extract_subflow`, but they rarely did. On a long change they built one chain of steps on the top level instead. Their guidance taught grouping by purpose only for imports.

- **The rule:** the skill's planning step, the MCP server's instructions and the Copilot instructions now say to put the steps of one purpose (pre-checks, backup, change, verify, rollback) in a subflow, not one long chain. The import guidance points to the same rule.
- **A hint in the answer:** when a `flow_edit` batch grows a level past 8 steps, its answer names the level and its steps in run order, and suggests `extract_subflow` with them. Start and end nodes do not count. Edits that do not add steps to that level get no hint, so a long imported flow is not flagged on every edit. The hint is for agents only: it is not a problem and does not show on the canvas or in the Problems list.

## 0.79.0 — AFD-216, AFD-217 (agents annotate flows)

AI agents could always add notes, sections and text to a flow, but in practice they did it only when asked. Their guidance said how, never when.

- **When agents annotate:** the skill, the MCP server's instructions and the Copilot instructions now say when. An agent adds a note on a step, without being asked, to keep a reason you gave that the flow cannot show: a limit, why the steps run in this order, a manual step, a runbook link. It does not note every step or repeat what a step shows. It draws a section around steps of one level that belong together but are not a subflow. On a format 1 flow it adds annotations only when you ask. The guide's [Notes, sections and text](docs/guide/how-to/annotations.md) page has a new "AI assistants" section.
- **`around` on `annotate`:** `{"op": "annotate", "text": "Change window", "around": ["backup-config", "push-baseline"]}` draws a section that holds those steps and the notes on them, sized as **Add Section Around** sizes one, so dragging the section carries them. Before, an agent had to work out the box from coordinates.
- **Feedback page:** the README now says that the feedback form page counts how often it is opened (which page, the version and the editor; no cookie, no address, deleted after 400 days). The extension still sends nothing itself.

## 0.78.0 — AFD-208 (fixes from an agent's report)

An agent converted eight more playbooks into flows and wrote down what slowed it down. Fixes:

- **The checks follow Ansible on variables set twice.** A node input is a play var, and a set_fact or register of the same name wins over it. So a step that sets the input's own name now counts as setting the input: a value created on one branch, with a default set on every path before it, no longer warns "may be undefined". The new warning `input-shadowed` flags the opposite case, where another step sets the name after the `from:` step and the step reads that value instead. Accepts the new rule makes unnecessary show as stale (ADR-0018 amendment).
- **Steps that ignore errors:** an open fail port on a step with `ignore_errors: true` or `failed_when: false` is an info, not a warning. Ansible still fails such a step on an undefined variable, so it stays listed.
- **One accept for several ports:** `accept` (and `unaccept`) take a list in `at`, with one reason.
- **`flow:` works where `path:` is asked:** the flow tools take `flow` as another name for the flow file, the name `source_outline` uses. Before, it was ignored, and with two flows in the workspace the tool failed.
- **Imported flow names:** a playbook of several plays is named after the play with the most tasks, not a helper play that comes first.
- **Layout check first:** `flow_describe` with `layout: true` gives the layout check total near the top, so page 1 of a long answer has it.

## 0.77.0 — AFD-200 (feedback)

Feedback, without telemetry: the extension still sends nothing itself. It only opens links, and you decide what to send.

- **Send Feedback…** (Command Palette, and the designer's **…** menu) opens a short form in the browser. **Report a Problem…** opens a GitHub issue, with new forms for a bug report or an idea.
- **One notice after a week of real use** (three days with a flow in the designer, seven since the first) asks for a rating or a few words. **Not Now** asks once more, a month and three days of use later at most; **Don't Ask Again** ends it. It never shows when another notice asked at the same start.
- **After uninstall**, at the next restart of VS Code, the browser opens a short "why did you leave?" page once. Not after **Don't Ask Again**, on a remote server or in CI.
- **`afd.feedback.prompt`** (default on) turns off the notice and the uninstall page. The README's new "Feedback and privacy" section says what happens to an answer (ADR-0033).

## 0.76.0 — AFD-197 (AFD-176 to AFD-196)

An AI agent converted eight real playbooks (5 to 210 tasks) into flows, then filed everything that slowed it down or made the result wrong. This release fixes all of it. Imported flows now pass the checks as imported and run as the playbooks did, and the tools give large flows in pieces an agent can read. Far fewer warnings need an accept.

Generated code and import:
- **Paths work from `generated/`:** generated playbooks run from the flow's `generated/` folder, so `{{ playbook_dir }}` pointed there and scripts next to the playbook were not found. Validation stayed clean. Import and the outline now write every path next to the playbook, including script paths inside commands, from `{{ afd_repo_root }}`, the repository root the generated plays set. The new `binding-playbook-dir` warning flags `playbook_dir` left in a binding.
- **Shared task files:** a task file run as `include_tasks` can write its paths as `{{ afd_repo_root | default(playbook_dir) }}/…`, and then works from the playbook and from the flow. The import notes each such file that needs this.
- **A rescue step knows what failed:** every step keeps the failure as host facts (`afd_failed_result`, `afd_failed_task`, `afd_failed_node`), so the step on its `failed_hosts` can report it. Before, Ansible's `ansible_failed_result` was gone by then, and reports said "unknown error". Imported rescue steps read the new names.
- **block/rescue/always imports cleanly:** the always steps are imported once. Hosts that failed are marked, run them, and fail after them, as in Ansible. A second copy of the always steps registered every variable twice, so a fresh import had 28 errors and no generated code.
- **Looped and self-including includes run as written:** an `include_tasks` in a loop, or of a file that includes itself, becomes one step bound to `include_tasks` with its vars, loop and when. Before, it was a draft step, or a copy inlined one level deep. Such a step's code keeps only the keywords Ansible allows on an include.
- **`meta: end_play` ends the hosts:** it becomes an end node, after a decision on its `when`. Before, it was a step that let hosts through, so a dry run would have carried on into the upgrade.
- **Readable names:** keys are cut at a word boundary, a `{{ var }}` in a title reads `<var>`, and the intent no longer repeats the title. A file of one task is that step on the level, titled by the include (for example "phase_event: preflight started"). Include vars stay only on the steps that read them.
- **A node input's default reaches the code:** the generated play var falls back to it. Before, the default only quieted the check.
- **Re-import:** flows imported before this version are offered updates for many steps on their next re-import, because imported steps now look different.

Checks:
- **No more false unknown variables:**
  - `x is not skipped` reads only `x`.
  - Names a template sets itself (`{% set %}`, `{% for %}`) are not reads.
  - A `set_fact` that builds up its own value over a loop is fine.
  - AWX's `awx_*` and `tower_*` variables are known.
  - A variable read only with `| default` or `is defined` is an info, not a warning.
- **Variables set outside the flow:** `flow.external_vars` lists what AWX or Kestra extra vars, the inventory or a caller sets at run time, and steps read those without an input. One `update_flow` replaces the hundreds of accepts the agent needed.
- **"May be undefined" knows guards:** a read behind an `is defined` test, in the step's `when` or a decision before it, is fine. So is an input marked `optional: true`. The suggested fix no longer says "give it a default", since a default makes `is defined` always true.
- **Accepting a warning:** `flow_validate` prints the exact key after each warning, and `check:<code>` without a subject accepts every warning of that code on the step. An accept that matches no warning is refused, and one that stops matching later is flagged (`stale-decision`). Before, a wrong key was saved and hid nothing.

AI tools:
- **Large flows fit:**
  - Every answer stays under 40,000 characters and comes in pages.
  - `flow_validate` has `summary: true` and filters by code, node and severity.
  - `flow_describe` has `nodes`, `detail: brief` and `only_problems`.
  - `flow_import` answers in about 6,000 to 13,000 characters, where it took 38,000 to 157,000.
  - `source_outline` shows `#3,#9` or `#25-#37` in full in one call, or everything with `full: true`.
- **New edit ops:**
  - `rename` (several keys at once);
  - `replace_text` (find and replace in bindings);
  - `dissolve_subflow` (move a subflow's steps up, the reverse of extract);
  - `regenerate` (write `generated/` again after an edit outside the tools).
- **Generated code:** `flow_validate` says whether `generated/` is current.
- **Deleting a step leaves nothing dangling:** subflow outputs that lifted it go, and inputs that read it lose their `from:`, with a note each.
- **Renaming an input** also rewrites the step's keywords (`when`, `loop`) and a decision's condition.
- **Large playbooks:** the import prompt and the skill suggest importing a playbook of more than about 40 tasks first and restructuring it, instead of adding its steps one by one.

Subflows and layout:
- **Named exits:** a subflow can have exits of its own, such as `dry_run_done`. Each is a port on the subflow node that the parent wires like `ok_hosts`. Extract into Subflow creates one where the selection leaves for two places. An end node inside a subflow ends the host's run.
- **Auto layout uses the canvas's ports:** a decision's true and false labels no longer overlap, steps fed by `failed_hosts` stand right of the column they handle, and simple chains stand in one straight column. Over the test flows, the problems the layout check finds went from 28 to 10.
- **The AI layout check follows the canvas:** the check and `tidy_up` use the canvas direction (`afd.canvas.direction`). The MCP server reads it from the workspace's settings, then the user's.

AI setup:
- **Agents set up before 0.69.1 work again:** their registrations pointed at the server copy of the old publisher ID, which is gone, so the flow tools failed to start (CONNECTION_CLOSED). At start, the extension now finds registrations of a server that no longer exists and offers to repair them.
- **The server copy is refreshed at every start:** it is replaced in one step and now includes the Ansible probe that scenario verification needs.
- **Show AI Integration Diagnostics** shows which server file each agent's registration starts, and whether it exists.
- **The MCP server** writes startup errors to its log and to `AFD_MCP_TRACE`.

## 0.75.0 — AFD-170 (AFD-171 to AFD-174)

The agents built into Cursor, Kiro, Antigravity IDE and Devin Desktop (Windsurf) can now design and change Ansible flows, the way Copilot does in VS Code. These editors install the extension from [Open VSX](https://open-vsx.org/extension/chistokhinsv/ansible-flow-designer). It now installs in VS Code 1.94 or later; it asked for 1.140 before.

- **Cursor's agent gets the flow tools automatically:** the extension registers them through Cursor's extension API each time it starts, for the folders you have open. Nothing is written. The agent lists them as `extension-ansible-flow`.
- **Kiro, Antigravity IDE and Devin Desktop ask once:** the first time the designer shows a flow with a step, one notice offers to give the editor's agent the flow tools and the `ansible-flow` skill, and names the files it writes. After **Set Up**, they are kept up to date at each start. Antigravity loads them at once; Devin uses them with its agent set to local. `afd.ai.hostIntegration` turns this off.
- **Set Up AI Assistants knows Kiro, Antigravity IDE and Devin Desktop**, with the files each agent was seen to read. "Other agent…" no longer lists Windsurf and Kiro as manual.
- **The MCP server never searches your home folder:** Cursor starts global servers there without naming a folder. `flow_list` then searched the whole home folder, took about 20 seconds and listed flows from other projects. Now the server answers "No folder to work in", and Cursor's entry from Set Up passes the open folder (`${workspaceFolder}`).
- **Updates keep your agent settings:** an update of an MCP entry changes only the command, its arguments and environment. Settings you or the agent added stay, such as Kiro's `autoApprove` and `disabled`. A skill copy written by a newer version of the extension (VS Code and a fork on one machine) is left alone.

- **VS Code 1.94 or later:** the designer, validation, generated playbooks, runs and the MCP server work from 1.94.
- **The module catalog needs VS Code 1.101 or later:** it uses SQLite from Node.js 22.13. In an older editor, the catalog says it is off and why, and everything else works without it. Binding checks then have no catalog facts.
- **Copilot's flow tools need VS Code 1.95 or later:** before that, VS Code has no tools API for extensions. The extension starts without them and logs one line. Other assistants use the MCP server, as before.
- **Show AI Integration Diagnostics:** a new command that reports how this editor and its built-in agent can reach the flow tools. It covers the editor and its runtime, how the MCP server would start, and which agent APIs the editor offers. It also lists the MCP servers and skills each agent is configured with on this machine. It only reads; MCP server entries are listed by name only.
- **The MCP server can trace and fall back:** with `AFD_MCP_TRACE=<file>`, it logs each start, the client's name and roots, tool listings and calls (names only, not arguments). With `AFD_MCP_ROOTS`, it works in those folders when the agent sends no roots.
- **Changes made while a flow was closed are marked the same in every editor:** some editors keep a file loaded after its designer closes and reload it only when the designer opens again. Such a change was marked as an outside edit made just now, and old marks came back. Now it is marked as a change since you last had the flow open, and the marks end when the designer closes, as in VS Code.

## 0.74.4 — AFD-158 to AFD-166

The last, smaller findings of the code review (AFD-125): files the extension writes are always valid, scenario runs cannot leave the machine they run on, and a few names and upgrades that Ansible would refuse are caught in the designer. The AWX token and device credentials travel more safely, and the module catalog, the designer and the AI tools are sturdier against odd input. Large flows are faster to edit, and a few small designer bugs are gone.

- **Deleting many steps at once is fast:** select-all and delete on a flow of 400 steps took 14 seconds, with VS Code unresponsive; it now takes under a third of a second. Pasting many steps, Tidy Up on large flows, the checks of data references and exporting images of every level are faster too.
- **The layout direction applies at once:** changing `afd.canvas.direction` now redraws open designers. Before, it waited for the next edit.
- **Generate code on save says when it fails:** a failure shows in the status bar and the log, instead of nothing. After **Overwrite** on save, the result is shown too.
- **Saving stays quick when Git is slow:** the version bump on save waits for Git's copy of the file for a moment only, then uses the copy read before. VS Code drops a save step that keeps running over its time, which would have ended the version bump for good.
- **Code mode shows the newest scan:** a sync asked for while one was running now runs again after it.
- **Git copies of a flow are not opened as flows:** a flow file shown by a diff or the Timeline no longer gets a designer session, problems and layout of its own.
- **Resizing the side panel ends when you let go,** also when the mouse button is released outside the designer.
- **Outside changes:** a step added and then removed by edits outside the designer is no longer counted as "1 step removed".

- **AWX over plain http is refused:** an `http://` AWX address would send the token unencrypted, so Ansible Flow refuses it before the token is asked for or sent. For a lab AWX without TLS, turn on the new `afd.awx.allowHttp`. An AWX on this machine (`localhost`) needs no setting.
- **`afd.awx.verifyTls` and `afd.awx.allowHttp` come from your user settings only:** a repository's `.vscode/settings.json` can no longer turn TLS checks off for the AWX your token is stored for. If you had turned `verifyTls` off in a workspace, set it in your user settings. Turning it off now shows a warning once per session.
- **AWX requests end:** each request has a time limit for its whole answer, not only between chunks. An answer over 64 MB is not read, and a list whose pages lead back to themselves stops instead of looping.
- **SSH host keys are checked in the `afd-ee` image:** the image used to turn host key checking off, so a run accepted any host key and could hand device credentials to whoever answered. A lab sets `host_key_checking = False` in its own `ansible.cfg`. The image's base and its collections (ansible.netcommon 8.7.1, ansible.utils 6.1.1, cisco.ios 11.6.0) are pinned, so a rebuild gets what was tested. AWX sets its own host key checking for jobs; this does not change AWX runs.
- **The module catalog keeps going:** a collection file that reads as JSON but is no catalog dump is skipped, as a truncated one was; it used to fail the whole catalog. Indexing that hangs stops after 5 minutes and ends when VS Code closes the window. A search of more than 30 words uses the first 30, so the ranking stays right.
- **Copilot asks the right question for scenarios:** **List** and **Check** no longer ask for confirmation, since they only read. **Add**, **Update** and **Delete** say they change the scenarios file. **Verify** says it runs `ansible-playbook` in your environment.
- **The designer's messages are checked in VS Code:** a message of the wrong shape is refused. **Open Code** opens files in the workspace folder, or outside it only when the last code scan named the file. **Compare with** reads only a version from its own list. The module docs lookup takes plugin names only.
- **MCP errors name files relative to the workspace**, and your home folder as `~`, instead of by absolute path.

- **JUnit for several flows is one XML file:** `afd-scenarios --junit` wrote one document per flow, one after the other, which CI dashboards could not read once there were two flows. All flows' suites now go under one `<testsuites>` root. Terminal colour codes in Ansible's output are left out, since XML does not allow them.
- **Exports and flow files take any text:** draw.io and SVG exports leave out control characters XML does not allow (a title pasted from a terminal). Tabs and line breaks in labels are kept. A flow text with a line or paragraph separator (U+2028, U+2029, NEL) or another control character is written quoted and escaped, so Ansible's YAML reader reads the same text back.
- **Scenarios run on this machine only:**
  - A host or group name in a scenario must be one inventory word (letters, digits, `.`, `_`, `-`). A name with a line break could add an inventory line of its own, with a real connection.
  - Scenario inputs cannot set `ansible_*` variables. Extra vars outrank the inventory, so `ansible_connection: ssh` in inputs took the run to a real machine.
- **Scenario run folders are private:** with `--python` and `--wsl`, only you can read or write them. With an image, other users can read the run folder but not write to it, and the image writes its events into a folder of their own. Before, the folder was open to every user of the machine, and Ansible loads plugins and `group_vars` from beside the playbook.
- **A bad scenarios file is a problem, not a crash:** an empty entry (`- ` alone), a name that is a number, or a list where a map goes is reported with the scenario. A flow file the command line cannot read, or a path that does not exist, ends with one line and exit code 2, not a stack trace. A flow file with too many YAML aliases (a "billion laughs") is reported as not readable.
- **Input, output and register names Ansible can use:** a name such as `retry-count`, or a Python or Jinja keyword (`in`, `not`, `true`, `none`, `class`), is now a problem in the designer, on hand-written and AI-written flows too. Before, only the designer's own edits checked it, and Ansible refused the generated playbook. The flow schema says the same, for editors that read it.
- **Become user without become:** a Become user set on a step or subflow without Become now still goes into the generated play. It applies when `ansible.cfg` or the inventory turns become on, as in format 1. Before, upgraded steps ran as root there. Become set to false turns both off.
- **Upgrade Flow Format** names the nodes marked tested by hand that lose the mark because they are not implemented.
- **Removing several items from a `[a, b, c]` list in one edit** works. Deleting a node with several wires, or clearing several accepted findings, failed with "overlapping edits" when the file wrote that list in flow style.

## 0.74.3 — AFD-131, AFD-133 to AFD-157

More fixes from the code review (AFD-125): names and paths that come from a flow, a playbook, an AWX export or the Ansible environment no longer lead outside the workspace. Secrets stay out of files and child processes. Runs in WSL stop when you stop them, and your repository's own callbacks keep running. Several flow edits and generated plays now do what the design says.

- **A step title with `{{ }}` no longer breaks the run.** Ansible renders play and task names and messages, so a title such as "Install {{ item }}" (common in imported playbooks) stopped the whole playbook with "Error processing keyword 'name'". Titles, intents and reasons are now written so they show exactly as typed.
- **Renames keep a subflow's outputs working:** renaming a step inside a subflow, or one of its outputs, now also updates the subflow output that lifts it (`from: <step>.<output>`). Before, the generated code read an undefined variable.
- **A new or renamed step no longer takes over references:** a key that would make an existing `from:` read the new step instead of the one around it (another level's step, or a subflow's own input) is refused when you type it. A generated key gets a number instead.
- **max_fail_percentage counts the step's own failures:** a step inside a subflow counted the hosts earlier steps had failed, too, and could stop healthy hosts. The simulator counts the same way.
- **Decision conditions:** a condition written whole as `{{ x == 1 }}` works. A condition with `{{ }}` inside it (`{{ x }} == 1`) is a problem that says how to write it, instead of failing every host at run time. Spaces inside quoted strings in a condition are kept.
- **A YAML alias inside what it names** (`&s … *s` within itself), in a flow file or on the clipboard, is refused with a message instead of hanging the designer.
- **Re-import keeps the order of new tasks:** several tasks added to the playbook in a row used to arrive in reverse order.
- **`include_tasks` imports as Ansible runs it:** its `when` is checked once, before the file runs, so the import adds a decision in front of the file's subflow (false goes around it) instead of putting the condition on every task in the file. Its tags no longer reach the tasks inside, and its `apply:` does. `import_tasks` is read as before.
- **Scenario simulation of host patterns:** a pattern of only `!` or `&` terms (`!db`) starts from every host, as in Ansible. A pattern that names `localhost` or `127.0.0.1` without an inventory entry now asks for a check in Ansible instead of guessing.
- **Code mode drift:** a step bound to a collection role (`ns.collection.role`) is no longer reported as "role missing" when it compiles. A role task file that another covered file includes is no longer reported as "task not in design" (adding it would run it twice).
- **"Saving…" never stays for good:** a designer action that fails in VS Code now answers with its error. One that is never answered ends after 2 minutes. Before, a read-only `generated/` file could leave the spinner turning.
- **Fast edits no longer get lost:** commands from the designer run one after the other. Holding Delete or Ctrl+D acts once, not once per key repeat. Before, a quick second edit could be rejected, and the first one shown as an edit made outside the designer.
- **Revert brings the flow's problems back too:** the Flows view and Problems no longer keep the facts of unsaved text after Revert or closing without saving.
- **A lighter start:** the workspace is scanned for flows once at start-up, without `node_modules` and `.git`. After a save, only that flow is read again, not every flow in the workspace.
- **A move VS Code refused** no longer leaves the node where it was dragged: it goes back to where the file has it.
- **A designer behind another tab keeps its state:** the open level, mode, lens, selection and an unsaved binding are still there when you come back to it.

- **Stop Run in WSL** ends the run's processes in the distribution, not only `wsl.exe`. It ends the run's shell and everything under it, and nothing else in the distribution. A scenario that times out on Linux or macOS ends ansible-playbook too, not only the shell that started it.
- **Secret inputs and the vault password:**
  - Their temporary files are removed however the run ends, including Stop and a closed terminal.
  - Their variables are unset once written, so ansible-playbook and what it starts (local tasks, inventory scripts, `lookup('env')`) never see them.
  - A vault password with backslashes now works in WSL and in images whose shell is dash.
- **Run events never hold a secret:** the event callback leaves the values out as it writes, so a run that is stopped or crashes leaves nothing behind either. A list or dict secret is matched by its parts too (`{{ creds.password }}`), and so is the vault password.
- **Your callbacks keep running:** a run adds Ansible Flow's event callback to the `callbacks_enabled` and `callback_plugins` of your `ansible.cfg` instead of replacing them, so ARA, syslog or another audit callback still records runs started from VS Code.
- **Flow keys and IDs:** a key that is not a lowercase slug, or an ID that is not a ULID, never names a file or a folder. The scenarios file, the run and scenario folders, the run history and `generated/<key>.yml` are refused for such a flow instead of being written elsewhere; fix the key, or run Complete IDs.
- **Module catalog:** a collection whose name or version would make its dump file land outside the catalog cache is left out of the catalog, both in the environment and in VS Code.
- **Create Role** (Code mode) is offered only for a role name that makes one folder under `roles/`: not for a collection role, and not for a name with a path in it.
- **Import:** `include_tasks`, `vars_files`, role names and AWX playbook paths that lead outside the workspace folder, through `..` or a link, are not read. A file is read only up to 2 MB.
- **AI tools:** the MCP server and Copilot's flow tools decide a new file or an export by the folder it is written through, links followed, so a linked `flows/` or `generated/` folder cannot lead outside the workspace. An export onto an existing link is refused.
- **AWX in Restricted Mode:** Set Up AWX Template and launching in AWX need a trusted workspace, as local runs do. Importing from AWX only reads and still works. Set Up asks before it attaches credentials the flow file names, and before it changes a template of the same name that runs another playbook.

## 0.74.2 — AFD-126 to AFD-132

Security fixes from a code review (AFD-125). The flows you design work as before. Several things a cloned repository, a flow file or a playbook could make the extension do are now refused.

- **Scenario verify from a terminal agent:** the MCP server runs Ansible in the environment of your VS Code user settings (`afd.environment.*`, as Set Up Ansible Environment… writes them). A repository's `.vscode/settings.json` can name an image, container options or mounts, so the server uses those keys only when you start it with `AFD_MCP_WORKSPACE_ENVIRONMENT=1`. `AFD_USER_SETTINGS` names the settings file when it is not found. Copilot and the designer already needed a trusted workspace for this. Every scenario run now uses an empty `ansible.cfg`, so the repository's own config never loads. The `flow_scenarios` tool says that verify runs programs.
- **AI assistant setup:** Remove AI Assistant Setup and the setup's updates delete only files inside the skill folder, whatever its manifest lists. A folder that is a link, or whose manifest does not read, is left alone.
- **Shared subflows:** a copy's source must be a `.flow.yaml` in the same workspace folder, named by a relative path, and at most 2 MB. Absolute and network paths are refused before anything is opened, so a flow cannot make Windows connect to another machine.
- **Import:** a playbook whose YAML aliases expand to more than 100,000 values is refused with a message. A file of under 1 KB could expand to a billion values and stop the extension.
- **Generated code:** titles, playbook refs, inventory targets and parameter values that contain a line break Ansible's YAML reader knows (U+0085, U+2028, U+2029) or a control character stay on their line, or in quotes. They can no longer add a play under a comment. A parameter named `$comment` or `$flow` is written as data.
- **Stop Run removes the run's container,** so the playbook stops changing hosts at once. A scenario that times out, and a probe call that hangs, remove their containers too.
- **CI:** every push and pull request runs the type checks, Biome and the unit tests. Publishing runs them first, and only its last job holds the Marketplace and Open VSX tokens. No dependency's install script runs in that job.

## 0.74.1 — AFD-123, AFD-124

The extension works as in 0.74.0. This release brings its page up to date and is the first one published from CI.

- **The README shows the extension at work:** a short recording at the top builds on the Hello sample. It adds a step from a port, gives its failure a rollback in one click, shows the play it makes, and runs the flow as a skeleton, where one host fails and ends at Stopped. Three shorter ones show handling a failure from a port's menu, a run that shows where every host went, and a scenario that turns red when a step fails for a host. They load from the repository and are not part of the extension package.
- **Published from GitHub Actions:** a version tag publishes the extension to the Visual Studio Marketplace (Trusted Publishing, no stored token) and Open VSX, and creates the GitHub release.
- **Now on Open VSX** as `chistokhinsv.ansible-flow-designer`, for VSCodium, Cursor and other editors that use it.

## 0.74.0 — AFD-118

Wave 11 ends: scenario tests where you look for tests, in the samples and in the guide.

- **The Testing view** lists every flow with scenarios, with its scenarios under it, and runs them two ways:
  - **Check (simulated)**, the default: instant;
  - **Verify in Ansible**: a run with every step as its stub.

  A failing scenario's message points at the `expect` line of each host that ended elsewhere.
- **The Hello and Edge baseline samples come with scenarios.** Open Sample Flow copies them too: a happy path, and a failure that stops the host or rolls it back.
- **The first-flow walkthrough** has a new step, "Test where hosts end".
- **The scenario runner** for CI runs in WSL with `--wsl` (or `--wsl-distro NAME`), as the designer can.
- **The guide's Scenario tests page** is rewritten around the canvas, the Testing view and the AI tools, with two new screenshots.
- **A smaller extension:** the guide's screenshots are stored in 256 colours, which look the same at under half the size. The VSIX shrinks by about 2 MB.

## 0.73.0 — AFD-117

Wave 11, part 4: AI assistants work with scenario tests.

- **A new flow tool, `flow_scenarios`,** for Copilot (`#flowScenarios`) and the MCP server. An assistant can:
  - list and check a flow's scenarios in the simulation;
  - add one by step key (the expectations default to where the simulation sends each host);
  - update one, or take the new ends with `accept_ends`;
  - delete one;
  - verify them in Ansible.

  A scenario that does not fit the flow is not written; the assistant gets its problems instead.
- **`flow_describe`** says how a flow's scenarios stand, and **`flow_validate`** names a scenario the simulation fails.
- **The MCP server verifies in the environment** your workspace's `.vscode/settings.json` sets (`afd.environment.*`, or the Red Hat Ansible extension's settings). Copilot runs Run Scenarios.
- **The `ansible-flow` skill** has a scenarios reference and a worked example, and the assistants' instructions say to check scenarios after a wiring change.
- **Fixed:** the guide's scenario example forced Validate to fail and expected the switch to roll back. In that flow the rollback follows a failed push, so the example now forces Push baseline.

## 0.72.0 — AFD-116

Wave 11, part 3: write scenarios on the canvas instead of in YAML.

- **The Scenarios chip** in the top bar says how they stand ("Scenarios · 3 pass", "1 failing") or offers to add some, and opens the **Scenarios** tab in the side panel.
- **New Scenario**: a name and a number of hosts. It starts with every host where the flow sends it now, so it passes, and it guards that routing from then on.
- **Show on Canvas, then right-click a step:** "In <scenario>" offers Fail for…, Unreachable for…, Time Out for… or Unchanged for… (the ports the step has) with a host checklist; Take False for… on a decision; Approved, Rejected or Timed Out on an approval; Expect <host> Here on an end. The simulated run on the canvas changes as you choose.
- **Each row in words:** what the scenario plants ("Gate fails for h03"), where hosts now end ("h03 now ends at Gate's open failed_hosts; expected Done"), and the last run in Ansible with when it ran, marked out of date when the flow or the scenario changed since.
- **Accept New Ends** writes the ends the flow now gives as the expectations. **Verify in Ansible** runs one scenario, **Verify All** runs all, and **Undo** takes back the last change made in the tab or on the canvas. Rename, Duplicate and Delete are on each row.

## 0.71.0 — AFD-115

Wave 11, part 2: scenarios stay current with their flow.

- **Renames follow:** renaming a step or an end, renaming a subflow, or extracting steps into a new subflow changes the key paths a scenarios file names them by. The designer, the Copilot flow tools and the MCP server now rewrite the scenarios file in the same edit. The designer saves the scenarios file when you save the flow; the tools say what they renamed. A step you delete is left for the check to name.
- **Checked as you type:** shortly after you change a flow or its scenarios file, the scenarios are checked and simulated, even when the file is not open. Problems shows:
  - a host the simulation sends elsewhere, on its `expect` line: "Simulated: h03 ended at Gate's open failed_hosts; the scenario expected Done";
  - a failing scenario on the flow (`scenario-miss`);
  - a note on a scenario the simulator can model only as a best effort.
- **Verdicts from Ansible are kept:** Run Scenarios results are stored per flow with when they ran. A result is out of date once the flow's routing or that scenario changes; a status, a position or a note does not count. The canvas shows them in the next version.
- **For the canvas and the tools:** scenario files can be changed by commands, each one edit: add, rename, duplicate or delete a scenario, set its hosts, force an outcome, set an approval or an expectation. A new file lists hosts on one line, as people write them.

## 0.70.0 — AFD-114

Wave 11 starts: scenarios you can write without typing YAML. First, an answer in milliseconds instead of minutes, which the canvas, the AI tools and the Testing view will use.

- **The scenario simulator:** works out where each host of a scenario goes without running Ansible. The code generator records the plays it writes, with where each port leads; the simulator treats each play as the generated tasks do. That covers stubs forced to fail, `max_fail_percentage`, decisions, approvals, branches and joins, and `inventory_target`. A suite runs the same flows in Ansible and requires the same result: the engine fixtures, the examples and seeded random flows (ADR-0032).
- **What it does not model is named:** a host pattern among the hosts, a regex or slice in an `inventory_target`, Jinja that a stub run renders, and `serial` with `max_fail_percentage`. Run those scenarios with Ansible.
- **The command line:** `node afd-scenarios.js --simulate flows` needs no Ansible and skips a scenario the simulator cannot model (JUnit `<skipped/>`). `--check` checks the files only. An unknown option is named, `--help` lists them all, and a folder without scenarios says so instead of passing silently.
- **Scenario file checks:**
  - A `force` list that is not a list is an error.
  - So is an expectation on a wired port (a host never stops there).
  - So is an approval choice the approval has no port for. `timeout` is allowed when it has one.
  - A host that runs without an expectation is a warning, and warnings no longer stop a run.
- **Fixed:**
  - A flow with two host-list inputs read its scenario hosts from the first one, while the run started from the one marked as the targets.
  - A scenario run stopped every host at a step that runs on its `inventory_target` when the step's output comes from its result: the stub registers nothing, and copying the output back failed. The copy now happens only when the target host set it, as for other steps. The simulator's Ansible suite found it.

## 0.69.1 — AFD-113

Ready to publish.

- **New icon:** a teal icon for the Marketplace and the Extensions view, and a matching glyph in the Activity Bar. The Marketplace banner is teal too.
- **Publisher `chistokhinsv`:** the extension ID is now `chistokhinsv.ansible-flow-designer`. VS Code treats a VSIX installed under the old `afd-dev` ID as a different extension, so its stored AWX token and remembered flows do not carry over.
- **The source is public** at [github.com/ChistokhinSV/ansible-flow-designer](https://github.com/ChistokhinSV/ansible-flow-designer). The extension's page shows the README's screenshots, which point at the repository.
- **A shorter README:** the main features with screenshots. Requirements, settings, the repository layout and building from source moved to `docs/details.md`.
- **Removed from the repository** (still in its history): the design handoff, the UX measurements and usability kit, and the lab scripts.

## 0.69.0 — AFD-112

A step's Timing given at run time (`docs/ux/wave10-usability/round4.md`, Q4). The round 4 participant was asked to let the operator set how long to wait for a pool to drain, and wrote it into the flow's goal instead. Retries and Delay took only numbers, so no input could drive the wait.

- **Retries, Delay and Timeout take an input:** type `@` (or press the @ button) in the field and pick a step input or a flow input that can hold a number. Picking a flow input adds the step input in the same edit. The flow keeps `retries: "{{ drain_tries }}"`, and Ansible renders it before the task runs.
- **Ask at Run Time…** under each of the three fields makes an integer flow input (with the field's value as its default, and what it is for), the step input that reads it, and the field's template, in one edit. Whoever runs the flow sets the value in the launch dialog or the AWX survey. The field then says "Asked at run time: the flow input drain_tries, default 12".
- **The Timing sentence reads it with the defaults:** "Tries up to drain_tries + 1 times (13 with its default 12), 10 s apart, …; the step takes at most 8 min 30 s in all with the defaults". An expression such as `{{ (drain_wait / 10) | int }}` is "worked out at run time". The sentence also says that a try that runs over its Timeout ends the step, as Ansible makes no more tries after it.
- **The check:**
  - `setting-unknown-var`: a template reads something that is not an input of the step.
  - `setting-input-type`: it reads an input that holds no number.
  - An approval's timeout stays a duration (`timeout-unreadable`), because AWX needs a number.
- **Renaming an input** renames it in Retries, Delay, Timeout and Until too. Until did not follow a rename before.
- **Imported playbooks** keep a templated `retries`, `delay` or `timeout` instead of dropping it, and the imported step gets the inputs it reads.
- **The flow tools** have `ask_at_run_time`, and the schema takes a template for `retries` and `delay`. A designer before 0.69 shows a schema error on a flow that uses one (ADR-0031).

## 0.68.2 — AFD-111

What usability round 4 found that a patch can fix (`docs/ux/wave10-usability/round4.md`, Q1-Q3, Q5, Q6).

- **The Timing sentence counts the first try:** Ansible runs a task once, then retries it, so Retries 12 makes 13 tries. The sentence said "Tries up to 12 times"; it now says "Tries up to 13 times (once, then 12 retries)", and 4 tries with Until alone (Ansible's default of 3 retries). The Retries hint says "Tries again up to this many times after the first try", a polling step's badge counts tries, and the guide's example is corrected.
- **How long in all:** with a Timeout, the sentence ends with the longest the step can take: "each try at most 30s; the step takes at most 8 min 30 s in all".
- **Delay takes a duration** like Timeout beside it: `10s`, `1m`, `1m30s` or a number of seconds. It is saved as seconds, as Ansible needs, and shown as `10s`.
- **A forced row says where the host was expected:** a step's Run tab row for a failure the scenario planted adds "ended at Stopped; the scenario expected Reported to the NOC" when the host missed.
- **A step put on a wire is one change:** after an outside change, the list says "Added Check the health probes pass, in Drain the balancer, after Move the VIPs to the peer", without separate lines for the wire it split and its subflow's new exit. A wire line names its steps by title: "Wire added: Validate (failed_hosts) → Failed".

## 0.68.1 — AFD-108

Wave 10 walkthrough, Z1 (`docs/ux/wave10/walkthrough.md`): the @ list offered a step's whole result, and `.stdout` typed after its chip stayed text outside the braces, so the task got the whole result followed by ".stdout".

- **A field of a result is one chip:** `{{ read_version_result.stdout }}` shows as one chip, including a value written by hand or by an AI assistant.
- **The @ list offers the fields:** for a result (an input that reads one, an output that is a step's register, or the result 0.68.0 offers), the fields its module documents come next: stdout, stdout_lines, rc and the rest, each with the docs' first sentence. They come right after you pick the result, when you type `.` right after its chip, or when you type `@read_version_result.std`. Picking one puts it into the chip.
- **The list fits a narrow panel:** rows wrap and long names break instead of scrolling the list sideways, and the arrow keys keep the active row in view.

## 0.68.0 — AFD-106

Wave 10, part 4: data in and out (`docs/ux/wave9-usability/round3.md`, R7, R6, R10).

- **An input nothing feeds is a warning** (`input-unfed`): a step input with no `from:` and no default. The message says where the value is: the step that registers it ("make it an output there and pick it with @") or the flow input of that name. The Data lens flags it too.
- **The @ list offers an upstream step's result:** "result of Read the software version · makes it an output there". Picking it makes the result an output of that step and an input of this one, so the value passes the designer's way.
- **Flow inputs get a Default** in the flow panel, read by the input's type. A new input starts as required; a default makes it optional.
- **Keeping a flagged become asks for a reason:** the Access lens's finding says "Needs root? Accept it with a reason, so others know why", with Accept with Reason first, and the step's Privilege fold says the same, with the lens off too.

## 0.67.0 — AFD-105

Wave 10, part 3: scenario results say why (`docs/ux/wave9-usability/round3.md`, R8: "the scenario fails it here" was not understood, and the participant went to the step's binding and the inventory to find out why a host failed).

- **A planted failure says so:** "lab-fw-36: the scenario forces Check the HA pair is in sync to fail for it (force: failed), so it leaves by failed_hosts". A step's Run tab says "Forced by the scenario (failed)" for that host. A failure the scenario did not force keeps the run's own message.
- **A miss says where and why:** "lab-fw-36 ended at Stopped; the scenario expected Reported to SecOps, because the scenario forces …". The run panel, the notification, the log and JUnit now use the same words.

## 0.66.0 — AFD-104

Wave 10, part 2: what changed outside the designer, in words (`docs/ux/wave9-usability/round3.md`, R9: the participant found the steps a colleague's pulled commit had changed, but not what had changed in them).

- **What changed:** under the note about outside changes, a list says what each change was: "Added Check the session table is empty, in Fail over to the peer", "Renamed Check the policy is loaded to Check the policy and NAT rules are loaded", "Copy the image: binding changed (msg)", "Wire removed: …". A line shows its step. A changed step's tooltip and its Details say it too.
- **More is noticed:** an outside edit that only removes a wire or changes the flow's own goal or inputs now leaves a mark as well.
- **The Changes lens follows:** while the flow has these marks, it compares with the flow as you last had it open, not with HEAD, so a change pulled with Git shows field by field. Compare with still offers HEAD and the commits.

## 0.65.0 — AFD-103

Wave 10, part 1: the Execution tab explains itself (`docs/ux/wave9-usability/round3.md`, R1-R4: the session's hardest task was setting retries on a step).

- **Folds say what they hold:** "Timing: timeout, retries, until, delay · 2 set", "Targeting: serial, max fail percentage, inventory target". On a step bound to a module, Timing is open until you close it.
- **Timing in one sentence:** under the fields, what the generated task will do with them: "Tries up to 10 times, 15 s apart, until …; each try at most 15s". Timeout now reads as the limit for one try, Delay as the time between tries.
- **Until helps:** it offers the result's fields from the module's returns (`<result>.stdout`, `<result>.rc`, …) and shows an example. A new warning, `until-whole-result`, catches a test that compares the whole result with a value (`result == "installed"`), which never holds.
- **Timeout is checked:** the field takes `30s`, `15m` or `1h30m`; a timeout the generated code cannot read used to be left out without a word, and is now a warning (`timeout-unreadable`).
- **Task keywords have a fold of their own,** out of Tags, with one-click buttons for when, loop, no_log, ignore_errors, delegate_to, run_once and changed_when.
- **The YAML box helps as an editor does** (task keywords and every YAML field): coloured keys, strings and comments; the line with a YAML error underlined as you type; Enter keeps the indent, indents after `loop:` and continues or ends a list.

## 0.64.3 — AFD-102

What usability round 3 found that a patch can fix (`docs/ux/wave9-usability/round3.md`, R5, R11-R13).

- **The @ button inserts where you are:** at the cursor, or in place of the selected text. Before, it always added the input at the end of the value. Typing `@` already worked this way.
- **The side panel's edge** can be dragged anywhere along it. When the panel was scrolled, only its top part still resized it.
- **A module's Returns** (and its badges) wrap in the About section, so a module with many returns no longer makes the panel scroll sideways.
- **The tip on selecting several steps** under a step's Details lines up with the text above it.

## 0.64.2 — AFD-100

- **Input descriptions are saved.** A description typed in the flow panel stayed in its box, but the flow never kept it, so after a reload it was gone. The same happened when an AI assistant set one through the flow tools. Descriptions (0.63.0) worked only in YAML written by hand. Now both ways save them, and emptying the box removes the description. Found by the round 3 walkthrough (`docs/ux/wave9-usability/walkthrough-r3.md`, Y6).

## 0.64.1 — AFD-97

- **Tests:** the integration tests wait until the designer has drawn its wires, in a panel that is still open. A test that reopened a flow on the same version could read a designer that had not drawn yet (no wires, or no answer), and the M1 checks failed now and then (wave 9: 3 of about 12 full runs). Nothing changes for people using the designer; the perf measures stay as they were.

## 0.64.0 — AFD-96

Wave 9, part 5: what round 2 and the walkthroughs left (`docs/ux/wave8-usability/round2.md`, S3, S4, S1; walkthroughs W1, W5, X3, X4).

- **Back to the run's results:** in Run mode, a step's Details start with **‹ Run Results**, so a click on a failed step no longer loses the whole run's list.
- **Output** in a step's hosts table is an icon button, which a narrow panel no longer breaks over three lines.
- **Port labels stay readable:** the step's preview card waits while the pointer is on a port.
- **Stop Flow** is one of the failure banner's buttons, not only under Other Choices.
- **A palette click adds where the flow goes on:** after the one selected step, wired (onto its wire when it has one), or onto Start → Done in a flow with no steps yet. With nothing selected on a level with steps, it is placed as before.
- **How to select several steps** is also said in a step's Details, on a level with three steps or more.
- **A step's lens findings** sit under the Details tabs, so the tabs stay where they are.

## 0.63.0 — AFD-95

Wave 9, part 4: the launch dialog, and inputs that say what they are for (`docs/ux/wave8-usability/round2.md`, S2, S6, X5; W9).

- **Groups say what they hold:** each inventory group button reads "lab · 4", and its tooltip lists the hosts; the buttons are labelled "Inventory groups".
- **Run stays in view:** the dialog's buttons stay at its bottom; only the fields and the facts scroll.
- **A skeleton run starts with no hosts when the inventory has groups:** pick a group or type host names ("Pick the hosts to run on: a group below, or host names"). Without groups, as in the Hello sample, it still starts on `localhost`. What you entered last time still comes back.
- **Input descriptions:** a flow input can say what it is for (`description` in the flow file; the box under each input in the flow panel, except the hosts list). The launch dialog, the run prompts and the AWX survey show it; Set Up AWX Template writes it to a survey it wrote before.

## 0.62.0 — AFD-94

Wave 9, part 3: scenario results in words (`docs/ux/wave8-usability/round2.md`, S9).

- **Ends by their titles:** the run panel says "lab-rt-14 ended at Stopped; the scenario expected Reported to NetOps" instead of the ends' keys, and an end node's table names where each host ended.
- **The notification names the first miss:** "Scenarios: 1 of 2 failed for Campus health check: lab-rt-14 ended at Stopped, expected Reported to NetOps."
- **A scenario's failures say what they are:** "lab-rt-14: the scenario fails it in Check power supplies are redundant", not the stub's "[check-power] TODO · TODO: ..."; a step's Run tab says "the scenario fails it here".
- **The log, the command line and JUnit** give the titles with the keys a scenario file uses in brackets.
- **Fixed:** a host that dropped out of the run passed `expect: stopped` when the flow has an end keyed `stopped`.

## 0.61.0 — AFD-93

Wave 9, part 2: the workspace's state where you already look (`docs/ux/wave8-usability/round2.md`, S8, S7, X2).

- **The Problems panel lists every flow,** not only open ones: the errors and warnings of each flow in the workspace, checked in the background after start-up. An open flow adds its binding checks. `afd.problems.scope: open` keeps the old behaviour.
- **A generated playbook edited by hand says so** in the Problems panel ("Edited by hand: saving ... leaves this playbook alone, and Generate Code asks before writing over it"), with **Open the Flow** as a quick fix.
- **The flow panel says what the other flows need:** "In this workspace: 1 flow with errors, 1 with code edited by hand: Flows View". When a flow has errors or code edited by hand, the line also shows at the top of the panel.
- **Find says what a filter lists:** "4 steps not implemented yet", "2 approvals", "8 draft steps and subflows".
- **The Flows view** shows a root per folder in a multi-root workspace (it listed only the first folder's paths right).

## 0.60.0 — AFD-92

Wave 9, part 1: what changed while a flow was closed (`docs/ux/wave8-usability/round2.md`, S12).

- **Marks for a closed flow.** When you open a flow again, the steps and wires that changed since the designer last showed it get the dashed outline, and the note says "3 steps changed outside the designer since you last had this flow open (4 Nov, 20:49)". That covers an agent's edit, a text editor, a Git pull or checkout: anything the designer did not write. Before, marks counted only from the moment the designer opened.
- **What the designer last showed** is kept per workspace, when its last panel closes, when you save in it and when you press Clear; flows not opened for 90 days are forgotten.
- **A save's own edits** (the version bump, a tested step going back to implemented) are no longer counted as outside edits.
- The note shows the day when the marks are not from today.

## 0.59.3 — AFD-91

Two bugs from the second usability round (`docs/ux/wave8-usability/round2.md`).

- **Lens rows stay put.** In a lens list that has a step inside a subflow, every row says where its step is ("in Drain the switch", "on the top level") on every level. Before, the line showed only for a step on another level. A click that opened the step's level removed it, the row shrank, and the next row moved under the pointer, so the next click opened the other step.
- **Hovering a row for a step inside a subflow lights that subflow.** Before, every node on the level dimmed and none lit. A step in a subflow beside the level on screen dims nothing.
- **The launch dialog counts the hosts as soon as a host list reads,** whatever the other fields hold. Before, it waited until every required input was filled, so "devices is required" from when it opened stayed, with Run disabled, after the devices were set.

## 0.59.2 — AFD-89

- The flow panel's **Flows View** link sits with the Readiness counts, so a new flow's first screen keeps its 35 controls (0.59.1 had 36).

## 0.59.1 — AFD-89

Wave 8: two loose ends of 0.57.0, before the second usability round.

- **`has:no-binding`** lists the steps whose card says "not implemented yet", on every level, and nothing else. `status:draft` also lists every subflow with such a step inside. It is the Find box's first offer.
- **The flow panel leads to the Flows view:** "Other flows of this workspace, with their problems and code state: Flows View".

## 0.59.0 — AFD-88

Wave 8, part 9: line steps up without dragging by eye.

- **Arrange:** with several steps selected, **Align Centers** puts them on one flow line and **Distribute Vertically** gives three or more equal gaps, from the selection panel or Shift+Alt+A / Shift+Alt+D. The selection's right-click menu has **Arrange ▸** with left, right, top, middle and bottom edges and horizontal spacing too. Each is one move: Ctrl+Z puts them back, and the rest of the level stays where it is.
- **Guide lines while dragging:** a dashed line shows when the step you drag shares an edge or a centre with another; release near it and the step snaps onto it. "even gaps" shows when it sits halfway between its neighbours.
- **Reset Position:** a step you placed by hand (or a selection) goes back to automatic placement.
- **Drop a step on a wire:** a palette step dropped on a wire goes into it; the wire lights while you drag over it.
- **How to select several:** the flow panel says so (Ctrl+click, Shift+drag).

## 0.58.0 — AFD-87

Wave 8, part 8: lens findings where you check a step.

- **A step's Details show its lens findings.** With a lens on, a step that has findings shows a fold under its name ("Lens: Access · 2 on this step") with the same fixes and **Accept with Reason…** as the lens tab. The fold is open while a finding there is not accepted. After a fix leaves the step with none, **Next Finding** takes you to the step of the next open one.
- **A finding says where its step is:** a finding or a lens row for a step on another level names its subflow ("in Drain the switch") or "on the top level".
- **The lens tab moves on after a fix:** the next open finding gets the focus and lights its steps. Before, the fixed step stayed lit.
- **The lens tab keeps its place:** checking a step and coming back to the tab finds it scrolled where you left it.

## 0.57.0 — AFD-86

Wave 8, part 7: find your way through a flow and a repository.

- **Find filters:** `status:draft`, `type:approval`, `open:fail`, `has:errors`, `has:binding`, `tag:` and `target:` list the matching steps on every level at once, alone or with words. Two values of one filter mean either. The Find box offers the filters and completes them. Before, listing the steps without an implementation meant opening every level.
- **Readiness counts lead somewhere:** in the flow panel, each count (drafts, specified, open fail ports…) opens Find with its filter.
- **"Not implemented yet":** a task without a module, role or playbook says so on its card, not only "Task".
- **The Flows view shows the repository's health:** flows by folder. Each says its errors and warnings and whether its code is out of date, edited by hand or not generated yet, and the tooltip explains what that means and what a save will do. **Run as Skeleton** and **Peek Code** sit on each flow. The view honours `files.exclude`.

## 0.56.0 — AFD-85

Wave 8, part 6: see what an agent changed.

- **Edits made outside the designer are marked.** When an agent, a command line, a Git checkout or another extension changes the flow while the designer has it open, a note over the canvas says what changed since you opened it ("2 steps and 1 wire changed outside the designer"). The changed steps and wires have a dashed outline; a subflow with a changed step inside has a thin one. **Show** lights them and opens the first; **Clear** drops the marks.
- **Your own edits are never marked:** those in the designer, Undo and Redo, and typing in the flow's text editor. The marks stay apart from the Changes lens, which compares with Git and so shows your edits too.
- The legend explains the dashed outline.

## 0.55.0 — AFD-84

Wave 8, part 5: scenario results on the canvas.

- **A scenario shows on the canvas like a run.** After Run Scenarios, **Show on Canvas** in the notification opens the first failing scenario in Run mode: each step shows the hosts that took its ports, and each wire how many took it.
- **The run panel lists the scenarios:** pass or fail, and each host that ended elsewhere ("lab-sw-04: expected reported, ended at stopped"). Click one to show it; **Back to Last Run** puts the last run back.
- **End nodes say who was expected there:** in a scenario, an end node's Run tab lists the hosts expected there and the hosts that came, with where each ended.
- **The notification is one line:** how many scenarios failed and the first one's name, with Show on Canvas and Show Log; before, it ran the failures together.

## 0.54.0 — AFD-83

Wave 8, part 4: lenses and the inventory, explained.

- **A lens says what it shows.** With a lens on, a line over the canvas names it and what it shows on each step. When no step on the level has anything for it, the line says why: no step reads or sets data, none is bound yet, none sets a credential or become. Before, the canvas just went quiet. The Inventory lens without flow targets says that the targets are not set, with **Set Targets…** beside it. The lens tab starts with the same description.
- **The modes say what they are for:** in Code and Run, the line over the canvas says what the mode shows and that the graph only reads there.
- **The Inventory view:** **Inventory** in the Ansible Flows view (Activity Bar) lists the groups and hosts the runs use, read in your Ansible environment, with each group's host count. **Run Flow on This Group…** on a group or a host opens the launch dialog of the flow you are working on, with it as the targets.

## 0.53.0 — AFD-82

Wave 8, part 3: one dialog to start a run.

- **Run as Skeleton and Run for Real… in the designer open a launch dialog** (Ctrl+F5 too), instead of an input box per input and a confirmation after them. It shows every input of the flow by name and type, with its last value or default, and **Run** starts the run.
- **Lists read as you mean them:** `10.20.0.10, 10.20.0.11` is a list of two, as is a JSON list. A dict takes `key: value` lines or JSON, and the dialog says what each reads as ("2 items: …"). Text that does not read is named before anything runs, where it used to pass as one string.
- **Hosts and groups:** the inventory's groups are buttons under a host list. The dialog shows how many hosts the targets match, and which are not in the inventory, counted again as you change them.
- **A real run's confirmation is in the dialog,** in the same words as before: hosts, inventory_targets, production-looking groups, environment. Just before the run starts, the hosts are counted once more: when the inventory answers differently from what the dialog showed, nothing runs and the dialog opens again with the new facts.
- **Secret inputs and the vault password** are typed in the dialog, sent once and never kept.
- From the Command Palette, or with no designer open, the run asks as before. Launch in AWX keeps its own prompts for now.

## 0.52.0 — AFD-81

Wave 8, part 2: local runs you can follow on the canvas.

- **The canvas follows a local run while it goes.** The step that runs now has a pulsing outline and reads "running…" (a subflow too, while a step inside it runs). Steps show their hosts as they finish, about every half second, instead of everything at the end. On the Hello sample the first result now comes before the run ends, not with it. With reduced motion the outline stays still; in Windows contrast themes it uses the system highlight.
- **A run you start from the designer switches it to Run mode**, and the top bar names the step that runs.
- **The terminal stays out of the way** while the flow's designer is open. It comes forward by itself when the canvas cannot explain the run: it did not start, produced no events, or failed before its first step. **Show Terminal** brings forward that run's own terminal. Without a designer open the terminal shows as before.
- **No new events for 20 s:** a notification and the top bar say so, with Show Terminal: a step may be slow, or the run may be waiting for input there (an SSH host key question, a `pause`).
- **Output per host:** after a local run, **Output** on a host in a step's Run tab shows what each task printed for it (msg, stdout, stderr, changed, return code). A `no_log` task says only that its output is hidden.
- **Secret inputs stay out of the run's events**, now that they carry output: their values are replaced, both while the run goes and in the events kept after it.

## 0.51.0 — AFD-80

Wave 8, part 1: the Binding tab at the side panel's width.

- **The parameters come first.** Once a step has a module, role or playbook, the Binding tab starts at **Configure**. **Change module** (the search) and **About** (the docs) are folded below it. In the docked panel the first parameter is now 176 px down; it was 1099 px, below the fold. A step without a binding still starts at the search. **Change module** opens by itself while you pick another one, and when the bound one is missing from the environment, removed, moved or deprecated. **Expand** shows the three side by side with both folds open.
- **Required and Optional:** Configure groups the parameters the module needs, then those with a value or added by you.
- **Add a parameter** replaces the bare list of names. Type a name, an alias or what the parameter does (`line`, `permissions`) and pick it from a list that shows each one's description; arrows, Enter and Escape work as in VS Code's own pickers.
- **Full Docs** is at the top of About, not at the end of a row of badges.
- **No silent loss of a binding change:** hiding the side panel and opening the lens tab now ask first, like choosing another node does. Turning a lens on keeps the Details open while the binding is not saved.
- **The panel's edge has a grip:** the side panel could always be dragged wider, but its edge only showed on hover.

## 0.50.1 — AFD-79

Fixes from the first usability session (wave 8, round 1).

- **Ctrl+V into a parameter value works:** a path or text pasted into a module's parameter field (the field with input chips) was dropped, because VS Code pastes into the designer in a way the field's own paste could not use. The pasted text now lands at the caret, or over the selected text, as one line.
- **Guide pages show their screenshots:** pages under How-to, Tutorials and Reference, opened with **Ansible Flow: Open User Guide** or a "?" link, showed broken images in the Markdown preview. The extension now registers an (empty) preview style, which lets the preview load the guide's images from the extension's folder.
- **The extension's page in the Extensions view has no broken image:** that page shows only images on the web and opens no link into the extension, so the packaged README leaves out the screenshot and the guide links and says where the guide opens instead.
- **The scenario log is readable:** Run Scenarios wrote Ansible's colour codes into the Ansible Flow log as text (`[0;31m` before every failure); they are removed there. A terminal and the scenario command line for CI keep the colours.

## 0.50.0 — AFD-75

- **WSL as an Ansible environment:** on Windows, runs, the module catalog, Code mode and the lenses can use Ansible inside a WSL distribution (WSL 1 or WSL 2), from Windows VS Code: no Docker and no Remote window. Set `afd.environment.kind` to `wsl` (and `afd.environment.wslDistro` to the distribution, or leave it empty for WSL's default), or pick the distribution in **Set Up Ansible Environment…**, which now lists them. The repository stays on Windows (the distribution sees it under `/mnt`); a vault password and secret inputs still travel only in environment variables.
- **Ansible from pipx in WSL works as installed:** the extension uses the PATH of a login shell (so `~/.local/bin` counts) and runs its helper with the Python on the first line of `ansible-playbook`; `afd.environment.python` still overrides it. Commands now reach the distribution word for word (`wsl.exe -e`), so a vault password and secret inputs with quotes or spaces arrive intact.
- **Checked end to end** on Debian 13 in WSL 1 (ansible-core 2.22.0) and Ubuntu 24.04 in WSL 2 (ansible-core 2.21.6): probe, catalog, skeleton and audited runs, Code mode, lenses, scenarios, a vault with secret inputs, `ansible.cfg` on `C:`, a folder with spaces, and a real run over SSH. The guide adds what came up: keep SSH keys in the distribution (ssh refuses a key under `/mnt/c`), name the distribution when Docker Desktop is WSL's default, and an antivirus that inspects HTTPS breaks downloads in WSL 1.

## 0.49.0 — AFD-74

Wave 7, a gentler first hour, part 4: docs and samples for a newcomer.

- **Hello, Ansible:** a new sample, first in Open Sample Flow…: three steps bound to builtin modules (reach each host, read a few facts, say hello), every failure handled, no problems, and it runs on `localhost` as a skeleton.
- **Tutorial 1 shows the result first:** a playbook after two steps, then the banner's question about failures, then a skeleton run on `localhost`, in about ten minutes. Subflows moved to the start of Tutorial 2.
- **How flows work:** a new page on what happens to the hosts: they travel along wires, a step is a play, how failures end, what a skeleton run is, with the Hello flow, its YAML and its play.
- **The glossary** has the words the designer uses (node kinds, fail port, failure pattern, intent, key, skeleton run, Ansible environment, palette, banner, Quick Add, Peek Code and more), and the guide's index links it instead of its own word list.
- **The README starts with a first flow** in three steps; the full feature list moved to the guide (Reference › Features), without ticket codes.

## 0.48.0 — AFD-73

Wave 7, a gentler first hour, part 3: a guided first flow.

- **Your first flow:** a small checklist over the canvas, on a flow with one to five steps: add a step, see the playbook it makes, decide what happens when it fails, run it as a skeleton. Each ticks as you do it, and **Show Me** does it or opens where it is done. Hide it once and it stays hidden ("…" › Show First-Flow Checklist brings it back).
- **Ansible Flows in the Activity Bar:** the flows of the workspace, New Flow and Refresh. With no folder it offers Open Folder and Get Started; with no flows, New Flow, Open Sample Flow, Import Ansible Playbooks, Get Started and the User Guide.
- **"?" links** beside the Details tabs, the failure patterns and the Run, Design vs code and lens panels open the guide page about them.
- **AI assistants are offered after you meet a flow:** the setup notice comes the first time the designer shows a flow with a step, not when VS Code starts, and **Set Up…** shows what it writes before writing it.
- **The walkthrough** "Design your first Ansible flow" has six steps that match the checklist, with Set Up Ansible Environment… in its run step. The empty-flow card links Get Started.
- **A quieter Command Palette:** Launch in AWX, Set Up AWX Template and Clear AWX Token show once an AWX address is set; Remove AI Assistant Setup… once there is one.
- Your progress (the walkthrough's steps and the checklist) is kept between sessions.

## 0.47.0 — AFD-72

Wave 7, a gentler first hour, part 2: a calmer first screen. Things show when they can act; rarer fields fold away behind a line that says what is inside, and open by themselves when something there needs you. Nothing is removed.

- **The open-port banner asks a question:** _What should happen when "Check NTP" fails?_, with the first fixes as buttons (for example Rollback from Backup, Notify On-Call and Stop, Accept with Reason…), Other Choices for the port's menu, and Next for the next open port. The problem says what happens to the hosts: they have nowhere to go, so they fail the run.
- **Ports explained in plain words:** port names stay as in the file, and the port tooltip, the port menu, the Ports tab, Quick Add and the Legend say what each is for ("Hosts that failed this step continue here").
- **The flow panel** shows the name, the goal and the inputs; key, ID, version, owner, runtime and maintenance window are under More details. Readiness shows once there is a step.
- **The palette** shows Task, Subflow, Decision and Approval, with Parallel, Join, Start and End under More node types; the failure patterns appear once a step can fail.
- **The top bar:** while a run goes, Run as Skeleton is the Stop button (no greyed Stop the rest of the time). Export as draw.io Diagram… and Export as Image… moved into "…". The Lens dropdown appears once the flow has a step.
- **Quick Add:** Extra ports are folded and say what each is for; the button names what it adds (Add Task); Intent is marked optional.
- **The Execution tab:** each group is a fold that says how much is set ("Timing · 2 set").
- **A selected wire** shows which hosts take it, with Insert, Rewire and Disconnect.
- Inputs read `from` in words ("this step's result", "flow input devices"); the reference itself is in the tooltip. "req" reads "required". A node's ID is under More details.
- **The minimap never covers a step:** it moves to a free corner, or a Mini Map button shows it when neither corner is free.

## 0.46.0 — AFD-71

Wave 7, a gentler first hour, part 1: the dead ends a newcomer hit.

- **Set Up Ansible Environment…** (new command): a run with nowhere to run (native Windows with no image set) no longer stops at an error. The error offers the setup: it finds Docker or Podman and proposes the public Ansible dev tools image (`ghcr.io/ansible/community-ansible-dev-tools`, editable; the first run pulls it), or reopens the folder in WSL, then offers the run again. The error is shown once, not twice.
- **A first skeleton run suggests `localhost`** for the hosts (real runs suggest nothing).
- **Add Next Node (N) continues on the main path:** after a step whose `ok_hosts` already leads on, the new step goes onto that wire, between them, instead of off the step's `always` port.
- **The Execution tab shows what the code uses:** decision, approval, parallel and join steps show batches, privilege and tags (an approval also its AWX timeout); a subflow with steps inside shows rolling, privilege and inventory target. A setting set where it does nothing still shows, with "Not used on a … node: clear it."
- **Fix:** the Details stayed blank after adding a step with Quick Add (Add a Step, N) until another node was clicked.
- **Fix:** Quick Add's Extra ports offered `undo` and `cancelled`, ports that were never built and raise a warning; the AI tools could add them too.
- Peek Code on a flow not saved yet offers Generate Code instead of a dead end. New Flow and Open Sample Flow with no folder open offer Open Folder….
- Design, Code, Run and each lens say in their tooltips what they are for. The Mark Tested dialog is titled Mark Tested. An empty subflow shows one "no steps" message, not two. The selection panel's button reads Extract into Subflow.

## 0.45.0 — AFD-70

- **Wires go round steps:** a wire that would run through a step (one that skips a step, such as several failure wires into one rescue step, or one back up the flow) now goes round the steps in its way, on the canvas while you drag and in draw.io, SVG and PNG exports. Wires into one port share their last stretch, and a label sits where it covers no step.
- **Tidy Up gives a clean level by itself:** after Tidy Up (and an AI assistant's `tidy_up`) no wire runs through a step; what the layout check can still report is mostly crossings.
- Every other wire looks exactly as before.

## 0.44.0 — AFD-69

- **AI assistants check the layout they cannot see:** `flow_describe` with layout lists, per level, a wire running through a step, a wire label on a step or on another label, steps or notes on top of each other, and wires crossing. An edit that places steps checks the levels it laid out, so the assistant can tell whether a move helped.
- **An AI import checks the layout before it finishes** and moves steps until no wire runs through one.
- Tidy Up (`tidy_up`) is described as what it is: it places steps, not wires.

## 0.43.0 — AFD-68

- **Sections are easier to move:** a title bar across the top with a grip is the handle; drag it and the steps inside come along.
- **A palette click places new annotations in free space** near the middle of the view, not under a step.
- **Add Section with steps selected** (palette, or right-click several steps › Add Section Around) draws the section around them.
- **Fix:** resizing a note, section or text right after editing its text no longer snaps it to the smallest size.

## 0.42.1 — AFD-67

- **Fix:** the Details, Run and lens panels show the lines between their sections again; they had been lost in 0.41.0, when canvas sections took the panels' class name. Canvas sections no longer get the panels' extra spacing either.

## 0.42.0 — AFD-66

- **Annotations in exports, reviews and code**: draw.io diagrams and images include notes (draw.io notes tied to their steps), sections and text. The Changes lens outlines the annotations added or changed and lists those removed. A note on a step becomes `# Note:` comments above that step's play in the generated code (the flow's version stays).

## 0.41.0 — AFD-65

- **Notes, sections and text on the canvas** (format 2): add them from the palette's Annotate group, the canvas menu (Add Note/Section/Text Here), a node's menu (Add Note to This Node) or Shift+N. Double-click, Enter or F2 edits the Markdown in place; Ctrl+Enter saves, Esc cancels. A note on a node is tied to it by a dashed line and moves with it; a section is dragged by its title and carries the steps inside it; text comes in three sizes. Their panel sets the text, color, size and the node a note is on (Attach to Node…, Detach from Node). Links open in the browser. Find searches their words; … › Hide Annotations takes them off your canvas. They never change the flow's version.

## 0.40.0 — AFD-64

- **Annotations in the flow file (format 2)**: Notes (Markdown), Notes on a node (they move, are copied, extracted and deleted with it), Sections (titled regions that carry what is inside them when moved) and Text, under `annotations:` on each level. They never run and change no version: saving a flow whose only change is its annotations keeps its version and its tested steps. Multi-line text is written as a readable YAML block. Complete IDs completes annotations written by hand. The canvas shows them from the next version.
- **AI tools**: `annotate` and `update_annotation`; `delete` and `move` take annotations (moving a section carries its contents); `flow_describe` lists them by key (`note-1`, `fix-ntp/note-1`).
- Info-level problem counts now say `info` instead of `note(s)`.

## 0.39.1 — AFD-62

- **A shared subflow copied from a format 1 flow is copied as format 2**: the source is upgraded in memory first (the file is left as it is), so its legacy ports and field names no longer land in the copy, where they showed warnings that could not be cleared.

## 0.39.0 — AFD-61

- **Re-import from Source**: a flow imported as is from a playbook takes the playbook's later changes and keeps yours. A step the playbook changed and you did not takes the playbook's version; a step both changed is a conflict that keeps yours unless you pick it; new tasks become steps after the task before them; a step whose task is gone stays, with the warning `import-gone`. A list previews the merge, then it applies as one edit. Imported steps now record their task (`origin`); flows imported earlier need a new import first.

## 0.38.0 — AFD-60

- **Shared subflows**: **Insert Shared Subflow…** copies a subflow of another flow in the workspace, pinned to that flow's version (format 2). The copy's level is edited in its source; when the source has a newer version, **Update Shared Subflow** brings it (a quick fix, and saving the source is enough for open flows to notice). A copy changed here is flagged; **Unlink Shared Subflow** makes it the flow's own.
- Changes lens: the list of branches comes from the Git extension's newer API.

## 0.37.0 — AFD-59

- **AWX surveys from the flow inputs**: Set Up AWX Template writes the template's survey, so a launch in AWX asks for what the flow needs (host lists as comma-separated text, text, whole numbers, secrets as passwords; booleans, lists and mappings stay extra variables). A survey changed in AWX is kept unless you choose Replace Survey; ours follows the inputs.
- The generated start play takes the targets input as a list or as comma-separated text (what a survey answers).

## 0.36.0 — AFD-58

- **Scenario tests**: `<flow key>.scenarios.yaml` next to a flow says, per scenario, the inputs, the outcomes to force on chosen hosts and steps, and where each host must end. **Run ▾ › Run Scenarios** runs them with every step as its stub on local hosts (no binding runs) and says which pass; the Problems panel checks the file against the flow. **Copy Scenario Runner to Repository** puts the CI command line into `.afd/afd-scenarios.js` (`--image`, `--junit`, exit 1 on a failure).

## 0.35.0 — AFD-57

- **Changes lens: compare with HEAD, a branch or a commit**, node by node, for a review. Changed and added nodes get chips (`changed: title, binding`), a subflow says how many changes are inside it, removed nodes come back as ghosts where they stood, and the panel lists every changed, added and removed node, wire and flow field. A selected node's Details shows its field changes, before → after. **Compare with** picks the version from Git.

## 0.34.1 — AFD-56

- **Complete IDs handles wires written as one flow mapping**, such as `- {from: {node: a, port: ok_hosts}, to: {node: b, port: in}}`.
  - It used to fail with "overlapping edits". This affected the quick fix, the AI and MCP tools, and paste.
  - Edits to a flow mapping are now written in place, so its spacing stays as written.
  - A value containing a comma or a bracket is quoted inside a flow mapping. It used to be read back as two keys.

## 0.34.0 — AFD-55

- **Rolling subflows**: set **Rolling batch** on a subflow (a number, or a percentage like `25%`) and its hosts go through every step inside in batches, one batch after another: the steps run in one play with `serial`, and every host takes the same ports as before. A step that needs plays of its own (a nested subflow, an approval, a parallel or join, a playbook binding, an inventory_target, or its own serial or max_fail_percentage) is reported (`rolling-unsupported`) and the steps then run play by play. The level shows a `rolling, N at a time` chip.

## 0.33.0 — AFD-54

- **The undo and cancelled ports are gone**: they were never built (nothing ran an undo port, and a cancelled job routes no host). They are no longer offered; a flow that has one shows it with the warning `legacy-port`, and Upgrade Flow Format removes them with their wires. A node's `undo` binding stays.
- **Rollback wires explicit undo steps**: the pattern builds a Rollback subflow with one undo step per completed step on the level, newest first, starting with the failing step; a step with an `undo` binding gets its undo step bound to it. The next failure port reuses the same Rollback.

## 0.32.0 — AFD-53

- **Each step keeps its own outputs** in the generated code: a role's, playbook's or stub's output is copied right after the step into `afd_<key>__<output>`, and readers read that copy. Two steps that both set `version` no longer overwrite each other. The flow file does not change (both formats).
- A register that another step also registers, or that a flow input names, is now the error `register-collision` where it is read (it was the warning `output-name-collision`, which no longer applies to other outputs).

## 0.31.0 — AFD-52

- **Privilege reaches the steps of a subflow** (format 2): become and its user, set on a subflow, apply to the generated plays of the steps inside; the nearest setting wins and a step can turn it off. The level chips say so. **Become user** is a setting (Execution › Privilege), no longer a task keyword; Upgrade Flow Format moves it and lists the subflows whose become now applies inside. Format 1 flows generate what they always did.
- The **serial** chip on subflow levels is gone: serial batches the hosts of a node's own play, nothing inside.
- **AWX credentials and execution environment belong to the flow** (format 2): the template has one set, so the flow keeps them by name next to the template (`flow.runtime`). Set Up AWX Template uses them, or asks and records what you pick; the AWX import writes them there; the upgrade moves the ones nodes named (they were never applied) and says which. The Access lens shows the flow's.
- **Retry sets retries on the step itself**: the pattern no longer adds a placeholder "Retry …" step; it sets Retries 3 and Delay 10 s on the module step (keeping values it has), so the generated task tries again. Hosts that still fail leave by the same port. Offered on `failed_hosts` and `timeout` of module steps only (Ansible cannot retry a role, a subflow or an unreachable host); renamed from Retry with Backoff, which it never was.
- **`handler` is called `purpose`** (format 2): it says what a step is for in failure handling (rollback, notify, retry, exclude) and was easy to read as an Ansible handler, which it is not. Details › General shows **Purpose in failure handling**; the patterns write the name the file's format uses; the upgrade renames it in place, and a run recorded before still matches. AI tools: `purpose`, with `handler` still taken for one release.

## 0.30.0 — AFD-51

- **Keep a warning with a reason** (format 2): **Accept…** next to it in the node's Details, or **Accept with Reason…** in the Problems panel; the flow records why and the warning stops showing for that node (and that variable). The import's `binding-unknown-var` for variables from `group_vars` no longer nags.
- **One kind of decision** in format 2: open ports, drift items, lens findings and warnings are all `kind: accepted`, keyed by what they accept (`port:`, `drift:`, `lens:`, `check:`). Upgrade Flow Format converts the format 1 kinds; nothing else about them changes.
- AI tools: `accept` and `unaccept` for all four; `leave_open` and `reopen` still work for one release.

## 0.29.0 — AFD-50

- **Status follows the content** (format 2): a binding makes a step implemented, inputs or outputs specified; a decision is implemented by its condition, an approval, parallel or join as it is; a subflow is as far as its least finished step. Every writer gets the same statuses: the designer, the AI tools and MCP. The Lifecycle in the Details shows the status, with **Mark Tested…** and **Clear Tested**; the node menu has the same two.
- **Tested keeps its evidence on the node:** the run (id, flow version, commit) when the run panel marks nodes tested, or the reason, who and when for Mark Tested…. A design change takes both away.
- **The runtime is worked out from the flow** in format 2: AWX when a template is named (a workflow when approvals split it, else a job). Set Up AWX Template writes only the template.
- **Upgrade Flow Format** now brings statuses in line with what the nodes have, turns tested into records (keeping a reason given by hand), and drops `runtime.kind`; the banner lists these changes before you upgrade.
- Format 1 flows keep working as before: statuses by hand, tested by hand as a decision.

## 0.28.0 — AFD-49

- **Flow format 2** (improvement program, wave 4): new flows, imports and the samples are written with `schema_version: 2`. A format 1 flow stays readable and works as before; nothing is changed on open.
- **Upgrade Flow Format** (the banner over the canvas on a format 1 flow, the Command Palette, or the AI op `upgrade_format`) moves a flow to format 2 in one edit; one undo reverts it, and comments and layout stay. For now it changes only the version: the next wave 4 changes add what format 2 is for, and the banner will list them before anyone upgrades.
- An edit that needs format 2 will say so and how to upgrade, instead of writing what an older reader rejects.
- **The command ids from before 0.25 are gone** (`afd.validate`, `afd.generate`, `afd.runSkeleton`, …): they ran as hidden aliases of the `afd.<area>.<verb>` ids through 0.27. Keybindings or links that still use an old id need the new one (the commands reference lists them).

## 0.27.3 — AFD-48

- **Navigation and onboarding** (improvement program, wave 3):
  - **Find a node:** Ctrl+F (also in "…" and the canvas menu) searches every level by title, key or binding; each result says which subflows it is in. The arrows and Enter open one where it is, and the box stays open for the next.
  - **Failed steps:** with nothing selected, Run mode's panel lists the steps where hosts failed, on every level; click one to open it.
  - **Room for the canvas:** the palette folds to icons, and its legend opens from **? Legend**; the side panel folds to a strip (double-click or Enter on its edge, or "…" › _Hide Side Panel_). Both are remembered.
  - **An empty flow says how to begin:** a card under Start and End offers **Add a Step** (between them), **Import Ansible Playbooks…**, **Import AWX Workflow or Job Template…** and **Open Sample Flow…**.
  - Shown nodes come to the middle of the view, also on another level (find, failed steps, the open-ports banner's Show).

## 0.27.2 — AFD-47

- **Keyboard and accessibility** (improvement program, wave 3):
  - **Ports by keyboard:** on the selected node, Tab reaches its ports; Enter or Space opens a port's menu.
  - **Pick a node by keyboard:** while connecting, Tab or the arrow keys show a node (dashed outline, named in the bar above the canvas) and Enter wires it.
  - **New keys:** N adds a node (after the selected one, else at the pointer), Enter goes into a node's Details (a subflow still opens), Ctrl+A selects the level, Shift+1 fits it, Alt+1/2/3 switch modes. The cheat sheet lists Redo too.
  - **Focus:** every dialog takes the focus, keeps Tab inside and gives the focus back (also when opened from a menu). The arrow keys switch the Details tabs.
  - **Names:** a node is read as its type, title, status and open fail ports; the failure patterns say what they need on screen, not only in a tooltip.

## 0.27.1 — AFD-46

- **Feedback** (improvement program, wave 3):
  - **Messages over the canvas:** at its bottom centre, whatever the side panels' widths; info, success and error, stacked, each with ×. They close by themselves, errors after 9 s, the others after 4 s. Screen readers hear errors at once and the rest politely.
  - **Success says so:** Generate Code ("Generated 3 file(s) in …" or "… is up to date"), Check Flow and Tidy Up report in the designer instead of a VS Code notification; from the Command Palette they still notify.
  - **Saving…** with the messages while an edit waits for VS Code longer than 250 ms.
  - **A file with YAML errors** shows a read-only banner naming the error, with **Open in Text Editor**.

## 0.27.0 — AFD-45

- **The same toolbar in every mode** (improvement program, wave 3): **Run as Skeleton** (with **Run for Real…** and **Launch in AWX** under its arrow), **Stop**, **Generate Code**, **Export** ▾ and "…". What cannot run now is greyed out, and its tooltip says why. **Re-sync from Git** is at the top of Code mode's panel.
- **Code mode reads the graph**, like Run mode: no moving, wiring or deleting there; bindings stay editable (Details › Binding, the node menu's **Binding…**, the drift actions). The palette shows in Design mode only.
- **A lens no longer takes over:** the palette stays, and the right panel gets a **Lens** tab beside the panel you had; selecting a node shows its Details, and the Lens tab is one click away.

## 0.26.1 — AFD-44

- **Details content** (improvement program, wave 3):
  - **Execution** in groups: Targeting, Privilege, Timing, Tags.
  - **Task keywords** stay visible while they cannot apply, disabled, saying why (bind a module or role first; a playbook takes none).
  - **+** on a row of the module docs adds that parameter to the form.
  - **Problems inline:** a node's problems are listed at the top of its Details, each opening its tab; the fields they are about show them underneath, and tabs with problems are marked.
  - **Tested by hand takes a reason:** choosing **tested** (Lifecycle, or Status ▸ tested) asks why; the reason is recorded in the flow with your Git user name and goes when the node's design changes. A passing run still marks nodes tested by itself.

## 0.26.0 — AFD-43

- **One Details panel** (improvement program, wave 3): a selected node's Details are docked on the right in every mode, instead of an inspector plus a page over the canvas.
  - Tabs: General, Binding, Inputs and outputs, Ports, Execution; Code and Run modes add their own tab first. The tab you were on stays when you select another node.
  - **Fields save as you go.** The binding is staged: a bar says it is not saved, with **Discard** and **Save Binding**, and leaving it (Esc, another node, another level or mode) asks first.
  - **Resize** the panel by its left edge (or the arrow keys on it); **Expand** widens it so the binding's search, docs and parameters sit side by side. Both are remembered.
- **Fixed:** a bound task without an explicit register name counted as changed before any edit (Save was enabled at once); an untouched binding is no change now.
- **Fewer places for the same thing:** the card under a selected node is gone (its facts are in the node's rows from 1.4× zoom); the hover card previews only; generated code is in the Binding tab and **Peek Code** (`</>` in the Details).

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

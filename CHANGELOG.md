# Changelog

All notable changes to Ansible Flow Designer.

## 0.85.0 — Run on Ansible Flow Server, npm packages

### Added

- **Run on Server:** run a flow on [Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server) and follow it on the canvas. Set `afd.runner.url` and **Set Server Token**; the project is found from the repository's remote (or `afd.runner.project`), and the flow's launch configuration on the server is used. See [Ansible Flow Server](docs/guide/how-to/server.md).
  - The confirmation shows the commit the server runs and warns when your HEAD differs or you have uncommitted changes.
  - Check or real; Stop stops it on the server; approvals are decided from the canvas when the server allows you.
  - A server that speaks another API or does not read the flow's format is refused with the reason.
  - **Check My Work on Server** checks work you have not pushed yet, committed or not, as a dev run in check mode; your index and branches are not touched. See [Check your work before you push it](docs/guide/how-to/server.md#check-your-work-before-you-push-it).
- Approval nodes say who may decide them, who is told, and what they read: **Approvers**, **Notify** and **Message** in the node's Details, or `approval` in the flow file. Ansible Flow Server asks these people; in AWX the message becomes the approval's description. Changing who approves keeps the node tested. See [Approvals](docs/guide/how-to/approvals.md#who-decides).
- The collections a flow needs are worked out from its steps (every level, step and undo bindings), at least at the version a step chosen from the module catalog was made against; the project's `collections/requirements.yml` wins, and a step made against a version it does not allow is named. Agents see them in `flow_describe`; `@ansible-flow/core` has `flowCollections` and `mergeRequirements`. See [npm packages](docs/packages.md).
- `@ansible-flow/node` runs flows with approvals outside AWX: `runSegments` waits at each approval for a decision, and its step functions let a server wait between runs. See [npm packages](docs/packages.md#running-a-flow-with-approval-gates).
- Run mode shows approvals from any runner: waiting, then who decided, when, and their comment. Where the runner allows it, the node's Run tab has **Approve** and **Reject** with a comment.
- The extension's code is also published as npm packages, so other programs can read, check, generate and run flows the same way the extension does. See [npm packages for other hosts](docs/packages.md).
  - `@ansible-flow/core`: the flow model, commands, validation, code generation, run summaries and the designer's message protocol, for any JavaScript host.
  - `@ansible-flow/node`: layout, the probe client, the AWX client, the module catalog, SSH, and `runFlow`, the local run without VS Code.
  - `@ansible-flow/assets`: the Python probe, the run events callback and the JSON schemas.
  - `@ansible-flow/designer`: the designer for a web page. The page supplies a transport to its host and calls `mount()`; `viewer: true` shows and runs a flow without changing it.
- The packages carry the extension's version and are released with it. Before 1.0 any module may change; the guide lists the documented entry points.

### Changed

- A runner that waits for a person can send hosts that waited too long through the approval's `timeout` port. AWX workflows work as before: AWX cannot tell a timeout from a rejection.
- Local runs use `runFlow` from `@ansible-flow/node`. Run behaviour is unchanged.

### Fixed

- A run on `localhost` that is not in your inventory (Ansible's implicit localhost) counted no hosts: the run's host list and counts now include it.

## 0.84.0 — Inventory view: switches and editing

### Added

- **Switch Ansible Environment…** on the Inventory view's title: lists the environments your settings describe (a container image on this machine, each WSL distribution, the SSH host), marks the current one and offers **Set Up Another…**. A pick switches at once and keeps the other settings, so you can switch back. The view's title names the environment and the inventory. See [Switch between environments](docs/guide/how-to/runs-and-environments.md#switch-between-environments).
- **Switch Inventory…**: lists the inventories found in the repository (`hosts` or `inventory` at the root, `inventory/` and its files, each environment under `inventories/`), the `ansible.cfg` default, and **Browse…**. The pick sets the workspace's `afd.run.inventory`.
- The launch dialog shows "Runs in: … · Inventory: …", each with **Change**.
- Setting `afd.environment.sshImage`: the image used on an SSH host. When it is not set, `afd.environment.image` is still used there, so setups made with 0.83 keep working.
- The Inventory view and the inventory files stay linked. See [The Inventory view](docs/guide/how-to/runs-and-environments.md#the-inventory-view).
  - A click on a host, or **Open in Editor** on a host or a group, opens the line that defines it (YAML and INI). A host from a range (`sw[01:10]`) opens at the range.
  - The view lists the files the inventory is read from and their kind: YAML, INI, or dynamic (plugin or script, read-only).
  - Saving an inventory file, a file under `group_vars/` or `host_vars/`, or `ansible.cfg` refreshes the view.
  - **New Inventory…** creates an empty YAML inventory, makes it the workspace's inventory and opens it.
  - Lines Ansible cannot read in an inventory file (a host given its address as a value, a list where names belong, an INI word that is not `name=value`) are shown at the top of the view with the line and the correct form.
- Edit the inventory from the view:
  - Hosts and groups: **Add Host…** (with its address, `ansible_host`), **Add Group…** (title bar, top level), **Add Child Group…**, rename, **Move to Group…** for a host or a group (with its hosts, variables, child groups and comments), delete. **Set Address…** changes or clears a host's address.
  - Variables: a host or group lists its own variables and where each is defined (inventory file, `host_vars/`, `group_vars/`), with **Add Variable…**, **Edit Value…** and **Delete…**. Values are typed as YAML. A new variable goes to `host_vars/` or `group_vars/` when that folder exists, otherwise to the inventory file; you are asked when both hold variables.
  - Each change is a minimal edit of the YAML or INI file; comments, order and layout are kept. Moving a host moves its variables; renaming renames its variables file.
  - Not editable (opened as text): hosts from a range, dynamic sources, vault-encrypted values and files, YAML with anchors, the `all` and `ungrouped` groups, and files with unsaved changes.
- AI assistants: new `inventory` tool (Copilot `#inventory`, and the MCP server). See [AI assistants](docs/guide/how-to/ai-assistants.md#the-inventory).
  - `list`: the inventory's files, groups and hosts as written, and a host's or group's variables with where each is defined, plus the lines Ansible cannot read.
  - `edit`: ops applied all or nothing: `add_host`, `remove_host`, `rename_host`, `move_host`, `add_group`, `remove_group`, `rename_group`, `move_group`, `set_var`, `remove_var`, with the same rules as the Inventory view.
  - Vault-encrypted values, and values of variables whose names contain `password`, `passwd`, `secret`, `token` or `key`, are not shown.
  - Copilot asks before a change and lists each op without values. The MCP server reads and writes inside the repository only.

### Changed

- `afd.environment.image` applies to containers on this machine only.
- Environment and inventory switches write the workspace settings.
- Uninstall feedback: a notification at uninstall asks whether you want to say why; the form opens only from **Tell Us Why**. The browser no longer opens a page at the next restart. `afd.feedback.prompt` still turns both prompts off.

## 0.83.2

### Fixed

- `flow_scenarios` `verify` through the MCP server failed with "Set afd.environment.sshHost" in an SSH environment. The server now reads `afd.environment.sshHost` and `sshDir` from your user settings, and from the workspace's with `AFD_MCP_WORKSPACE_ENVIRONMENT=1`. See [Scenario tests](docs/guide/how-to/scenario-tests.md).

## 0.83.1

### Fixed

- **Set Up Ansible Environment…**: choosing an SSH host that has Ansible on its PATH no longer runs the image from your user settings on that host; the setup writes an empty image for the workspace. A host without Ansible is offered your image before the public one.
- Choosing Docker, Podman or a WSL distribution in a workspace that has an SSH host now writes the workspace settings. Before, the workspace settings hid the change and runs kept using the SSH host.
- The setup message shows the actual folder on the host (`~/.afd/<workspace>`).

## 0.83.0 — Remote Linux host over SSH

### Added

- SSH environment: `afd.environment.kind: ssh` with `afd.environment.sshHost` runs Ansible on a remote Linux host while the repository stays on your machine. **Set Up Ansible Environment…** offers it, lists the hosts of your SSH config and checks the host. See [A remote Linux host over SSH](docs/guide/how-to/runs-and-environments.md#a-remote-linux-host-over-ssh).
  - Before each run the repository is copied to the host as it is on disk (tracked files, and untracked files `.gitignore` does not exclude), so uncommitted work runs. After the first copy only changes are sent.
  - Runs with the host's `ansible-playbook`, or in an execution environment image with the host's Docker or Podman (`afd.environment.image`).
  - Supports skeleton and real runs with live results on the canvas, Stop Run, the launch dialog's host counts, lenses, the module catalog, partial runs and scenario verification.
  - Uses your SSH config, keys or agent; no password is asked for or stored. The vault password and secret inputs are sent on the connection's input, never as arguments.
  - Requires `ssh` and `tar` on this machine (included in Windows 10 1803 and later). One environment per workspace. The command-line scenario runner has no SSH option.
- **Copy a File to the SSH Host…**: copies one file (for example a vault password file) to the host, readable only by the account.

### Fixed

- Code mode again reports a role task file that only the role's `main` includes as "task not in design" when no step runs `main`. A file included by a step's own task file still counts as covered.

## 0.82.0 — Faster flow editing

### Added

- A **+** under a step whose main output is open opens Quick Add wired from that output. A hovered or selected wire shows a **+** that adds a step on it. See [Add, wire, move, delete](docs/guide/how-to/canvas-basics.md#add-wire-move-delete).
- Quick Add's Title field suggests matching step types, catalog modules and roles as you type, and the flow's modules while empty; a pick adds a step bound to it. Double-click on empty canvas opens Quick Add there.
- Drag either end of a wire to another node or port; release it on empty canvas to disconnect.
- Drag a step that stands free of any path onto a wire to insert it.
- Deleting a step reconnects its incoming wire to where the step led, when there is one answer, in the same undo step. Shift+Delete leaves the gap. **Detach from Path** takes steps out of their path and keeps them.
- Steps show the count of their errors and warnings; a click opens the first one in Details. A subflow counts the problems of its steps.
- F2, or a double-click on a title, renames a step in place.
- Ctrl+↓ and Ctrl+↑ follow a wire to the next or previous step; **Select Upstream** and **Select Downstream** select the whole path; Shift+2 zooms to the selection.
- Undo and redo show a message naming the change ("Undid: removed Validate, added 1 wire").
- A flow open as text has an Outline and breadcrumbs. Selecting a symbol or a problem in the text shows its node on the canvas.
- **Dissolve Subflow** moves a subflow's steps up to its level, where the subflow stood. See [Subflows](docs/guide/how-to/subflows.md).
- **Disable** (D) switches a step off and keeps it: hosts pass straight to the next step, no code is generated for it, and scenarios simulate the same. A decision with both branches wired cannot be disabled; a step reading a disabled step's output gets a warning. AI assistants use `update_node` with `disabled: true`; Find has `has:disabled`.
- Expand a subflow in place: an arrow on a subflow node shows its inner steps and wires on the current level, for reading only. `afd.canvas.expandSubflows` (on by default) removes the arrow.
- **Run from Here (Skeleton)** and **Run This Step (Skeleton)** on a top-level step run a trimmed copy of the flow; the flow's own code is not changed. A step reading a step left out runs as its stub, and the Run panel says which. See [Runs](docs/guide/how-to/runs-and-environments.md).
- The Run panel lists the local runs kept for the flow; pick one to show it on the canvas with each host's output. A run of an earlier flow version is marked.

## 0.81.0 — Jinja in fields

### Added

- Jinja colouring, in the theme's colours, in parameter values, list items, variables and facts, the Timing fields, Task keywords, and a decision's Condition and Until. See [Jinja in fields](docs/guide/how-to/binding-and-catalog.md#jinja-in-fields).
- Completion inside `{{ }}`, `{% %}` and bare tests: the step's and Ansible's variables (`inventory_hostname`, `hostvars`…), functions (`now()`, `lookup()`…), filters after `|`, tests after `is`, fields after `.` (a result's fields, string methods, `strftime` with ready formats), date codes inside `strftime('` and lookups inside `lookup('`. Filters, tests and lookups of the collections in the catalog are included. Ctrl+Space opens the list anywhere; Enter or Tab inserts, Ctrl+Z undoes.
- Inline help: the selected entry's signature and description, a live preview of date formats (`'%Y%m%d_%H%M%S'` → `20261112_101530`), argument hints inside a call, and hover help.
- Condition, Until, `assert` `that` and `debug` `var` complete as tests; `@` inserts a name without braces. Picking a variable that is not yet a step input adds it as one.
- `set_fact` lists its facts under **Facts**, one row each; lists and dicts are edited as YAML.

### Changed

- Smaller designer script.

### Fixed

- Typing `!` in a parameter field fitted the canvas (Shift+1), so `!=` could not be typed.
- The YAML box ended a string at `''` or `\"` and coloured the rest wrongly.
- `set_fact` with module docs loaded hid the facts, asked for `key_value` and reported each fact as an unknown parameter.

## 0.80.0 — Agents group long chains into subflows

### Added

- When a `flow_edit` batch grows a level past 8 steps (start and end not counted), the answer names the level and its steps in run order and suggests `extract_subflow`. Only edits that add steps to that level get the hint; it is not a problem and does not show on the canvas.

### Changed

- The skill, the MCP server's instructions and the Copilot instructions tell agents to put steps of one purpose (pre-checks, backup, change, verify, rollback) in a subflow instead of one long chain. The import guidance follows the same rule.

## 0.79.0 — Agents annotate flows

### Added

- `annotate` takes `around: [step keys]` and draws a section sized to hold those steps and their notes, as **Add Section Around** does.

### Changed

- Agent guidance says when to annotate: a note on a step for a reason you gave that the flow cannot show (a limit, why steps run in this order, a manual step, a runbook link), and a section around steps of one level that belong together but are not a subflow. On a format 1 flow, agents annotate only when asked. The [Notes, sections and text](docs/guide/how-to/annotations.md) page has a new AI assistants section.
- The README states that the feedback form page counts how often it is opened (page, version and editor; no cookie, no address; deleted after 400 days). The extension sends nothing itself.

## 0.78.0 — Checks and agent tools

### Added

- Warning `input-shadowed`: another step sets an input's name after its `from:` step, so the step reads that value instead.
- `accept` and `unaccept` take a list in `at`, with one reason.

### Changed

- Checks follow Ansible for variables set twice: a step that sets an input's own name (`set_fact` or `register`) counts as setting the input. A value created on one branch, with a default set on every path before it, no longer warns "may be undefined". Accepts made unnecessary by this show as stale.
- An open fail port on a step with `ignore_errors: true` or `failed_when: false` is info, not a warning.
- An imported playbook of several plays is named after the play with the most tasks.
- `flow_describe` with `layout: true` gives the layout check total near the top.

### Fixed

- The flow tools ignored `flow` as the name of the flow file (the name `source_outline` uses) and failed with two flows in the workspace. `flow` now works wherever `path` does.

## 0.77.0 — Feedback

### Added

- **Send Feedback…** (Command Palette and the designer's **…** menu) opens a short form in the browser. **Report a Problem…** opens a GitHub issue, with forms for a bug report or an idea.
- One notice after a week of use (three days with a flow in the designer, seven since the first) asks for a rating or a few words. **Not Now** asks once more later; **Don't Ask Again** ends it. It never shows together with another notice.
- After an uninstall, the next VS Code restart opens a short "why did you leave?" page once; not after **Don't Ask Again**, on a remote server or in CI.
- `afd.feedback.prompt` (default on) turns off the notice and the uninstall page. The README's "Feedback and privacy" section explains what happens to an answer. The extension sends no telemetry.

## 0.76.0 — Playbook import, checks and AI tools for large flows

### Added

- `flow.external_vars` lists variables set outside the flow at run time (AWX or Kestra extra vars, the inventory, a caller); steps read them without an input.
- Host facts `afd_failed_result`, `afd_failed_task` and `afd_failed_node` keep a failure, so a step on `failed_hosts` can report it. Imported rescue steps read them.
- `{{ afd_repo_root }}`, the repository root set by generated plays. A shared task file can write paths as `{{ afd_repo_root | default(playbook_dir) }}/…` to work from both the playbook and the flow; the import notes each file that needs this.
- Warning `binding-playbook-dir`: `playbook_dir` left in a binding.
- Named subflow exits (such as `dry_run_done`): each is a port on the subflow node, wired like `ok_hosts`. Extract into Subflow creates one when the selection leaves for two places. An end node inside a subflow ends the host's run.
- AI tools for large flows:
  - Every answer stays under 40,000 characters and comes in pages.
  - `flow_validate`: `summary: true`, filters by code, node and severity, the exact accept key after each warning, and whether `generated/` is current.
  - `flow_describe`: `nodes`, `detail: brief` and `only_problems`.
  - `source_outline`: ranges such as `#3,#9` or `#25-#37`, or `full: true`.
  - New ops: `rename` (several keys), `replace_text` (find and replace in bindings), `dissolve_subflow`, `regenerate` (rewrite `generated/` after an outside edit).
- **Show AI Integration Diagnostics** shows which server file each agent's registration starts, and whether it exists.

### Changed

- Import and the outline write every path next to the playbook, including script paths inside commands, from `{{ afd_repo_root }}`.
- An `include_tasks` in a loop, or of a file that includes itself, imports as one step bound to `include_tasks` with its vars, loop and when; its code keeps only the keywords Ansible allows on an include.
- Imported names are more readable: keys are cut at a word boundary, `{{ var }}` in a title reads `<var>`, the intent no longer repeats the title, and a one-task file becomes that step, titled by the include. Include vars stay only on the steps that read them.
- Flows imported earlier are offered updates for many steps on their next re-import.
- "May be undefined" accepts guards: a read behind an `is defined` test (in the step's `when` or a decision before it), or an input marked `optional: true`. The suggested fix no longer says "give it a default".
- A variable read only with `| default` or `is defined` is info, not a warning.
- `check:<code>` without a subject accepts every warning of that code on the step. An accept that matches no warning is refused; one that stops matching is flagged `stale-decision`.
- `flow_import` answers are much shorter (about 6,000 to 13,000 characters).
- Deleting a step removes subflow outputs that lifted it and clears `from:` of inputs that read it, with a note for each.
- Renaming an input also rewrites the step's keywords (`when`, `loop`) and a decision's condition.
- The import prompt and the skill suggest importing a playbook of more than about 40 tasks first and restructuring it.
- Auto layout uses the canvas's ports: decision labels no longer overlap, steps fed by `failed_hosts` stand right of the column they handle, and simple chains form one column.
- The AI layout check and `tidy_up` use `afd.canvas.direction`; the MCP server reads it from the workspace settings, then the user's.
- The MCP server's copy is replaced in one step at every start and includes the Ansible probe needed for scenario verification.
- The MCP server writes startup errors to its log and to `AFD_MCP_TRACE`.

### Fixed

- Generated playbooks run from `generated/`, so `{{ playbook_dir }}` pointed there and scripts next to the original playbook were not found.
- A rescue step reported "unknown error": Ansible's `ansible_failed_result` was gone by then.
- block/rescue/always imported the always steps twice, giving a fresh import errors and no generated code. Hosts that failed now run the always steps and then fail, as in Ansible.
- `meta: end_play` imported as a step that let hosts through; it is now an end node after a decision on its `when`.
- A node input's default now reaches the generated code.
- False unknown-variable warnings: `x is not skipped` reads only `x`; names a template sets itself (`{% set %}`, `{% for %}`) are not reads; a `set_fact` building its own value over a loop is fine; AWX `awx_*` and `tower_*` variables are known.
- An accept with a wrong key was saved and hid nothing.
- Agents set up before 0.69.1 could not start the flow tools (CONNECTION_CLOSED). At start the extension finds registrations of a server that no longer exists and offers to repair them.

## 0.75.0 — Agents in Cursor, Kiro, Antigravity IDE and Devin Desktop

### Added

- The built-in agents of Cursor, Kiro, Antigravity IDE and Devin Desktop (Windsurf) can design and change flows. These editors install the extension from [Open VSX](https://open-vsx.org/extension/chistokhinsv/ansible-flow-designer).
  - Cursor: the flow tools are registered through Cursor's extension API at each start, for the open folders. Nothing is written. The agent lists them as `extension-ansible-flow`.
  - Kiro, Antigravity IDE and Devin Desktop: the first time the designer shows a flow with a step, one notice offers to give the agent the flow tools and the `ansible-flow` skill, naming the files it writes. After **Set Up** they are kept up to date at each start. `afd.ai.hostIntegration` turns this off.
- **Set Up AI Assistants** supports Kiro, Antigravity IDE and Devin Desktop.
- **Show AI Integration Diagnostics**: reports how this editor and its agent can reach the flow tools (editor and runtime, how the MCP server would start, the agent APIs offered) and lists the MCP servers and skills each agent is configured with. Read-only; MCP entries are listed by name only.
- MCP server: `AFD_MCP_TRACE=<file>` logs starts, the client's name and roots, tool listings and calls (names only); `AFD_MCP_ROOTS` sets the folders to work in when the agent sends none.

### Changed

- Requires VS Code 1.94 or later (was 1.140). The module catalog needs 1.101 or later; in older editors it is turned off with a reason and binding checks have no catalog facts. Copilot's flow tools need 1.95 or later.
- Updating an MCP entry changes only its command, arguments and environment; other settings (such as Kiro's `autoApprove` and `disabled`) are kept. A skill copy written by a newer extension version is left alone.

### Fixed

- The MCP server searched the whole home folder when an editor started it without a folder (Cursor's global servers): `flow_list` took about 20 seconds and listed flows of other projects. It now answers "No folder to work in", and Cursor's entry from Set Up passes `${workspaceFolder}`.
- In editors that keep a file loaded after its designer closes, changes made while the flow was closed were marked as outside edits made just now, and old marks came back.

## 0.74.4 — Fixes and hardening

### Changed

- Faster editing of large flows: deleting 400 steps at once takes under a third of a second (was 14 seconds). Pasting many steps, Tidy Up, data-reference checks and exporting images of every level are faster too.
- Changing `afd.canvas.direction` redraws open designers at once.
- The version bump on save waits only briefly for Git, so a slow Git no longer makes VS Code drop it.
- Module catalog: a JSON file that is not a catalog dump is skipped; indexing stops after 5 minutes or when the window closes; a search uses its first 30 words.
- Copilot's scenario tool: **List** and **Check** no longer ask for confirmation; **Add**, **Update** and **Delete** say they change the scenarios file; **Verify** says it runs `ansible-playbook`.
- MCP errors show paths relative to the workspace, and the home folder as `~`.
- `afd-scenarios --junit` writes one XML document with a single `<testsuites>` root for several flows, without terminal colour codes.
- **Upgrade Flow Format** names the nodes that lose a manual tested mark.

### Security

- An `http://` AWX address is refused before the token is sent. Set `afd.awx.allowHttp` for a lab AWX without TLS; `localhost` needs no setting.
- `afd.awx.verifyTls` and `afd.awx.allowHttp` are read from user settings only. If you turned `verifyTls` off in a workspace, set it in your user settings. Turning it off shows a warning once per session.
- AWX requests have a time limit for the whole response, answers over 64 MB are not read, and paging that loops stops.
- The `afd-ee` image checks SSH host keys (set `host_key_checking = False` in your own `ansible.cfg` for a lab). Its base image and collections are pinned (ansible.netcommon 8.7.1, ansible.utils 6.1.1, cisco.ios 11.6.0). AWX runs are not affected.
- Designer messages are validated: **Open Code** opens files in the workspace folder (or a file the last code scan named), **Compare with** reads only listed versions, and the module docs lookup takes plugin names only.
- Scenarios run on this machine only: host and group names must be one inventory word, and scenario inputs cannot set `ansible_*` variables.
- Scenario run folders are private to you with `--python` and `--wsl`; with an image, others can read but not write them.

### Fixed

- Generate Code on save reports a failure in the status bar and the log; the result is shown after **Overwrite** too.
- Code mode runs a sync requested during another sync after it ends.
- Flow files opened from a Git diff or the Timeline no longer get a designer session, problems and layout.
- Resizing the side panel ends when the mouse button is released outside the designer.
- A step added and then removed by outside edits no longer counts as "1 step removed".
- draw.io and SVG exports leave out control characters XML does not allow; tabs and line breaks in labels are kept. Flow text with U+2028, U+2029, NEL or another control character is written quoted and escaped.
- A malformed scenarios file is reported as a problem instead of crashing. The command line ends with one line and exit code 2 for an unreadable flow file or a missing path. A flow file with too many YAML aliases is reported as unreadable.
- Input, output and register names Ansible cannot use (such as `retry-count`, or keywords like `in`, `not`, `true`, `class`) are problems on hand-written and AI-written flows too, and in the schema.
- Become user set without Become is generated into the play and applies when `ansible.cfg` or the inventory turns become on. Upgraded steps ran as root there. Become set to false turns both off.
- Removing several items from a flow-style `[a, b, c]` list in one edit failed with "overlapping edits".

## 0.74.3 — Fixes and hardening

### Changed

- Faster start: the workspace is scanned for flows once at start-up, skipping `node_modules` and `.git`; after a save only that flow is read again.

### Security

- Secret inputs and the vault password: their temporary files are removed however the run ends; their variables are unset once written, so `ansible-playbook` and what it starts never see them.
- Run events never contain secrets: the event callback removes the values as it writes, including parts of list or dict secrets and the vault password.
- A flow key that is not a lowercase slug, or an ID that is not a ULID, never names a file or folder; such a flow cannot write scenarios, run folders, run history or generated code until fixed (or Complete IDs is run).
- The module catalog leaves out a collection whose name or version would place its dump outside the cache.
- **Create Role** (Code mode) is offered only for a name that makes one folder under `roles/`.
- Import does not read `include_tasks`, `vars_files`, role names or AWX playbook paths that lead outside the workspace folder (through `..` or a link), and reads files up to 2 MB.
- The AI tools resolve links before writing a new file or an export, so a linked folder cannot lead outside the workspace; an export onto an existing link is refused.
- AWX in Restricted Mode: **Set Up AWX Template** and launching need a trusted workspace; importing still works. Set Up asks before attaching credentials the flow names and before changing a template of the same name that runs another playbook.

### Fixed

- A step title with `{{ }}` (such as "Install {{ item }}") stopped the run with "Error processing keyword 'name'". Titles, intents and reasons now show exactly as typed.
- Renaming a step inside a subflow, or its output, now updates the subflow output that lifts it.
- A new or renamed key that would make an existing `from:` read a different step is refused; a generated key gets a number.
- `max_fail_percentage` on a step inside a subflow counted hosts earlier steps had failed. The simulator counts the same way now.
- Decision conditions: `{{ x == 1 }}` works; `{{ x }} == 1` is a problem that explains the fix; spaces inside quoted strings are kept.
- A YAML alias inside what it names is refused instead of hanging the designer.
- Re-import keeps the order of several new consecutive tasks.
- `include_tasks` imports as Ansible runs it: its `when` becomes a decision before the file's subflow, its tags no longer reach the tasks inside, and its `apply:` does.
- Scenario simulation: a host pattern of only `!` or `&` terms starts from every host; a pattern naming `localhost` or `127.0.0.1` without an inventory entry asks for a check in Ansible.
- Code mode: a step bound to a collection role is no longer "role missing"; a role task file included by another covered file is no longer "task not in design".
- "Saving…" could stay forever: a failed designer action now returns its error, and an unanswered one ends after 2 minutes.
- Fast edits could be lost: designer commands run in order, and holding Delete or Ctrl+D acts once.
- After Revert or closing without saving, the Flows view and Problems no longer keep the unsaved text's problems.
- A move VS Code refused returns the node to its saved position.
- A designer behind another tab keeps its level, mode, lens, selection and unsaved binding.
- Stop Run in WSL ends the run's processes in the distribution. A scenario that times out on Linux or macOS ends `ansible-playbook` too.
- A vault password with backslashes works in WSL and in images whose shell is dash.
- Runs add the event callback to the `callbacks_enabled` and `callback_plugins` of your `ansible.cfg` instead of replacing them, so ARA, syslog or audit callbacks keep recording.

## 0.74.2 — Security fixes

### Security

- Scenario verification from the MCP server uses the environment of your user settings. Workspace `afd.environment.*` values are used only with `AFD_MCP_WORKSPACE_ENVIRONMENT=1`; `AFD_USER_SETTINGS` names the settings file. Scenario runs use an empty `ansible.cfg`. The `flow_scenarios` tool says that verify runs programs.
- **Remove AI Assistant Setup** and setup updates delete only files inside the skill folder; a linked folder or an unreadable manifest is left alone.
- A shared subflow's source must be a `.flow.yaml` in the same workspace folder, given by a relative path, at most 2 MB. Absolute and network paths are refused.
- Import refuses a playbook whose YAML aliases expand to more than 100,000 values.
- Generated code keeps values with U+0085, U+2028, U+2029 or control characters on their line or in quotes. A parameter named `$comment` or `$flow` is written as data.
- **Stop Run** removes the run's container. A timed-out scenario and a hung probe call remove theirs too.

## 0.74.1

### Added

- Published on Open VSX as `chistokhinsv.ansible-flow-designer`, for VSCodium, Cursor and other editors that use it. Each version also gets a GitHub release.
- The README shows recordings of the extension at work.

## 0.74.0 — Scenario tests in the Testing view

### Added

- The Testing view lists every flow with scenarios and runs them as **Check (simulated)**, the default, or **Verify in Ansible** (every step as its stub). A failing scenario points at the `expect` line of each host that ended elsewhere.
- The Hello and Edge baseline samples include scenarios; Open Sample Flow copies them.
- The first-flow walkthrough has a step "Test where hosts end".
- The scenario runner for CI runs in WSL with `--wsl` or `--wsl-distro NAME`.

### Changed

- The guide's Scenario tests page is rewritten around the canvas, the Testing view and the AI tools.
- The package is about 2 MB smaller.

## 0.73.0 — AI assistants and scenario tests

### Added

- Flow tool `flow_scenarios` for Copilot (`#flowScenarios`) and the MCP server: list and check a flow's scenarios in the simulation, add one by step key (expectations default to where the simulation sends each host), update one or take the new ends with `accept_ends`, delete one, and verify them in Ansible. A scenario that does not fit the flow is not written; its problems are returned instead.
- `flow_describe` reports the state of a flow's scenarios; `flow_validate` names a scenario the simulation fails.
- The `ansible-flow` skill has a scenarios reference and a worked example; the assistants' instructions say to check scenarios after a wiring change.
- The MCP server verifies scenarios in the environment your workspace's `.vscode/settings.json` sets (`afd.environment.*`, or the Red Hat Ansible extension's settings). Copilot runs Run Scenarios.

### Fixed

- The guide's scenario example forced the wrong step to fail; it now forces Push baseline.

## 0.72.0 — Scenarios on the canvas

### Added

- A **Scenarios** chip in the top bar shows their state ("Scenarios · 3 pass", "1 failing") or offers to add some, and opens the **Scenarios** tab in the side panel.
- **New Scenario**: a name and a number of hosts. It starts with every host where the flow sends it now, so it passes and guards that routing from then on.
- **Show on Canvas**, then right-click a step: "In <scenario>" offers Fail for…, Unreachable for…, Time Out for… or Unchanged for… with a host checklist; Take False for… on a decision; Approved, Rejected or Timed Out on an approval; Expect <host> Here on an end. The simulated run on the canvas updates as you choose.
- Each scenario row says what it plants ("Gate fails for h03"), where hosts now end, and the last Ansible run with its time, marked out of date when the flow or the scenario changed.
- **Accept New Ends**, **Verify in Ansible**, **Verify All**, **Undo**, and Rename, Duplicate and Delete on each row.

## 0.71.0 — Scenarios stay current

### Added

- Scenarios are checked and simulated shortly after you change a flow or its scenarios file, even when the file is not open. Problems shows a host the simulation sends elsewhere on its `expect` line, a failing scenario on the flow (`scenario-miss`), and a note on a scenario the simulator can only approximate.
- Run Scenarios results are stored per flow with their time. A result is out of date once the flow's routing or that scenario changes.

### Changed

- Renaming a step, an end or a subflow, or extracting steps into a subflow, updates the key paths in the scenarios file in the same edit, from the designer, Copilot's flow tools and the MCP server. The designer saves the scenarios file with the flow.

## 0.70.0 — Scenario simulator

### Added

- A scenario simulator works out where each host of a scenario goes without running Ansible, in milliseconds. It covers forced stub outcomes, `max_fail_percentage`, decisions, approvals, branches and joins, and `inventory_target`. It names what it does not model (a host pattern among the hosts, a regex or slice in an `inventory_target`, Jinja a stub run renders, `serial` with `max_fail_percentage`); run those scenarios in Ansible.
- Command line: `node afd-scenarios.js --simulate flows` needs no Ansible and skips scenarios the simulator cannot model (JUnit `<skipped/>`); `--check` checks the files only; `--help` lists the options; an unknown option is named; a folder without scenarios says so.
- Scenario file checks: a `force` that is not a list, an expectation on a wired port and an approval choice the approval has no port for are errors (`timeout` is allowed when the port exists). A host without an expectation is a warning; warnings no longer stop a run.

### Fixed

- A flow with two host-list inputs read its scenario hosts from the first one instead of the one marked as the targets.
- A scenario run stopped every host at a step that runs on its `inventory_target` when the step's output comes from its result.

## 0.69.1

### Changed

- New teal icon, Activity Bar glyph and Marketplace banner.
- The publisher is `chistokhinsv`; the extension ID is `chistokhinsv.ansible-flow-designer`. A VSIX installed under the old `afd-dev` ID is a different extension to VS Code: its stored AWX token and remembered flows do not carry over.
- The source is public at [github.com/ChistokhinSV/ansible-flow-designer](https://github.com/ChistokhinSV/ansible-flow-designer).
- A shorter README with the main features and screenshots; requirements, settings, the repository layout and building from source moved to `docs/details.md`.

## 0.69.0 — Timing values set at run time

### Added

- Retries, Delay and Timeout take an input: type `@` (or press the @ button) and pick a step or flow input that holds a number. Picking a flow input adds the step input in the same edit. The flow keeps `retries: "{{ drain_tries }}"`, rendered by Ansible before the task runs.
- **Ask at Run Time…** under each of the three fields creates an integer flow input (with the field's value as default), the step input that reads it and the field's template, in one edit. The value is set in the launch dialog or the AWX survey.
- The Timing sentence reads templated values with their defaults ("Tries up to drain_tries + 1 times (13 with its default 12)…"); an expression is "worked out at run time". It also says that a try running over its Timeout ends the step.
- Checks: `setting-unknown-var` (a template reads something that is not a step input) and `setting-input-type` (an input that holds no number). An approval's timeout must stay a duration (`timeout-unreadable`).
- Flow tools: `ask_at_run_time`; the schema accepts a template for `retries` and `delay`. Designers before 0.69 show a schema error on a flow that uses one.

### Changed

- Renaming an input renames it in Retries, Delay, Timeout and Until.
- Imported playbooks keep a templated `retries`, `delay` or `timeout`, and the imported step gets the inputs it reads.

### Fixed

- Until did not follow an input rename.

## 0.68.2

### Changed

- The Timing sentence counts the first try: Retries 12 is "Tries up to 13 times (once, then 12 retries)", and Until alone is 4 tries (Ansible's default of 3 retries). The Retries hint, a polling step's badge and the guide say the same.
- With a Timeout, the Timing sentence ends with the longest the step can take ("the step takes at most 8 min 30 s in all").
- Delay takes a duration like Timeout (`10s`, `1m`, `1m30s` or seconds); it is saved as seconds and shown as `10s`.
- A step's Run tab row for a failure the scenario planted adds where the host was expected when it missed.
- A step put on a wire by an outside change is listed as one change ("Added Check the health probes pass, in Drain the balancer, after Move the VIPs to the peer"). Wire lines name their steps by title.

## 0.68.1

### Changed

- A field of a result is one chip: `{{ read_version_result.stdout }}` shows as one chip, also when written by hand or by an AI assistant.
- The @ list offers a result's documented fields (stdout, stdout_lines, rc…) with the docs' first sentence, after you pick the result, type `.` after its chip, or type `@read_version_result.std`.
- The @ list fits a narrow panel: rows wrap, long names break, and the arrow keys keep the active row in view.

### Fixed

- The @ list offered only a step's whole result, and `.stdout` typed after its chip stayed text outside the braces.

## 0.68.0 — Data in and out

### Added

- Warning `input-unfed`: a step input with no `from:` and no default. The message says where the value is (the step that registers it, or the flow input of that name). The Data lens flags it too.
- The @ list offers an upstream step's result; picking it makes it an output of that step and an input of this one.
- Flow inputs have a **Default** in the flow panel. A new input starts as required; a default makes it optional.

### Changed

- Keeping a flagged become asks for a reason: the Access lens finding and the step's Privilege fold offer **Accept with Reason** first.

## 0.67.0 — Scenario results say why

### Changed

- A failure the scenario planted says so ("lab-fw-36: the scenario forces Check the HA pair is in sync to fail for it (force: failed), so it leaves by failed_hosts"); a step's Run tab says "Forced by the scenario (failed)". Other failures keep the run's own message.
- A miss says where and why ("lab-fw-36 ended at Stopped; the scenario expected Reported to SecOps, because the scenario forces …"), with the same words in the run panel, the notification, the log and JUnit.

## 0.66.0 — Outside changes in words

### Added

- Under the note about outside changes, a list says what each change was ("Added …", "Renamed … to …", "Copy the image: binding changed (msg)", "Wire removed: …"). A line shows its step; a changed step's tooltip and Details say it too.

### Changed

- An outside edit that only removes a wire or changes the flow's goal or inputs is marked as well.
- While a flow has outside-change marks, the Changes lens compares with the flow as you last had it open, not with HEAD. Compare with still offers HEAD and commits.

## 0.65.0 — Execution tab

### Added

- Folds say what they hold ("Timing: timeout, retries, until, delay · 2 set"). On a step bound to a module, Timing is open until you close it.
- A sentence under the Timing fields says what the generated task will do ("Tries up to 10 times, 15 s apart, until …; each try at most 15s").
- Until offers the result's fields from the module's returns and shows an example. Warning `until-whole-result`: a test that compares the whole result with a value.
- Timeout takes `30s`, `15m` or `1h30m`; an unreadable timeout is a warning (`timeout-unreadable`) instead of being dropped silently.
- Task keywords have their own fold, with buttons for when, loop, no_log, ignore_errors, delegate_to, run_once and changed_when.
- YAML fields colour keys, strings and comments, underline the line with a YAML error as you type, keep the indent on Enter, indent after `loop:`, and continue or end a list.

## 0.64.3

### Fixed

- The @ button inserts at the cursor, or in place of the selected text, instead of at the end of the value.
- The side panel's edge can be dragged along its whole length when the panel is scrolled.
- A module's Returns and badges wrap, so the panel no longer scrolls sideways.
- The tip on selecting several steps lines up with the text above it.

## 0.64.2

### Fixed

- Input descriptions typed in the flow panel, or set by an AI assistant, were not saved. Emptying the box removes the description.

## 0.64.1

No user-facing changes.

## 0.64.0

### Changed

- In Run mode, a step's Details start with **‹ Run Results**, back to the run's list.
- **Output** in a step's hosts table is an icon button.
- The step preview card waits while the pointer is on a port, so port labels stay readable.
- **Stop Flow** is one of the failure banner's buttons.
- A palette click adds the step after the selected step, wired (onto its wire when it has one), or onto Start → Done in an empty flow.
- A step's Details explain how to select several steps, on a level with three steps or more.
- A step's lens findings sit under the Details tabs, so the tabs do not move.

## 0.63.0 — Launch dialog and input descriptions

### Added

- A flow input can have a `description`, edited under each input in the flow panel. The launch dialog, run prompts and the AWX survey show it; Set Up AWX Template writes it to a survey it created.

### Changed

- Inventory group buttons show their host count ("lab · 4") and list the hosts in the tooltip.
- The dialog's buttons stay at its bottom; only the fields and facts scroll.
- A skeleton run starts with no hosts when the inventory has groups: pick a group or type host names. Without groups it still starts on `localhost`. The last values are remembered.

## 0.62.0 — Scenario results in words

### Changed

- The run panel names ends by their titles ("lab-rt-14 ended at Stopped; the scenario expected Reported to NetOps"), and an end node's table names where each host ended.
- The notification names the first miss.
- A planted failure reads "the scenario fails it in <step>" instead of the stub's TODO text; the step's Run tab says "the scenario fails it here".
- The log, the command line and JUnit give titles with the scenario-file keys in brackets.

### Fixed

- A host that dropped out of the run passed `expect: stopped` when the flow has an end keyed `stopped`.

## 0.61.0 — Workspace state

### Added

- The Problems panel lists every flow in the workspace, checked in the background after start-up; an open flow adds its binding checks. `afd.problems.scope: open` keeps the old behaviour.
- A generated playbook edited by hand is reported in Problems, with **Open the Flow** as a quick fix.
- The flow panel says what other flows need ("In this workspace: 1 flow with errors, 1 with code edited by hand: Flows View").
- Find says what a filter lists ("4 steps not implemented yet").

### Fixed

- The Flows view shows a root per folder in a multi-root workspace.

## 0.60.0 — Changes while a flow was closed

### Added

- When you open a flow again, the steps and wires changed since the designer last showed it are marked, whatever made the change (an agent, a text editor, a Git pull or checkout), and the note gives the time. The last-shown state is kept per workspace and forgotten after 90 days without opening the flow.

### Fixed

- A save's own edits (the version bump, a tested step going back to implemented) are no longer counted as outside edits.

## 0.59.3

### Fixed

- Lens rows for steps inside subflows always say where the step is, so rows no longer shift under the pointer after a click.
- Hovering a row for a step inside a subflow highlights that subflow.
- The launch dialog counts the hosts as soon as a host list reads, instead of waiting for every required input.

## 0.59.2

### Changed

- The flow panel's **Flows View** link moved next to the Readiness counts.

## 0.59.1

### Added

- Find filter `has:no-binding` lists the steps not implemented yet, on every level; `status:draft` also lists subflows that contain such a step.
- The flow panel links to the Flows view.

## 0.59.0 — Arrange steps

### Added

- **Align Centers** and **Distribute Vertically** (Shift+Alt+A, Shift+Alt+D) for selected steps; **Arrange ▸** in the selection's menu also aligns edges and spaces horizontally. Each is one undo step.
- Guide lines while dragging show shared edges and centres and snap the step to them; "even gaps" shows between neighbours.
- **Reset Position** returns a step or a selection to automatic placement.
- A palette step dropped on a wire goes into it.
- The flow panel explains how to select several steps.

## 0.58.0 — Lens findings in a step's Details

### Added

- With a lens on, a step's Details show its findings with the same fixes and **Accept with Reason…** as the lens tab. **Next Finding** goes to the next open one.
- A finding for a step on another level names its subflow or "on the top level".

### Changed

- After a fix, the lens tab moves to the next open finding, and it keeps its scroll position.

## 0.57.0 — Find filters and the Flows view

### Added

- Find filters `status:draft`, `type:approval`, `open:fail`, `has:errors`, `has:binding`, `tag:` and `target:` list matching steps on every level, alone or with words; two values of one filter mean either. The Find box offers and completes them.
- Readiness counts in the flow panel open Find with their filter.
- A task without a module, role or playbook says "Not implemented yet" on its card.
- The Flows view groups flows by folder and shows each flow's errors, warnings and code state (out of date, edited by hand, not generated), with **Run as Skeleton** and **Peek Code**. It honours `files.exclude`.

## 0.56.0 — Outside edits are marked

### Added

- When an agent, a command line, a Git checkout or another extension changes an open flow, a note says what changed, and the changed steps and wires get a dashed outline (thin on a subflow with a changed step inside). **Show** highlights them; **Clear** removes the marks. Your own edits are never marked. The legend explains the outline.

## 0.55.0 — Scenario results on the canvas

### Added

- After Run Scenarios, **Show on Canvas** opens the first failing scenario in Run mode, with hosts per port and per wire.
- The run panel lists the scenarios with pass or fail and each host that ended elsewhere; **Back to Last Run** restores the last run.
- In a scenario, an end node's Run tab lists the expected hosts and the hosts that came.

### Changed

- The scenario notification is one line: how many failed and the first one's name, with Show on Canvas and Show Log.

## 0.54.0 — Lenses and the Inventory view

### Added

- With a lens on, a line over the canvas names it and what it shows, or why nothing on the level has anything for it. The Inventory lens without flow targets offers **Set Targets…**.
- In Code and Run modes, a line over the canvas says what the mode shows and that the graph is read-only there.
- **Inventory** view in the Ansible Flows Activity Bar container: groups and hosts read in your Ansible environment, with host counts. **Run Flow on This Group…** opens the launch dialog with it as the targets.

## 0.53.0 — Launch dialog

### Added

- **Run as Skeleton** and **Run for Real…** in the designer (also Ctrl+F5) open one launch dialog with every flow input, its type and its last value or default.
- Lists are read as comma-separated values or JSON, dicts as `key: value` lines or JSON; the dialog shows how each reads and names text that does not read before anything runs.
- The inventory's groups are buttons under a host list; the dialog counts the matched hosts and lists those not in the inventory.
- A real run's confirmation is in the dialog. Just before the run, hosts are counted again; if the inventory answers differently, nothing runs and the dialog reopens.
- Secret inputs and the vault password are typed in the dialog, sent once and never kept.

## 0.52.0 — Live local runs on the canvas

### Added

- The canvas follows a local run: the running step has a pulsing outline and reads "running…", and steps show their hosts as they finish, about every half second. Reduced motion and Windows contrast themes are respected.
- Starting a run from the designer switches it to Run mode; the top bar names the running step.
- The terminal stays in the background while the designer is open, and comes forward when the run did not start, produced no events or failed before its first step. **Show Terminal** brings forward the run's terminal.
- After 20 s without events, a notification and the top bar say so, with Show Terminal (a slow step, or a prompt such as an SSH host key question).
- **Output** on a host in a step's Run tab shows what each task printed for it (msg, stdout, stderr, changed, return code); `no_log` tasks say their output is hidden.

### Security

- Secret input values are replaced in the run's events, live and kept.

## 0.51.0 — Binding tab

### Changed

- Once a step has a module, role or playbook, the Binding tab starts at **Configure**, with **Change module** and **About** folded below. **Change module** opens by itself when the bound module is missing, removed, moved or deprecated. **Expand** shows the three side by side.
- Configure groups the parameters as Required and Optional.
- **Add a parameter** searches by name, alias or description, with keyboard navigation.
- **Full Docs** is at the top of About.
- Hiding the side panel or opening the lens tab asks first when a binding change is not saved; turning a lens on keeps the Details open.
- The side panel's edge shows a grip.

## 0.50.1

### Fixed

- Ctrl+V into a module's parameter field dropped the pasted text. It now lands at the caret or over the selection, as one line.
- Guide pages opened with **Ansible Flow: Open User Guide** or a "?" link showed broken images in the Markdown preview.
- The extension's page in the Extensions view showed a broken image; the packaged README leaves out the screenshot and guide links and says where the guide opens.
- Run Scenarios wrote Ansible's colour codes into the Ansible Flow log as text. Terminals and the CI command line keep the colours.

## 0.50.0 — WSL as an Ansible environment

### Added

- On Windows, runs, the module catalog, Code mode and lenses can use Ansible inside a WSL distribution (WSL 1 or 2), without Docker or a Remote window. Set `afd.environment.kind` to `wsl` (and `afd.environment.wslDistro`, or leave it empty for WSL's default), or pick the distribution in **Set Up Ansible Environment…**. The repository stays on Windows; the vault password and secret inputs travel only in environment variables.
- The guide covers keeping SSH keys inside the distribution, naming the distribution when Docker Desktop is WSL's default, and antivirus HTTPS inspection breaking downloads in WSL 1.

### Changed

- Ansible installed with pipx in WSL works: the extension uses a login shell's PATH and the Python from the first line of `ansible-playbook`; `afd.environment.python` still overrides it. Commands reach the distribution unchanged (`wsl.exe -e`), so values with quotes or spaces arrive intact.

## 0.49.0 — Docs and samples for newcomers

### Added

- **Hello, Ansible** sample, first in Open Sample Flow…: three steps bound to builtin modules, every failure handled, no problems, runs on `localhost` as a skeleton.
- Guide page "How flows work": hosts travel along wires, a step is a play, how failures end, what a skeleton run is.
- The glossary covers the designer's terms, and the guide's index links it.

### Changed

- Tutorial 1 shows a playbook after two steps, the failure question and a skeleton run on `localhost` in about ten minutes; subflows moved to Tutorial 2.
- The README starts with a first flow in three steps; the full feature list moved to the guide (Reference › Features).

## 0.48.0 — Guided first flow

### Added

- A first-flow checklist over the canvas (flows with one to five steps): add a step, see the playbook, decide what happens on failure, run as a skeleton. Each item ticks as you do it; **Show Me** does it or opens where it is done. Hidden once, it stays hidden ("…" › Show First-Flow Checklist brings it back).
- **Ansible Flows** in the Activity Bar: the workspace's flows, New Flow and Refresh, with start actions when there is no folder or no flow.
- "?" links beside the Details tabs, the failure patterns and the Run, Design vs code and lens panels open the related guide page.
- Walkthrough progress and the checklist are kept between sessions.

### Changed

- The AI assistant setup notice appears the first time the designer shows a flow with a step, not at start-up; **Set Up…** previews what it writes.
- The walkthrough "Design your first Ansible flow" has six steps matching the checklist.
- Launch in AWX, Set Up AWX Template and Clear AWX Token appear in the Command Palette once an AWX address is set; Remove AI Assistant Setup… once there is a setup.

## 0.47.0 — Calmer first screen

### Changed

- The open-port banner asks what should happen when a step fails, with the first fixes as buttons, **Other Choices** and **Next**. The problem says the hosts would fail the run.
- Port tooltips, menus, the Ports tab, Quick Add and the Legend explain each port in plain words.
- The flow panel shows the name, goal and inputs; other fields are under **More details**. Readiness shows once there is a step.
- The palette shows Task, Subflow, Decision and Approval, with the other node types folded; failure patterns appear once a step can fail.
- The top bar: during a run, Run as Skeleton becomes Stop; the exports moved into "…"; the Lens dropdown appears once the flow has a step.
- Quick Add folds Extra ports, names what its button adds, and marks Intent optional.
- Execution tab groups are folds that say how much is set.
- A selected wire shows which hosts take it, with Insert, Rewire and Disconnect.
- Inputs describe `from` in words; "req" reads "required"; a node's ID is under More details.
- The minimap never covers a step: it moves to a free corner or is shown with a Mini Map button.

## 0.46.0 — First-hour dead ends

### Added

- **Set Up Ansible Environment…**: a run with no environment (native Windows without an image) offers the setup, which finds Docker or Podman and proposes the public Ansible dev tools image (`ghcr.io/ansible/community-ansible-dev-tools`), or reopens the folder in WSL, then offers the run again.
- A first skeleton run suggests `localhost` for the hosts.

### Changed

- Add Next Node (N) after a step whose `ok_hosts` already leads on inserts the new step on that wire.
- The Execution tab shows the settings the code uses for decisions, approvals, parallels, joins and subflows; a setting that does nothing there is shown with "Not used on a … node: clear it."
- Peek Code on an unsaved flow offers Generate Code; New Flow and Open Sample Flow without a folder offer Open Folder….
- Mode and lens tooltips say what each is for; smaller wording fixes.

### Fixed

- The Details stayed blank after adding a step with Quick Add until another node was clicked.
- Quick Add and the AI tools offered the unbuilt `undo` and `cancelled` ports.
- The missing-environment error was shown twice.

## 0.45.0 — Wires route around steps

### Changed

- A wire that would cross a step goes around it, on the canvas and in draw.io, SVG and PNG exports. Wires into one port share their last stretch, and labels sit where they cover no step.
- After Tidy Up (and `tidy_up`), no wire runs through a step.

## 0.44.0 — Layout check for AI assistants

### Added

- `flow_describe` with layout lists, per level, wires through steps, labels on steps or other labels, overlapping steps or notes, and crossing wires. Edits that place steps check the levels they laid out.
- An AI import checks the layout and moves steps until no wire runs through one.

### Changed

- `tidy_up` is described as placing steps, not wires.

## 0.43.0 — Easier sections

### Added

- Sections have a title bar with a grip; dragging it moves the steps inside.
- **Add Section** with steps selected (palette, or right-click › Add Section Around) draws the section around them.

### Changed

- A palette click places a new annotation in free space near the middle of the view.

### Fixed

- Resizing a note, section or text right after editing its text snapped it to the smallest size.

## 0.42.1

### Fixed

- The Details, Run and lens panels lost the lines between their sections in 0.41.0.

## 0.42.0 — Annotations in exports, reviews and code

### Added

- draw.io diagrams and images include notes (tied to their steps in draw.io), sections and text.
- The Changes lens outlines added or changed annotations and lists removed ones.
- A note on a step becomes `# Note:` comments above that step's play in the generated code; the flow's version does not change.

## 0.41.0 — Annotations on the canvas

### Added

- Notes, sections and text on the canvas (format 2), from the palette's Annotate group, the canvas menu, a node's menu (Add Note to This Node) or Shift+N. Double-click, Enter or F2 edits the Markdown in place; Ctrl+Enter saves, Esc cancels.
  - A note on a node is tied to it by a dashed line and moves with it; a section is dragged by its title and carries the steps inside it; text comes in three sizes.
  - Their panel sets text, colour, size and the node a note is on (Attach to Node…, Detach from Node).
  - Links open in the browser; Find searches their words; … › Hide Annotations hides them. They never change the flow's version.

## 0.40.0 — Annotations in the flow file

### Added

- Format 2 flows can hold notes (Markdown), notes on a node (moved, copied, extracted and deleted with it), sections (titled regions that carry their contents) and text, under `annotations:` on each level. They never run and do not change the version or tested steps. Multi-line text is written as a YAML block. Complete IDs completes hand-written annotations.
- AI tools: `annotate` and `update_annotation`; `delete` and `move` take annotations; `flow_describe` lists them by key (`note-1`, `fix-ntp/note-1`).

### Changed

- Info-level problem counts say `info` instead of `note(s)`.

## 0.39.1

### Fixed

- A shared subflow copied from a format 1 flow is copied as format 2, so legacy ports and field names no longer land in the copy with warnings that could not be cleared. The source file is not changed.

## 0.39.0 — Re-import from source

### Added

- **Re-import from Source**: a flow imported as is takes the playbook's later changes and keeps yours. Steps only the playbook changed take its version; steps both changed are conflicts that keep yours unless you pick the playbook's; new tasks become steps after their predecessor; a step whose task is gone stays, with warning `import-gone`. A preview lists the merge, applied as one edit. Imported steps record their task (`origin`); flows imported earlier need a new import first.

## 0.38.0 — Shared subflows

### Added

- **Insert Shared Subflow…** copies a subflow of another flow in the workspace, pinned to that flow's version (format 2). The copy is edited in its source; **Update Shared Subflow** brings a newer version (also as a quick fix). A copy changed locally is flagged; **Unlink Shared Subflow** makes it the flow's own.

### Changed

- The Changes lens reads branches through the Git extension's newer API.

## 0.37.0 — AWX surveys from flow inputs

### Added

- **Set Up AWX Template** writes the template's survey from the flow inputs: host lists as comma-separated text, text, whole numbers, secrets as passwords; booleans, lists and mappings stay extra variables. A survey changed in AWX is kept unless you choose **Replace Survey**.
- The generated start play takes the targets input as a list or as comma-separated text.

## 0.36.0 — Scenario tests

### Added

- `<flow key>.scenarios.yaml` next to a flow defines scenarios: inputs, outcomes to force on chosen hosts and steps, and where each host must end. **Run ▾ › Run Scenarios** runs them with every step as its stub on local hosts and reports which pass; the Problems panel checks the file against the flow.
- **Copy Scenario Runner to Repository** puts the CI command line into `.afd/afd-scenarios.js` (`--image`, `--junit`, exit code 1 on a failure).

## 0.35.0 — Compare with Git

### Added

- The Changes lens compares the flow with HEAD, a branch or a commit, node by node: chips on changed and added nodes, a change count on subflows, removed nodes shown as ghosts, and a list of every changed, added and removed node, wire and flow field. A selected node's Details show its field changes. **Compare with** picks the version.

## 0.34.1

### Fixed

- Complete IDs failed with "overlapping edits" on wires written as one flow mapping (`- {from: {…}, to: {…}}`); this affected the quick fix, the AI tools and paste. Edits to a flow mapping keep its spacing, and a value with a comma or bracket is quoted.

## 0.34.0 — Rolling subflows

### Added

- **Rolling batch** on a subflow (a number or a percentage like `25%`) runs its hosts through every step inside in batches, in one play with `serial`; hosts take the same ports as before. Steps that need plays of their own (nested subflow, approval, parallel, join, playbook binding, `inventory_target`, or their own serial or max_fail_percentage) are reported as `rolling-unsupported` and run play by play. The level shows a `rolling, N at a time` chip.

## 0.33.0 — Undo steps for rollback

### Changed

- The Rollback pattern builds a Rollback subflow with one undo step per completed step on the level, newest first, starting with the failing step; a step with an `undo` binding gets its undo step bound to it. Later failure ports reuse the same Rollback.

### Removed

- The `undo` and `cancelled` ports, which never routed hosts. A flow that has one shows warning `legacy-port`; Upgrade Flow Format removes them with their wires. A node's `undo` binding stays.

## 0.32.0 — Step outputs kept apart

### Changed

- Each step's outputs are copied right after the step into `afd_<key>__<output>`, and readers read that copy, so two steps setting `version` no longer overwrite each other. The flow file does not change.
- A register name another step also registers, or that a flow input names, is the error `register-collision` where it is read (was the warning `output-name-collision`).

## 0.31.0 — Privilege, AWX runtime and patterns

### Changed

- Become and become user set on a subflow apply to the steps inside (format 2); the nearest setting wins and a step can turn it off. **Become user** is a setting under Execution › Privilege instead of a task keyword. Upgrade Flow Format moves it and lists the subflows whose become now applies inside.
- AWX credentials and the execution environment belong to the flow (`flow.runtime`, format 2). Set Up AWX Template uses them or records what you pick; the AWX import writes them there; the upgrade moves the ones nodes named, which were never applied. The Access lens shows them.
- The Retry pattern sets Retries 3 and Delay 10 s on the module step itself instead of adding a placeholder step; hosts that still fail leave by the same port. Offered on `failed_hosts` and `timeout` of module steps only; renamed from Retry with Backoff.
- `handler` is renamed `purpose` (format 2), shown as **Purpose in failure handling**; the upgrade renames it. AI tools accept `handler` for one more release.
- Format 1 flows generate what they always did.

### Removed

- The serial chip on subflow levels.

## 0.30.0 — Accept warnings with a reason

### Added

- **Accept…** next to a warning in a node's Details, or **Accept with Reason…** in the Problems panel (format 2): the flow records why and the warning stops showing for that node and variable.
- AI tools: `accept` and `unaccept`; `leave_open` and `reopen` still work for one release.

### Changed

- Open ports, drift items, lens findings and warnings are all `kind: accepted` in format 2, keyed by what they accept (`port:`, `drift:`, `lens:`, `check:`). Upgrade Flow Format converts format 1 kinds.
- The import's `binding-unknown-var` for variables from `group_vars` can be accepted once.

## 0.29.0 — Status follows content

### Changed

- In format 2, a step's status follows its content: a binding makes it implemented, inputs or outputs make it specified; a decision is implemented by its condition; an approval, parallel or join as it is; a subflow is as far as its least finished step. The designer, the AI tools and MCP set the same statuses. Details › Lifecycle shows the status with **Mark Tested…** and **Clear Tested**.
- Tested keeps its evidence on the node: the run (id, flow version, commit), or the reason, author and time for Mark Tested…. A design change removes both.
- The runtime is derived from the flow in format 2: AWX when a template is named (a workflow when approvals split it, else a job). Set Up AWX Template writes only the template.
- Upgrade Flow Format aligns statuses, turns tested into records and drops `runtime.kind`; the banner lists these changes first.
- Format 1 flows work as before.

## 0.28.0 — Flow format 2

### Added

- Flow format 2: new flows, imports and samples use `schema_version: 2`. Format 1 flows stay readable and are not changed on open.
- **Upgrade Flow Format** (banner on a format 1 flow, Command Palette, or AI op `upgrade_format`) moves a flow to format 2 in one undoable edit, keeping comments and layout.
- An edit that needs format 2 says so and how to upgrade.

### Removed

- The command ids from before 0.25 (`afd.validate`, `afd.generate`, `afd.runSkeleton`, …). Keybindings or links that use them need the `afd.<area>.<verb>` ids.

## 0.27.3 — Navigation and onboarding

### Added

- **Find a node** (Ctrl+F, also in "…" and the canvas menu) searches every level by title, key or binding; results name their subflows; arrows and Enter open one.
- With nothing selected, Run mode's panel lists the steps where hosts failed, on every level.
- The palette folds to icons, with the legend under **? Legend**; the side panel folds to a strip. Both are remembered.
- An empty flow shows a card with **Add a Step**, **Import Ansible Playbooks…**, **Import AWX Workflow or Job Template…** and **Open Sample Flow…**.

### Changed

- Revealed nodes are centred, also on another level.

## 0.27.2 — Keyboard and accessibility

### Added

- Tab reaches the selected node's ports; Enter or Space opens a port's menu.
- While connecting, Tab or the arrow keys pick a target node and Enter wires it.
- Keys: N adds a node, Enter opens a node's Details (a subflow still opens), Ctrl+A selects the level, Shift+1 fits it, Alt+1/2/3 switch modes. The cheat sheet lists Redo.

### Changed

- Dialogs take and trap focus and return it on close; the arrow keys switch Details tabs.
- Screen readers announce a node's type, title, status and open fail ports; failure patterns state their requirements on screen.

## 0.27.1 — Designer messages

### Added

- Messages over the canvas (info, success, error), stacked, each with ×; errors close after 9 s, others after 4 s. Screen readers announce errors at once and others politely.
- **Saving…** shows while an edit waits for VS Code longer than 250 ms.
- A file with YAML errors shows a read-only banner naming the error, with **Open in Text Editor**.

### Changed

- Generate Code, Check Flow and Tidy Up report in the designer instead of a VS Code notification; from the Command Palette they still notify.

## 0.27.0 — One toolbar

### Changed

- The same toolbar in every mode: **Run as Skeleton** (with **Run for Real…** and **Launch in AWX** under its arrow), **Stop**, **Generate Code**, **Export** ▾ and "…". Unavailable actions are greyed out with the reason in the tooltip. **Re-sync from Git** is at the top of Code mode's panel.
- Code mode is read-only for the graph, like Run mode; bindings stay editable. The palette shows in Design mode only.
- A lens no longer replaces the panels: the palette stays, and the right panel gets a **Lens** tab.

## 0.26.1 — Details content

### Added

- **+** on a row of the module docs adds that parameter to the form.
- A node's problems are listed at the top of its Details, each opening its tab; fields show their problems underneath, and tabs with problems are marked.
- Marking a node tested by hand asks for a reason, recorded with your Git user name and removed when the node's design changes.

### Changed

- Execution is grouped into Targeting, Privilege, Timing and Tags.
- Task keywords stay visible when they cannot apply, disabled with the reason.

## 0.26.0 — One Details panel

### Changed

- A selected node's Details are docked on the right in every mode, with tabs General, Binding, Inputs and outputs, Ports and Execution (Code and Run modes add their own tab). The open tab stays when you select another node.
- Fields save as you go; a binding change is staged with **Discard** and **Save Binding**, and leaving it asks first.
- The panel can be resized and expanded; both are remembered.
- The card under a selected node is removed (its facts show in the node's rows from 1.4× zoom); the hover card only previews; generated code is in the Binding tab and **Peek Code**.

### Fixed

- A bound task without an explicit register name counted as changed before any edit.

## 0.25.1 — Readable canvas

### Added

- `afd.canvas.direction` (TB or LR): the direction of automatic layout and Tidy Up. A user setting, never written to the flow.
- A minimap while part of the level is out of view.

### Changed

- Levels open readable: whole when titles stay at least 11 px on screen (at most 100%), otherwise fitted to their width from the top.
- Larger text: node titles 14 px, the line under them 12 px.
- Wires on the normal path (`ok_hosts`, `approved`) have no label at rest; other wires keep theirs. Hover or select a wire to see its port.
- Status is shown with a stripe and an icon; the readiness list uses the same icons.
- The bound module or role (else the node kind) shows under the title; a decision shows its condition.
- Parallel and join are fork and merge bars; decisions and approvals have a coloured header.

## 0.25.0 — Consistent names

### Changed

- A [glossary](docs/guide/reference/glossary.md) fixes the terms used in the designer, the Command Palette and the guide:
  - Implementation mode is **Code mode**; its tab is **Binding**; the node page is **Details**.
  - **Accept with Reason…** replaces Leave open on purpose…, Mark expected and Ignore…; **Reopen** reverses it.
  - **Open in Text Editor** replaces Open as text, Show as text and Show in text; also **Tidy Up**, **Generate Code**, **Import AWX Workflow or Job Template…**.
  - Actions are in Title Case.
- **Check Flow** replaces Validate Design and Check Generated Code: it checks the design and, when the design has no errors, the generated code in your Ansible environment.
- Command ids are `afd.<area>.<verb>` (`afd.flow.check`, `afd.run.skeleton`, …). The old ids work until 0.27 but are hidden ([commands](docs/guide/reference/commands.md)).

### Added

- Designer keys: Ctrl+F5 Run as Skeleton, Shift+F5 Stop Run, Ctrl+Shift+B Generate Code, Shift+Alt+F Tidy Up, F7 Check Flow.

## 0.24.6

### Fixed

- Extract into Subflow could give two lifted outputs the same name; the second is now suffixed (`a_b_c_2`).

## 0.24.5 — Stop a run

### Added

- **Stop** in the top bar and **Ansible Flow: Stop Run**: a local run ends and shows as stopped; an AWX job or workflow is cancelled and followed until AWX reports it canceled.
- **Check Generated Code** shows a cancellable progress notification.

## 0.24.4

### Fixed

- Problems from an older validation could overwrite newer ones.

### Changed

- Typing in the text editor settles for 150 ms before the designer updates; the designer's own edits still show at once.

## 0.24.3

### Changed

- A command run without an open flow says "Open a flow first" with **New Flow…**.
- A missing AWX address, token or template comes with the button that fixes it; a cancelled prompt is not shown as an error.
- **Set Up AI Assistants** logs to the Ansible Flow output channel.
- Copilot's tools and the MCP server read the same kinds of import files, skip the same folders and refuse files over 2 MB. Copilot's tools refuse a link that leads out of the folder and, in a multi-root workspace, resolve module names from the playbooks' folder.
- Faster start after an AI setup.

## 0.24.2

### Added

- The designer does not animate with the system's reduce-motion setting.
- In Windows contrast themes, ports, status dots and legend swatches keep their colours, and focus uses the system highlight.

### Fixed

- The error message no longer overlaps the right panel when the panel is resized.

## 0.24.1

### Changed

- Leave Open on Purpose, Ignore This Drift and Mark as Expected share one reason dialog.
- The right panel's accessible name says "Selected nodes" and "Subflow boundary" for those panels.

## 0.24.0

### Changed

- Faster designer updates.

## 0.23.4

No user-facing changes.

## 0.23.3 — Ansible probe reliability

### Added

- **Ansible Flow** output channel: the probe's start, the ansible-core version, timeouts and, at Debug level, its stderr.

### Changed

- Probe calls queue in the extension, so a call's timeout starts when it is sent. A call that times out fails alone; the probe restarts for the calls behind it.
- Reading collection docs for the module catalog runs in a separate probe.
- ansible-core older than 2.19 is refused with a message naming the version found.
- Changing the environment settings makes the module catalog read the new environment on the next search.

### Fixed

- A lens or Re-sync call could time out while waiting behind a catalog dump and stop the probe, failing every other call.
- AWX: a GET on a connection closed while idle is retried once instead of failing with "read ECONNRESET".

## 0.23.2 — Consistent lifecycle and new warnings

### Added

- Warnings: `success-port-unwired` (a top-level success port that leads nowhere), `output-name-collision` (a `from:` reads a host variable another step or a flow input also sets) and `ref-may-be-undefined` (the step a `from:` reads does not run for every host that gets there; reads with `| default(…)` are fine).

### Changed

- Binding a step makes it implemented and unbinding it specified, from any source (properties page, AI assistant, import).
- Inside a subflow, level chips show become, serial, credential and execution environment set on the subflow as not applied; only the inventory target is inherited.

### Fixed

- A step an AI assistant bound stayed draft.

## 0.23.1 — Designer fixes

### Fixed

- Esc on the properties page with an unsaved binding asks: **Keep editing**, **Discard** or **Save binding**. Esc in a field reverts only that field.
- The inspector, flow panel and properties page are read-only while the file has YAML errors or missing IDs.
- Inside a subflow, the right panel with nothing selected describes that subflow. The breadcrumb starts at the flow.
- Steps inside subflows are named by title, not ID, in the connect bar and the Leave Open on Purpose dialog.
- Delete from the inspector works like delete on the canvas (boundary wires, one undo step).
- The top bar and the run panel agree on the run's result; a failure routed to a handler is not shown as ok; a run stopped after it started says "Run interrupted".
- Wording: internal codes removed from UI text; clearer Inventory target help; the copy tooltip shows macOS keys on a Mac; sample flows name a real AWX template.

## 0.23.0 — Run data and security

### Added

- `afd.runs.keep`: each flow keeps the event logs of its last 30 runs by default. The audit log rotates at 1 MB, keeping two older files.
- Restricted Mode support: in untrusted workspaces you can design, edit and generate flows; local runs and the Ansible probe need trust, and workspace `afd.environment.*` and `afd.awx.*` values are ignored until then.
- Following an AWX job or workflow shows a cancellable notification and stops after 12 hours at most; stopping leaves the job running and offers to cancel it in AWX or open it.

### Security

- Secret run inputs never touch the disk: they travel in an environment variable into a temporary file that lasts as long as the run. Other inputs are written for the run and deleted when it ends. `vars.json` files left by earlier versions are deleted at start-up.
- The AWX token is sent only to the configured AWX; links to other origins are followed on the configured AWX.

## 0.22.0 — Importing existing playbooks: guide and sample

### Added

- Tutorial 5: bring existing playbooks into flows (about 25 minutes).
- **Open Sample Flow…** offers _Playbooks to import: edge-baseline_, a small fictional repository to import. It copies only into an empty folder and offers **Import Ansible Playbooks…** right after.
- Walkthrough steps for importing playbooks, with and without an assistant.
- Guide: import sections in Tutorials 3 and 4, and an Imports section in troubleshooting.

### Fixed

- Secret-looking run inputs (such as `enable_secret`) are typed hidden and never remembered between runs.
- The import looks for a role in `roles/` next to the playbook before `roles_path`, as Ansible does.
- A step with task keywords no longer shows unsaved changes on its Implementation tab; its task preview shows the keywords.

## 0.21.0 — Import with an AI assistant

### Added

- **Import Ansible Playbooks…** and **Import from AWX…** ask **As is** or **With an AI assistant**. An assistant designs the flow by intent: subflows by purpose, steps named by what they achieve, the source's modules, parameters and keywords.
  - Copilot Chat opens in agent mode with the prompt filled in; for Claude Code, Codex and other assistants the prompt is copied to the clipboard.
  - From AWX, the extension writes `flows/<key>/source/awx-export.json` for the assistant, with secret values left out. The AWX token never leaves VS Code.
- AI tools (Copilot and the MCP server):
  - `source_outline` reads a playbook, folder, role or AWX export: plays, tasks, blocks, includes, roles, handlers and variables. Each task carries the exact binding an import writes (`impl`), ready for `add_node`. Secrets show by name only; long outlines come in pages; `focus` shows one task in full.
  - `flow_import` runs the as-is import.
  - Both read only YAML, JSON and `ansible.cfg` inside the workspace, up to 2 MB per file.
- The skill has an import section and a worked example; the assistants' instructions send import requests to `source_outline`.

## 0.20.0 — Import Ansible playbooks

### Added

- **Ansible Flow: Import Ansible Playbooks…**, or right-click a playbook or folder in the Explorer.
  - A playbook becomes a flow at `flows/<key>/<key>.flow.yaml`, one step per task. A folder lists its playbooks with the top-level ones selected; each becomes a flow.
  - Several plays and `import_playbook` become subflows; facts are gathered where the play gathered them.
  - Blocks with rescue and always become subflows; roles become role steps (a role whose `main.yml` only includes task files becomes a subflow); `include_tasks` files become subflows; handlers become steps that run when a notifying step changed something.
  - Registered variables, `set_fact`, `vars_files` and role variables become outputs, and readers get inputs. Play vars and prompts become flow inputs; vault values and prompted secrets are imported by name only.
  - Template and copy sources are rewritten so the generated playbooks find them.
  - Unhandled failures stay open on the banner; **Show notes** lists what has no one-to-one form.
- **Import from AWX** (was Import AWX Workflow…) also lists job templates: the limit is where the flow runs, the survey and extra vars are inputs, the credential and EE are settings. A job template whose playbook is in the repository becomes a subflow of that playbook's steps; otherwise it stays one draft playbook step.
- Task keywords on a binding (`impl.keywords`): `when`, `loop`, `ignore_errors`, `changed_when`, `failed_when`, `delegate_to`, `run_once`, `no_log`, `become_user`, `environment` and more. Edited on the Execution tab as YAML and written on the generated task; variables in them are checked. Keywords the flow models itself (register, tags, become, timeout, retries, until, notify, block) are refused with where they belong. Node cards show "when" and "loop".

## 0.19.0 — draw.io and image export

### Added

- **Export as draw.io Diagram…** (designer "…" menu, Command Palette, or right-click a `*.flow.yaml`): one page per level, subflow nodes linked to their pages, the canvas look (light theme), ports that keep wires attached when nodes move, and each node's details as draw.io shape data and a hover summary. The page background holds the flow's name, version, goal, inputs and problem counts.
- **Export as Image…** for the open level, or **Ansible Flow: Export as Image (SVG, PNG)…** for the top level or every level. SVG, or PNG at twice the size, always in the light theme. Files are `.drawio.svg` / `.drawio.png`, so draw.io opens them as editable diagrams.
- AI tool `flow_export` writes a draw.io file or SVG images next to the flow, or to `out` inside the workspace. The skill and instructions send requests for a picture of a flow there.

## 0.18.0 — AI agents place nodes

### Added

- `add_node`, `apply_pattern` and `extract_subflow` take a `position`: `{x, y}`, or `below` / `above` / `right_of` / `left_of` a node with an optional `gap`. A relative position moves aside until the spot is free.
- Ops `move` (place or move nodes, each optionally relative to the previous) and `unplace` (return nodes or a level to automatic placement).
- The first position stored on an auto-laid-out level also stores the other nodes where the canvas shows them, so nothing jumps. An overlapping position is applied and reported.
- Place-taking ops, `move`, `unplace` and `tidy_up` explain the coordinate system and node sizes; `flow_describe` with `layout: true` lists each node `at x,y` (stored) or `auto x,y`.
- Agent instructions say to leave positions out unless asked; the user guide's AI page explains what to ask for.

## 0.17.1

### Fixed

- Agent-built flows stood in one column with siblings on top of each other. New flows (New Flow, `flow_new`, Create a flow here) store no positions; levels whose only positions come from the old template are laid out automatically; unplaced nodes on a partly placed level go next to their placed neighbours without overlapping.

## 0.17.0 — User documentation

### Added

- Walkthroughs on the Welcome page: _Design your first Ansible flow_, _Build flows with an AI assistant_ and _Run your flows in AWX_. Steps check themselves off; **Ansible Flow: Get Started** opens them again.
- The user guide ships with the extension and opens in the Markdown preview with **Ansible Flow: Open User Guide** or _User guide_ in the designer's "…" menu: four tutorials, eighteen how-to pages, reference (commands, settings, problem codes, flow format) and troubleshooting.
- **Ansible Flow: Open Sample Flow…** copies `firewall-upgrade` (subflows, data across levels, polling, an approval, rollback) or `edge-baseline` into `flows/<key>/` and opens it.
- New extension icon.

### Fixed

- Clicking a wired port or an `in` port did nothing, so their menus (Insert node on this wire, Rewire, Disconnect) could not be opened by click.

## 0.16.0 — Data across subflows, polling

### Added

- Inside a subflow, `from: <subflow>.<input>` reads the subflow's input.
- A subflow output without `from` lifts the inner output of the same name; warning `subflow-output-unset` when nothing inside sets it.
- `set_io` and the @ picker lift a step inside another subflow (`precheck/normalize-facts.fos_platform`) to that subflow's outputs in the same edit.
- Polling settings `until` and `delay`, with fields on the Properties page.
- Checks of bare expressions: `assert` `that`, `debug` `var`, decision conditions (`condition-unknown-var`) and `until`.
- `afd_approvals` sets an approval's outcome in local runs.
- `apply_pattern` takes an `end`; the answer names the end used.

### Changed

- Renaming a subflow input rewrites the inner reads; renaming an output no longer touches them.
- Unknown-name warnings say where the value could come from.
- `stop`, `notify-stop`, `escalate` and `rollback` reuse an end node only by key (`stopped`, `failed`).
- The problem count in `flow_edit` answers counts every finding and splits it by severity.

### Fixed

- A subflow output with nothing inside setting it read an unset variable at run time.
- Data lens: outputs a subflow lifts were reported as unread; readers are counted per node.
- Removed an outdated message about AWX approval nodes.

## 0.15.1 — AI assistant fixes

### Added

- After VS Code starts, agents found without the setup get one notice with **Set Up**, **Choose…**, **Not Now** or **Don't Ask Again**.
- Setup supports OpenCode, ZCode, GitHub Copilot CLI and Cursor, besides Claude Code, Codex and Gemini CLI. Agents that read another agent's skill folder share its copy.
- **Other agent…** opens a guide with this machine's MCP config and copies the skill to a chosen folder.

### Changed

- `add_node` with `after` on a wired port inserts the new node on that wire, so `after: "start.ok_hosts"` adds the first step of a new flow.
- `flow_new` keys the flow by its file name and says how to add the first step.
- The skill, MCP instructions and `flow_new` say to build Ansible flows with the tools, not as PlantUML, Mermaid or draw.io pictures.
- Faster activation: the flow schema compiles on first use.

### Fixed

- `on_wire` inside a subflow adds the node there.
- `null` for an optional op field counts as not given.
- `maintenance_window` says it takes a duration (`4h`).
- An edit against an old revision shows the current flow again.
- A config file that does not parse is left alone by the setup.

## 0.15.0 — AI assistants edit flows

### Added

- Copilot gets the `ansible-flow` skill, instructions for `*.flow.yaml` and seven tools (`#flowDescribe`, `#flowEdit`, …) without setup. An edit asks first and is one undo step.
- **Ansible Flow: Set Up AI Assistants…** gives Claude Code, Codex CLI and Gemini CLI the same skill and tools through a bundled MCP server: pick the agents and the skill's place (this repository or just you), preview every change. Config files are backed up once; **Remove AI Assistant Setup…** removes only what setup wrote.
- The tools describe a flow by key (`precheck.ok_hosts -> check-ntp`, `fix-ntp/push-config`) and edit it with all-or-nothing batches of ops: add, connect, rewire, patterns, ports, inputs and outputs, bindings, subflows. Errors name the op and the fix; answers list problems added or solved; `tested` is refused.
- A terminal agent's edit acts like a save: the version bumps once per commit and `generated/` is refreshed without overwriting hand edits.
- Hand-written flows may leave out `id:` lines and name nodes by key. The designer shows a _Written by hand_ banner and lists each gap; **Complete IDs** adds the IDs in one edit that keeps the rest of the text. Paste completes hand-written snippets.
- Every problem code has a one-line meaning and fix.

### Changed

- Schema: every property has a description; `id` is optional; references may be keys.

## 0.14.1

### Changed

- _Show in text_ selects the whole node in the text editor, including its contents.
- Faster start: the auto-layout library loads at the first auto-layout instead of at activation; the extension bundle shrank from 1.9 MB to 460 KB.

## 0.14.0 — Canvas menu and shortcuts

### Added

- Right-click menu on the canvas for nodes, groups, wires, subflow entry and exit wires, ports and empty canvas, with icons, shortcut hints, disabled items with reasons, and one submenu per open fail port. Run mode is read-only.
- Keyboard shortcuts with a `?` sheet: Delete/Backspace deletes a selection in one undo step; Ctrl+X cuts; Ctrl+D duplicates; F2 renames; Alt+↑ goes up a level; Shift+F10 or the Menu key opens the menu.

### Changed

- The six lens buttons are one _Lens_ dropdown; _Run for real…_ is under _Run as skeleton_; _Tidy up_, _Show as text_, _Validate design_ and _Keyboard shortcuts_ are in a "…" menu.
- Escape closes only the innermost menu or dialog, else clears the selection.
- Keys the designer handles no longer reach VS Code's keybindings; Ctrl+C/X/V/Z/Y always do.

### Fixed

- Arrow-key nudges were not saved.
- Dialogs and the toast opened behind the Properties page; a dialog's Escape also closed the page.
- Delete on a focused menu item deleted the selection.
- The palette and node dragging were active in Run mode.
- The summary card opened while a menu was open.

## 0.13.2

### Fixed

- Paste and Extract into subflow rearranged auto-laid-out flows; they now store the shown positions of the other nodes in the same undo step.

## 0.13.1

### Fixed

- A right-click selects the node under it (unless it is part of the selection), so _Copy_ copies the right nodes.
- _Paste_ from the context menu lands where the menu opened; from the Edit menu or palette, at the last click, else the middle of the view.
- Text selected on the canvas no longer stops Copy from taking the nodes.

## 0.13.0 — Copy and paste nodes

### Added

- Ctrl+C (Cmd+C), _Copy_, or **Ansible Flow: Copy Nodes** copies the selected nodes of one level as plain flow-file YAML, with inner levels, wires between them, layout and open-on-purpose decisions.
- Ctrl+V or **Ansible Flow: Paste Nodes** pastes on the open level at the pointer, in one undo step; the pasted nodes are selected. New IDs are assigned; taken keys get `-2`, `-3`, … and `from:` references between pasted nodes follow. `tested` becomes `implemented`; wires to nodes not copied are dropped.
- Hand-written snippets paste too (one node, a list, or a `nodes:` mapping). Other text is refused with a reason.

## 0.12.1

### Changed

- An empty `*.flow.yaml` opens with _Create a flow here_, which fills in the New Flow template named after the file and keeps existing comments. An empty file is no longer a problem.
- A `*.flow.yaml` that does not parse shows the error and _Open as text_; it never offers to overwrite the content.

## 0.12.0 — Extract into subflow

### Added

- Select several connected nodes (Ctrl/Cmd+click, Shift+drag) and **Extract into subflow** moves them into a new subflow in one edit, on any level. IDs, inner wires and positions are kept; wires in and out become the subflow's entry and exits; outputs read outside are lifted to subflow outputs and references rewritten. Two ways in, or two places on one exit port, are refused. The subflow's status follows its least advanced step.

## 0.11.0 — AWX approvals

### Added

- A flow with top-level approvals runs in AWX as a workflow of segment playbooks with real approval nodes. `generated/<key>.seg_<segment>.yml` is written next to the single playbook, which local and skeleton runs keep using (auto-approved).
- **Set Up AWX Template** creates the segment job templates and the workflow `AFD · <key>` with approval nodes and their timeouts.
- **Launch in AWX** follows the workflow job and its segment jobs; approval nodes show waiting, approved, denied or timed out and open the approval in AWX.
- Check `awx-segments`: an approval inside a subflow, or two that can wait at once.

## 0.10.0 — Inventory target

### Added

- `settings.inventory_target` is applied in generated code: a task runs its binding once on the target instead of the arriving hosts, and subflow steps inherit it. Arriving hosts leave together by `ok_hosts`, or by `failed_hosts`/`timeout` when the target fails beyond `max_fail_percentage` or matches no host.
- Checks: `inventory-target-ignored` on decisions, approvals, parallels and joins; `codegen-target-ports` for ports arriving hosts can never take.
- Real-run and AWX confirmations name every target with its host count; the audit log records them.

### Removed

- The Inventory lens finding that `inventory_target` is not applied.

## 0.9.0 — Import AWX workflows

### Added

- **Import AWX Workflow…**: a workflow job template from the AWX API or an `awx export` file becomes a new flow, laid out at every level. AWX is only read.
  - Job template nodes become tasks bound to the playbook (implemented when it is in the repository, otherwise draft), with their limit, tags, extra data, credential, EE, become and timeout.
  - Nested workflows become subflows; approvals keep their timeout; syncs and system jobs become draft tasks.
  - `success`, `failure` and `always` map to ports; fan-out, several roots and convergence "all" map to parallel and join nodes. Unhandled failures stay open.
  - Survey and extra vars become flow inputs; secret values are imported by name only.
- Schema: `flow.imported_from`.

## 0.8.0 — Lenses

### Added

- Lens toggle in the top bar (None, Inventory, Data, Code, Access, Timing), independent of mode. Each lens fills node chips, adds a panel whose rows highlight their nodes, and lists findings with one-edit fixes.
  - Inventory: hosts matched by the targets, hosts outside them, access variables with their origin, vaulted variable names (never decrypted). Findings: broad targets on failure paths, groups that are not flow inputs, patterns without hosts, production groups.
  - Data: inputs and outputs, data wires from `from:` references, unresolved inputs, unused outputs.
  - Code: binding, collection version, execution environment. Findings: not in the EE, removed, deprecated, versions against `collections/requirements.yml`.
  - Access: credential, inventory user, become, vault references.
  - Timing: serial, timeout, average and p95 of the last 20 real runs. Findings: the slowest path against `flow.maintenance_window`, p95 near a timeout.
- _Mark expected_ and _Reopen_ for findings, with a reason and the Git author.
- Semantic zoom: titles only when zoomed out, two chips at default zoom, summary rows from 1.4×.
- Schema: `flow.maintenance_window`.

## 0.7.1

### Changed

- A `tested` node whose design changes goes back to implemented, and a message names it. _Mark N nodes tested_ leaves out nodes changed since the run started.

## 0.7.0 — AWX

### Added

- Settings `afd.awx.url` and `afd.awx.verifyTls`; commands _Set AWX Token_ (verified, stored in SecretStorage only), _Clear AWX Token_, _Set Up AWX Template_ and _Launch in AWX_.
- _Set Up AWX Template_ picks the project, inventory, execution environment and credentials, checks the project has the generated playbook, creates or updates `AFD · <flow key>`, and records it in `flow.runtime`.
- _Launch in AWX_ confirms targets and commit, launches with the inputs as extra vars, follows the job on the canvas, records it in the audit log, and warns when AWX ran another commit.
- Run mode: nodes show hosts, failed hosts and time; wires show host counts; selecting a wire or node lists its hosts; the run panel shows the job, status, commit and _Open in AWX_. Read-only.
- Local and AWX runs share one run summary, with per-node timings and per-host problems.
- After a passing real run of the current version, _Mark N nodes tested_ sets the implemented nodes it ran to tested.

## 0.6.0 — Implementation mode

### Added

- Implementation mode: nodes show what they run and its state (drift, TODO stub, last run). The _Design vs code_ panel shows the sync source (branch, commit, uncommitted files, environment), matched nodes, drift items with actions, and the last run. A selected node lists its tasks with file and line links.
- _Re-sync from git_ compiles the generated playbook and bound roles in your Ansible environment to find the tasks each node runs; it re-syncs after each save while a scan is shown.
- Drift detection: contract mismatches (outputs, role arguments, module result keys), code without design (uncovered role task files, plays for deleted nodes), and design without code (unbound nodes, missing roles, playbooks or generated code).
- Drift actions: Update design, Open code, Add to subflow, Generate stub (role scaffold and binding), Write argument_specs, Bind…, Ignore… with a reason and Stop ignoring, Regenerate, Re-sync.
- Renaming a node output rewrites downstream `from:` references in the same edit.

## 0.5.0 — Bindings and the module catalog

### Added

- Node properties page with General, Implementation, Inputs and outputs, Ports and Execution:
  - **Find** modules in the environment's catalog, roles from `roles_path` and playbooks from the repository, with badges (in EE, check mode, diff, read-only, other platform, deprecated).
  - **Understand**: docs, parameters, returns that can become node outputs, examples, role argument specs, a playbook's plays.
  - **Configure**: a form from the argument spec; `{{ name }}` input chips, where `@` offers node inputs, flow inputs and upstream outputs and adds missing ones; the register name; a checklist and the generated task.
  - **Save binding** in one edit and one undo step. Roles without argument specs and playbooks take free-form variables.
- Module catalog built from your environment's collections and indexed locally; search matches names, abbreviations ("ip address" finds `ipaddr`) and descriptions, prefers collections in use and inventory platforms, ranks deprecated modules lower, and follows redirects. Command _Rebuild Module Catalog_.
- Code generation passes upstream outputs as play variables, reads registered module results, sets placeholder facts for unbound nodes with outputs, and runs playbook bindings on the arriving hosts.
- Checks: `binding-unknown-var`, and with the catalog `binding-not-in-ee`, `binding-removed`, `binding-redirect`, `binding-deprecated`, `binding-no-check-mode`, `binding-missing-param`, `binding-unknown-param`. `from:` may point into an output (`key.output.path`).
- Renaming a node input rewrites the binding's Jinja reads.

## 0.4.0 — Subflow levels

### Added

- Open a subflow by double-click, Enter, the inspector or the preview card; _Back_, a breadcrumb, inherited-context chips and a viewport per level. Revealing a problem opens the right level.
- Boundary frame showing the subflow's ports, with editable entry and exit wires and exit reasons.
- Checks: `boundary-no-entry`, `boundary-port-unfed`, `inner-exit-unmapped`.
- Preview card on subflows and bound nodes, with _Peek code_ and _Open subflow_.
- Auto-layout and _Tidy up_ on inner levels.

## 0.3.1

### Fixed

- With the Red Hat YAML extension, `*.flow.yaml` was validated against an unrelated SchemaStore schema, giving false "Property … is not allowed" errors. The extension now provides the flow schema for `*.flow.yaml`, with completion and validation in the text view.

## 0.3.0 — Code generation and local runs

### Added

- Code generation: one playbook per flow level in `generated/`, plays in graph order, routing of every port (including `unreachable`, `unchanged` and `timeout`), decisions, approvals (auto-approved locally), parallel and join, subflows and `max_fail_percentage`.
- Generate on save (`afd.codegen.onSave`): writes only changed files, never overwrites hand edits, removes stale level files. Command _Generate Playbook_.
- Ansible environments: a Docker or Podman execution environment image, or a local interpreter. Settings of this extension win over the Red Hat Ansible extension's. Native Windows needs a container.
- _Run as skeleton_ (check mode) and _Run for real…_: inputs remembered per flow, a real-run confirmation with inventory, host count and production-looking groups, the vault password asked per run and passed only in an environment variable, a local audit log, and results mapped back to the nodes.
- _Check Generated Code (Syntax)_ runs `--syntax-check` and reports errors in the Problems panel.
- Checks: `port-role-unroutable`, `timeout-without-setting`, `no-targets`.
- The inspector shows each node's generated play.

## 0.2.0 — Ports and failure patterns

### Added

- Ports appear on demand: at rest only wired, open-fail and open-on-purpose ports; hover, selection or an open menu shows all of them.
- Port menus: suggestions for open ports, Insert, Rewire and Disconnect for wired ones, and connecting to another node by clicking it.
- Failure patterns: Rollback from backup, Notify on-call and stop, Retry with backoff, Exclude and report, Stop flow, Connect/Skip to Done, Escalate approval, Send run report. One undo step each; drag from the palette onto a port or node.
- Open on purpose: a reason is required and the author is recorded; wiring the port removes it.
- Checks: `rollback-unreachable`, `duplicate-decision`, `decision-not-fail`.

### Fixed

- Selecting a node created by Quick add or a pattern while another node was selected made the canvas loop.

## 0.1.0 — First version

### Added

- Visual editor for `*.flow.yaml`. Every canvas action is a minimal text edit, so undo, dirty state and save work as in VS Code, and comments and formatting are kept.
- Flow model, port catalog and validation, with open fail ports reported in the Problems panel.
- Design canvas: node types and statuses, ports, wires, palette, Quick add, inspector, flow description and the open-port banner.
- Automatic layout for flows without positions, and _Tidy up_.
- `flow.version` bumped once per commit relative to Git HEAD.
- Light, dark and high-contrast themes.

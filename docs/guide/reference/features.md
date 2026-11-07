# Features

Everything Ansible Flow Designer does, in one list. New here? Start with [Tutorial 1](../tutorials/01-first-flow.md) or [how flows work](../explanation/how-flows-work.md). Back to the [guide](../README.md).

## What the designer does

- `*.flow.yaml` opens in the **Ansible Flow Designer** custom editor; _Open in Text Editor_ (editor title bar) shows the YAML. Both views edit the same document, so save, dirty state, undo/redo, Git diff and hot exit are VS Code's own.
- **Canvas (Design mode):** nodes by type (task, subflow, decision, approval, parallel and join as fork and merge bars, start, end), with their status (draft, specified, implemented, tested) as a stripe and an icon, and the module or role they run under the title; ports placed by role (control in on top, outcomes at the bottom, problems on the right); wires colored by port, dashed for problem paths, labelled when they leave the normal path; far zoom shows titles only. A level opens readable (titles at least 11 px): whole when it fits, else fitted to its width at the top, with a minimap while part of it is out of view. `afd.canvas.direction` (TB or LR) sets the auto-layout direction.
- **Editing:** drag to move, drag from a port to another node to wire it, release on empty canvas to add a node there (Quick add), Delete/Backspace to remove (a whole selection is one undo step), palette click or drag to add. The Details panel edits title, key, intent, status, contract (inputs and outputs), optional ports and type-specific fields. The flow panel edits name, key, goal, owner and flow inputs and shows readiness counters.
- **Every canvas action is one minimal text edit** made by the extension host with a byte-preserving YAML engine: comments, quoting and formatting outside the edited lines never change, and one Ctrl+Z undoes one action.
- **Validation:** JSON Schema (`schema/flow.schema.json`) plus semantic checks (IDs, keys, ports, edges, references, decisions, subflow boundary, status) go to the Problems panel; open fail ports also show in the canvas banner. The schema is also registered with the Red Hat YAML extension for `*.flow.yaml` (`contributes.yamlValidation`), so _Open in Text Editor_ gets completion and validation from it, and SchemaStore's unrelated Estuary Flow schema, which claims the same file pattern, no longer applies.
- **Layout** lives in one `layout:` block of the flow file. Flows without positions are auto-laid out (ELK) in memory and only written on the first move or _Tidy Up_. New flows start without positions; nodes added without one (by an AI agent, say) go where the auto-layout puts them next to the placed nodes.
- **`flow.version`** is bumped once per commit on save when the semantic content changed (compared with Git HEAD), never for layout-only changes.
- **Ports appear when needed:** at rest a node shows only wired ports, open fail ports (amber) and ports left open on purpose (gray). Hovering or selecting a node shows every port its type supports, with names; dragging a wire shows every input.
- **Wires round steps:** a wire that would run through a step goes round the steps in its way, on the canvas (also mid-drag) and in exports; draw.io gets the route as waypoints. Other wires keep their smooth steps, so Tidy Up leaves no wire through a step.
- **AI layout check:** AI assistants get, in words, what they cannot see on the canvas (a wire through a step, labels on steps or on each other, overlaps, crossings) from `flow_describe` with layout and after edits that place steps; an AI import checks and fixes its layout before it finishes.
- **Annotations after first use:** sections move by a title bar with a grip; a palette click places annotations in free space; with steps selected, Add Section (palette or Add Section Around) wraps them; a resize after a text edit no longer collapses.
- **Annotations in exports, the Changes lens and code:** draw.io and images include them; the Changes lens outlines and lists annotation changes; a note on a step becomes a `# Note:` comment above its play.
- **Annotations on the canvas:** the palette's Annotate group, Add Note/Section/Text Here, Add Note to This Node and Shift+N add them; double-click edits the Markdown in place; a note on a node is tied to it and moves with it; a section dragged by its title carries the steps inside; Find searches them; … › Hide Annotations hides them for you.
- **Annotations:** Notes (Markdown; a Note on a node moves, is copied and deleted with it), Sections (titled regions that carry what is inside them) and Text explain a flow and never run: `annotations:` per level, format 2, no version change. AI tools add and change them by key (`annotate`, `update_annotation`).
- **Shared subflows:** Insert Shared Subflow… copies another flow's subflow pinned to that flow's version; the copy is edited in its source and brought up to date with Update Shared Subflow.
- **AWX surveys:** Set Up AWX Template writes the template's survey from the flow inputs, and asks before replacing a survey changed in AWX.
- **Scenario tests:** `<flow key>.scenarios.yaml` next to a flow says where each host must end when chosen steps fail; Run ▾ › Run Scenarios runs them with every step as its stub on local hosts, the Problems panel checks the file, and `.afd/afd-scenarios.js` (Copy Scenario Runner to Repository) runs them in CI with JUnit output.
- **Port menus:** click any port. An open port offers suggestions for its kind, for example `failed_hosts`: Rollback (existing), Notify On-Call and Stop, Exclude and Report, Retry, Stop Flow, Accept with Reason…. `unreachable` never offers Rollback. A wired port offers Insert Node on This Wire, Rewire to Another Node and Disconnect. The Ports tab of a node's Details lists every port with the same menu and quick fixes for open fail ports.
- **Failure patterns:** drag Rollback from Backup, Notify On-Call and Stop, Retry or Exclude and Report from the palette onto an open fail port (or a node), or click one with a node selected. The handler node, its end node (reused only when the level has one with the pattern's key, such as `stopped`, `failed` or `excluded`; otherwise a new one) and all wires are created in one undo step. Retry adds no node: it sets retries and delay on the module step itself. Rollback builds a subflow with an undo step per completed step, newest first, bound where the step has an `undo` binding.
- **Open on purpose:** a reason is required; the decision records your Git user name in the flow's `decisions:` block and silences the warning. Wiring the port later removes the decision in the same edit.
- **Generated code:** saving a flow without errors writes `generated/<flow-key>.yml` next to it, plus `generated/<flow-key>.<subflow-key>.yml` per subflow level.
  - Plays come in graph order. Each one is named `[key] Title` and tagged `node_<ULID>`.
  - Hosts are routed between plays with `group_by`. Every task node rescues its failures, and a final **outcome play** fails the hosts left on open ports or failed end nodes. The job still ends red, but no branch is skipped.
  - Unbound nodes run a `TODO` debug message; role and module bindings run for real.
  - Files are written only when their content changed. A generated file edited by hand is never overwritten without asking.
  - The Details' Binding tab shows a node's generated task; _Peek Code_ opens its play in the generated file.
- **Run as Skeleton:** the top bar button generates the code, asks for the flow inputs (remembered per flow), and runs `ansible-playbook --check` in a terminal, in your Ansible environment.
  - **Guided first flow:** a "Your first flow" checklist in the designer (add a step, see the playbook, handle the failure, run it as a skeleton, each with Show Me), an **Ansible Flows** view in the Activity Bar with a welcome for no folder and no flows, "?" links from panels to the guide, the AI setup offered once a flow is open (with a preview), and AWX commands in the Command Palette once an AWX address is set.
  - **Contextual disclosure:** controls show when they can act (failure patterns once a step can fail, the Lens once there is a step, Stop in place of Run while a run goes); rarer fields fold behind a line that says what is inside and open by themselves when something there needs you. The open-port banner asks what should happen when the step fails, with the first fixes as buttons; ports and `from:` references are explained in plain words.
  - **Set Up Ansible Environment…:** with nowhere to run (native Windows, no image), the run's error offers the setup: Docker or Podman with the public Ansible dev tools image (editable), or the folder reopened in WSL. The first skeleton run suggests `localhost` for the hosts.
  - An event callback maps the run back to the flow: the top bar shows hosts, failures and the exit code, and a node's Details list the hosts that left each port.
  - _Run for Real…_ first shows a confirmation naming the inventory, host count, hosts missing from the inventory and production-looking groups.
  - The vault password is asked per run when vault data is present, and is passed through an environment variable only. Secret-looking inputs travel the same way and are never remembered; other input values are deleted when the run ends.
  - Every launch is written to a local audit log (_Show Run Audit Log_), without input values. The log rotates at 1 MB; each flow keeps the events of its last runs (`afd.runs.keep`, 30).
  - **Restricted Mode:** an untrusted workspace can design, edit and generate flows; local runs, the probe (catalog, lenses, Re-sync) and the workspace's `afd.environment.*` / `afd.awx.*` values wait for trust.
- **Syntax check:** _Check Flow_ runs `ansible-playbook --syntax-check` inside the environment. Errors land on the generated files in the Problems panel.
- **Right-click menu:** right-click a node, a group, a wire, a port or the empty canvas for what you can do there, with the keyboard shortcut next to each item. The menu replaces VS Code's own (Cut/Copy/Paste) on the canvas; text fields keep VS Code's.
  - **Node:** Open Subflow, Details…, Binding…, Rename, Status ▸, one submenu per open fail port with its suggestions (Rollback, Notify On-Call and Stop, Accept with Reason…), Add Next Node…, Cut, Copy, Duplicate, Open in Text Editor, Peek Code, Delete.
  - **Group** (also a right-click on the Shift+drag selection box): Cut, Copy, Duplicate, Extract into Subflow…, Delete.
  - **Wire:** Insert Node on This Wire, Rewire to Another Node…, Disconnect. Entry and exit wires of a subflow: Remove Entry, Edit Reason…, Remove Exit.
  - **Port:** the port menu. **Empty canvas:** Paste Here, Add Node Here…, Select All, Tidy Up, Fit View, Up to Parent.
  - Code mode offers the same edits as Design (except Rename and Extract, whose panels are Design's). Run mode only reads.
  - Shift+F10 or the Menu key opens the menu for the selection.
- **Keyboard shortcuts:** press `?` for the list (also in the top bar's "…" menu). Ctrl stands for ⌘ on macOS.
- **Keyboard only:** Tab walks the nodes and, on the selected node, its ports (Enter opens a port's menu); _Connect to Another Node…_ takes a node with Tab or the arrows and Enter; N adds a node, Enter goes into the Details, Ctrl+A selects the level, Shift+1 fits it, Alt+1/2/3 switch modes. Dialogs keep the focus and give it back.

  | Keys                     | Action                                                    |
  | ------------------------ | --------------------------------------------------------- |
  | Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, paste nodes (as YAML text)                     |
  | Ctrl+D                   | Duplicate the selection, next to it                       |
  | Delete / Backspace       | Delete the selection, in one undo step                    |
  | F2                       | Rename: the cursor goes to the Title in the Details       |
  | Enter / Alt+↑            | Open the selected subflow / back to the parent level      |
  | Arrow keys               | Nudge the focused node; the move is saved when you stop   |
  | Esc                      | Close the menu or dialog on top; else clear the selection |
  | Shift+F10                | Context menu for the selection                            |

- **Export:** _Export as draw.io…_ and _Export as image…_ in the "…" menu, the same commands in the Command Palette, and on a `*.flow.yaml` in the Explorer's right-click menu.
  - **draw.io:** every level is a page (subflow nodes link to their page). It looks like the canvas, and the node details are draw.io shape data (Edit Data, Ctrl+M): intent, binding and parameters, inputs and outputs, settings, open ports and problems.
  - **Images:** SVG, or PNG at twice the size, of the open level, the top level or every level. They are always light, and they embed the draw.io diagram (`.drawio.svg`, `.drawio.png`).
  - The flow stays the source: export again after a change ([how-to](../how-to/export.md)).
- **Copy and paste nodes:** select one or more nodes and press Ctrl+C (Cmd+C), or use _Copy_ in the Details or the selection panel, or _Ansible Flow: Copy Nodes_. The clipboard holds plain YAML: the nodes with their inner levels, the wires between them, their layout and their open-on-purpose decisions. Press Ctrl+V on any flow canvas (or _Ansible Flow: Paste Nodes_) to paste them on the open level, at the pointer, in one undo step. Or paste the text into any text file and keep it as a snippet.
  - In the right-click menu, _Copy_ takes the node you right-clicked (a selected group stays selected), and _Paste Here_ puts the nodes where you right-clicked. From the Edit menu or the palette, they go to your last click on the canvas.
  - Every pasted node, inner node and wire gets a new ID. A key the level already has gets `-2`, `-3`, …, and `from:` references between the pasted nodes follow it. References to nodes that were not copied stay as written.
  - Status `tested` becomes `implemented`: the copy has not run here. Wires to nodes that were not copied are dropped. Start nodes are not pasted.
  - Pasted into a subflow without inner steps, the first pasted node becomes its entry.
  - A snippet written by hand pastes too: one node, a list of nodes, or a `nodes:` mapping, for example `- {type: task, title: Check NTP}`.
- **Extract into Subflow:** Ctrl/Cmd+click or Shift+drag several connected nodes, then _Extract into Subflow_ in the right panel. The nodes and the wires between them move into a new subflow with their IDs, in one undo step.
  - Wires in must reach one node; wires out leave through the subflow's ports.
  - Outputs read outside become subflow outputs, and those references are rewritten.
  - It works inside subflows too.
- **Subflows:** double-click a subflow (or press Enter, or use _Open Subflow_) to open its inner steps.
  - The view shows a _Back_ button, a breadcrumb and chips for the context it inherits (inventory target, become, and `rolling, N at a time` for a rolling subflow: its steps run in batches, one batch through all of them before the next).
  - A dashed **boundary frame** carries the subflow's ports: `in` on top, outcomes below, problems on the right.
  - Drag from the frame's `in` to a step to make it the entry. Drag from an inner port to a frame port to make it an exit; an optional port is enabled on the subflow when needed.
  - Select an exit wire to give it a reason (shown on the wire, e.g. _SSH timeout_) or remove it.
  - The first step added to an empty subflow becomes its entry.
  - Everything inside works as on the top level, and each edit is one undo step.
  - The validator reports a missing entry, outer ports no inner step feeds, and inner outcomes that lead nowhere.
- **Preview card:** pause about 400 ms on a subflow or a bound node.
  - The card shows its binding and status, the inner steps in order with their exits and last-run results, the undo binding and the settings.
  - _Peek Code_ opens the generated play; _Open Subflow_ drills in.
- **Node details and binding:** a selected node's **Details** are docked on the right, resizable, with the tabs General, Binding, Inputs and outputs, Ports and Execution (Code and Run modes add theirs first). Fields save as you go; the binding is staged with _Save Binding_ / _Discard_, and leaving it unsaved (another node, level or mode, hiding the panel, the lens tab) asks first. The Binding tab of an unbound step starts at Find; once something is chosen, Configure comes first, with **Change module** (Find, open while another is chosen or the bound one is a problem) and **About** (its docs) folded below. _Expand_ shows the three side by side.
  - **Find:** Module, Role or Playbook. Module search runs over the environment's catalog, starting from the node's intent. Results are ranked by the words, ansible.builtin, the collections the repository uses and the inventory's platform (`ansible_network_os`), and carry badges: in EE, check mode, diff, read-only, other platform (dimmed), deprecated. Roles come from `roles_path` with their `meta/argument_specs.yml`; playbooks from the repository.
  - **About:** _Full Docs_ first, the module's docs as text, its parameter table, the returns (click one to make it a node output) and an example; a role's entry points and argument spec; a playbook's plays and the hosts they target.
  - **Configure:** a form from the argument spec (choices, booleans, one line per list item, YAML for dicts) in two groups, Required and Optional (set or added); **Add a parameter** finds the others by name, alias or description. Values are Jinja: `{{ name }}` or a field of it (`{{ name.stdout }}`) shows as a purple **input chip**, and typing `@` (or the @ button) offers node inputs, flow inputs, outputs of upstream nodes, the enclosing subflow's inputs, outputs of steps inside earlier subflows, and upstream module results. Choosing one that is not an input yet adds it with its `from:`; a step inside another subflow is lifted to that subflow's outputs in the same edit. After a result, or `.` typed right after its chip, the list offers the fields its module documents. Then the register name, a checklist (required parameters, where each variable comes from, check mode support, deprecation) and the generated task.
  - **Save binding** writes the binding, the inputs and outputs it added and the status (`implemented`) as one edit, one undo step. Renaming a node input later rewrites the parameters that read it.
- **Module catalog:** the first search in a folder asks the probe to dump every collection's docs in the environment (`ansible-doc --metadata-dump`, about 30 s for a full EE, only new versions later) into VS Code's global storage. A worker builds an SQLite FTS5 index per collection set (about 3 s), so searches take milliseconds. _Rebuild Module Catalog_ re-dumps. The last index also checks bindings when the probe is not running: modules missing from the EE, removed or deprecated, redirected names, missing or unknown parameters, no check mode.
- **Data between nodes:** an input `from: <node-key>.<output>` is passed to the node's play as a variable read from the upstream output. A module output `from: impl.register[.path]` reads the registered result; any other output is copied right after its step into the step's own variable (`afd_<key>__<output>`), so two steps may name outputs alike; `from: flow.<input>` reads the flow input. Unbound nodes with outputs set placeholder facts, so skeleton runs carry data through. A playbook binding imports the playbook with `afd_hosts` set to the arriving hosts; its plays should target `"{{ afd_hosts }}"`.
- **Data across subflows:**
  - inside a subflow, `from: <subflow-key>.<input>` reads the subflow's own input; the generated code follows it to where the input comes from;
  - a subflow output names the inner output it lifts (`from: <step>.<output>`); without `from` it lifts the inner output of the same name, and the validator warns (`subflow-output-unset`) when nothing inside sets it;
  - renaming a subflow input rewrites the inner reads;
  - the validator checks every name a step reads: parameters, `assert` `that:`, `debug` `var`, decision conditions and `until`. Each warning says where the value could come from.
- **Polling:** `settings.until` (a Jinja test without braces on the step's registered result) with `settings.retries` and `settings.delay` (seconds) makes a module step poll until a state is reached. Without `until`, retries stop on the first success.
- **Code mode:** the Code toggle in the top bar shows the same graph against the code.
  - **Re-sync from Git** compiles, in your Ansible environment, the flow's generated playbook, every bound role entry point and every bound playbook (`Playbook.load` + `compile`, not regex). It labels them with the branch, the HEAD commit and its time, and counts the uncommitted files of the flow, its roles and playbooks. It runs on the first visit and again after each save.
  - **Nodes** show what they run (`role: netops_validate`, `module: …`, `playbook: …`) and "N tasks · drift: outputs differ" (or TODO stub, last run, open subflow). Select one to see its tasks with file and line; click to open them.
  - **Design vs code** lists the nodes matched by ID (`node_<ULID>` tags) and the drift items, each with an action on both sides. Nothing is resolved automatically.
    - **Contract mismatch:** outputs the role does not set ("Design expects `validation_result`, code registers `diff_report`": _Update design_ renames the output and its downstream references, _Open code_); required role arguments the node does not pass; module result keys that do not exist.
    - **Code without design:** a role task file the subflow does not cover (_Add to subflow_ adds it as an unwired step, or _Ignore_); generated plays for nodes that are gone.
    - **Design without code:** an unbound node (_Generate stub_ writes `roles/<node_key>/` with a TODO task, output facts and `meta/argument_specs.yml` from the inputs, and binds the node in one edit; or _Bind role_); missing roles and playbooks; nodes without a play.
    - Roles without argument specs and dynamic includes (not expanded) are notes. *Write argument_specs* creates the specs from the node contract.
    - **Accept with Reason…** asks for a reason and records a `drift_ignored` decision in the flow with your Git user; ignored items stay listed with _Reopen_.
- **Run mode with AWX:** _Set Up AWX Template_ picks the AWX project, inventory, execution environment and credentials. It creates or updates the job template `AFD · <flow key>` for the generated playbook and writes its name to `flow.runtime`.
  - **Approvals:** a flow with top-level approvals runs in AWX as a workflow.
    - _Set Up AWX Template_ creates a job template per segment playbook (`generated/<key>.seg_<segment>.yml`, written on save) and the workflow `AFD · <flow key>`: the segments, an approval node at each gate (timeout from `settings.timeout`), and a finish path for when nobody reaches a gate.
    - Approving continues with the hosts waiting at the gate. Denying or a timeout sends them to `rejected`.
    - Hosts are failed only in the last segment, and a node on both sides of a gate runs once per host.
    - In Run mode the approval node shows waiting, approved, denied or timed out, with a link to decide it in AWX.
    - Approvals inside subflows, or two waiting at once, run only locally and as skeletons (auto-approved); the validator says why.
  - **Local runs** approve by themselves; the extra var `afd_approvals` takes another outcome per approval, by key path: `-e '{"afd_approvals": {"change-approval": "rejected"}}'`. A value the approval has no port for stops the run with an error. The generated playbook's header names the approvals.
  - _Launch in AWX_ (Code and Run modes, or the Command Palette) asks for the flow inputs and shows a confirmation with the targets and the commit, then launches the template with the inputs as extra vars. It follows the job's events until the job ends.
  - AWX runs the commit its project checks out. When that is not your HEAD (unpushed or uncommitted changes) you get a warning.
  - The token is checked against AWX before it is stored, in VS Code's secret storage only.
  - **Run mode** shows the last run (AWX or local) on the same canvas, read-only:
    - nodes show "3 hosts · 1 failed · 2.1 s", colored ok, warn (some hosts took a fail port), failed (a failure was not routed) or dimmed when not reached;
    - wires show how many hosts took them;
    - select a wire to list its hosts, or a node to see each host, the port it left through and why it failed; after a local run, _Output_ on a host shows what each task printed (msg, stdout, stderr, changed, rc; no_log tasks hidden, secret inputs replaced);
    - while a local run goes the canvas follows it: the running step pulses and reads "running…", done steps show their hosts as they finish, and a run started from the designer switches to Run mode. With the designer open the run's terminal stays in the background; it comes forward when the canvas cannot explain the run, and _Show Terminal_ or the notice after 20 s without events brings it;
    - with nothing selected the run panel shows the job, status, commit, flow version, failed hosts and _Open in AWX_.
  - **Tested:** after a passing real run of the current flow version (exit 0, every failure routed, no failed end), the run panel offers _Mark N nodes tested_ for the implemented nodes it ran: one edit you save. A tested node whose design changes later (anything but its status, position and wires) is implemented again, at once on the canvas or on save after a hand edit, with a message naming it.
- **Arrange:** Align Centers and Distribute Vertically for a selection (side panel, Shift+Alt+A / Shift+Alt+D), the other edges and horizontal spacing under the selection menu's _Arrange ▸_, each one undo step; guide lines and snap while a step is dragged; _Reset Position_ for placed steps; a palette step dropped on a wire goes into it.
- **Find filters:** `type:`, `status:`, `has:no-binding|binding|problems|errors`, `open:fail`, `tag:` and `target:` list steps across every level, alone or with words; the Readiness counts open Find with theirs. An unbound task reads "Task · not implemented yet".
- **Problems for every flow:** the Problems panel lists each flow's errors and warnings, open or not, read in the background (`afd.problems.scope`); a generated playbook edited by hand gets a warning with _Open the Flow_; the flow panel says what the workspace's flows need.
- **Flows view by folder:** each flow says its errors and warnings and whether its code is out of date, edited by hand or not generated yet (explained in the tooltip), with _Run as Skeleton_ and _Peek Code_ on it.
- **Changed outside the designer:** when an agent, a command line or another extension changes the open flow, a note over the canvas says how many steps and wires changed since the designer opened (or, for a flow changed while it was closed, since you last had it open), and they get a dashed outline (subflows around them a thin one); a list says what each change was ("Renamed A to B", "Copy the image: binding changed"), as do a changed step's Details and tooltip; _Show_ lights them, _Clear_ drops the marks; the Changes lens compares with the flow as it was before them. The designer's own edits, undo and typing in the flow's text editor are never marked.
- **Scenarios on the canvas:** after _Run Scenarios_, the run panel lists each scenario (pass or fail, the hosts that ended elsewhere) and shows one on the canvas like a run, with _Back to Last Run_; an end node lists the hosts expected there against where they ended. The notification's _Show on Canvas_ opens the first failing one.
- **Inventory view:** the Ansible Flows view's **Inventory** lists the groups and hosts the runs use, read in the Ansible environment; _Run Flow on This Group…_ opens the launch dialog with that group as the targets.
- **What the canvas shows:** in Code and Run modes and with a lens on, a line over the canvas says what the mode or the lens shows; when no step on the level has anything for the lens, it says why (the Inventory lens without flow targets offers _Set Targets…_).
- **Launch dialog:** _Run as Skeleton_ and _Run for Real…_ in the designer (and Ctrl+F5) open one dialog with every flow input (name, type, remembered value, what a list or dict reads as), the inventory's groups for host lists, the hosts the targets match (counted again as they change) and, for a real run, the confirmation's facts; _Run_ starts it with no further prompt, unless the inventory answers differently at that moment, when the dialog shows the new facts first. Secret inputs and the vault password are typed in the dialog and never kept. The Command Palette's run commands keep the input boxes and the confirmation.
- **Top bar:** the breadcrumb, the mode toggle, one _Lens_ dropdown, and the same actions in every mode: _Run as Skeleton_ (with _Run for Real…_ and _Launch in AWX_ under its arrow), _Stop_, _Generate Code_, _Export_ ▾ and a "…" menu (Tidy Up, Open in Text Editor, Check Flow, Keyboard Shortcuts, User Guide). What cannot run now is greyed out with a tooltip saying why. Code and Run modes read the graph; the palette folds away there.
- **Feedback:** messages at the bottom of the canvas say what _Generate Code_, _Check Flow_, _Tidy Up_, copy and paste came to (info, success, error; × closes one, errors stay longer); _Saving…_ there while an edit waits; a file with YAML errors shows its last valid version read-only, with _Open in Text Editor_.
- **Navigation:** _Ctrl+F_ finds a node on any level by title, key or binding and opens it where it is; the run panel lists the failed steps of every level; the palette folds to icons (its legend opens from _? Legend_) and the side panel folds to a strip; a level with only Start and End offers _Add a Step_, an import or a sample.
- **Flow format 2:** new flows are written in format 2; a format 1 flow still opens, runs and generates. _Upgrade Flow Format_ (the banner over the canvas, the Command Palette, or the AI op `upgrade_format`) moves it to 2 in one edit that one undo reverts; nothing is upgraded on open.
- **Status lifecycle:** in format 2 a node's status follows what it has (a binding: implemented; inputs or outputs: specified; a subflow: its least finished step), for the designer, the AI tools and MCP alike. Tested is the one status set by hand (_Mark Tested…_ with a reason) or by a passing run, and the node keeps the record of which; the runtime kind is worked out from the flow. The upgrade brings format 1 statuses in line and keeps why tested nodes are tested.
- **One kind of decision:** in format 2 every _Accept with Reason…_ (an open port, a drift item, a lens finding, and now a warning from the problems) is one `accepted` record keyed by what it accepts; a known warning, such as a variable `group_vars` sets, can be kept with a reason and stops showing. The upgrade converts the old kinds; the AI tools have `accept` / `unaccept`.
- **Lenses:** the top bar's _Lens_ dropdown (None, Inventory, Data, Code, Access, Timing; ✕ clears it) works in every mode. A lens fills the node chips across the flow (two at most) and opens a Lens tab in the right panel with its list and findings, beside the panel you had; hovering a row highlights its nodes. A lens never edits the flow. A selected step's Details show its lens findings in a fold with the same fixes, and where a list has a step inside a subflow, each row says where its step is, the same on every level; after a fix the next open finding gets the focus, and the tab keeps its scroll position.
  - **Inventory** reads the local environment's inventory through the probe when you open the lens. Chips show each node's target and host count; groups a node adds beyond the flow targets show as `+ core_spines · 2`; wires show last-run host counts. _Set targets…_ picks the flow targets, remembered for runs too. Findings: a handler that targets more than it receives (Rollback on `all`), groups that are not flow inputs, patterns that match nothing, production groups.
  - **Data** shows inputs and outputs and draws dotted data wires from `from:` references. Findings: unresolved inputs, outputs nothing reads.
  - **Code** shows each binding with its collection version and the execution environment. Findings: not in the environment, removed or deprecated, versions that do not meet `collections/requirements.yml`.
  - **Access** shows credentials, the inventory's connection user, become and vaulted variables (by name and file:line, never the value). Findings: a credential unlike the one its neighbours share, become alone, node credentials outside AWX.
  - **Changes** compares the flow with HEAD, another branch or a recent commit: chips on changed and added nodes, ghosts for removed ones, every change listed, and a node's field changes (before → after) in its Details.
  - **Timing** shows serial, timeout and average durations from the last 20 real runs started from VS Code. Findings: the slowest path does not fit `flow.maintenance_window` (set in the flow description), a node runs close to its timeout.
  - _Accept with Reason…_ keeps a finding with a required reason, recorded in the flow with your Git user (`finding_accepted`); _Reopen_ removes it.
- **Semantic zoom:** zoomed out, nodes show titles only. At default zoom they show their status and what they run, or a lens's two chips. From 1.4× the box lists summary rows. A selected node shows its Details on the right.
- **Playbook import:** _Import Ansible Playbooks…_ (Command Palette, or right-click a playbook or folder) turns a playbook, or the playbooks of a folder, into new flows: one step per task, in order, a faithful copy (checked by running both side by side). Plays and imported playbooks become subflows, blocks with rescue/always a subflow with its failure path, roles steps bound to the role (split roles a subflow, one step per task file), handlers steps that run when a notifier changed something. Registered and loaded variables are wired as inputs and outputs; vault values and prompted secrets are imported by name only. _Show notes_ lists what has no one-to-one form. **Re-import from Source** merges the playbook's later changes into the flow: steps the designer left alone take them, steps changed on both sides are conflicts to pick, new tasks become steps, gone ones are flagged; previewed, then one edit.
- **AI-assisted import:** both import commands offer _With an AI assistant_: the agent designs the flow by intent (subflows by purpose, the same modules and parameters). The command opens Copilot Chat with a ready prompt, or puts it on the clipboard for Claude Code, Codex and others. Agents read the source with `source_outline` (structure, and per task the binding to copy) and can make an exact copy with `flow_import`. For AWX, the extension writes a sanitized export (secrets by name only) for the agent; the token stays in VS Code.
- **Task keywords:** a binding carries Ansible task keywords (`when`, `loop`, `ignore_errors`, `delegate_to`, …) on the Execution tab, written on the generated task as is and checked like parameters.
- **AWX import:** _Import AWX Workflow or Job Template…_ turns a workflow or job template, read from AWX or from an `awx export` file, into a new flow laid out top-down at every level. It is a one-time copy: AWX is only read, and the flow description shows where it came from.
  - A job template node whose playbook is in this repository becomes a subflow of the playbook's steps; otherwise it is a draft task bound to the playbook, and the notes name the project. Node limit, tags, extra data, the machine credential, EE, become and timeout carry over. A job template on its own imports the same way, its limit as the flow's hosts.
  - Nested workflows become subflows; approvals stay approvals, with their timeout; project and inventory syncs become draft tasks.
  - `success` goes to `ok_hosts`, `failure` to `failed_hosts`, and `always` to both, because AWX counts it as a failure handler. Several children get a parallel node, several roots start in parallel, and convergence "all" gets a join.
  - A failure with no AWX path stays open, so the banner shows what AWX would fail on.
  - Survey questions and extra vars become flow inputs. Passwords, `$encrypted$` values and secret-looking names are imported by name only.
- **Run on another target (`inventory_target`):** a task (or a subflow, whose inner steps inherit it) with `settings.inventory_target` runs its work once on that pattern instead of on the hosts that arrive. For example, drain traffic on `edge_switches,core_spines`, or update the load balancers in `{{ lb_group }}`.
  - The arriving hosts leave together: `ok_hosts` when the target finished, `failed_hosts` when a target host failed. `max_fail_percentage` tolerates that share of the target. A pattern that matches no host also fails them.
  - The work gets `afd_arriving` (the arriving hosts) and reads upstream outputs from the first of them; its outputs come back from the first target host that finished.
  - Real-run and AWX confirmations name every target and its host count.
- **Engine limits the validator reports:** `unreachable` and `unchanged` on role nodes (Ansible gives no per-host signal for a role), and a `timeout` port without `settings.timeout`.

## Using it

- **New flow:** Command Palette → _Ansible Flow: New Flow…_ creates `flows/<key>/<key>.flow.yaml` in the workspace with a start and an end node. Or create an empty `*.flow.yaml` file anywhere: it opens in the designer with _Create a flow here_, which writes the same start (named after the file) in one undo step. A `*.flow.yaml` that does not parse shows why, with _Open in Text Editor_.
- **Import playbooks:** Command Palette → _Ansible Flow: Import Ansible Playbooks…_, or right-click a playbook or a folder in the Explorer. A folder lists its playbooks (top-level ones selected). Choose _As is_ (each becomes `flows/<key>/<key>.flow.yaml`, one step per task; the first opens, and _Show notes_ lists what did not map one to one) or _With an AI assistant_ (Copilot Chat opens with the prompt, or it is copied for another assistant, which designs the flow by intent).
- **Import an AWX workflow or job template:** Command Palette → _Ansible Flow: Import AWX Workflow or Job Template…_, then _From AWX_ (uses `afd.awx.url` and the stored token) or _From an export file…_ (`awx export --workflow_job_templates --job_templates > awx-export.json`). Pick a workflow or job template, the flow key, and _As is_ (the new flow opens; _Show notes_ lists what did not map one to one) or _With an AI assistant_ (a sanitized export goes to `flows/<key>/source/` for the assistant).
- **Open:** click any `*.flow.yaml` file. _Ansible Flow: Check Flow_, _Tidy Up_ and _Open in Text Editor_ are in the Command Palette and the top bar.
- **Compare with the code:** switch the top bar to _Code_; _Re-sync from Git_ (top of the panel) refreshes. Each drift item's buttons fix the design or open the code.
- **Bind:** select a node, then the **Binding** tab of its Details. Search, pick, fill in the parameters (`@` inserts inputs), _Save Binding_. _Rebuild Module Catalog_ in the Command Palette re-reads the environment's docs.
- **Review with a lens:** pick a lens in the top bar. For Inventory and Access, _Set Targets…_ in the Lens tab enters the flow targets; the refresh button reads the inventory again. Hover a row to see its nodes, use a finding's fix button, or _Accept with Reason…_.
- **Run in AWX:** set `afd.awx.url`, run _Ansible Flow: Set AWX Token_ and _Set Up AWX Template_ once per flow, commit and push, then _Launch in AWX_. Switch the top bar to _Run_ to see the results; select nodes and wires for hosts.
- **Run:** _Run as Skeleton_ in the top bar (or the play button in the editor title bar) runs the flow in check mode. The button next to it runs it for real after a confirmation. Other commands: _Generate Code_, _Check Flow_, _Show Run Audit Log_.

The smallest complete flow is the **Hello, Ansible** sample (`samples/hello.flow.yaml`, **Open Sample Flow…**); [how flows work](../explanation/how-flows-work.md) walks through it and the play it generates, and the [flow file format](flow-format.md) describes every field.

Ports per node type (the optional ones a new node can get):

| Type          | Default ports                    | Optional                                        |
| ------------- | -------------------------------- | ----------------------------------------------- |
| start         | `ok_hosts`                       | none                                            |
| end           | `in`                             | none                                            |
| task, subflow | `in`, `ok_hosts`, `failed_hosts` | `unreachable`, `unchanged`, `always`, `timeout` |
| decision      | `in`, `true`, `false`            | none                                            |
| approval      | `in`, `approved`, `rejected`     | `timeout`                                       |
| parallel      | `in`, `branch_1..n`              | none                                            |
| join          | `in`, `ok_hosts`                 | `failed_hosts`                                  |

## AI assistants

The extension teaches AI assistants the flow format and gives them tools that edit flows by key, so they never write IDs, wire ports a node does not have, or leave failures unhandled.

**Copilot (VS Code):** nothing to set up.
- The `ansible-flow` skill and the instructions for `*.flow.yaml` load when they are relevant.
- Ten tools are in agent mode and can be referenced with `#`: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`, `#flowNew`, `#flowCompleteIds`, `#flowExport`, `#sourceOutline`, `#flowImport`.
- An edit asks for confirmation and is one undo step. It is saved when the file had no unsaved changes, so the version bump and `generated/` follow as on any save.

**Other agents** (Claude Code, Codex, Gemini CLI, OpenCode, ZCode, GitHub Copilot CLI, Cursor) need the skill copied and the tools registered once:
- **Offered once:** after VS Code starts, the extension looks for these agents: a program on PATH, their config folder, an installed app or their VS Code extension. Agents found without the setup get one notice: _Set Up_ (all of them, for every repository, in one click), _Choose…_, _Not Now_ or _Don't Ask Again_. An agent is asked about again only if it is new.
- **By hand:** Command Palette → _Ansible Flow: Set Up AI Assistants…_
  1. Pick the agents. Each is marked as found (and why) or "not found: config only".
  2. Choose where the skill goes: _This repository_ (commit the copies to share them with the team) or _Just me_.
  3. Check the preview of every file and registration, then apply. Restart running agents.
- **Any other agent:** pick _Other agent…_. A guide opens with the MCP config for this machine (JSON and command line), and buttons to copy the skill to a folder you choose and the config to the clipboard.

| Agent                                       | Skill copy                                        | Flow tools (MCP server `ansible-flow`)         |
| ------------------------------------------- | ------------------------------------------------- | ---------------------------------------------- |
| Claude Code (CLI and its VS Code extension) | `.claude/skills/` or `~/.claude/skills/`          | `claude mcp add -s user` (run for you)         |
| Codex (CLI, app, VS Code extension)         | `.agents/skills/` or `~/.agents/skills/`          | marked block in `~/.codex/config.toml`         |
| Gemini CLI                                  | `.agents/skills/` or `~/.gemini/skills/`          | `mcpServers` in `~/.gemini/settings.json`      |
| OpenCode                                    | `.agents/skills/` or `~/.agents/skills/` (shared) | `mcp` in `~/.config/opencode/opencode.json(c)` |
| ZCode                                       | `.agents/skills/` or `~/.agents/skills/` (shared) | `mcpServers` in `~/.agents/mcp.json`           |
| GitHub Copilot CLI                          | `.github/skills/` or `~/.copilot/skills/`         | `mcpServers` in `~/.copilot/mcp-config.json`   |
| Cursor                                      | `.claude/skills/` or `~/.claude/skills/` (shared) | `mcpServers` in `~/.cursor/mcp.json`           |
- The server runs on `node` when Node 20+ is on PATH, else on VS Code's own runtime. No Node install is needed.
- Config files get a one-time `.afd-backup` copy before the first change. Entries you wrote yourself are left alone.
- After an extension update the setup offers to update itself once.
- _Ansible Flow: Remove AI Assistant Setup…_ removes only what setup wrote.
- Gemini enables MCP servers only in trusted folders: accept its trust prompt for the repository.
- A config file that does not parse is left alone and reported in the preview.
- Without the claude CLI on PATH, setup offers the `claude mcp add …` command to copy.

**What the tools do:**
- `flow_describe` shows a flow by key: nodes, wires `precheck.ok_hosts -> check-ntp`, subflows as `fix-ntp/push-config`, open fail ports and a revision.
- `flow_edit` takes a batch of ops in order, all or nothing, e.g.:

  ```json
  {"ops": [
    {"op": "add_node", "type": "task", "title": "Check NTP", "on_wire": "precheck.ok_hosts"},
    {"op": "apply_pattern", "at": "check-ntp.failed_hosts", "pattern": "notify-stop"}
  ]}
  ```

  Errors name the op and how to fix it ("No node "chek-ntp"; did you mean check-ntp?"), and nothing is written. The answer lists the nodes created and the problems the edit added or solved, counted one by one.
- `set_io` takes a path into another subflow as `from:` (`precheck/normalize-facts.fos_platform`): the subflow gets an output that lifts it, the field reads `precheck.fos_platform`, and the answer says so.
- `apply_pattern` takes an `end` to choose the end node; the answer names the end it used.
- `flow_export` writes a draw.io file (a page per level, node details as shape data) or SVG images of a level or every level next to the flow. PNG comes only from VS Code's _Export as image_.
- **Layout:** agents leave positions out unless you ask for an arrangement; the canvas places those nodes next to their neighbours. To arrange, `add_node`, `apply_pattern` and `extract_subflow` take a `position` (`{x, y}`, or `below` / `above` / `right_of` / `left_of` a node, with a `gap`), `move` places nodes later and `unplace` hands them back to the canvas. `flow_describe` with `layout: true` shows each node `at x,y` (stored) or `auto x,y`. The first position on an auto-laid-out level also stores the others where they are shown, and a position that overlaps another node is reported in the answer.
- `flow_new` starts a flow as `start -> done`, keyed by its file name. `add_node` with `after: "start.ok_hosts"` puts the first step between them, and each next `after` grows the chain: on a port that is already wired, the new node goes on that wire.
- A terminal agent's edit acts like a save in the designer:
  - `flow.version` moves once per commit;
  - tested nodes that changed drop back to implemented;
  - `generated/` is refreshed, keeping files edited by hand.
- Tools touch only `*.flow.yaml` inside the workspace (Copilot) or the agent's roots, else its working folder (MCP).

**Hand-written YAML:**
- An assistant without the tools, or you, can write a flow or a snippet without `id:` lines and name nodes by key in wires and references.
- The designer shows it with a _Written by hand_ banner. The Problems panel lists each gap (`missing-id`).
- _Complete IDs_ (the banner button, the lightbulb quick fix, or the command) adds the IDs in one edit, which one undo reverts.
- Paste does the same for snippets.

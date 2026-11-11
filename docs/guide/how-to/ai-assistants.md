# AI assistants

The extension teaches AI assistants the flow format and gives them tools that edit flows by key. So
they never write IDs, never wire ports a node does not have, and never leave failures unhandled
silently. A step-by-step example: [Tutorial 4](../tutorials/04-ai-assistant.md).

## Copilot: nothing to set up

- In **agent mode**, the `ansible-flow` skill and the instructions for `*.flow.yaml` load when they
  are relevant.
- Eleven tools: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`,
  `#flowNew`, `#flowCompleteIds`, `#flowExport`, `#sourceOutline`, `#flowImport`,
  `#flowScenarios`.
- An edit asks for confirmation and is one undo step. It is saved when the file had no unsaved
  changes, so the version bump and `generated/` follow.

## The agent built into Cursor, Kiro, Antigravity IDE or Devin Desktop

These editors install extensions from Open VSX:
[Ansible Flow Designer on Open VSX](https://open-vsx.org/extension/chistokhinsv/ansible-flow-designer).
Their own agents do not read Copilot's tools, so the extension gives them the same flow tools (its
MCP server) and the `ansible-flow` skill:

- **Cursor:** automatically. The extension registers the tools through Cursor's extension API each
  time it starts, for the folders you have open; the agent lists them as `extension-ansible-flow`.
  Nothing is written for the tools. If no copy of the skill is in a folder Cursor reads, you are
  asked once to put one in `~/.claude/skills/`.
- **Kiro, Antigravity IDE, Devin Desktop:** these agents read files only. The first time the
  designer shows a flow with a step, one notice asks to set the agent up and names the files it
  writes:

  | Editor                   | Flow tools                                                                           | Skill                         |
  | ------------------------ | ------------------------------------------------------------------------------------ | ----------------------------- |
  | Kiro                     | `~/.kiro/settings/mcp.json`                                                          | `~/.kiro/skills/`             |
  | Antigravity IDE          | `~/.gemini/config/mcp_config.json` (loaded at once)                                  | `~/.gemini/config/skills/`    |
  | Devin Desktop (Windsurf) | Devin's `mcp_config.json` (`%APPDATA%devin` on Windows, `~/.config/devin` elsewhere) | `~/.codeium/windsurf/skills/` |

  After **Set Up**, they are kept up to date at each start. Devin uses them with its agent set to
  **local**; it also runs the tools registered for Claude Code or Cursor, so it gets no second entry
  then.
- **Turn it off** with `afd.ai.hostIntegration`. **Remove AI Assistant Setup…** takes it back.
- Kiro, Antigravity and Devin ask before each tool call; Kiro lets you approve a tool for good.

## Other agents: set up once

| Agent                                       | Skill copy (repository / just me)                 | Flow tools (MCP server `ansible-flow`)             |
| ------------------------------------------- | ------------------------------------------------- | -------------------------------------------------- |
| Claude Code (CLI and its VS Code extension) | `.claude/skills/` / `~/.claude/skills/`           | `claude mcp add -s user` (run for you)             |
| Codex (CLI, app, VS Code extension)         | `.agents/skills/` / `~/.agents/skills/`           | marked block in `~/.codex/config.toml`             |
| Gemini CLI                                  | `.agents/skills/` / `~/.gemini/skills/`           | `mcpServers` in `~/.gemini/settings.json`          |
| OpenCode                                    | `.agents/skills/` / `~/.agents/skills/`           | `mcp` in `~/.config/opencode/opencode.json(c)`     |
| ZCode                                       | `.agents/skills/` / `~/.agents/skills/`           | `mcpServers` in `~/.agents/mcp.json`               |
| GitHub Copilot CLI                          | `.github/skills/` / `~/.copilot/skills/`          | `mcpServers` in `~/.copilot/mcp-config.json`       |
| Cursor                                      | `.claude/skills/` / `~/.claude/skills/`           | `mcpServers` in `~/.cursor/mcp.json`               |
| Kiro                                        | `.kiro/skills/` / `~/.kiro/skills/`               | `mcpServers` in `~/.kiro/settings/mcp.json`        |
| Antigravity IDE                             | `.agents/skills/` / `~/.gemini/config/skills/`    | `mcpServers` in `~/.gemini/config/mcp_config.json` |
| Devin Desktop (Windsurf)                    | `.agents/skills/` / `~/.codeium/windsurf/skills/` | `mcpServers` in Devin's `mcp_config.json`          |
- **Offered once:** the first time the designer shows a flow with a step, the extension looks for
  these agents (a program on PATH, their config folder, an installed app, their VS Code extension).
  Agents found without the setup get one notice: **Set Up…** (all of them, for every repository;
  you see what it writes first), **Choose…**, **Not Now** or **Don't Ask Again**. An agent is asked
  about again only when it is new.
- **By hand:** **Ansible Flow: Set Up AI Assistants…** → pick agents → choose **This repository**
  (commit the copies for your team) or **Just me** → check the preview → apply. Restart running
  agents.
- **Any other agent:** pick **Other agent…**. A guide opens with this machine's MCP config (JSON and
  command line), and buttons to copy the skill to a folder you choose and the config to the
  clipboard.

Good to know:
- the server runs on `node` when Node 20+ is on PATH, else on VS Code's own runtime;
- config files get a one-time `.afd-backup` copy; entries you wrote yourself are left alone, and a
  config that does not parse is left alone and reported;
- after an extension update, the setup offers to update itself once;
- **Ansible Flow: Remove AI Assistant Setup…** removes only what setup wrote;
- Gemini enables MCP servers only in trusted folders: accept its trust prompt;
- the server works in the folders the agent names (MCP roots), else in the folder it was started
  in, but never searches your whole home folder: an agent that starts it there without naming a
  folder gets "No folder to work in". Cursor's entry passes `${workspaceFolder}`; another agent can
  pass the folder as `AFD_MCP_ROOTS`.

## What the tools do

| Tool                | Does                                                                                                                               |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `flow_list`         | finds the flows in the workspace                                                                                                   |
| `flow_describe`     | shows a flow by key: nodes, wires `precheck.ok_hosts -> check-ntp`, subflows as `fix-ntp/push-config`, open fail ports, a revision |
| `flow_validate`     | lists problems, each with its fix                                                                                                  |
| `flow_reference`    | the format, ports, patterns, ops and problem codes                                                                                 |
| `flow_edit`         | a batch of ops, in order, all or nothing                                                                                           |
| `flow_new`          | a new flow, `start -> done`, keyed by its file name                                                                                |
| `flow_complete_ids` | adds the IDs a hand-written flow lacks                                                                                             |
| `flow_export`       | writes a draw.io file (a page per level, node details as data) or SVG images of the flow ([export](export.md))                     |
| `source_outline`    | reads a playbook, a folder, a role or an AWX export: its structure, and per task the binding to copy ([import](import.md))         |
| `flow_import`       | imports a playbook or an AWX template one to one, one step per task ([import](import.md))                                          |
| `flow_scenarios`    | lists, checks, adds, updates and deletes [scenario tests](scenario-tests.md), and verifies them in Ansible                         |
- **Large flows:** every answer stays under about 40,000 characters; a longer one comes in pages
  (`page`) or says how to ask for less. `flow_validate` takes `summary: true` (problems by code,
  the fix once), `code`, `node` and `severity`; `flow_describe` takes `nodes`, `detail: brief`
  and, with `layout`, `only_problems`. `flow_import` answers with counts, notes, problems by code
  and the top level; `source_outline` takes `focus: "#3,#9"` or `"#25-#37"`, or `full: true`.
- **Accepting a warning:** `flow_validate` prints the key after each warning,
  `[accept: check:<code>:<subject>]`, for the `accept` op; one that matches nothing is refused.
  Variables set outside the flow go into `external_vars` with `update_flow`, not one accept each.
- **Mechanical edits:** `rename` takes a key map, `replace_text` finds and replaces in bindings,
  `dissolve_subflow` moves a subflow's steps up (the reverse of `extract_subflow`), and
  `regenerate` writes `generated/` again after the file was changed outside the tools.
  `flow_validate` says whether `generated/` matches the flow.
- **Answers:** a `flow_edit` answer lists the nodes created, the problems it added or solved
  (counted one by one), and what it did besides the ops: a node put on a wire, an output lifted
  into a subflow, the end node a pattern used.
- **Subflows, not long chains:** agents put the steps of one purpose (pre-checks, backup, change,
  verify, rollback) in a [subflow](subflows.md). When an edit grows a level past 8 steps, the
  `flow_edit` answer names the level and its steps and suggests `extract_subflow`. Edits that do
  not add steps to that level get no hint, so a long imported flow is not flagged on every edit.
- **`set_io`** takes a path into another subflow (`precheck/normalize.fw_version`) and lifts it.
- **`apply_pattern`** takes an `end` to choose the end node.
- **Layout:** agents leave positions out unless you ask for an arrangement; the canvas places those
  nodes next to their neighbours. Ask "put the notify step under the rollback" and the agent passes
  a `position` (`{x, y}`, or `below` / `above` / `right_of` / `left_of` a node) to `add_node`, or
  uses `move` later; `unplace` hands nodes back to automatic placement and `tidy_up` lays out a
  level. `flow_describe` with `layout` shows where each node is. The first position on an
  automatically laid out level also stores the others where you see them, so nothing jumps.
- **Layout check:** agents cannot see the canvas, so `flow_describe` with `layout` also lists, per
  level, what would look wrong there: nodes or notes overlapping, a wire through a node, a wire
  label on a node or on another label, wires crossing. A `flow_edit` that places nodes (a
  `position`, `move`, `tidy_up`) checks the levels it laid out. If a level looks messy, ask "fix the
  layout of the change subflow": the agent moves nodes until the check is clean. Wires step round
  the nodes in their way by themselves, so after `tidy_up` what is left is mostly crossings; a wire
  still runs through a node only where there is no gap for it.
- **Terminal agents** write the file like a save: `flow.version` once per commit, tested nodes that
  changed drop back to implemented, `generated/` is refreshed. They touch only `*.flow.yaml` inside
  the agent's roots.

## See what an agent changed

When an agent (or a command line, a Git checkout, another extension) changes the flow file while
the designer has it open, the canvas redraws, and a note over it says what changed outside the
designer since you opened it: "2 steps and 1 wire changed outside the designer". The changed steps
and wires have a dashed outline. A subflow with a changed step inside has a thin dashed outline.

The same goes for changes made while the flow was closed: when you open it again, the note says
what changed "since you last had this flow open", with the day and time. The designer keeps what it
last showed of each flow in the workspace's storage, and forgets flows not opened for 90 days.

- **What changed** under the note lists each change in words: "Added Check the session table is
  empty, in Fail over to the peer, after Move the VIPs to the peer", "Renamed Check the policy is
  loaded to Check the policy and NAT rules are loaded", "Copy the image: binding changed (msg)",
  "Wire removed: Check (failed_hosts) → Stopped". A step put on a wire is one line: the wire it
  split and its subflow's new exit are part of it. Click a line to show its step. A changed step's
  Details and its tooltip on the canvas say the same.
- **Show** lights the changed steps and opens the first.
- **Clear** drops the marks.
- **The Changes lens** compares with the flow as it was before these changes ("the flow as you last
  had it open") while the marks are there, so a change pulled with Git, which is already in HEAD,
  still shows field by field. **Compare with** goes back to HEAD or a commit.

Your own edits are never marked: those in the designer, Undo and Redo, and typing in the flow's
text editor.

An agent that uses the flow tools through MCP (every agent except Copilot) writes the file the way
a save does. Whether **Undo** in the designer takes its change back depends on the editor: VS Code
and most editors built on it reload the file as one undoable change, Cursor does not. **Compare
with** and Git always can. The marks themselves stay apart from the **Changes** lens, which also shows your own
edits since the version it compares with.

## Hand-written YAML

An agent without the tools can still write a flow or a snippet by key, with no `id:` lines.
**Complete IDs** turns it into a normal flow ([hand-written YAML](hand-written-yaml.md)).

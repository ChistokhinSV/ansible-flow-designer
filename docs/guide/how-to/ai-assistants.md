# AI assistants

The extension teaches AI assistants the flow format and gives them tools that edit flows by key. So
they never write IDs, never wire ports a node does not have, and never leave failures unhandled
silently. A step-by-step example: [Tutorial 4](../tutorials/04-ai-assistant.md).

## Copilot: nothing to set up

- In **agent mode**, the `ansible-flow` skill and the instructions for `*.flow.yaml` load when they
  are relevant.
- Ten tools: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`,
  `#flowNew`, `#flowCompleteIds`, `#flowExport`, `#sourceOutline`, `#flowImport`.
- An edit asks for confirmation and is one undo step. It is saved when the file had no unsaved
  changes, so the version bump and `generated/` follow.

## Other agents: set up once

| Agent                                       | Skill copy (repository / just me)        | Flow tools (MCP server `ansible-flow`)         |
| ------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| Claude Code (CLI and its VS Code extension) | `.claude/skills/` / `~/.claude/skills/`  | `claude mcp add -s user` (run for you)         |
| Codex (CLI, app, VS Code extension)         | `.agents/skills/` / `~/.agents/skills/`  | marked block in `~/.codex/config.toml`         |
| Gemini CLI                                  | `.agents/skills/` / `~/.gemini/skills/`  | `mcpServers` in `~/.gemini/settings.json`      |
| OpenCode                                    | `.agents/skills/` / `~/.agents/skills/`  | `mcp` in `~/.config/opencode/opencode.json(c)` |
| ZCode                                       | `.agents/skills/` / `~/.agents/skills/`  | `mcpServers` in `~/.agents/mcp.json`           |
| GitHub Copilot CLI                          | `.github/skills/` / `~/.copilot/skills/` | `mcpServers` in `~/.copilot/mcp-config.json`   |
| Cursor                                      | `.claude/skills/` / `~/.claude/skills/`  | `mcpServers` in `~/.cursor/mcp.json`           |
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
- Gemini enables MCP servers only in trusted folders: accept its trust prompt.

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
- **Answers:** a `flow_edit` answer lists the nodes created, the problems it added or solved
  (counted one by one), and what it did besides the ops: a node put on a wire, an output lifted
  into a subflow, the end node a pattern used.
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

- **Show** lights the changed steps and opens the first.
- **Clear** drops the marks.

Your own edits are never marked: those in the designer, Undo and Redo, and typing in the flow's
text editor. The marks stay apart from the **Changes** lens, which compares with Git and so shows
your edits too.

## Hand-written YAML

An agent without the tools can still write a flow or a snippet by key, with no `id:` lines.
**Complete IDs** turns it into a normal flow ([hand-written YAML](hand-written-yaml.md)).

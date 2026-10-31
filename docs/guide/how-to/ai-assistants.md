# AI assistants

The extension teaches AI assistants the flow format and gives them tools that edit flows by key. So
they never write IDs, never wire ports a node does not have, and never leave failures unhandled
silently. A step-by-step example: [Tutorial 4](../tutorials/04-ai-assistant.md).

## Copilot: nothing to set up

- In **agent mode**, the `ansible-flow` skill and the instructions for `*.flow.yaml` load when they
  are relevant.
- Seven tools: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`,
  `#flowNew`, `#flowCompleteIds`.
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
- **Offered once:** after VS Code starts, the extension looks for these agents (a program on PATH,
  their config folder, an installed app, their VS Code extension). Agents found without the setup
  get one notice: **Set Up** (all of them, for every repository, in one click), **Choose…**, **Not
  Now** or **Don't Ask Again**. An agent is asked about again only when it is new.
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
- **Terminal agents** write the file like a save: `flow.version` once per commit, tested nodes that
  changed drop back to implemented, `generated/` is refreshed. They touch only `*.flow.yaml` inside
  the agent's roots.

## Hand-written YAML

An agent without the tools can still write a flow or a snippet by key, with no `id:` lines.
**Complete IDs** turns it into a normal flow ([hand-written YAML](hand-written-yaml.md)).

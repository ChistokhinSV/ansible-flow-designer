# ADR-0017 · AI assistants: skill, flow tools, MCP server

Status: Accepted · 2026-10-30 · AFD-19 · amended by AFD-20 (0.15.1), see the end

## Context

Flows are code, so AI assistants can edit them. Without help they guess badly: they invent ULIDs, wire ports a node type does not have, put two wires on one output, and leave fail ports open. The product owner wants diagram editing with AI to be easy for:
- the agents embedded in VS Code (Copilot, and Claude Code's extension, which runs the Claude Code CLI);
- terminal agents (Claude Code, Codex CLI, Gemini CLI).

Embedded agents get a skill and tools. What VS Code cannot install for an agent gets a clear setup command.

Decisions by the product owner (AFD-19):
1. Terminal agents get the same skill and tools as embedded ones.
2. Setup asks each time where the skill goes: this repository or just me.
3. A flow written by hand without IDs is accepted, and the _Complete IDs_ quick fix completes it.
4. The schema allows a missing `id` and key references; our validator reports them as errors.
5. A terminal agent's edit acts like a save: version bump and `generated/` refreshed, without overwriting hand edits.
6. AI tools may bind implementations; `tested` is refused (only runs set it, decision 15).
7. A Copilot edit is saved automatically when the file had no unsaved changes before.

Facts checked on 2026-10-30:
- **Copilot:** VS Code 1.109+ contributes `chatSkills` (with a `when` clause), `chatInstructions` and `languageModelTools` to Copilot without setup. Copilot also reads skill folders on disk: `.github/skills`, `.claude/skills` and `.agents/skills`, and `~/.copilot/skills`, `~/.claude/skills` and `~/.agents/skills`.
- **Claude Code** does not read `chatSkills`. It reads `.claude/skills` and `~/.claude/skills`, and MCP servers from `claude mcp add -s user`. `claude mcp get` prints the command and arguments.
- **Codex:** skills in `.agents/skills` and `~/.agents/skills`; MCP servers in `~/.codex/config.toml` under `[mcp_servers.<name>]`.
- **Gemini:** skills in `.gemini/skills`, `.agents/skills` and `~/.gemini/skills`; MCP servers under `mcpServers` in `~/.gemini/settings.json`. MCP servers stay disabled until the folder is trusted.
- **Runtime:** VS Code's own runtime runs the server with `ELECTRON_RUN_AS_NODE=1`. Claude Code connects to it from a path with spaces.

## Decision

**One tool core, two adapters.** `src/core/ai/` is pure: no VS Code, no file system.
- `refs.ts` names nodes by key (`check-ntp`), by path inside subflows (`fix-ntp/push-config`), and ports as `node.port`. It suggests the nearest keys and lists a node's ports in errors.
- `ops.ts` is the edit language: `add_node` (`after`, `on_wire`, `failed_to`, `in`), `update_node`, `delete`, `connect`, `disconnect`, `rewire`, `enable_port`/`disable_port`, `leave_open`/`reopen`, `apply_pattern`, `set_io`, `update_flow`, `set_entry`, `add_exit`/`remove_exit`, `extract_subflow`, `bind` and `tidy_up`.
  - Every op becomes existing FlowCommands; there are no new command kinds.
  - A batch runs in order and is all or nothing. A node created by one op can be used by later ops.
  - A batch first completes missing IDs.
  - Keys are computed explicitly, so a clash is an error rather than a silent `-2`.
- `describe.ts`: the flow by key, one line per node and wire, with open fail ports, decisions, problem counts and a `revision` (a checksum of the text).
- `specs.ts`: the op and tool input schemas. Field types are inlined from `flow.schema.json`, because some agents do not follow `$ref`. `checkOps` names the op and field of each mistake.
- `handlers.ts`: `flow_list`, `flow_describe`, `flow_validate`, `flow_reference`, `flow_edit {ops, revision?, dry_run?}`, `flow_new` and `flow_complete_ids`, over a `FlowIO`.
  - An edit with an old revision is refused, and the answer includes the current flow.
  - The answer lists the nodes created, the problems the edit added (compared by code, node key and port, not by message), and those it solved.
- No tool output contains an ID.

**Copilot** (`src/extension/ai/lmTools.ts`): `languageModelTools` named `afd_<tool>`.
- They read open documents, unsaved changes included.
- An edit is one WorkspaceEdit (one undo step). It is saved only when the file had no unsaved changes, so the usual save rules apply.
- Edits ask for confirmation in `prepareInvocation`; reads and dry runs do not.
- The `package.json` entries are generated from the specs (`just gen-ai`); a test keeps them equal.

**Terminal agents** (`src/mcp/` → `dist/mcp.js`, 800 KB, budget 900 KB): a stdio MCP server built with the low-level SDK `Server`.
- Roots are the client's MCP roots, else the working directory. Only `*.flow.yaml` inside a root is read or written, checked after resolving symlinks. Reads are capped at 2 MB.
- Calls run one at a time. Files are replaced atomically (temp file, then rename).
- A write is a save:
  - `planSave` drops back changed tested nodes and bumps `flow.version` once against `git show HEAD:`;
  - `planGenerated` (`src/core/engine/writePlan.ts`, now shared with the extension) refreshes `generated/`. It keeps hand-edited files and honours `afd.codegen.onSave`.

**Skill** `skills/ansible-flow/`:
- `SKILL.md` (written by hand, under 200 lines): the rules, the workflow, an ops cheat sheet and hand-editing without tools;
- `examples.md`, whose op batches run in a test;
- `references/format.md` and `references/ops.md`, generated from the schema descriptions, the port catalog, `PATTERNS`, the op specs and `FINDING_CODES`.

`instructions/ansible-flow.instructions.md` applies to `**/*.flow.yaml`.

**Setup** (`src/extension/ai/`): _Ansible Flow: Set Up AI Assistants…_ picks the agents (found on PATH or not), then the skill's place, then previews every change before applying it.
- **Skill copies** carry `.afd-skill.json` (version and file hashes): updates, hand edits and foreign folders are told apart.
  - This repository: `.claude/skills` and `.agents/skills`.
  - Just me: `~/.claude/skills`, `~/.agents/skills` and `~/.gemini/skills`.
- **MCP registration** is always for the user, because the launch path is machine specific:
  - **Claude:** `claude mcp add -s user`. Without the CLI, the command is offered to copy.
  - **Codex:** a marked block in `config.toml`. A table the user wrote stays untouched.
  - **Gemini:** one key set with `jsonc-parser`, so comments and other servers stay.
  - Each config file gets a one-time `*.afd-backup` copy.
- **Launch:** the server is copied to global storage, a path that survives updates. It runs on `node` when Node 20+ is on PATH, else on VS Code's runtime.
- **After an update**, or when that runtime moved, the extension offers once per version to update the setup.
- **Copilot duplicates:** while a copy of the skill exists where Copilot reads skills, the context key `afd.skillOnDisk` hides the built-in one.
- _Remove AI Assistant Setup…_ removes only what has our manifest or our server name.

**Schema** (amends ADR-0004):
- `id` is optional on the flow, nodes and edges.
- References may be keys (`$defs/nodeRef` = ULID or slug).
- Every property has a description, which agents and YAML hovers read; a test enforces it.

**Complete IDs** (`src/core/flow/completeIds.ts`):
- The validator reports each gap (`missing-id`, `unknown-key`) and checks the rest of the design on a copy with stable filled-in IDs.
- The designer shows the flow with a _Written by hand_ banner and refuses canvas edits until it is completed.
- The quick fix (also `source.afd.completeIds`) writes the missing IDs and replaces keys in one edit that keeps the rest of the text byte for byte. Paste completes hand-written snippets the same way.

## Consequences

- Agents edit by intent and get errors they can act on. A batch that fails writes nothing.
- The format a tool accepts and the reference an agent reads come from the same code; stale references fail the tests.
- The published schema is looser (`id` optional), but the designer still treats a missing ID as an error, so runs and codegen stay blocked until the flow is completed.
- A terminal agent's write can conflict with unsaved changes in VS Code. The revision check and VS Code's own conflict handling cover it, and git is the undo for terminal agents.
- The production `extension.js` grows by about 90 KB, to 539 KB (the tool core and its specs); the MCP server is a separate file that loads only when an agent starts it.
- Not verified here: Copilot itself (not in the test host), Codex (not installed), and a full Gemini run (installed, not signed in). Their configuration is covered by tests.

## Amendment: AFD-20 (0.15.1)

Context: in its first real use, Copilot's first edit failed. A new flow is `start -> done`, and `add_node` with `after: "start.ok_hosts"` was refused because the port was wired. Claude Code's VS Code extension drew PlantUML: setup had never run, and nothing told the user to run it, because the extension does not start in a folder without flows.

Decisions (product owner, 2026-10-30):
1. **`after` on a wired port** puts the node on that wire, and the answer says so. An end node still gets the error. Passing `after` and `on_wire` together is refused.
2. **Found agents without the setup** are offered it once.
   - The notice has _Set Up_ (all found agents, just me, one click), _Choose…_, _Not Now_ and _Don't Ask Again_.
   - An agent is asked about again only when it is new. The offered agents are kept in `afd.ai.offered`.
3. **Setup also covers OpenCode, ZCode, GitHub Copilot CLI and Cursor.** Any other agent gets _Other agent…_: a guide with this machine's MCP config, and the skill copied to a folder the user picks.
4. **The check runs after VS Code starts** (`onStartupFinished`).
5. **"Ansible flow diagram" is claimed by wording first:** the skill description, the server instructions and `flow_new`.

Facts checked on 2026-10-30:
- **ZCode** reads MCP servers from `~/.agents/mcp.json` (`mcpServers`) or `~/.zcode/config.json` (`mcp.servers`). Skills come from `~/.zcode/skills` and `~/.agents/skills`, and for a project from `.zcode/skills` and `.agents/skills`. Read from the app bundle.
- **OpenCode** reads `~/.config/opencode/opencode.json[c]` (`mcp`: `type: local`, `command` array, `environment`, `enabled`). Skills come from its own folders and `.claude/skills` and `.agents/skills`.
- **Copilot CLI** reads `~/.copilot/mcp-config.json` (`mcpServers`, `type: local`, `tools: ["*"]`) and `~/.copilot/skills`.
- **Cursor** reads `~/.cursor/mcp.json` and Claude's skill folders.

Design:
- **`writers.ts`:**
  - one writer for a key in a JSON(C) file covers Gemini, OpenCode, ZCode, Copilot CLI and Cursor;
  - a table maps each agent and scope to its skill folder, so agents that share a folder share one copy;
  - a config file that does not parse is skipped and left alone.
- **`agents.ts`** (no VS Code import) tells which agents are installed: a program on PATH (each PATH folder is listed once), a VS Code extension, a config folder or an installed app. It also writes the guide for other agents.
- **The flow schema compiles on first use.** That brings activation down from 160 ms to 7 ms against a stub. The bundle itself loads in about 100 ms, without VS Code's code cache.
  - Where a workspace has flows, the schema is compiled right after activation, so the first flow does not open more slowly.
  - Listing PATH for the agent check takes about 85 ms (95 folders), in the background.

Verified with Claude Code 2.1.308 headless, using the user's own CLAUDE.md (which prefers PlantUML) and the drawio skill:
- With the tools only, no skill, it built the flow with the tools, not PlantUML. Its first edit grew the chain with `after`. One op sent `"failed_to": null`, which now counts as not given.
- With the skill and the tools, every edit applied on the first try.
- Both flows ended with 0 problems, two levels, and every fail port handled.
- OpenCode 1.0.10 read the written `opencode.jsonc` and started the server.
- ZCode, Copilot CLI and Cursor are covered by tests of the written files only.

## Amendment: AFD-24 (0.18.0)

Context: agents could not set positions. Only `tidy_up` wrote them (ELK), so a request like "put the notify step under the rollback" could not be followed, and the tools did not say how unplaced nodes are shown (AFD-23 found the canvas placing them).

Decisions (product owner, 2026-10-31):
1. **Absolute and relative places.** `{x, y}` is the top-left corner in canvas pixels, per level. Or `below` / `above` / `right_of` / `left_of` a node on the same level, with an optional `gap` (defaults: 56 px vertical, 48 px beside).
2. **Ops:** `position` on `add_node`, `apply_pattern` (the handler, or its new end) and `extract_subflow`; a `move` op for later; an `unplace` op that drops stored positions (nodes, or a level: `top`, `all`, a subflow key).
3. **Freeze like the canvas.** The first position on an auto-laid-out level also stores the other nodes where the canvas shows them, as a drag does.
4. **Positions on request:** `flow_describe` with `layout: true` lists `at x,y` (stored) or `auto x,y` (shown by the canvas).
5. **Overlaps are allowed**, and the answer names what overlaps.
6. **Agents leave positions out unless the user asks for an arrangement** (skill, MCP instructions, Copilot instructions).

Design:
- **Op handling** (`core/ai/ops.ts`):
  - places resolve against what the canvas shows (stored positions plus ELK's auto positions), taken from `OpsContext.positions`. The core stays free of ELK; the extension (`lmTools`) and the MCP server (`fsIO`) pass `shownPositions` from `extension/autoLayout.ts`;
  - a relative place starts centred under or over its reference node, or level with it beside, and steps right (vertical relations) or down (beside) until it overlaps nothing;
  - `move` resolves its nodes in order, so one place can name a node moved before it in the same op.
- **Commands:** `unplaceNodes` deletes layout keys, and the whole block when it empties. Like `moveNodes`, it is not a design change, so `flow.version` does not move.
- **Shared wording:** one rules text (`LAYOUT_RULES` in `specs.ts`) covers coordinates, node sizes (start/end 136x40, others 208x76) and auto-placement. Every place-taking op's schema, `move`, `unplace`, and the `flow_describe` header with `layout` carry it, so the generated references and Copilot tools say the same.

Consequences:
- Agents can arrange a flow and follow layout requests without `tidy_up` replacing the whole level.
- A place needs `OpsContext.positions`. Without it (a host that cannot run ELK), ops that take a place fail with "positions are not available here"; both shipped hosts provide it.
- An agent that places by numbers without reading the layout can overlap nodes. The answer reports it, and `move` or `unplace` repairs it.

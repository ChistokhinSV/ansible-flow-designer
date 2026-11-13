# ADR-0023 · Host layering, commands and errors

Status: Accepted · 2026-10-31 · AFD-37 (improvement program, KB AFD-A-17). Amends ADR-0001 and ADR-0017.

## Context

The improvement review found:
- ten modules under `src/extension` that never import `vscode`, two of them imported by the MCP server and the CLI;
- `activate()` registering 21 commands inline in about 400 lines, with five ways of finding "the flow the user means", some of which did nothing when no flow was open;
- errors told apart by matching words in messages (`/Set Up AWX Template/`, `'Cancelled'` in 24 places);
- the same run preamble (save, folder, generate, parse) and audit header in the local run, both AWX launch paths and the syntax check;
- Copilot's tools and the MCP server reading import sources with different rules (no size cap or symlink check in VS Code; a multi-root bug for module resolution);
- the MCP server installer hashing about 2.4 MB at every start;
- only the MCP bundle under a size budget.

## Decision

**Layers** (enforced by Biome `noRestrictedImports`):

| Layer                | May use                                                                       | Holds                                                                                                                                               |
| -------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core`           | nothing outside the core (no `vscode`, no `node:fs`, no `node:child_process`) | the model, commands, validation, codegen, AI tools, imports, exports                                                                                |
| `src/node`           | Node APIs                                                                     | layout (ELK), the AWX client and workflow follower, the catalog index and worker, the probe client, agent detection and config writers, run storage |
| `src/mcp`, `src/cli` | core, node                                                                    | the MCP server, the lab CLI                                                                                                                         |
| `src/extension`      | everything, `vscode`                                                          | the VS Code adapter                                                                                                                                 |
| `src/webview`        | core (browser-safe)                                                           | the designer                                                                                                                                        |

**Composition:** `extension.ts` composes; `Host` (`host.ts`) holds the services and the sessions; commands live per area (`commands/flowCommands.ts`, `runCommands.ts`, `importCommands.ts`; help, export, AI setup as before); `documents.ts` the flow documents' lifecycle and the save rules; `testApi.ts` the test API.

**The flow a command means:** `Host.targetUri(arg)` (the argument, the active designer, a flow open as text) and `resolveTargetFlow(arg)`, which says "Open a flow first" with _New Flow…_ instead of doing nothing (quiet in test mode). Folder-scoped commands (AWX token, catalog) use `scopeUri`.

**Errors:** `RunView.errorCode` (`cancelled`, `awx-url`, `awx-token`, `awx-template`) and `showOutcomeError` (`errors.ts`), which adds the button that fixes it; `CANCELLED` / `isCancelled` for pick and prompt outcomes. One log: the _Ansible Flow_ `LogOutputChannel` (probe, AI setup).

**Runs:** `run/prepare.ts` (`prepareRun`, `auditHeader`, `stamp`) and `run/inputs.ts` (the inputs helpers lenses and AWX share).

**Import sources:** `core/ai/sourceRules.ts` (file kinds, 2 MB cap, skipped folders) used by both adapters; Copilot's tools also check symlinks stay in the folder, and resolve module names with the folder the source came from.

**Startup and size:** `installServer` compares the size and modification time recorded at the last copy; production builds fail past 960 KB (`mcp.js`, 954 KB now), 768 KB (`extension.js`, 714 KB) or 1,088 KB (webview `index.js`, 967 KB).

## Consequences

- MCP and the CLI no longer import from `src/extension`.
- The MCP bundle has 6 KB of room; wave 4's core additions will need it raised or the SDK's footprint (267 KB of the 954) reduced. That decision is due with AFD-49. **Decided 2026-11-01:** the budget is raised to 1,088 KB, as the webview's (product owner); the SDK stays.

## Amendment: flow sessions (AFD-38, 2026-10-31)

- **Problems before layout:** `FlowSession.build` sets diagnostics right after validation, only when the build is for the current document version; `built` and `lastGood` are only replaced by a build of the same or a newer version. Before, a build awaited ELK before setting diagnostics, so an older build finishing late could write problems for text that had changed.
- **Typing settles:** text changes go through `FlowSession.changed()`: the designer's own commands (the text equals the parse the command produced) and changes with no visible text editor (undo in the designer) refresh at once; typing in a visible text editor refreshes after 150 ms.
- **Controllers:** `LensController` (lens facts, targets, the Timing history) and `SyncController` (code sync, drift actions) own their state; `FlowSession` keeps thin methods for the panels and the test API. `RequestTracker<T>` answers PNG drawing and DOM summary requests by id with a timeout.
- **Not done:** computing the "freeze unplaced positions" maps on the host. The webview has one helper (`unplacedPositions`) called from six actions, each with the view it acts on; moving it would change every command's protocol for no behaviour change. The message router stays a `switch`, which is already one table.

## Amendment: core, one rule in one place (AFD-40, 2026-10-31)

A pure refactor: generated code, routes, plays, findings, open ports, level and frame views, and import output are byte-identical for every flow file in the repository (21), and the import goldens pass.

- **Bubbling** (`core/flow/bubbling.ts`): what takes a level's ports (`levelTaken`: wires, boundary exits), `untakenFailPorts`, `bubbles` (an untaken fail port leaves by the parent's port of the same name), `fedByBubbling`, `unreachableBubbles` and `openOnPurpose`. Used by the open-port banner, Option A's routing and rescue comments, the subflow frame, the boundary check and Extract into Subflow (5 copies before).
- **Lifting** (`core/flow/lift.ts`): `existingLift`, `liftName` (the output's own name, else `<key>_<output>`, then `_2`, `_3`), `liftField`. Used by references into subflows (`liftOne`) and Extract into Subflow, which now also numbers a second clash instead of writing the same output name twice.
- **Walking** (`core/flow/walk.ts`): `walkNodes` and `descendantIds`, for design fingerprints, the clipboard, commands and both importers. Levels with paths stay in `buildModel`; `completeIds` keeps its own level walk because it must see nodes without IDs, which the model does not index.
- **Builder** (`core/flow/builder.ts`): `LevelBuilder` (nodes, wires, taken keys, the start node) and `importedFlow` (the document of an import), used by the AWX and playbook importers. Paste edits YAML with remapped IDs and the new-flow template writes text, so they keep their own code.
- **Data names** (`core/flow/dataNames.ts`): `groupPart`, `registerName`, `outputVar`; approval segments moved to `core/flow/segments.ts`. The validator no longer imports the engine, and Biome refuses `../engine` imports in `src/core/flow`.
- **Engine choice** (`core/engine/engines.ts`): `engineFor(doc)` (Option A, ADR-0003) replaces the 7 direct `optionA.generate` calls outside tests.
- **Not done:** the playbook import's own lift (one output name per variable, type `any`) stays: it matches how outputs compile today (one host fact per name) and changes with per-node capture (AFD-53).

## Amendment: extension.js budget (AFD-63, 2026-11-02)

After wave 5 (0.39.1), `extension.js` was 765 KB of its 768 KB budget, so the next host feature would fail the production build. The product owner raised the budget to 832 KB, as was done for `mcp.js`, rather than moving host code into a lazy chunk. The other budgets stay: `mcp.js` 1,088 KB (966 KB now), webview `index.js` 1,088 KB (1,020 KB).

## Amendment: webview budget 1,152 KB (AFD-80, 2026-11-04)

AFD-80 left the webview's `index.js` at 1,087 KB of its 1,088 KB budget. Wave 8 still adds a
launch dialog, live runs, scenario results, marks and arrange tools to the webview. The wave's
plan, approved by the product owner, raises the budget to 1,152 KB. The other budgets stay:
`extension.js` 832 KB (809 KB now), `mcp.js` 1,088 KB (1,002 KB).

## Amendment: extension.js budget 864 KB (AFD-92, 2026-11-05)

AFD-92 took the host bundle to 835 KB, past 832. As wave 8's plan allowed, the budget is now
864 KB.

## Amendment: webview budget 1,216 KB (AFD-103, 2026-11-07)

Wave 9 left the webview's `index.js` at about 1,140 KB of 1,152. Wave 10 adds to it: the
Execution tab's folds, Timing sentence, keyword chips and YAML box (AFD-103), the outside-change
list (AFD-104) and the inputs editor's default (AFD-106). The product owner chose to raise the
budget to 1,216 KB rather than cut any of it, with no new library: the YAML box colours its lines
with its own small tokenizer (`core/view/yamlText.ts`), not an editor component. The other budgets
stay: `extension.js` 864 KB, `mcp.js` 1,088 KB.

## Amendment: extension.js budget 960 KB (AFD-172, 2026-11-08)

The budget was 928 KB by the 0.74 releases. Epic AFD-170 (agents built into VS Code forks) took `extension.js` to about 936 KB, adding:

- the API checks above the engine floor (`compat.ts`);
- the editor and agent-config table (`node/ai/hosts.ts`, `hostConfig.ts`);
- **Show AI Integration Diagnostics**;
- the developer experiments.

Phase 2 (AFD-173/174) adds the integration for each editor, so the budget is now 960 KB. The experiments go when Phase 2 lands. The other budgets stay: `mcp.js` 1,088 KB, webview 1,216 KB.

## Amendment: budgets 1,024 KB and 1,152 KB (AFD-197, 2026-11-09)

The fixes for agents converting large playbooks (AFD-176 to AFD-196) went into the core both bundles carry:

- import paths and include handling;
- Jinja scopes in the checker;
- paging and summaries in the tools;
- the dissolve, rename and replace ops;
- named exits;
- the repair of stale agent registrations.

`extension.js` reached about 968 KB and `mcp.js` about 1,100 KB. The budgets are now 1,024 KB and 1,152 KB. The webview stays at 1,216 KB.

## Amendment: a minify pass for the webview (AFD-223, 2026-11-12)

The webview's `index.js` was about 1,200 KB of its 1,216 KB budget. Most of the margin was lost to
whitespace: Vite's library mode keeps the whitespace and comments of an ES bundle even when it
minifies, so that a later bundler still sees the pure annotations. The webview bundle has no later
bundler. The production build now passes it through esbuild's minifier once more
(`scripts/build.mjs`, `minifyWebview`), with the same code and its legal comments kept. It is now
about 893 KB. The budget stays at 1,216 KB, which leaves room for the Jinja colouring and completion
in fields (AFD-221). The other budgets stay: `extension.js` 1,024 KB (987 KB now), `mcp.js` 1,152 KB
(1,111 KB).

## Amendment: the layers are also packages (AFD-266, 2026-11-13)

`src/core`, `src/node` and `src/webview` are published as `@ansible-flow/core`, `node` and
`designer` (ADR-0036). The layer rules do not change. Two things follow from them being used by
another repository:

- a file's path under `src/core` or `src/node` is an import path of a package, so a rename is a
  change the server sees;
- the package build fails when a file of these layers imports from outside its layer (other than
  `schema/`, and `src/core` for `src/node`), which the Biome rules did not check for `test/` or
  `probe/`.

The VSIX budgets stay as they are; the packages have none.

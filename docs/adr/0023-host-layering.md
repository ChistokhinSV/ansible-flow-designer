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
- The MCP bundle has 6 KB of room; wave 4's core additions will need it raised or the SDK's footprint (267 KB of the 954) reduced. That decision is due with AFD-49.

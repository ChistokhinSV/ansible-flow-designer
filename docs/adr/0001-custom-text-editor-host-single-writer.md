# ADR-0001 · Custom text editor; the extension host is the only writer

Status: Accepted · 2026-10-28 · AFD-1

## Context

The product ships as a VS Code extension (handoff doc 08). The flow file is text and must stay the source of truth, with VS Code's own save, dirty state, undo/redo, hot exit and Git integration.

## Decision

- `*.flow.yaml` opens in a `CustomTextEditorProvider` (`afd.flowEditor`). There is no server and no own document store.
- The webview never computes text. It sends intent commands that reference IDs (`moveNodes`, `addNode`, …). The host parses the current `TextDocument`, plans a minimal `TextEdit[]` with the new YAML edit engine (`src/core/yaml`) and applies one `WorkspaceEdit` per command, which makes each command one undo step.
- Document → webview: `onDidChangeTextDocument` → parse (cached by `document.version`) → validate → snapshot to every panel of that document. Unparseable text keeps the last good model under an error banner and refuses commands.
- Schema validation (ajv) and auto-layout (elkjs) run in the host: ajv compiles with `new Function`, which the webview CSP blocks; ELK on 5–15 nodes per level takes milliseconds, so no worker (which would need a `blob:` CSP).
- Webview: strict CSP (`default-src 'none'`, nonce scripts, styles/fonts from the extension only), `--vscode-*` theme variables, codicons, VS Code fonts (remote fonts are blocked), Ansible-derived text rendered as text only. `@vscode/webview-ui-toolkit` is not used (archived 2025-01-06).

## Consequences

Commands that target IDs are immune to version races. Undo, redo, revert and external edits all arrive as document changes and re-render the canvas.

## Amendment (AFD-17, 2026-10-30): copy and paste

- Copied nodes are plain text on the system clipboard, not an internal format. The text is YAML in the shape of a flow file (`nodes`, `edges`, `layout`, `decisions`) under one comment line, so it pastes into another flow or VS Code window and also reads well when it is kept in a text file as a snippet.
- The webview builds the copy from its snapshot: copying writes nothing to the document. Pasting is a host command (`pasteNodes`) like any other, and the host stays the only writer. It gives new IDs and level-unique keys and applies one edit.
- Keys reach the webview as the page's `copy` and `paste` events. On the desktop, VS Code prevents Ctrl+C and Ctrl+V in the webview, runs its Copy and Paste commands, and these call `execCommand` in the focused webview. Fields and selected text keep the browser's own copy and paste. Buttons and the palette commands go through the host (`vscode.env.clipboard`), since a webview cannot read the clipboard by itself.
- Chromium lets `execCommand` reach the page only after a real key press, which an integration test cannot make. The events are covered by webview tests, and the integration tests use the palette commands.

## Amendment (AFD-18 follow-up, 2026-10-30): auto-layout loads on first use

ELK (elkjs, the host-side auto-layout of this ADR) is three quarters of the host code and took about 160 ms to load at every activation. `autoLayout.ts` now imports it with a dynamic `import()` on the first layout. The build turns that import into a separate `dist/elk.js` (an esbuild plugin in `scripts/build.mjs`), which `.vscodeignore` ships. Vite (the harness) and Vitest resolve the package as before. A flow with a stored layout never loads ELK at all.

## Amendment: edits made outside the designer are marked (AFD-85, 2026-11-04)

The host stays the single writer of the designer's own edits. Other writers still change the
document: an agent through the MCP server or its own file tools, a command line, a Git checkout,
another extension. Round 1's participant could not see what an agent had changed, and the Changes
lens mixed their own edits in (P21).

- **Telling own edits from outside ones.** `FlowSession.changed(reason)` treats a change as the
  designer's own when:
  - its text is what a command wrote (`pendingParse`);
  - it is what Complete IDs or Create Flow wrote (`ownText`);
  - it is an undo or redo (`TextDocumentChangeEvent.reason`);
  - the flow's text editor is the active editor (the person typing).

  Anything else is an outside edit.
- **Marking.** On the next rebuild, the session compares the flow as shown with the flow now
  (`core/view/outsideChanges.ts`, on `diffFlows`). It adds the added or changed steps and the added
  wires to marks kept since the session started. The person's own later edits only drop marks on
  what is gone. The marks go to the panels (`outsideMarks`, again when a panel becomes ready), and
  Clear drops them (`clearOutside`).
- **Not detected.** A disk change while the flow's text editor is the active editor counts as the
  person's own.

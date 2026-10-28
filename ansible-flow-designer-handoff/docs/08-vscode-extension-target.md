# 08 · Target platform: a VS Code extension

**Change of target (product owner, 2026-10-28).** The designer ships as a **VS Code extension**, not a standalone web app. Docs 01–05 stay valid for the product: flow model, ports, lenses, Ansible mapping. Doc 06's *architecture* (React web frontend + FastAPI backend + database) is superseded by this file. Its milestones and open questions still apply.

Everything below is a **suggestion** with trade-offs, written from the predecessor's experience (07). Confirm with the product owner before committing.

## What VS Code changes, and what it gives for free

| Concern | Web-app plan (06) | VS Code extension |
|---|---|---|
| Opening a flow | Own file browser / API | `*.flow.yaml` opens in a **custom editor** (webview) from the Explorer; "Reopen with text editor" works |
| Source of truth, save, dirty state | Own store + backend writes | The **`TextDocument`** of the flow file. Save, dirty marker, hot exit, Git diff, Timeline and SCM come from VS Code |
| Undo / redo | Own history | VS Code's, *if* every canvas action is applied as a `WorkspaceEdit` to the document (see "Custom editor model") |
| Code view, YAML/Jinja editing | Out of scope (01) | Generated playbooks and roles open in normal VS Code editors. The Red Hat Ansible extension, if installed, provides language features there |
| Backend service | FastAPI server | **No server.** The extension host (Node/TS) holds the logic; Ansible-truth questions go to a Python **probe** (07 §1) as a child process |
| Auth / secrets (AWX tokens) | Own | `SecretStorage` |
| Settings | Own | `contributes.configuration` (EE image, interpreter, AWX URL…) |
| Caches (module docs per EE) | Database | `ExtensionContext.globalStorageUri` (per user), `storageUri` (per workspace) |
| Remote targets | n/a | **VS Code Remote (SSH / WSL / Dev Containers)** runs a workspace extension *next to Ansible*, which removes most Windows pain |

## Suggested architecture

```
VS Code
├─ extension host (TypeScript, bundled with esbuild)
│   ├─ FlowEditorProvider: CustomTextEditorProvider for *.flow.yaml
│   ├─ flow model: parse/validate (schema/flow.schema.json), semantic checks, minimal TextEdits (07 §7)
│   ├─ codegen: flow → generated/playbook.yml (Option A, 05), written via WorkspaceEdit
│   ├─ probe client: spawn + JSON-lines session (local | docker/podman EE | wsl | ssh), path mapping
│   ├─ caches: module catalog per EE (globalStorage), inventory per workspace
│   └─ AWX client (Run mode, M7), tokens in SecretStorage
├─ webview (React 19 + @xyflow/react 12): canvas, panels, inspector
│   └─ typed message protocol ⇄ extension host (one request/response + notification scheme)
└─ probe (Python, stdlib only, runs inside the Ansible environment)
    catalog dump/normalize · routing · inventory · vars/templating · playbook load/compile · syntax-check
```

### Custom editor model
- Use **`CustomTextEditorProvider`**, not `CustomEditorProvider`. The flow file is text; this gives native undo, dirty state, save and conflict handling.
- Every canvas action becomes a minimal `TextEdit` set, computed with a CST-based YAML editor (port the predecessor's doc-engine, 07 §7), and is applied with `workspace.applyEdit`.
- External changes (Git checkout, a text edit in a split editor) arrive through `onDidChangeTextDocument`. Re-parse and push to the webview, which keeps node identity by ULID.
- **Layout file (D-30) is a real decision here.** Edits to a *second* document (`<flow>.layout.yaml`) land on that document's undo stack, so Ctrl+Z in the canvas would not undo a drag. Options:
  - (a) keep `layout:` inside `flow.yaml` (single undo stack; diffs are confined to one block)
  - (b) a separate file with its own undo handling in the webview
  - (c) layout in workspace state (not shared through Git)

  Ask before M1.
- Validation results go to the **Problems panel** as `DiagnosticCollection` entries on the flow file (open fail ports, schema errors, boundary gaps), in addition to the canvas banner.

### Webview rules
- **Strict CSP:** `default-src 'none'`; scripts only with a nonce; styles from the extension; `localResourceRoots` limited to the bundled UI; no remote fetches.
  - Render all Ansible-derived text (module docs, inventory values) as text, never HTML (07 §8).
- **Theme:** use the `--vscode-*` CSS variables (editor background, foreground, focus border, button, input…) and codicons (`@vscode/codicons`) so light, dark and high-contrast work.
  - The palette in 04 (port and lens colors) must be checked for contrast on dark and high-contrast themes.
  - Color is never the only signal (04), which helps here.
- **Do not use `@vscode/webview-ui-toolkit`.** Microsoft archived it on 2025-01-06. Use plain components styled with the theme variables.
- Persist UI-only state (viewport, open panels) with `webview.setState` / `getState`. Use `retainContextWhenHidden` only if re-render cost proves it necessary.

### Ansible environment (probe)
- **Reuse the predecessor probe** (07 §1) almost as-is. The extension needs a TypeScript port of its session client: spawn, ready line, request ids, timeouts, restart, path mapping, Docker mount flags, the `ANSIBLE_CONFIG` fix.
- Environment sources, in order of preference:
  1. A workspace extension running under **VS Code Remote** (WSL / SSH / Dev Container) with Ansible installed: plain local mode.
  2. An **EE image** via Docker or Podman (`docker run -i … <ee-image>`), which also matches D-24's "search in the node's execution environment".
  3. Local venv.
  4. SSH host.
- **Coexist with the Red Hat Ansible extension (`redhat.ansible`):** it provides the language server (hover, completion, ansible-lint) and runs playbooks in EEs through ansible-navigator. Don't duplicate YAML/Jinja editing. Consider reading its interpreter and EE settings as defaults. Check the current setting names in its docs before relying on them.

### Module catalog storage (M5) — decide early
The predecessor kept SQLite FTS5 in Python (180 MB with full docs JSON for 9,656 plugins; search p95 17 ms). Options in an extension:
- (a) **keep search in Python:** the probe or a small sidecar owns the SQLite index in `globalStorage`. Python's `sqlite3` usually has FTS5; verify in the EE images.
- (b) the probe exports normalized docs as JSON per collection; the extension host builds an **in-memory JS index** (MiniSearch-like) on load. About 9k docs is small; only summaries and option names need to be indexed.
- (c) **sql.js** (WASM). Check whether its build includes FTS5.

Avoid native Node modules such as `better-sqlite3`: they force per-platform VSIX builds.

### Testing
- Pure TS logic (flow model, edits, codegen, port rules, Jinja scanner): Vitest.
- Extension integration: `@vscode/test-cli` / `@vscode/test-electron`.
- Probe: contract tests in the 2.19/2.20/2.21 images.
- Generated skeletons run for real in the probe image against the fictional inventory, with no devices (07 §5).
- Webview: component tests. Measure performance on production bundles only.

### Packaging
- esbuild for the extension host, Vite for the webview bundle, `vsce package`.
- The probe ships inside the VSIX as a `.pyz` resource.
- Minimum ansible-core: 2.19, because Origin tags and the trust model are what make sources and previews reliable (07 §4). Older cores degrade to values without sources.

## Questions to settle with the product owner (in addition to 06)
1. Layout storage under VS Code undo semantics: (a) / (b) / (c) above.
2. Catalog storage: Python SQLite vs JS index vs sql.js.
3. Which environments must work in v1: Remote-WSL / SSH / Dev Container, Docker/Podman EE, local venv. Is VS Code Remote the primary path on Windows?
4. Minimum VS Code version and ansible-core version (proposed: 2.19+).
5. Is `redhat.ansible` a hard dependency (`extensionDependencies`), a soft one (read its settings if present), or ignored?
6. Do flows live inside each automation repo (`flows/<key>/…`, per 05) or in a separate repo? This affects workspace discovery and multi-root support.
7. Marketplace publishing (publisher id, license) or internal VSIX only.
8. Can the predecessor's code be copied in (same author), or should it be re-implemented from the notes in 07?

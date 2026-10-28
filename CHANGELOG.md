# Changelog

## 0.1.0 — M1 (AFD-2)

- Custom editor for `*.flow.yaml` (`CustomTextEditorProvider`): the extension host is the only writer; every canvas action is one minimal `WorkspaceEdit`, so undo, dirty state and save are VS Code's.
- Byte-preserving YAML edit engine (`src/core/yaml`): path ops, style detection (EOL, indent, sequence indentation), YAML 1.1/1.2-safe quoting, anchor/alias guards; seeded fuzz harness.
- Flow model, port catalog, semantic validation and open fail ports with subflow bubbling; findings in the Problems panel.
- Schema v1 with additive fields: `join_mode`, `branches`, `handler`, `targets`, port names with digits.
- Design canvas (React Flow 12): node types and statuses, ports by side and state, wires by tone, far LOD; palette, Quick add, inspector, flow description, open-port banner.
- Layout in one flat `layout:` block; in-memory ELK auto-layout for flows without positions; Tidy up.
- `flow.version` bumped once per commit relative to Git HEAD.
- Theme tokens for light, dark and high-contrast themes with contrast tests; strict webview CSP.
- Tests: Vitest (core, webview), VS Code integration and performance suites; `just` recipes for everything.
- Decisions recorded in `docs/adr/0001`–`0007`.

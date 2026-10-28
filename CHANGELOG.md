# Changelog

## 0.2.0 — M2 (AFD-3)

- Progressive port disclosure (D-14): at rest only wired, open-fail and open-on-purpose ports; hover (with a margin zone), selection or an open menu reveals every port of the type with labels; dragging a wire reveals inputs. Ports keep fixed slots.
- Port menus (04 §3, mockup 07): suggestions per port kind for open ports, Insert / Rewire / Disconnect for wired ones, Connect from/to another node by clicking it; same items in the inspector with quick fixes for open fail ports.
- Failure patterns (D-16): Rollback from backup (reuses the level's Rollback), Notify on-call and stop, Retry with backoff (rejoins the happy path), Exclude and report, plus Stop flow, Connect/Skip to Done, Escalate approval, Send run report. One command, one undo step; palette drag onto a port or node.
- Open on purpose: reason required, `by` from Git user.name (fallback OS user), edit reason, reopen; wiring a port removes its decision in the same edit.
- New commands: `applyPattern`, `setDecision`, `clearDecision`, `rewire`, `addNode.insertOn`, `addNode.freeze`. Edge IDs survive rewire and insert.
- Validator: `rollback-unreachable` (D-09), `duplicate-decision`, `decision-not-fail`.
- Fixed: selecting a node created from code (Quick add, patterns) while another node was selected looped the canvas (React Flow selection echo).
- ADR-0008.

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

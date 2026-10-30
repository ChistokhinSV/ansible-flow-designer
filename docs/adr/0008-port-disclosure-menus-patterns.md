# ADR-0008 · Port disclosure, port menus and failure patterns

Status: Accepted · 2026-10-28 · AFD-3 (M2)

## Context

D-13 to D-16 and 04 §3 ask for ports that stay out of the way at rest, a contextual menu per port, failure patterns dropped onto open fail ports, and "open on purpose" decisions. Each action must stay one undo step (ADR-0001), and the same suggestions appear in three places: the canvas port menu, the inspector and the palette.

## Decision

- **Rendering.** Every port the node type supports is rendered as a React Flow handle, enabled or not, at a fixed slot per side (`legalPorts`), so ports never shift when others appear and a wire can be dragged to any of them (connecting enables an optional port in the same edit). Visibility is CSS only: connected, open-fail and open-on-purpose ports show at rest; hover (with a margin zone around the node and its labels), selection, an open port menu, a wire being dragged (inputs) or a pattern being dragged (problem ports) reveal the rest with labels.
- **Click vs drag.** `connectOnClick` is off and `connectionDragThreshold` is 4 px: a click opens the port menu, a drag draws a wire.
- **Menu content is pure.** `core/flow/portMenu.ts` derives the items from the model; the webview only executes them (`portActions.ts`). `unreachable` never offers Rollback (D-09), and the validator warns when one is wired that way anyway.
- **Patterns are recipes.** `core/flow/patterns.ts` describes each pattern as a handler node, an end node to reuse or create, and an optional rejoin to the source's happy path. The rollback pattern reuses the level's Rollback (`handler: rollback`, or key `rollback` in older flows). The command builds all nodes, edges, positions, port enabling and decision removal against one parse and applies them in one batch (one re-parse, about 25 ms for os-upgrade).
- **Decisions.** `setDecision` requires a non-empty reason; the host, not the webview, fills `by` from Git `user.name` (repository, then global), falling back to the OS user. Wiring a port removes its decision in the same edit, so `decision-on-connected` cannot arise from the canvas.
- **Edge identity.** Rewire and insert-on-wire keep the edge ID and its source; only `to` changes, and insert adds one new edge from the new node.
- **Selection** follows React Flow's user `select` changes (`onNodesChange`/`onEdgesChange`). `onSelectionChange` reports one commit late and fought a selection set from code (the node just created), which looped.

## Consequences

About nine handles per task node instead of three: first render of os-upgrade went from 89 to about 180 ms (budget 300) and a move round trip from 15 to about 30 ms (budget 100). Pattern code templates (syntax-checked snippets) come with M3 codegen; in M2 a pattern's intent drives the skeleton stub.

## Amendment (AFD-18, 2026-10-30): canvas menu, shortcuts, calmer top bar

- **Our menu.** A right-click on the canvas opens the designer's own context menu, not VS Code's native webview menu (`webview/context`). The native menu cannot change its items with the target, carry icons, show port suggestions or be tested. Our handlers call `preventDefault()`, and VS Code's webview script then shows no menu of its own. Text fields keep the native menu.
- **Pure model.** `src/core/flow/canvasMenu.ts` builds the entries per target and mode as data, reusing `portMenu`. One `Menu` component draws them and the port menu, with keyboard navigation and submenus.
- **Edits per mode.** Design and Implementation offer the same edits, because the canvas allows them in both. Run mode only reads.
- **Keys.** VS Code forwards every webview key to its own keybindings from a non-capture window listener. Keys the designer handles (Delete, F2, Ctrl+D, Alt+↑, `?`, Escape) therefore stop propagating. Ctrl+C/X/V/Z/Y never do, because VS Code turns them back into the page's copy, cut and paste and into undo. Ctrl+A stays unbound, since VS Code would also run Select All on the page.
- **One undo step per gesture.** Deleting a selection is one `deleteNodes` command, and Duplicate is one `pasteNodes`. Arrow nudges are saved as one `moveNodes` once the keys rest.
- **Top bar.** Rarer actions move into dropdowns (lens, "…", run options). Every action stays one click from the bar, and the canvas keeps its room.

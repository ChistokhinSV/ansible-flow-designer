# ADR-0010 · Subflow levels: drill-down, boundary editing, preview card

Status: Accepted · 2026-10-29 · AFD-6 (M4)

## Context

D-05 lets any subflow have an inner graph. D-23 asks for a drilled-in view where the parent's ports sit on a dashed boundary and inner exits wire to them. D-22 asks for a hover preview of what a subflow (or bound node) runs. The data model (03) has `subflow.boundary.in` and `subflow.boundary.outputs.<port>: [{node, port}]`. Mockup 10 labels exits with reasons ("SSH timeout"), which the model could not hold.

## Decision

**Levels on the canvas.**
- The webview keeps the open level (`root` or a subflow node id) in its store.
- Opening and leaving:
  - Double-click a subflow, press Enter on a selected one, or use "Open subflow" in the inspector or preview card.
  - _Back_ and the breadcrumb leave.
  - Each level gets its own React Flow store (the provider is keyed by level), so each keeps its own viewport.
  - Reveal (banner, diagnostics) opens the node's level first.
- Selection, menus, picks and Quick add belong to the level being left.
- Quick add, palette, patterns and Tidy up act on the open level.
- The host now computes in-memory auto positions for every level. Positions stay in the one flat layout map (ADR-0002).

**Boundary frame.**
- In the view model, the frame is a React Flow node that wraps the inner steps with padding (420×280 when empty). It shows every legal port of the subflow except `undo` and `cancelled`.
- Port placement:
  - `in` sits on top, as the source of the entry wire.
  - Outcomes sit at the bottom and problems on the right, as the targets of exit wires.
  - The handles face inward, so wires never loop around the frame.
- Port states:
  - connected: fed by an exit;
  - bubbled: a fail port fed only by inner fail ports that bubble up (ADR-0004);
  - unfed: amber, a warning;
  - available: optional and not enabled; shown while a wire is dragged.
- The frame lets pointer events through to the canvas.
- The entry and the exits are drawn as wires.
- Connecting:
  - a wire from the frame's `in` runs `setBoundaryIn`;
  - a wire into a frame port runs `connectBoundary`;
  - deleting either runs the inverse.
- A selected entry or exit shows a small panel: the exit reason and Remove.

**Commands** (each is one WorkspaceEdit).
- `setBoundaryIn`, `connectBoundary`, `disconnectBoundary`, `setExitReason`.
- `connectBoundary`:
  - enables the parent's optional port and the inner node's optional port when needed;
  - refuses a port that is wired inside or already leaves through another port;
  - removes the inner port's open-on-purpose decision in the same edit.
- An inner port that leaves the subflow counts as wired: `connect` and disabling it are refused.
- The boundary block is rewritten as a whole when it changes (it is small). Its key order is kept.
- `addNode` with a `parent` that has no inner graph creates `subflow: {nodes, boundary: {in}}`: the first step becomes the entry.
- `deleteNode` also:
  - removes the node from an enclosing boundary;
  - removes the decisions and positions of every step of its own inner levels.

**Schema (additive, schema_version stays 1).** Boundary outputs are `exitref` items: `{node, port, reason?}`. The reason labels the exit wire and appears in the preview card. Codegen ignores it.

**Validation (03).**
- `boundary-no-entry`: inner steps exist, but there is no `boundary.in`.
- `boundary-port-unfed`: an enabled output of the subflow is fed by neither an exit nor a bubbling fail port.
- `inner-exit-unmapped`: an inner outcome (non-fail output) neither continues inside nor leaves the subflow.
- `boundary-ref`: additionally reports exits from ports that do not exist and ports that are wired inside.
- All are warnings; banner and bubbling rules are unchanged.

**Preview card.**
- Opens after 400 ms of pause on a subflow or code-bound node (draft tasks keep the port reveal). Menus, picks and dialogs suppress it.
- It stays open while the pointer is on the node or the card.
- Content:
  - header: title, binding and version, status;
  - inner steps in graph order, with entry, impl kind and settings badges, exits with reasons, and last-run hosts per port;
  - undo binding and settings.
- Actions:
  - _Peek code_ opens the node's play in its generated file; for a subflow, its level file.
  - _Open subflow_ drills in.
- Duration and last change are left out until Run mode (M7) and Git sync (M6).

**Not in M4:** extracting selected nodes into a new subflow (follow-up AFD-7).

## Consequences

Inner levels are first-class: every M1–M3 action works inside them, generated code follows boundary edits (ADR-0009 already compiles levels), and the Problems panel explains broken boundaries. Inherited-context chips show the subflow chain's settings (inventory target, credential, EE, become, serial); host counts per group need the Inventory lens (M8).

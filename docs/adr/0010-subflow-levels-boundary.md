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

**Not in M4:** extracting selected nodes into a new subflow (follow-up AFD-7, done below).

## Amendment: extract into a subflow (AFD-7, 2026-10-30)

Decisions by the user:
- one way in: a selection entered at two nodes is refused;
- outputs read outside the selection are lifted to the new subflow;
- extraction works on any level.

**Selection.** Ctrl/Cmd+click or Shift+drag selects several nodes (`selection.nodes`). The right panel then shows the selection and _Extract into subflow_ (title, key preview). A refusal is shown in the panel. Summary cards stay closed for a group.

**The command `extractSubflow`** (one WorkspaceEdit). It refuses a selection that:
- spans more than one level, or includes start or end nodes;
- is not connected;
- is entered at two nodes (counting the enclosing `boundary.in`);
- needs two wires on one subflow port.

What it does:
- **Moves:** the nodes, with their IDs and in document order, and the wires between them go into `subflow.nodes` and `subflow.edges`. Positions stay in the flat layout map.
- **Places:** the new subflow node takes the place of the first selected node, at the selection's top-left corner.
- **Entry:** wires into the group keep their IDs and end at the subflow's `in`; `boundary.in` is the node they reached.
- **Exits:** wires out keep their IDs and start at the subflow port of the same name. A port the subflow lacks maps by kind: fail-type ports go to `failed_hosts`, other outcomes to `ok_hosts`. Each becomes a boundary exit. Exits to the same place merge into one parent wire, and the other wires' IDs are dropped.
- **Nested levels:** exits of an enclosing subflow now leave through the new one, and an enclosing `boundary.in` in the group becomes the new subflow.
- **Bubbling:** open fail ports keep bubbling. The optional fail ports they use (`unreachable`, `timeout`) are enabled on the new subflow.
- **Lifted outputs:** each output of a moved node that is read outside becomes a subflow output (`<output>`, or `<key>_<output>` on a clash) with `from: <inner key>.<output>`. Those references are rewritten in the same edit, and the nodes whose references changed keep their tested status (a mechanical rename). The validator resolves a subflow's outputs in its inner scope, and codegen resolves them through to the inner node's variable (`outputVar`), so generated code reads the same host variable.
- **Status:** the subflow is as far along as its least advanced work step, but "specified" only with a contract of its own; otherwise draft.

**Tests.**
- **Unit:**
  - the move with every ID kept;
  - wires, boundary and banner;
  - lifted outputs with identical input vars, and a merged exit;
  - a nested extraction (exit through the new subflow, `unreachable` enabled);
  - refusals.
- **Webview:** group selection on the canvas, the command and its position, a refusal, the new subflow selected.
- **Integration:** one edit, the new level on the canvas, one undo restores the bytes; a refusal leaves the file untouched.
- **Engine (2.19–2.21):** the os-upgrade check run with `set-boot-variable` and `reload` extracted routes every host through the same ports to the same outcome. The data-passing run with `produce` and `stub` extracted delivers the same values (its `assert` checks them).

## Consequences

Inner levels are first-class: every M1–M3 action works inside them, generated code follows boundary edits (ADR-0009 already compiles levels), and the Problems panel explains broken boundaries. Inherited-context chips show the subflow chain's settings (inventory target, credential, EE, become, serial); host counts per group need the Inventory lens (M8).

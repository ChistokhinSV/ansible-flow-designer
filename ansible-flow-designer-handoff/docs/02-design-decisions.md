# 02 · Design decisions

Each decision lists the choice, why it was made, and what was rejected. IDs are referenced from other documents.

## Structure and process

### D-01 · Top-down design in three layers
**Decision.** A flow is built in three layers that are filled in order: structure (nodes and edges), contracts (inputs and outputs), implementation (bound Ansible artifacts).
**Why.** Matches how experienced engineers design production automation: outcome and data model first, code last. Lets reviewers approve structure before effort goes into code.
**Rejected.** Code-first with generated diagrams only. That gives documentation, not design.

### D-02 · Draft nodes are real nodes, not comments
**Decision.** Skeleton nodes are full nodes with `status: draft` and no implementation. They have ports, can be wired, and are validated.
**Why.** Comment or annotation nodes cannot be connected or validated, so the flow is not a real graph until coded.
**Rejected.** Comment nodes, sticky notes.

### D-03 · Walking skeleton
**Decision.** Every flow is runnable from the first minute. A draft node generates an `ansible.builtin.debug` task with its intent text and continues on its `ok` port.
**Why.** Validates wiring, inventory and AWX plumbing before any real change logic exists.

### D-04 · Node lifecycle
**Decision.** `draft → specified → implemented → tested`. Specified means the contract (inputs and outputs) is defined. Implemented means bound to code. Tested means a passing run is recorded for the current version.
**Why.** Gives a visible, per-node measure of design completeness. Drives node styling and readiness counters.

### D-05 · Subflows for decomposition, stop at role or playbook granularity
**Decision.** Any node can be a subflow with its own inner graph. The canvas never shows individual tasks inside a role.
**Why.** Keeps each level to roughly five to fifteen nodes. Task-level graphs become noise and duplicate the code.

## Identity

### D-06 · Immutable IDs separate from human keys
**Decision.** Every flow, node and edge gets a ULID at creation, never derived from the name. Nodes also have a human `key` (slug) that may change. Edges reference IDs only.
**Why.** Renaming or moving never breaks wiring, generated code tags, or run history. ULIDs sort by creation time and are collision-free.
**Rejected.** Names as IDs; UUIDv4 (works, but not sortable).

## Ports

### D-07 · Explicit, typed ports; final names
**Decision.** Edges connect ports, not nodes. Port names: input `in`; outputs `ok_hosts`, `failed_hosts`, `unreachable`, `unchanged`, `always`, `cancelled`, `timeout`; compensation input `undo`; decision `true`/`false`; approval `approved`/`rejected`/`timeout`. Early mockups (02, 03) use `success`/`failure`; those names are retired.
**Why.** Matches Ansible semantics more precisely than generic success/failure, and maps onto AWX workflow edges where possible.

### D-08 · Per-host split as the default output semantics
**Decision.** `ok_hosts` and `failed_hosts` each carry the subset of hosts that took that path. Downstream nodes run only against the hosts they receive. A node property `max_fail_percentage` turns a split into a whole-flow failure when exceeded.
**Why.** In network automation one bad device must not block a maintenance window for the others, and rollback must touch only the broken devices.
**Note.** AWX workflow edges are per job, not per host, so the engine must carry host subsets itself. See 05-ansible-mapping.

### D-09 · `unreachable` separate from `failed_hosts`
**Why.** Different remediation: connectivity or credentials versus config or logic. You cannot roll back a device you cannot reach, so unreachable usually goes to notify or retry, never to rollback.

### D-10 · `unchanged` port from idempotency
**Why.** Lets a flow skip validation, config saves or tickets when nothing changed. Behaves like handlers at flow level.

### D-11 · Compensation via `undo` ports
**Decision.** Nodes that change state may declare an `undo` input bound to their own rollback logic. A Rollback node walks completed nodes in reverse order and calls their `undo` for the failed hosts only.
**Why.** Scales better than one monolithic rollback node; adding a node in the middle does not require editing Rollback. Saga pattern.

### D-12 · Port placement convention
**Decision.** Top: control `in`. Bottom: normal outcomes. Right: problems (`failed_hosts`, `unreachable`, `timeout`) and data outputs. Left: data inputs and `undo`.
**Why.** Users learn where to look; layout stays consistent for auto-layout.

### D-13 · Port visual language
**Decision.** Squares are control ports, circles are data ports. Filled means connected and always shown. Amber outline means an open fail port, always shown. Gray outline means open on purpose. Colored outline means optional, shown on hover or selection.

### D-14 · Progressive port disclosure
**Decision.** At rest a node shows only connected ports plus open fail ports. Hover or selection reveals every port its type supports, with labels. Clicking a port opens a contextual menu (suggestions for open ports, edit actions for connected ones).
**Why.** The full port set teaches what is possible without permanent clutter.
**Detail.** The hover zone includes a margin around the node and its labels, and the node stays active while its menu is open, so ports do not vanish before they can be clicked.

## Failure handling

### D-15 · Failure paths are nudged, never forced
**Decision.** Open fail ports are flagged in three places: a canvas banner with a count, the port itself (amber), and the inspector. Users can resolve by wiring, by dropping a failure pattern on the port, or by marking it "open on purpose", which records a decision and silences the warning.
**Why.** Early sketching must stay fast; safety must stay visible.
**Rejected.** Ghost "Add failure path" nodes next to every node (first iteration). They took too much space; replaced by ports (see mockup 01 versus earlier chat iteration).

### D-16 · Failure patterns in the palette
**Decision.** A palette group offers ready-made handlers (rollback from backup, notify and stop, retry with backoff) that can be dropped onto an open fail port.

## Views

### D-17 · One graph, three modes
**Decision.** Design, Implementation and Run are renderings of the same flow document. Node positions, IDs and edges never change between modes; only what nodes and wires display.
**Why.** "The exact flow" stays exact after implementation; no second diagram to maintain.

### D-18 · Lenses, independent of mode
**Decision.** A lens toggle (None, Inventory, Data, Code, Access, Timing) picks which category fills the node chips across the whole canvas. Each lens may contribute a side panel and automated findings.
**Why.** Most review questions are about one dimension across all nodes ("which credentials does this flow use?").

### D-19 · Two-chip budget and semantic zoom
**Decision.** At default zoom a node shows a status dot and at most two chips. Zoomed out it shows the title only. Zoomed in or selected it shows a compact summary card.
**Why.** Prevents clutter as implementation detail grows.

### D-20 · Wires carry information
**Decision.** Wire labels show port names in Design mode, variable names in the Data lens, and host counts in Run mode.

### D-21 · Things that stay off the canvas
Raw variable values, task lists, Jinja templates. They live in the inspector, properties panel or code view.

## Subflows

### D-22 · Hover preview before drill-down
**Decision.** Pausing on a subflow node (about 400 ms) opens a preview card with the inner step chain, per-step last-run results, which inner steps exit to which outer ports, duration stats, undo action and last change. Actions: Peek code, Open subflow.
**Why.** Answers "where does this failure come from" without navigating away.
**Detail.** Only for subflows and code-bound nodes; draft tasks show the normal port reveal.

### D-23 · Drill-down shows the boundary contract
**Decision.** Inside a subflow, the parent's ports appear on a dashed boundary frame and inner exits wire to them. A breadcrumb and inherited-context chips (inventory group, credential) keep orientation.
**Why.** Makes the parent/child contract explicit and checkable.

## Implementation binding

### D-24 · Module search scoped by context
**Decision.** Module search is pre-filtered to the node's execution environment and the inventory platform, and ranked by the node's intent text. Out-of-context results stay visible but dimmed with a reason.

### D-25 · Inline documentation and generated forms
**Decision.** Module docs (description, capabilities, parameters, returns, examples) render inside the properties panel. The configuration form is generated from the module's argument spec. Return values are offered as node outputs.

### D-26 · Inputs as chips, not raw Jinja
**Decision.** Flow and node inputs appear as chips inside parameter fields (inserted with `@`). They serialize to Jinja on export.
**Why.** Renaming an input updates every reference; the contract stays linked to the code.

### D-27 · Flow-aware hints
**Decision.** The form may comment on flow context, e.g. "backup is off because Backup config runs earlier in this flow."

## Code round-trip

### D-28 · Node IDs embedded in generated code
**Decision.** Generated tasks carry the node ID as a tag (`node_<ULID>`) and the key in the task name prefix (`[set-boot-variable] ...`).
**Why.** Lets a sync job map code and run events back to nodes; enables drift detection and Run mode highlighting.

### D-29 · Drift is shown both ways and never auto-resolved
**Decision.** Three drift kinds: contract mismatch, code without design, design without code. Each offers both directions (update design from code, open code).
**Why.** If either side silently wins, the diagram stops telling the truth.

### D-30 · Layout stored separately from semantics
**Decision.** Node positions live in a separate `layout` block (or file).
**Why.** Dragging nodes must not produce diffs that look like logic changes.

### D-31 · Import of existing AWX workflows
**Decision.** Existing AWX workflow templates can be imported (they already have nodes and success/failure/always edges) and auto-laid out.

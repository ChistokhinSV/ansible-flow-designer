# 04 · UI specification

Mockup references point to files in `mockups/`. The visual language at the end applies everywhere.

## 1. Application shell (mockups 01, 09)

- **Top bar:** breadcrumb (Flows / flow name), flow key and version, mode toggle (Design, Implementation, Run), lens toggle (None, Inventory, Data, Code, Access, Timing), primary actions (Validate design, Run as skeleton in Design mode; Re-sync, Launch in AWX in Implementation mode).
- **Left panel:** depends on mode and lens. Design mode: node palette, failure patterns, legend. Inventory lens: inventory browser (groups used by the flow with host and node counts, excluded hosts).
- **Center:** canvas, with a dismissible warning banner for open fail ports.
- **Right panel:** flow description when nothing is selected (name, key, fixed ID, goal, typed inputs, owner, runtime, readiness counters); node inspector when a node is selected; lens summary and findings when a lens is active.

## 2. Canvas

- Nodes laid out top-down; problem branches to the right; skip lanes on the far left (mockup 06).
- Node appearance by status: draft = white with dashed gray border; specified = light purple; implemented = light green. Node type shapes: task (plain), subflow (double border), decision (light blue), approval (light violet), failure handler (light amber), start/end (pill). Failed end is light red.
- Wires: solid for normal outcomes, dashed for problem ports, colored by port kind. Merge points join wires before a shared handler.
- Wire labels: port name (Design), variable names (Data lens), host counts (Run).
- Semantic zoom (mockup 08): far = title only; default = status dot + max two chips; near or selected = summary card.

## 3. Ports (mockups 01, 05, 06, 07)

- Placement and visuals per D-12 and D-13.
- At rest: connected ports and open fail ports only.
- Hover or select: all ports of the node type, each labeled (mockup 07).
- Click an open port: menu of suggestions for that port kind (e.g. `failed_hosts`: Rollback (existing), Notify on-call, Exclude and report, Retry with backoff, Leave open on purpose). `unreachable` never suggests Rollback.
- Click a connected port: Insert node on this wire, Rewire to another node, Disconnect.
- Drag from a port: wire to an existing node or release on empty canvas to open Quick add.
- Drop a failure pattern from the palette onto an open fail port: creates and wires the handler.

## 4. Quick add (mockup 02)

Opened from a port or the palette. Shows context ("After Backup config, from port ok_hosts"), type selector, title (generates key and ID), intent, inputs suggested from upstream outputs, preset ports with a pre-checked option to wire `failed_hosts` to an existing Rollback. Creates a draft node.

## 5. Node inspector (mockup 03)

Identity (ID, key, intent), lifecycle stepper with the missing requirement for the next stage, contract, ports list with resolution actions for open ports, implementation summary with the skeleton TODO stub preview and "Bind role or playbook".

## 6. Implementation mode (mockup 04)

Same geometry as Design. Nodes show bound artifact and task count. Side panel "Design vs code": sync source (branch and commit), nodes matched by ID, drift items with two-way actions (D-29), last run summary.

## 7. Lenses (mockups 08, 09)

| Lens | Node chips | Wires | Side panel findings (examples) |
|---|---|---|---|
| Inventory | target group, host count | host counts | node targets a broader group than it receives (e.g. Rollback on `all`); groups touched that are not flow inputs |
| Data | inputs, outputs | variable names | unresolved inputs, unused outputs |
| Code | role or module and version, execution environment | — | collection not in EE, outdated versions |
| Access | credential, become, vault refs | — | node uses broader credential than neighbors |
| Timing | serial, timeout, average duration | — | flow does not fit maintenance window |

Hovering an item in the lens side panel (e.g. an inventory group) highlights the matching nodes and dims the rest.

## 8. Subflows (mockup 10)

- Hover preview after about 400 ms on subflow or code-bound nodes: header (title, bound role and version, status), inner step chain with last-run result per step and exit tags (e.g. "→ unreachable"), duration (avg, p95), undo action, handlers, last change, actions Peek code and Open subflow. Open with double-click or Enter.
- Drilled-in view: Back button, breadcrumb, inherited-context chips, dashed boundary frame, parent ports on the frame edges, inner exits wired to them with reason labels.

## 9. Node properties (mockup 11)

Tabs: General, Implementation, Inputs and outputs, Ports, Execution, History. Implementation tab in three columns:

1. **Find:** Module / Role / Playbook switch; search filtered by EE and platform; results with badges (in EE, check mode, read-only, other platform, not in EE); intent-based suggestion.
2. **Understand:** module docs inline — description, capability badges (collection version, check mode, diff mode, connection, idempotency), parameter table (most relevant first, "show more"), returns as potential outputs, example.
3. **Configure:** form generated from argument spec, inputs as chips (`@` to insert), flow-aware hints, register-as field, validation checklist, generated task preview.

Saving moves the node to Implemented.

## 10. Run mode

Not mocked as a full screen. Same canvas; nodes show per-run status and timing; wires show host counts; selecting a wire lists its hosts; selecting a node lists per-host results and links to AWX job events.

## Visual language

| Token | Value | Use |
|---|---|---|
| Font | Inter; JetBrains Mono for IDs, keys, code | |
| Accent | #1d4ed8 | selection, primary actions |
| ok | #2f855a | ok ports and wires |
| failed | #c2410c | failed_hosts |
| unreachable | #d97706 | unreachable, open-port warnings |
| decision | #5b7fd6 | true/false |
| approval | #8b7fd9 | approval ports |
| undo | #0f766e | compensation |
| neutral border | #8a8f98 | draft nodes, gray wires |
| Lens chip colors | inventory #e8f1fb/#1e4f86, data #f3f0ff/#4c3fa8, code #e9f7f1/#0f5a43, access #fdf2e7/#8a4b0a, timing #f1f2f4/#3d444d | |

Colors are never the only signal: port shape, fill and labels carry the same meaning.

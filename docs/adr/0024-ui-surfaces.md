# ADR-0024 · UI surfaces: one Details panel for a node

Status: Accepted · 2026-11-01 · AFD-43

## Context

The improvement review (KB AFD-A-17) counted five places that showed or edited a node: the
inspector on the right, a properties page over the whole canvas (M5), a summary card under a selected
node (D-19), the hover preview card (D-22), and the Code and Run mode panels. Generated code showed
in six. The properties page hid the canvas, so a binding could not be set while looking at the flow,
and the inspector and the page edited the same fields in two layouts.

Product-owner decision 2 (2026-10-31): node editing in one docked, resizable **Details panel**
(inspector and properties merged); fields save as you go; a binding is staged with Save / Discard
and a leave guard.

## Decision

**One panel.** `details/Details.tsx` is the right panel whenever one node is selected, in every
mode (`rightPanelFor` → `{ kind: 'details' }`). Inside a subflow with nothing selected it describes
that subflow (`context`).

**Tabs** (`detailsTabs(node, mode)`):
- **Design:** General (title, key, intent, lifecycle, what the type adds, inner steps, ID, last run), Binding (task and subflow), Inputs and outputs, Ports, Execution (settings and task keywords).
- **Code mode** puts **Code** first (the node's code and drift); **Run mode** puts **Run** first (each host, the port it left by, its result).
- The open tab (`detailsTab`) stays from node to node. Entering Code or Run opens their tab; going back to Design leaves it.
- In Run mode the editing tabs are read-only.

**Saving:**
- Fields commit on blur or Enter, each one command (one undo step), as before.
- The binding is a draft (`draftOf`) kept in the panel across tab switches. While it differs from the file:
  - a sticky bar says so, with **Discard** and **Save Binding**;
  - the store's `pendingBinding` names the node.
- `select`, `setLevel`, `setMode`, `reveal` and `openDetails` then record a `leave` request instead of acting. The panel asks **Keep Editing**, **Discard** or **Save Binding**, and `resolveLeave('go')` replays the request.
- Escape clears the selection, so it asks too; Escape while asking keeps editing.
- `isDirty` compares the draft with the draft the node loads as (`draftOf(node)`), not with the node. Loading fills in the default register name, so an untouched draft of most bound tasks used to count as a change; a test checks every bound node of every flow file.

**Layout:**
- The panel is 340 px by default. Its left edge resizes it (260–720 px, a focusable `separator`, the arrow keys move it in 16 px steps or 64 with Shift).
- **Expand** widens it to `min(1100px, 80vw)` for the catalog docs.
- Width and expanded state are kept in the webview state.
- The binding editor is one column in the panel, and three side by side (find, docs, configure) when the panel is at least 900 px wide (container query on `.afd-right`).

**Fewer surfaces:**
- The summary card under a selected node is gone. Its facts are the node's summary rows from 1.4× zoom.
- The hover card previews only (Open Subflow stays).
- Generated code is in two places: the Binding tab's **Generated task**, and **Peek Code** (`</>` in the Details header, or the node menu), which opens the play in the generated file.

**Store and overlays:**
- `properties` (the page overlay) is removed. `openProperties` became `openDetails(node, tab, bindKind?)`; the host message is `openDetails`.
- The overlay table has no `properties`; `CLOSES.details` closes the preview and the menus.

## Consequences

- One place to edit a node, beside the canvas; the flow stays in view while binding.
- Tests render `<Details>` directly and drive the guard through the store and the keyboard handler (`panelFixes.test.tsx`).
- The Details are narrower than the old page: tabs wrap at the default width, and the docs need **Expand** to sit beside the search.
- Deviation: the Code and Run panels with nothing selected (drift list, run summary) stay as they were; AFD-45 revisits the modes.

## Amendment: Details content (AFD-44, 2026-11-01)

- **Execution** is grouped as an operator reads a play: Targeting (inventory target, serial, max fail percentage), Privilege (become, AWX credential), Timing (timeout, retries, until, delay), Tags (tags and the task keywords). `SettingField.group`, `SETTING_GROUPS` in `core/view/settings.ts`.
- **Task keywords** stay in view while they cannot apply: disabled, with why (no binding yet, or a playbook binding).
- **Parameters from the docs:** **+** on a row of a module's parameter table adds it to Configure, like **More parameters**. The list of added parameters moved from Configure up to the binding editor, so the table and the form share it.
- **Problems inline:**
  - `core/view/nodeProblems.ts` maps the node's findings to the tab they are about (by the path segment after the node: `impl` → Binding, `inputs`/`outputs` → Inputs and outputs, `settings` → Execution, a port → Ports, else General) and to a field;
  - the Details list them at the top, each opening its tab, and mark those tabs;
  - Title, Key and the Execution fields show their problem under them (`CommitField.problem`, `aria-describedby`).
- **`tested` by hand** (decision 10):
  - The Lifecycle stepper and the node menu's Status ▸ tested open a reason dialog. `markTested` sets the status and records `finding_accepted` with `finding: status:tested|<node>`, the reason and the author (the host fills `by`), in one edit.
  - `updateNode` refuses `status: tested`, as the AI ops already did; a passing run still marks nodes through `setStatuses`.
  - Setting another status, or the drop-back after a design change (`implementedAgain`), removes the record in the same edit.
  - AFD-50 replaces the record with the v2 `tested` record and AFD-51 with the unified `accepted` decision.

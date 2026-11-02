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

## Amendment: modes and lenses (AFD-45, 2026-11-01)

- **One toolbar in every mode:** Run ▾ (Run as Skeleton up front; Run for Real… and Launch in AWX in its menu), Stop, Generate Code, Export ▾ (draw.io, image), "…" (Tidy Up, Open in Text Editor, Check Flow, Keyboard Shortcuts, User Guide).
  - What cannot run now stays in place with `aria-disabled` and a tooltip that says why: no run going, a run going, `N` errors before Generate Code, a read-only graph for Tidy Up. A `disabled` button shows no tooltip.
  - Code mode's **Re-sync from Git** moved to the top of its Design vs code panel.
- **Code mode reads the graph** like Run mode:
  - no dragging, wiring, port menus, deleting, cutting, pasting or nudging (`canEdit` is Design only);
  - node menus offer Details… and **Binding…**, and the Details are read-only except the Binding tab;
  - drift actions still change the design, since that is what they are for.
- **The palette** (and its legend) shows in Design only; in Code and Run modes the left column folds to nothing.
- **A lens is an overlay with a tab:**
  - It no longer replaces the palette or the mode's panel.
  - With a lens on, the right panel has two tabs: the mode's panel (the flow, a node's Details, the drift or run panel) and **Lens: X** with the lens's browser and findings (`lensTab`).
  - Turning a lens on opens its tab; selecting a node or a wire shows the panel; the tabs switch back and forth.
  - `rightPanelFor` no longer knows lenses.

## Amendment: feedback (AFD-46, 2026-11-01)

- **Messages** are one stack in the store (`toasts`, `notify(level, text)`, `dismissToast`), drawn by `panels/Toasts.tsx` at the bottom centre of `.afd-center`, so the side panels' widths no longer place them. Levels info, success, error; at most four; the same text again replaces the older one; each closes after `TOAST_MS` (errors 9 s, the others 4 s) or by its ×. Errors are `role="alert"`, the others `role="status"`, inside an `aria-live="polite"` region. `setError` is now `notify('error', …)`.
- **The host's word:** a `notify` host message (`Notice {level, text}` in `core/protocol.ts`). Generate Code and Check Flow take `{ quiet: true }` from the designer and return their `Notice` instead of showing a notification, so the outcome reads over the canvas that asked; the walkthrough still sees Check Flow run, and from the Command Palette both notify as before. Tidy Up from the designer reports through the same message.
- **Pending:** `bus.onInFlight` counts requests waiting for their answer; `saving` in the store follows it, and **Saving…** shows at the top of the message stack only after `SAVING_DELAY_MS` (250 ms), so quick edits stay quiet. Not in the top bar: its slot, even empty, took a flex gap and wrapped the bar at 1200 px, and the note coming and going would move the actions.
- **Read-only file:** while the text has YAML errors the banner says **Read-only** with the error and **Open in Text Editor** (`data-read-only-banner`); the panels were already read-only then (AFD-30).

## Amendment: navigation and onboarding (AFD-48, 2026-11-01)

- **Find** is a box over the canvas (a React Flow `Panel`, top right), not a side panel: it searches every level (`core/view/find.ts`: title, key, binding ref; every word must match; title starts first; with the subflow trail) and stays open while one moves between levels, since the canvas is remade per level and the query lives in the store (`find`, `findQuery`, `findNonce`). An overlay in the policy table that menus close and Escape closes after dialogs; levels and modes leave it open. Ctrl+F is taken before the field check, so it works from a panel field too.
- **Showing a node** anywhere goes through `reveal(node)`, which now also sets `centerOn`; the canvas centres it once the level is drawn, after the opening fit, at 100% or closer. The open-ports banner's Show uses it for its own level too.
- **Failed steps** in the run panel: every non-subflow node with failed hosts, sorted by trail, each a link that reveals it.
- **Collapsible side panels:** `paletteCollapsed` (icons with their names as labels; the pattern hint stays for screen readers) and `panelCollapsed` (a 40 px strip, `--afd-collapsed-width`, with Show Side Panel), both in webview state. The window-splitter pattern on the panel edge: Enter or a double-click folds it. The legend leaves the column for a non-modal popover from "? Legend" (Escape and an outside click close it). Resizing stays the right panel's only (the palette is icons or names).
- **Empty level card** in Design mode while the level has only Start and End: Add a Step (Quick Add on the Start to End wire of a new flow, else after Start or at the paste place), and on the top level a `startFrom` host message for the two importers and Open Sample Flow. "Apply a pattern" from the plan is not offered: a pattern needs a step with an open fail port, which an empty level does not have.

## Amendment: annotations on the canvas (AFD-65, 2026-11-02)

Notes, Sections and Text (ADR-0028) are canvas nodes of type `annotation`, without ports.
- **Layers:** `zIndexMode="manual"`. Sections are at -2, behind the subflow frame (-1); wires and free Notes and Text are at 0; nodes at 1; tied Notes at 2. In React Flow's default mode a selected node rises by 1000, which would put a selected Section over its steps.
- **A Note on a node** is that node's React Flow child (`parentId`). Its stored position is relative, as React Flow's is, so it follows drags, optimistic moves and Tidy Up. It draws its own dashed tie, border to border (`core/view/tie.ts`), so wires and the metrics see no extra edges.
- **Sections:** only the title bar (`dragHandle`) and the resize handles take the pointer; clicks, pan and box-select go through the body. A drag carries what `sectionContents` finds wholly inside, and saves one `moveNodes` with `annotations`.
- **Editing:**
  - double-click, Enter or F2 opens a textarea (`nodrag nopan nowheel`); Ctrl+Enter or blur saves one edit, and Escape cancels;
  - Markdown is shown as React text nodes from `core/view/markdown.ts`;
  - a link click asks the host, which opens only http(s) links found in the flow's annotations.
- **Surfaces:**
  - the palette's Annotate group (drag with `ANNOTATION_MIME`; a Note dropped on a node is tied to it);
  - the canvas menu (Add Note/Section/Text Here), the node menu (Add Note to This Node), and an annotation menu (Edit Text, Color, Attach to Node… with pick mode `attach`, Detach, Cut, Copy, Duplicate, Delete);
  - Shift+N;
  - an Annotation panel on the right for one selected annotation;
  - Find matches annotation text;
  - **Hide Annotations** in the … menu (per viewer, kept with the panel state).
- **Selection:** `Selection.annotations`, alone or with nodes; Delete, Copy, Cut, Duplicate and Select All take them.
- **Read-only** outside Design mode, on shared levels and on broken files; faded under a lens and in Run mode.
- **Colours:** `NOTE_COLORS` per theme, with a fill and an ink each. Note text reaches 4.5:1 on its fill and the ink 4.5:1 on the canvas (theme test); high contrast has no fills.

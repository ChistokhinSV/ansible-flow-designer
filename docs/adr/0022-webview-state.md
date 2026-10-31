# ADR-0022 · Webview state and derived views

Status: Accepted · 2026-10-31 · AFD-34 (improvement program, KB AFD-A-17)

## Context

The webview rebuilt the flow model from the snapshot's document in 25 places, and core helpers it calls per snapshot (level view, run view, lenses, drift) built their own: 6 builds for every snapshot (measured, AFD-33). Components also held rules that belong next to the model (a node's Code-mode state, the Execution settings and their parsing) and shared constants by importing other components.

## Decision

- **One model per document:** `modelOf(doc)` (`core/flow/model.ts`) caches the model in a WeakMap keyed by the document object. A snapshot's document is never changed after it arrives, so everything derived from it reads the cached model. Code that edits a document (commands, the validator, importers) keeps calling `buildModel`.
- **Hooks:** `useModel`, `useNode(id)`, `useLevelView(level?)` (`webview/hooks.ts`) give components the snapshot's model and views.
- **Rules in core:** `core/view/codeState.ts` (what Code mode says on a node) and `core/view/settings.ts` (the Execution fields, their validation and value parsing) are pure and unit-tested.
- **Constants:** node type and port state labels, drag data types and `ago` live in `webview/constants.ts`.

## Consequences

- One build per snapshot (`just ux-baseline`); no visible change.
- A document object must not be changed after its model is cached; the webview only ever replaces snapshots.

## Amendment: overlays, reason dialog, right panel (AFD-35, 2026-10-31)

- **Overlays as a table, not one field:** the plan was one discriminated `overlay` field. Overlays stack on purpose (a reason dialog over the properties page; the pick bar over a usable canvas), so a single field would model them wrongly. The store keeps a field per overlay; `webview/overlays.ts` declares what opening each one (or changing level or mode) closes (`CLOSES`, applied with `closing()`), which overlays hold the pointer (no hover card over them) and the Escape order. The keyboard handler and the setters use these tables.
- **Derived views stay setter-maintained:** drift, run states and the lens view are computed once in the setters that change their inputs (snapshot, run, scan, lens, facts), which already gives one computation per change; moving them into selectors would compute them per subscriber.
- **One reason dialog** (`panels/ReasonDialog.tsx`) for open-on-purpose, drift ignore and lens accept.
- **`rightPanelFor(state)`** (`webview/rightPanel.ts`) and `rightPanelLabel` replace the nested conditional in `App`; table-tested.
- **`webview/inspect.ts`** holds the DOM summaries integration tests read.

## Amendment: styles (AFD-36, 2026-10-31)

- `src/webview/styles/NN-area.css`, imported in order by `styles/index.css`: the old file's sections, unchanged in order, so the cascade is the same (screenshots byte-identical, `just ux-baseline`).
- Tokens in `00-base.css`: `--afd-fs-*` for each font size in use (no literal pixel sizes elsewhere; unit-tested), `--afd-font-node-title` / `--afd-font-node-sub` for the canvas redesign, `--afd-space-*`, `--afd-left-width` / `--afd-right-width` (the grid and the toast).
- `prefers-reduced-motion` turns animations and transitions off; `forced-colors` keeps the state colours of ports, dots and swatches and uses `Highlight` for focus.
- The improvement review's "duplicate selectors" were grouped rules followed by one selector's additions (`button.icon, button.link` then `button.link`): normal CSS, left as they are. Merging the first pair tried changed the icon buttons, which the screenshot gate caught.

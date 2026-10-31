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

# ADR-0025 · Flow format versions and the explicit upgrade

Status: Accepted · 2026-11-01 · AFD-49 · amends ADR-0004

## Context

ADR-0004 fixed `schema_version: 1` and allowed only additive fields since. Wave 4 of the
improvement program (KB AFD-A-17) changes the shape of the file: `tested` becomes a record, the
three kinds of decision become one, settings move, unfinished ports go. Product-owner decision 9
(2026-10-31): a **schema v2, applied by an explicit upgrade**. Files in Git are read by people,
reviewed in pull requests and opened by older copies of the extension, so they must not change
just because someone opened them.

## Decision

- **Two formats.** `schema_version` is 1 or 2 (`schema/flow.schema.json`). A format 1 file stays
  readable, editable and generatable forever. New flows (New Flow, Create a flow here, both
  importers, the AI tools' `flow_new`) and the shipped samples are written in the current format,
  `CURRENT_FORMAT` (2).
- **Nothing is written on open.** The upgrade runs only when someone asks for it: the
  **Upgrade Flow Format** command (`afd.flow.upgradeFormat`), the button on the designer's format
  banner, or the AI op `upgrade_format`.
- **Steps** (`core/flow/migrate.ts`): ordered `MigrationStep`s keyed by the version they read. Each
  makes its own edits; `migrate` then sets `schema_version` to the next version, until the current
  one. Each step also says what it changes in the document (`notes`), which the banner lists before
  anyone upgrades.
- **One transaction.** The upgrade is a flow command (`upgradeFormat`) planned like every edit: one
  `YamlTransaction`, so it is one WorkspaceEdit, one undo step, and the bytes outside the changed
  nodes (comments, order, quoting) stay. It is a format change, not a design change: no node goes
  back from `tested` over it.
- **Refusals.** A file already current says so (`format-current`); a file newer than the extension
  reads asks to update the extension (`format-newer`). An edit that needs a field format 1 does not
  have calls `requireFormat(doc, 2, what)`, which refuses with the way out (`needs-format`: "… run
  Upgrade Flow Format, then try again") instead of writing something a format 1 reader rejects.
  The AI tools and the MCP server pass that message on as the op's error.
- **The banner** shows on a format 1 flow while it can be edited, with what upgrading changes (or
  that the design stays as it is), the button, and a close button for the panel.

## Consequences

- Wave 4 tickets add their steps and their `requireFormat` checks (AFD-50 tested records, AFD-51
  decisions, AFD-52 settings, AFD-54 ports); until then the step from 1 changes only the version.
- An older extension (before 0.28) rejects `schema_version: 2` with a schema error; that is the
  price of the new format, and the reason format 1 files are never upgraded behind anyone's back.
- The examples and most test fixtures stay format 1, so both formats stay covered; every one of
  them is upgraded in a unit test with its design and generated code unchanged.

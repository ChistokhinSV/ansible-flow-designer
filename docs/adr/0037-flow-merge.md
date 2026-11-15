# ADR-0037: Merging flows by their steps

- Status: accepted (2026-11-15, AFD-283)
- Context: several people change one flow apart (two clones, pushes through Ansible Flow Server, a
  live session whose branch moved on: AFS-75, AFS-76). Git merged the YAML as lines: edits on
  neighbouring lines collided, and a clean text merge could break the flow's rules.

## Decision

- **A three-way merge of the flow model** in core (`core/flow/merge.ts`, `mergeFlows`), pure, so
  the git driver, the designer and the server use the same code. Each version is taken apart into
  steps, wires and notes with the level each is on, matched by ID (flows written by key get the
  IDs their keys give, as Complete IDs would). A step moved into a subflow is a change of its
  level, not a removal and an addition.
- **Field by field**, records a few levels deep (a step's settings, inputs, binding parameters).
  What one side changed is taken; both sides changing one value differently is a conflict with a
  stable id (`node:<id>:<field>`, `port:<node>.<port>`, ...). Positions never conflict (ours). The
  flow's version moves past both when both moved it. Decisions merge as a set.
- **Rules a merge could break are conflicts too:** a step removed on one side and changed, wired
  or filled on the other; two wires on one output port (one per port is the flow's rule). Wires
  whose ends went with a removal go with them. A different format on each side is one conflict.
- **Choices re-run the merge:** `mergeFlows(base, ours, theirs, choices)`; a conflict not chosen
  is ours. There is no partial merged state to keep in step; changing a choice back works.
- **Written over ours's text** with byte-preserving edits (`core/flow/mergeText.ts`): steps, wires
  and notes matched by ID in their lists, anything else replaced where it differs. Comments,
  quoting and order stay.
- **A git merge driver** (`dist/afd-merge.js`, `src/cli/merge.ts`), put into a repository by Set
  Up Flow Merging (with `.gitattributes` and this clone's `git config`; git settings are per
  clone). On a conflict it writes the flow with ours at each conflict, no text markers, keeps the
  three versions in `<git dir>/afd-merge/` (never the work tree) and exits 1, so git reports the
  file. A merged flow that breaks a rule neither side broke is also left for a person. Something
  that is not a readable flow goes to `git merge-file`.
- **Resolve on the canvas:** a flow with a waiting merge shows a Merge note (Mine / Theirs per
  conflict). Each choice is one edit of the document (one undo step), recomputed from the three
  stored versions; Finish saves, removes the state and runs `git add`.

## Consequences

- Without the driver setting a clone merges flows as text, as before; the setting is one line.
- The driver needs Node.js on the path of whoever merges (developers, CI that merges).
- Choices are applied from the stored versions: edits made by hand in the file during the merge
  are kept only where the merge does not decide.
- Ansible Flow Server can call `mergeFlows` / `mergeFlowTexts` for pushes it passes on and for
  live sessions.

## Alternatives considered

- **Text merge with a flow-aware conflict view:** keeps git's markers, so the file is no longer a
  flow until fixed by hand, and neighbouring-line collisions stay.
- **CRDT of the YAML text:** merges always, but can produce a flow that breaks its rules with no
  one told.
- **A conflict view in the Changes lens:** the lens compares two versions; a merge has three, and
  the choices belong with the conflicts, so a note of its own.

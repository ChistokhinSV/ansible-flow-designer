# ADR-0027: Shared subflows

- Status: accepted (2026-11-01, AFD-60)
- Context: wave 5 of the improvement program (KB AFD-A-17)

## Context

Teams write the same steps in many flows: a backup with its checks, a rollback, a maintenance mode.
Copying a subflow by hand (copy and paste, AFD-17) forks it: a fix in one flow never reaches the
others, and nobody can tell which copies are behind.

## Decision

A subflow can be a copy of another flow's subflow, pinned to that flow's version (product-owner
decision, 2026-11-01: pinned by flow version).

- **In the file:** `ref: {from: <file relative to this flow>#<subflow key path>, version, design}` on
  the subflow node (format 2), with the copy itself in `subflow:` (and its contract). The code, runs,
  scenarios and reviews read the flow as it is: no resolution step, no network, no other file needed.
- **Commands:** `addReference` (the host reads the source; the copy keeps the source's key, new IDs
  for every inner node and wire, the boundary and inner layouts follow, tested becomes implemented),
  `updateReference` (the same copy from a newer version; steps inside start untested),
  `unlinkReference` (the copy becomes the flow's own).
- **Checks:** `design` is a fingerprint of the copy as it was made; a different one is
  `shared-edited` (warning: Update or Unlink). The host checks every copy against its source
  (`src/node/sharedRefs.ts`, cached by file time): a missing file or subflow is an error, a newer
  version is information with **Update Shared Subflow**. A flow file saved anywhere in the workspace
  makes open flows with shared subflows check again (`recheck`).
- **Designer:** Insert Shared Subflow… lists the subflows of every other flow in the workspace; a
  copy's level is read-only and says where to edit it; the node shows `shared v<N>`.

## Consequences

- A copy is explicit and reviewable: the version bump and the new steps appear in the flow's diff.
- Updating is a choice per flow, not a surprise: a source change never alters a flow that did not
  ask for it.
- Steps inside an updated copy start untested in the flow that took the update.
- Not covered: pinning by Git commit, sources outside the workspace, AI tool ops for shared subflows
  (agents edit the source flow and the designer offers Update).

## Amendment: format 1 sources (AFD-62, 2026-11-01)

Found while capturing the wave 5 report: a subflow copied from a format 1 flow (the `os-upgrade` example) brought format 1 content into the format 2 target, such as the `undo` port (`legacy-port`). The copy's level takes no edits, and Update copied the same content again, so the warning could not be cleared from the target.
- `sharedSource` (`src/node/sharedRefs.ts`) reads a format 1 source through the same migration as Upgrade Flow Format (`planCommand(text, {kind: 'upgradeFormat'})`) in memory, cached by modification time with the file. The file is not written. The copy and the version check use the upgraded document; the version is the source's own.
- A format 1 source that cannot be upgraded (for example a newer format, or missing IDs) is a `shared-source` error that says to run Upgrade Flow Format on it.

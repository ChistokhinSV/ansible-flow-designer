# ADR-0002 · Layout inside flow.yaml, one flat map

Status: Accepted · 2026-10-28 · AFD-1

## Context
D-30 keeps positions apart from semantics. A separate layout file would put drags on a second document's undo stack, so Ctrl+Z on the canvas would not undo a drag (08).

## Decision
- Positions live in the flow document, in one top-level `layout:` map keyed by ULID, for every level including nodes inside subflows (ULIDs are globally unique).
- `node.subflow.layout` is still read but never written.
- Nodes without a position get an in-memory ELK auto-layout that is never written until the user moves a node or runs "Tidy up".
- The M1 acceptance check reads: a move changes only the layout block.

## Consequences
One undo stack; a drag is one undo step; layout diffs stay confined to one block; opening a flow without layout never dirties it.

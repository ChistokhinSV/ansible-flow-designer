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

## Amendment (AFD-17, 2026-10-30): freeze what the canvas shows

Once a level has one stored position, the in-memory layout only places the remaining nodes below their predecessor, or in a column below everything. Any command that writes the first position of a level must therefore also write the positions the canvas shows for its unplaced nodes (`freeze`), in the same edit. Moves, Quick add and failure patterns already did. Paste and _Extract into subflow_ now do as well; without it, a paste stacked the whole flow in one column (product-owner report).

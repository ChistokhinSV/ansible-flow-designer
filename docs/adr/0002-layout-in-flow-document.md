# ADR-0002 · Layout inside flow.yaml, one flat map

Status: Accepted · 2026-10-28 · AFD-1 · amended by AFD-17 and AFD-23 (see the end)

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

## Amendment (AFD-23, 2026-10-31): partly placed levels keep ELK's shape

The AFD-17 rule covered the designer's own commands, which freeze what the canvas shows. Positions can still be partial when nodes come from elsewhere: an AI agent's edits, a hand edit, or a flow made by _New Flow_, whose template stored Start and Done. An agent-built flow then stood in one column, with siblings on top of each other (product-owner report).

- **New flows store no positions.** The template (`newFlowText`, also used by `flow_new` and _Create a flow here_) writes no `layout:` block. The canvas lays the flow out until the first move or _Tidy up_ writes the shown positions.
- **The old template positions are ignored in the view.** A level whose only stored positions are the old template's (Start at 0,0, Done at 36,160) while it has other nodes is shown fully auto-laid out (`shownLayout`). The file is left as it is until the next move freezes what is shown.
- **Unplaced nodes keep ELK's shape.** On any other partly placed level, `autoPositions` lays out the whole level with ELK. Each unplaced node goes where ELK puts it relative to a placed neighbour (its predecessor first), else by the placed nodes' median shift, and moves right while it would overlap a node. Before, each went straight below its predecessor.

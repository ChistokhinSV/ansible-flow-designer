# ADR-0020 · Export: draw.io diagrams and images drawn from the canvas geometry

Status: Accepted · 2026-10-31 · AFD-25

## Context

Flows were only visible in VS Code. The product owner asked to export flows and subflows as
images and as draw.io diagrams, with node details people can read in draw.io.

Decisions (product owner, 2026-10-31):
1. Formats: draw.io, SVG and PNG; no PDF (draw.io exports PDF from the `.drawio` file).
2. Subflows in draw.io: one page per level, a subflow node linking to its page.
3. Node details as draw.io shape data: identity and intent, binding, data and settings, problems and
   ports.
4. Entry points: commands, the designer's "…" menu, the Explorer's right-click, and an AI tool.
5. Images: the open level from the designer; from the Explorer or the command, the top level or
   every level (one file each, `<key>--<subflow path>`).
6. Images are always light.
7. Images embed the draw.io file (`.drawio.svg`, `.drawio.png`).
8. PNG is drawn by the designer webview; the AI tool offers draw.io and SVG only.

## Decision

**One geometry.** The canvas's level projection (`levelView`, `boundaryView`: positions, port sides
and slots, port states, the subflow frame) moved from the webview to `core/flow/levelView.ts`, and
the palette (`TONES`, `FILLS`) to `core/theme.ts`. The webview re-exports both, unchanged.

**Scenes** (`core/export/scene.ts`): per level, the view from the session snapshot (stored and
auto positions, findings, open ports). Wires are routed with React Flow's own `getSmoothStepPath`
from `@xyflow/system` (now a direct dependency, pinned to the version React Flow uses), between
the same handle points the canvas uses. Levels come in drill-down order. That package also
imports d3's zoom and drag, which declare side effects; the host and MCP builds resolve `d3-*` to an
empty module (`scripts/build.mjs`), since neither ever pans or drags.

**draw.io** (`core/export/drawio.ts`), uncompressed XML:
- one `<diagram>` per level, ID `afd-<level>`;
- nodes are `UserObject`s with the details as attributes and a `tooltip`, styled like
  `styles.css` (status fills, dashed drafts, `shape=ext;double=1` for subflows, pills);
- ports at rest are child cells with relative geometry; wires are orthogonal edges between port
  cells, so draw.io keeps them attached when nodes move;
- subflow nodes and page titles carry `link="data:page/id,…"`;
- the flow's own data sits on the root cell (`id="0"`).

**SVG** (`core/export/svg.ts`): the same scene drawn as the canvas draws it, light theme. There is
no text layout without a browser, so titles are cut with an ellipsis using Helvetica/Arial
advance widths (`core/export/text.ts`), with the SVG asking for Arial first. The draw.io file goes
in the `content` attribute, as draw.io writes `.drawio.svg`.

**PNG:**
- the host sends the SVG to a designer panel (`renderPng` / `pngRendered`), which draws it on a
  canvas at twice the size (less when the canvas would pass 16,000 px or 120 Mpx);
- the host then embeds the draw.io file as a zTXt chunk with the keyword `mxGraphModel` and
  raw-deflated, URI-encoded content (`core/export/png.ts`). This matches what draw.io 27 writes;
  checked by decoding its own export.

**Hosts:**
- `extension/export.ts` registers `afd.exportDrawio` and `afd.exportImage`. They take an optional
  `{out, level, format, quiet}` for tests and scripts, and read the session snapshot (the shown
  layout, with the old template positions ignored);
- PNG opens the designer when it is not open and waits for its `ready`;
- `flow_export` writes through a new optional `FlowIO.writeExport`: `.drawio` and `.svg` inside the
  roots only, in the MCP server and in Copilot's tools.

## Consequences

- An export looks like the canvas and stays in step with it: there is one geometry.
- draw.io opens the files as editable diagrams with the node details, but edits there do not come
  back; the flow stays the source.
- Wires follow the canvas's routes in images. draw.io routes its own orthogonal wires between the
  same ports, so wire bends can differ slightly from the canvas there.
- SVG text widths are estimates. A viewer without Arial or Helvetica may draw titles a little
  wider or narrower; titles still end with an ellipsis.
- PNG needs VS Code with the designer; agents get draw.io and SVG.
- Bundles: the host grows by about 40 KB (624 KB) and the MCP server by about 34 KB (877 KB, within
  its 900 KB budget).
- Checked with draw.io desktop 27.0.9:
  - it renders the top level and subflow pages;
  - it reads the diagram back out of our `.drawio.png` and `.drawio.svg`.
- A real Claude Code (2.1.314), asked for a draw.io file and a wiki picture, used `flow_export` for
  both, with a draw.io drawing skill also installed.

## Amendment: wires round nodes (AFD-70, 0.45.0)

Context: the AFD-69 layout check showed what a product owner had seen on an AI import. After Tidy Up,
several failure wires into one rescue step ran through the steps between. ELK places the nodes but
gets no ports and its routes are dropped; the canvas and this scene draw each wire as a smooth step
from port to port, which steers round nothing. Any wire that skips a layer, or goes back up the
flow, can cross a node, on hand-made layouts too.

Options:
- (a) **Port-aware ELK** (`in` on top, normal outcomes below, problems right). ELK would keep its
  long edges beside the nodes, but only for the routes it computes, which are not drawn. The smooth
  step would still cut through, and still does after the first hand move. It also moves every
  auto-laid-out node in every flow.
- (b) **Draw ELK's routes** (bend points) on the canvas and here. They exist only right after a
  layout and go stale on the first move or drag. Keeping them means storing bend points in the flow
  file (ADR-0002 stores positions only), or running ELK on every change. ELK's layered algorithm
  cannot route around fixed positions, and libavoid is not in elkjs.
- (c) **Our own router** that steps round node boxes, used everywhere a wire is drawn.

Decision: (c), in `core/view/route.ts`: `routeWire(a, side, b, side, boxes, label)`.
1. **The smooth step first.** React Flow's `getSmoothStepPath` between the two ends, unchanged,
   whenever its corners clear every node box of the level (boxes shrunk by 2 px, the layout check's
   test). So every wire that ran clear looks exactly as before, label included.
2. **Otherwise an orthogonal route**, A* over a grid of lines: the two stub ends, lines 25 px off
   each box edge (a stub's own distance), and the middle of gaps too narrow for those. A stretch
   that would come within 8 px of a box is not taken. The cost is length, plus 40 px per turn,
   plus the length of a stretch that runs within 25 px of a box, plus 1 % for wire off the stub
   lines. That last part breaks ties so that wires into one port share their last stretch. No
   U-turns. The route
   keeps the smooth step's 20 px stubs, and its corners are drawn with the same 5 px rounding.
   The heuristic is distance plus the turns still needed (0, 1 or 2), so A* stays exact. Ties go
   to the deeper state, then to push order, so a route is the same wherever it is drawn. Nodes more
   than 400 px off the box spanning the two ends are left out of the first search; if it finds
   nothing, it runs again with every node.
3. **Boxed in:** when a stub end lies in or within 8 px of a box, or no route exists, the wire
   keeps its smooth step. The layout check still reports it.
4. **Labels on a route** go on the first stretch from the source that holds them clear of every
   box, as near its middle as possible, so a label sits by the port it names.
5. **Obstacles are nodes only.** Notes, Text, Sections, the subflow frame and Changes-lens ghosts
   are not avoided. A wire under a note is still reported by the layout check.
6. **Where it applies:**
   - the scene routes the level's wires and the boundary's entry and exit wires; `Wire.bends`
     holds a route's corners;
   - draw.io writes them as `<Array as="points">` waypoints, so draw.io draws the same route;
   - SVG and PNG draw the path;
   - the canvas draws its level and boundary wires with a custom edge (`RoutedEdge`). It routes
     the measured handle ends among the boxes of the canvas's own nodes state, so a wire steps
     aside while a node is dragged. The boxes reach the edges through a context, rebuilt only when
     a box moves or resizes. Data-lens wires stay bezier curves.

Consequences:
- Tidy Up and `tidy_up` leave no wire through a node on the rescue shape that prompted AFD-69. Only
  crossings remain, and moving the rescue step beside the step its wires skipped clears those.
  Across the repository's 23 flows, the 19 levels whose wires all ran clear export byte for byte as
  before; the 6 levels with wires through nodes changed only in those wires.
- The layout check reads the same scene, so "runs through" now means boxed in, or a note or text in
  the way. Its hint (`LAYOUT_FIX`), the import prompt, the skill and the `tidy_up` description say
  so.
- Cost: most wires only pay for the smooth step's check. A routed wire takes 0.04–1.1 ms; the
  longest are in the repository's examples. All 23 flows build every scene in about 24 ms (12 ms
  before), and a 100-node grid with 64 routed wires takes about 63 ms. On the canvas, routes are
  memoised per wire and recomputed when an end or a box moves. os-upgrade's webview render median
  went from about 12 ms to 17 ms in `just perf`. First render and round trips stayed within budget
  in quiet runs, and both versions miss the 100 ms round-trip budget at times under load.
- Bundles: extension 801.0 KB of 832 and MCP server 1002.0 KB of 1088 (+5 KB each); the webview does not grow,
  since React Flow already ships the smooth step.
- A route does not avoid other wires, so wires can still cross. Two routes can also run along the
  same line in opposite directions in a dense level.

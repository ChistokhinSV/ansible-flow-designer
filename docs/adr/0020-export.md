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

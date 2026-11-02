# ADR-0028: Annotations (Notes, Sections, Text)

- Status: accepted (2026-11-02, AFD-64)
- Context: wave 6 (KB AFD-A-17)

## Context

A flow says what runs; the reasons around it (why the pre-checks are safe to rerun, which steps are
the change window, where the runbook is) lived in node intents or outside the file. The product
owner asked for elements that explain a flow and never run (2026-11-02):

- **Kinds:** a sticky **Note**; a Note **on a node**, tied to it, which moves with it; a
  **Section**, a titled region behind nodes that carries what is inside it when dragged (nothing
  stores membership); **Text**, words with no background, in three sizes.
- **Text:** simple Markdown, from a parser of our own: no HTML, no new dependency.
- **Where else they show:** exports, AI tools, the Changes lens, and comments in generated code for
  Notes on a node.
- **Names:** "Frame" is the subflow boundary and "label" means wire and port labels, so the kinds
  are Note, Section and Text, under the umbrella "annotation".

## Decision

- **In the file:** per level, next to `nodes` and `edges`: `annotations:` on the top level,
  `subflow.annotations` inside a subflow. Because they nest with their level, extract, shared copies,
  deleting a subflow and paste carry them without bookkeeping.
- **An item:** `{id, key, kind, on, x, y, width, height, color, size, text}` (`$defs/annotation`,
  closed).
  - `id` is a ULID in the flow's one ID space, because the canvas draws nodes, wires and annotations
    together.
  - `key` is per level, by kind (`note-1`, `section-2`, `text-1`), never a slug of the text, which
    changes.
  - `on` ties a Note to a node of its level. Its `x`, `y` are then relative to that node, so it
    follows moves, optimistic drags and Tidy Up with no extra writes.
  - `text` comes last, as a YAML literal block (`|-`) when it spans lines.
- **Format 2 only** (`requireFormat`). No new format: the root and `subflow` objects are open in the
  schema, and the key is optional.
- **Not design:**
  - Annotations are removed **by location** from the version-bump key (`semanticKey`), node designs
    (`nodeDesign`) and shared fingerprints (`refDesign`), through `withoutAnnotations` in
    `src/core/flow/semantic.ts`.
  - They are not removed by key name, because a module parameter may be called `annotations`
    (Kubernetes metadata), and that is design.
  - The annotation commands are in `NO_DESIGN`, so they never drop `tested` or settle statuses.
- **Commands** (`src/core/flow/commands.ts`):
  - `addAnnotation`, with `freeze` like `addNode`;
  - `updateAnnotation {id, patch}`: tying and untying convert between relative and absolute positions
    through the stored layout, so the Note stays where it is shown;
  - `moveNodes`/`tidyUp` take `annotations`, so a Section drag is one edit;
  - `deleteNodes` takes `annotations`, so a mixed Delete is one undo step.
  - Deleting a node removes the Notes on it in the same batch, and the `annotations` key goes with
    the last item.
  - Extract into Subflow takes the Notes on the extracted nodes and the annotations picked.
  - Paste gives annotations new IDs and keys, ties them to the pasted copies, and accepts a clip of
    annotations only.
  - A shared copy brings the source level's annotations with new IDs.
- **Geometry** (`src/core/flow/annotations.ts`, `geometry.ts`):
  - `levelView` returns the level's annotations with absolute boxes, and the subflow frame includes
    them. The canvas and the exports share this.
  - `sectionContents` lists the nodes and annotations wholly inside a Section. The canvas drag and
    the AI `move` op both use it.
- **YAML:** an opt-in `Literal` value (`src/core/yaml/render.ts`) writes a multi-line string as a
  literal block only when it parses back to the same string, else as a quoted scalar. Other writers
  keep their quoted multi-line strings, and import goldens are unchanged.
- **Checks:**
  - `annotation-target-missing` (warning) covers a Note on a node that is not on its level, a Section
    or Text with `on`, and annotations in a format 1 file.
  - Annotation IDs share `duplicate-id`; keys get `duplicate-key` per level.
  - Complete IDs fills a hand-written annotation's `id` and `key` and resolves `on` by key.
- **AI tools:**
  - `annotate {kind, text, on, in, position, width, height, color, size, key}`;
  - `update_annotation {annotation, ...}` by key path (`note-1`, `fix-ntp/note-1`);
  - `delete` and `move` take `annotations`, and moving a Section carries its contents.
  - `flow_describe` lists annotations per level.
  - Info-level problem counts say `info` instead of `note(s)`, so agents never mix the two.
- **Markdown** (`src/core/view/markdown.ts`): paragraphs, `- ` lists, bold, italic, code, links and
  bare URLs, parsed into plain parts. Only http(s) URLs become links; the parts feed text nodes,
  plain text and an escaped HTML subset.

## Consequences

- Annotations can be added and changed at any time without moving a flow's version or its tested
  steps; reviews see them in Git and, from AFD-66, in the Changes lens.
- A Note on a node goes wherever the node goes, including into a subflow and onto the clipboard.
- Tidy Up moves nodes only: Sections, free Notes and Text keep their places.
- Not covered: notes on wires; Markdown headings, tables and images.

## Amendment: exports (AFD-66, 2026-11-02)

- `Scene.view.annotations` comes from `levelView`, and `boundsOf` includes them.
- **SVG:** Sections are drawn before the frame and wires, and Notes, ties and Text after the nodes. The Markdown is made plain and wrapped (`wrapText`).
- **draw.io:**
  - Sections are rounded cells before the nodes;
  - Notes use `shape=note`, with the Markdown as an escaped HTML subset (`markdownHtml`: b, i, code, a, ul/li);
  - Text cells have no border or fill;
  - ties are dashed edges with no arrow from the note to its node;
  - each annotation carries `annotation`, `key` and `text` as shape data.

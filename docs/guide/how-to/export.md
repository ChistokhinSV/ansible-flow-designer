# Export as draw.io or an image

Share a flow with people who do not use VS Code: as a draw.io diagram with every level and the
details of each step, or as an SVG or PNG image for a wiki page, a ticket or a slide. The flow file
stays the source: export again after a change. Edits made in draw.io do not come back to the flow.

## A draw.io diagram

Choose **Export as draw.io…** in the designer's **…** menu, run **Ansible Flow: Export as draw.io
Diagram…**, or right-click a `*.flow.yaml` in the Explorer. Pick where to save; the default is
`<key>.drawio` next to the flow.

The file opens in draw.io desktop, at app.diagrams.net, and in VS Code with a Draw.io extension.

- **One page per level.** The top level comes first, then each subflow, named after its title and
  key path, e.g. "Upgrade (upgrade)". A subflow node links to its page; the title on a subflow page
  links back to the level above.
- **It looks like the canvas**, in the light theme:
  - status colours;
  - dashed drafts;
  - double borders on subflows;
  - dashed wires from problem ports;
  - each wire labelled with its port.

  Nodes stay where the canvas shows them, including nodes the auto-layout places.
- **Ports are small shapes** on the node edges, and the wires are attached to them, so moving a node
  in draw.io keeps its wires. Ports left open show their name: amber when not handled, dashed when
  open on purpose.
- **Node details travel along.** Select a node and press **Ctrl+M** (Edit Data) to see them; hovering
  a node shows a summary.
- **The flow's own data** sits on the page background: select nothing and press Ctrl+M. It holds
  the name, key, version, goal, inputs and problem counts.

| Attribute                                                     | Holds                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `key`, `path`, `type`, `status`, `intent`                     | who the step is; `path` is `subflow/step` inside subflows                 |
| `handler`, `outcome`, `condition`, `branches`, `join_mode`    | what the node type adds: failure handler, end outcome, decision condition |
| `binding`, `collection_version`, `register`, `params`, `undo` | what the step runs; `params` is YAML                                      |
| `inputs`, `outputs`                                           | one field per line: `name: type (required) = default <- from`             |
| `retries`, `until`, `delay`, `timeout`, `serial`, …           | the step's settings, including `become`, `credential`, `inventory_target` |
| `steps`, `entry`, `exits`                                     | subflow nodes: how many steps, where hosts enter and leave                |
| `open_fail_ports`, `open_on_purpose`, `problems`              | what is not handled, ports left open with the reason, validator findings  |

Port shapes carry `port`, `state` and `reason`. Wires carry `port`, `from` and `to`, and exits
carry `exit`, `from` and `reason`.

## An image

Choose **Export as image…** in the **…** menu for the level open on the canvas. **Ansible Flow:
Export as Image (SVG, PNG)…** and the Explorer's right-click ask instead: the top level, or every
level.

- **SVG** is a vector image. **PNG** is drawn at twice the size. PNG needs the designer to lay
  out the text, so it opens the flow in the designer first when it is not open.
- **The light theme always**, whatever theme VS Code uses.
- **Every level** writes one file per level, named after the one you pick:
  `firewall-upgrade.drawio.svg`, `firewall-upgrade--upgrade.drawio.svg`, and so on.
- **The images are draw.io files too.** A `.drawio.svg` or `.drawio.png` also holds the draw.io
  diagram, with all levels and this one first. Image viewers show the picture; draw.io opens it as
  the editable diagram with all its details.

## From an AI assistant

Ask "export the firewall flow to draw.io" or "give me an SVG of the upgrade subflow". The agent uses
the `flow_export` tool, which writes a draw.io file or SVG images next to the flow. PNG comes only
from the command in VS Code. See [AI assistants](ai-assistants.md).

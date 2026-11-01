# Canvas basics

A `*.flow.yaml` file opens in the **Ansible Flow Designer** editor. The canvas shows one level at a
time: the top of the flow, or the inside of one subflow.

![The designer](../images/canvas-light.png)

## The screen

- **Top bar:**
  - the breadcrumb;
  - the mode toggle: **Design**, **Code** (design vs code) and **Run** (the last run);
  - the **Lens** dropdown;
  - the mode's main action: **Run as Skeleton**, with **Run for Real…** under its chevron;
  - a "…" menu with _Tidy Up_, _Open in Text Editor_, _Export as draw.io Diagram…_, _Export as
    Image…_, _Check Flow_, _Keyboard Shortcuts_ and _User Guide_.
- **Palette** (left): node types and failure patterns, and a legend of port and wire styles.
- **Canvas** (middle): nodes, ports and wires.
- **Right panel:** the flow (name, goal, owner, maintenance window, inputs, readiness) when nothing
  is selected; the **inspector** of the selected node; or the selection panel for several nodes.

## Nodes

| Type           | Use it for                                                      |
| -------------- | --------------------------------------------------------------- |
| task           | one unit of work: a module, a role or a playbook                |
| subflow        | a phase with its own inner steps (a level)                      |
| decision       | split hosts by a condition: `true` / `false`                    |
| approval       | a person decides: `approved` / `rejected`                       |
| parallel, join | branches that run side by side, and where they meet             |
| start, end     | where hosts enter and where they finish (`success` or `failed`) |

A node's **status** is shown by its dot: draft, specified (has inputs or outputs), implemented
(bound to code), tested (a passing real run).

## Add, wire, move, delete

- **Add:**
  - click or drag a type from the palette;
  - drag from a port and release on empty canvas (Quick add);
  - right-click the canvas → **Add Node Here…**;
  - or a port's **Insert node on this wire**.

  ![Quick add](../images/quick-add-light.png)
- **Wire:** drag from an output port to another node. One wire per output port; a node takes any
  number of wires in.
- **Move:** drag; arrow keys nudge the focused node. Positions go to the flow's `layout:` block.
  **Tidy Up** lays out the whole level. Nodes without a position (a new flow, or steps an AI agent
  added) are placed next to their neighbours until you move them.
- **Delete:** Delete or Backspace. A whole selection is one undo step.
- **Select several:** Ctrl+click, or Shift+drag a box.

Every action is one small text edit: Ctrl+Z undoes it, and comments and formatting elsewhere in the
file never change.

## The right-click menu

Right-click a node, a selection, a wire, a port or the empty canvas.

![The node menu](../images/context-menu-light.png)

- **Node:** Open subflow, Details…, Binding…, Rename, Status ▸, one submenu per open
  fail port, Add next node…, Cut, Copy, Duplicate, Open in Text Editor, Peek code, Delete.
- **Selection:** Cut, Copy, Duplicate, Extract into subflow…, Delete.
- **Wire:** Insert node on this wire, Rewire to another node…, Disconnect.
- **Empty canvas:** Paste here, Add Node Here…, Select all, Tidy Up, Fit view, Up to parent.

Shift+F10 or the Menu key opens it for the selection. Run mode only reads.

## Keyboard shortcuts

Press `?` for the sheet. Ctrl means ⌘ on macOS.

![The keyboard shortcuts sheet](../images/cheat-sheet-light.png)

| Keys                     | Action                                               |
| ------------------------ | ---------------------------------------------------- |
| Ctrl+C / Ctrl+X / Ctrl+V | Copy, cut, paste nodes                               |
| Ctrl+D                   | Duplicate the selection                              |
| Delete / Backspace       | Delete the selection                                 |
| F2                       | Rename (the inspector's Title)                       |
| Enter / Alt+↑            | Open the selected subflow / back to the parent level |
| Arrow keys               | Nudge the focused node                               |
| Esc                      | Close the menu or dialog; else clear the selection   |
| Shift+F10                | Context menu for the selection                       |
| Ctrl+F5 / Shift+F5       | Run as Skeleton / Stop Run                           |
| Ctrl+Shift+B             | Generate Code                                        |
| Shift+Alt+F              | Tidy Up                                              |
| F7                       | Check Flow                                           |

The last four are VS Code keybindings, active while the designer has focus: change them in VS
Code's Keyboard Shortcuts ([commands](../reference/commands.md#keyboard)).

## Zoom

Zoomed out, nodes show titles only. At normal zoom they show the status and two chips; from 1.4×,
summary rows. Select a node for a summary card. Pause on a subflow or a bound node for a preview of
what is inside.

## Text and the designer

**Open in Text Editor** opens the YAML next to the canvas. Both edit the same document, so save, dirty
state, undo, Git diff and hot exit are VS Code's own. `flow.version` goes up once per commit when
the design changes (not for layout moves).

See also: [ports and failure patterns](ports-and-failure-patterns.md), [subflows](subflows.md),
[copy and paste](copy-paste.md).

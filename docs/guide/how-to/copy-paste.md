# Copy and paste nodes

Copied nodes are plain YAML on the clipboard. You can paste them into another flow, or into a text
file to keep as a snippet.

## Copy

Select one or more nodes, then press **Ctrl+C**, use **Copy** in the Details or the selection
panel, or run **Ansible Flow: Copy Nodes**. In the right-click menu, _Copy_ takes the node you
right-clicked.

The clipboard holds:
- the nodes, with their inner levels;
- the wires between them;
- their layout;
- their open-on-purpose decisions.

## Paste

Press **Ctrl+V** on any flow's canvas, or run **Ansible Flow: Paste Nodes**. The nodes land on the
open level, at the pointer, in one undo step. _Paste Here_ in the right-click menu puts them where
you clicked.

- Every pasted node, inner node and wire gets a new ID.
- A key the level already has gets `-2`, `-3`, …, and `from:` references between the pasted nodes
  follow it. References to nodes that were not copied stay as written.
- `tested` becomes `implemented`: the copy has not run here.
- Wires to nodes that were not copied are dropped. Start nodes are not pasted.
- Pasted into an empty subflow, the first node becomes its entry.

## Paste a snippet written by hand

One node, a list of nodes, or a `nodes:` mapping pastes too:

```yaml
- { type: task, title: Check NTP, intent: Compare the NTP servers with the standard }
```

## Duplicate and cut

**Ctrl+D** duplicates the selection next to it. **Ctrl+X** cuts it.

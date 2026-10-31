# Subflows

A **subflow** node is a phase with its own inner steps: a level of its own. Use subflows to keep each
level short, top-down: the top level reads like a runbook, and each subflow holds the details of one
phase.

## Open, navigate, go back

- Double-click a subflow, press **Enter**, or use **Open subflow** (node menu, inspector, summary
  card).
- **Back**, the breadcrumb, or **Alt+↑** returns to the parent level.
- With nothing selected, the right panel describes the subflow you are in (its title, intent,
  contract and ports), not the whole flow.
- Chips at the top show what the inner steps inherit: inventory target, credential, execution
  environment, become, serial.
- Pause on a subflow node to preview its inner steps, exits and last-run results.

![The inner level of the pre-checks subflow](../images/subflow-level-light.png)

## The boundary

A dashed **boundary frame** carries the subflow's own ports: `in` on top, outcomes below, problems
on the right.

- **Entry:** drag from the frame's `in` to the inner step that receives the hosts. The first step
  you add to an empty subflow becomes the entry.
- **Exits:** drag from an inner port to a frame port. For example, the last step's `ok_hosts` to the
  frame's `ok_hosts`, and every inner `failed_hosts` to the frame's `failed_hosts`. An optional port
  (such as `unchanged`) is enabled on the subflow when you use it.
- **Exit reasons:** select an exit wire to give it a reason (shown on the wire, e.g. _SSH timeout_),
  or to remove it.

Hosts that leave through an exit continue from the subflow node's port of the same name on the
parent level.

## Extract steps into a subflow

1. Select several connected steps: Ctrl+click, or Shift+drag a box.
2. **Extract into subflow** in the right panel (or the selection's right-click menu), and give it a
   title.

![Two steps selected for extraction](../images/extract-selection-light.png)

The steps and the wires between them move into the new subflow, with their IDs, in one undo step:
- wires in must reach one step, which becomes the entry;
- wires out become exits through the subflow's ports;
- outputs that steps outside read become subflow outputs, and those references are rewritten.

It works inside subflows too.

## Data across the boundary

- **An inner step reads its subflow's input** as `from: <subflow key>.<input>`, e.g.
  `rollback.backup_file`.
- **Steps outside read what the subflow lifts:** a subflow output names the inner output it lifts
  (`from: store.backup_file`). Without `from`, it lifts the inner output of the same name.
- **The @ picker lifts for you** when you pick an output of a step inside another subflow.

Details in [data between steps](data-between-steps.md).

## What the validator checks

A missing entry, outer ports no inner step feeds, inner outcomes that lead nowhere, exits that
refer to steps outside, and subflow outputs nothing inside sets.

## Generated code

Each subflow level is its own playbook, `generated/<flow key>.<subflow key>.yml`, imported where
the subflow node sits. See [generated code](code-generation.md).

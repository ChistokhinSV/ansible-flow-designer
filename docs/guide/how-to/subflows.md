# Subflows

A **subflow** node is a phase with its own inner steps: a level of its own. Use subflows to keep each
level short, top-down: the top level reads like a runbook, and each subflow holds the details of one
phase.

## Open, navigate, go back

- Double-click a subflow, press **Enter**, or use **Open Subflow** (node menu, its Details, its
  preview card).
- **Back**, the breadcrumb, or **Alt+↑** returns to the parent level.
- With nothing selected, the right panel describes the subflow you are in (its title, intent,
  contract and ports), not the whole flow.
- Chips at the top show the settings of the subflows around you. The inner steps inherit the
  inventory target (**inherits …**). In a format 2 flow they also inherit **become** and its user
  (Execution › Privilege), the nearest subflow's setting winning, so a step can still turn it off.
  A Become user without Become is still written: it applies when `ansible.cfg` or the inventory
  turns become on. Become set to false turns both off.
  In a format 1 flow become set on a subflow is shown as **not applied**: set it on the steps.
  Serial is per node: it batches the hosts of that node's own play.
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

- **Named exits:** an exit can have a name of its own, such as `dry_run_done` or `nothing_to_do`
  (lowercase letters, digits and `_`; not a port name a node uses). The subflow node then has a
  port of that name, drawn below next to `ok_hosts`, which you wire on the parent level like any
  other. Use it for hosts that stop early inside the subflow and go somewhere of their own; with
  the AI tools, `add_exit` with the new name.
- **An end node inside a subflow** ends the run for the hosts that reach it: they do not come back
  to the parent level, and nothing after the subflow runs for them (as `meta: end_play` does).

## Extract steps into a subflow

1. Select several connected steps: Ctrl+click, or Shift+drag a box.
2. **Extract into Subflow** in the right panel (or the selection's right-click menu), and give it a
   title.

![Two steps selected for extraction](../images/extract-selection-light.png)

The steps and the wires between them move into the new subflow, with their IDs, in one undo step:
- wires in must reach one step, which becomes the entry;
- wires out become exits through the subflow's ports; normal hosts that leave for two places
  get a named exit for the second one (named after the step and port, such as `check_true`);
- outputs that steps outside read become subflow outputs, and those references are rewritten.

It works inside subflows too. The reverse is **Dissolve Subflow** in a subflow's right-click menu
(the AI tools' `dissolve_subflow` op): its steps move back up to its level, in one undo step.
Wires into the subflow go to its entry step, its exits become wires from the inner ports, and
references follow. On the canvas the steps keep their arrangement, placed where the subflow
stood; run **Tidy Up** if they cover their neighbours. A shared subflow is unlinked first.

### Expand a subflow in place (experimental)

With the setting `afd.canvas.expandSubflows` on (off by default; reopen the designer after
changing it), a subflow node has a small arrow in its corner. Click it and the node grows into a
frame on its own level, with its inner steps and wires drawn inside; click it again to close it.
The steps under and beside the frame move aside on screen only: nothing is written to the flow
file, and a step you drag is saved where it stands with the frame closed.

Inside the frame the steps are for reading: select one to see its Details, double-click the frame
to open the subflow and edit it there. Ports and wires inside the frame cannot be changed, the
frame itself is not dragged, and notes of the inner level are not shown. This is a trial: say
whether it helps before it is kept.

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

## Rolling subflows

By default each step of a subflow runs on every arriving host before the next step starts. For a
rolling change (upgrade a few switches at a time, each fully, then the next few), set **Rolling
batch** on the subflow (Execution › Targeting): a number of hosts, or a percentage like `25%`.

```yaml
settings:
  rolling: 2 # 2 hosts at a time through every step inside
```

The subflow's steps then run in one play with `serial: 2`: a batch goes through all of them, the
hosts take the same ports as without rolling, and then the next batch starts. The level shows a
`rolling, 2 at a time` chip.

Every step must fit in one play: tasks (bound to a module or a role, or not bound yet), decisions
and end nodes. A nested subflow, an approval, a parallel or join, a playbook binding, an
`inventory_target`, or a step's own `serial` or `max_fail_percentage` needs plays of its own: the
validator reports `rolling-unsupported` on that step, and the code runs the steps play by play.
`serial` on the subflow node itself batches nothing inside; use **Rolling batch**.

## Shared subflows

A subflow written once can be used in other flows: **Insert Shared Subflow…** (the canvas menu, or the
Command Palette) lists the subflows of every other flow in the workspace and copies the one you pick
here, pinned to that flow's version (format 2):

```yaml
- key: backup
  type: subflow
  title: Backup
  ref:
    from: ../shared/backup.flow.yaml#backup # the file, relative to this flow, and the subflow
    version: 3 # the source flow's version the copy was made from
    design: 6c1f0a2e # a fingerprint of the copy as it was made
  subflow: ... # the copy itself: the code, runs and reviews need nothing else
```

- Its level shows **shared from … · edit it there** and takes no edits: change the source flow.

  ![The level of a shared subflow: where it comes from, and no edits here](../images/shared-subflow-light.png)

- When the source flow has a newer version, the copy shows a problem with **Update Shared Subflow**:
  it copies the subflow again (its steps start untested: they have not run here). Saving the source
  is enough for open flows to notice.
- A copy changed here anyway (by hand or by an agent) is flagged (`shared-edited`); **Unlink Shared
  Subflow** makes it this flow's own, to edit here.
- A source that is gone (the file or the subflow) is an error, with Unlink as the way out.
- The source must be a `.flow.yaml` in the same workspace folder, named by a path relative to this
  flow, and at most 2 MB. Absolute and network paths (`\\server\share\…`) are refused without being
  opened, so a flow from someone else cannot make the editor connect to another machine.
- A source flow still in format 1 is copied as format 2: Insert and Update upgrade it in memory, the
  way **Upgrade Flow Format** would, and leave its file as it is.

The flows of a folder such as `flows/shared/` become a pattern library: real flows, tested like any
other, whose subflows the others reuse.

## Generated code

Each subflow level is its own playbook, `generated/<flow key>.<subflow key>.yml`, imported where
the subflow node sits; a rolling subflow's level is one play. See [generated code](code-generation.md).

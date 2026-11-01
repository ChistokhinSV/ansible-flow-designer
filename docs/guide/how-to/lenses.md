# Lenses

A lens looks at the whole flow from one angle. It fills the node chips and opens a **Lens** tab in
the right panel, with its list and its findings; the panel you had (the flow, a node's Details, the
mode's panel) stays in the tab beside it, and selecting a node switches to it. Pick a lens in the top
bar's **Lens** dropdown; ✕ clears it. Lenses work in every mode and never edit the flow. Hover a row
to highlight its nodes.

![The inventory lens](../images/inventory-lens-light.png)

| Lens          | Shows                                                                                                             | Finds                                                                                                                                             |
| ------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Inventory** | each node's target and host count from your inventory; groups added beyond the flow targets (`+ core_spines · 2`) | a handler that targets more than it receives (Rollback on `all`), groups that are not flow inputs, patterns that match nothing, production groups |
| **Data**      | inputs and outputs, dotted data wires from `from:`                                                                | inputs that resolve to nothing, outputs nothing reads                                                                                             |
| **Code**      | each binding with its collection version and the execution environment                                            | not in the environment, removed or deprecated, versions that miss `collections/requirements.yml`                                                  |
| **Access**    | credentials, the connection user, become, vaulted variables (by name and file, never the value)                   | a credential unlike its neighbours', become alone, node credentials outside AWX                                                                   |
| **Timing**    | serial, timeout and average durations from the last 20 real runs                                                  | the slowest path does not fit `flow.maintenance_window`, a node close to its timeout                                                              |
| **Changes**   | what changed since HEAD, a branch or a commit: chips on changed and added nodes, ghosts where removed nodes stood | nothing to fix: it lists every change for a review                                                                                                |
- **Inventory** and **Access** read your inventory through your Ansible environment when you open
  them. **Set targets…** chooses the flow targets (remembered for runs too).
- A finding's button fixes it where it can. **Accept with Reason…** keeps it, with a reason recorded in
  the flow (an `accepted` decision with `finding: lens:<id>`; `finding_accepted` in a format 1 flow);
  **Reopen** removes that.
- Set the maintenance window in the flow panel (e.g. `4h` or `2h30m`).

## Compare with HEAD (Changes)

**Lens → Changes** compares the flow with another version of it from Git, as a review reads a
change. **Compare with** in the lens panel picks the version: HEAD (the default), another local
branch, or one of the last commits that touched the flow.

![The Changes lens](../images/changes-lens-light.png)

- A changed node gets a chip naming what changed (`changed: title, binding`); an added node gets
  `added`; a subflow says how many changes are inside it, so you know where to go in.
- A removed node is drawn as a dashed, struck-through ghost where it stood (or beside the level
  when that version stored no place).
- Select a node: **Since <version>** at the top of its Details lists each field, before → after.
- The panel lists the changed, added and removed nodes, the wires added or removed, and changes to
  the flow itself (name, goal, inputs, runtime, format). A row with a node shows it.

Unsaved edits count: the lens compares what you see with the version you picked. Nodes match by
ID; a flow that got its IDs later (Complete IDs) matches by key.

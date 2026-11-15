# Merging flows in git

Two people change one flow on different branches, or in two clones, and git has to put the two
together. As text, that goes wrong easily: edits on neighbouring lines collide, and a "clean" text
merge can leave a flow that breaks its own rules (two wires on one output port). With flow merging
set up, git merges a flow by its steps instead. Back to the [guide](../README.md).

## Set it up

Run **Ansible Flow: Set Up Flow Merging in Repository** once in the repository. It:

- copies the merge driver to `.afd/afd-merge.js`,
- adds to `.gitattributes`:

  ```
  *.flow.yaml merge=ansible-flow
  *.flow.yml merge=ansible-flow
  ```

- and sets this clone's git to use it.

Commit `.afd/afd-merge.js` and `.gitattributes`. Git keeps the driver setting per clone, so each
person (and each CI machine that merges) runs once:

```bash
git config merge.ansible-flow.name "Ansible Flow Designer flow merge"
git config merge.ansible-flow.driver "node .afd/afd-merge.js %O %A %B %P"
```

Node.js 22 or later must be on the path. A clone without the setting merges flows as text, as
before.

## What merges by itself

Steps are matched by their IDs on every level, so a step one side moved into a subflow is still the
same step. Then, field by field:

- What only one side changed is taken: a new step, a removed step nobody else touched, a title,
  a wire, a note.
- Both sides changed different parts of one step: both are kept (a timeout here, retries there;
  a step's settings, inputs and binding parameters are merged a few levels deep).
- Positions never conflict: yours win.
- The flow's version moves past both when both moved it.
- The file keeps your comments and formatting: the merge is written over your version with the
  fewest edits.

## Conflicts

A conflict is a place both sides changed differently:

- the same field of the same step (both retitled it),
- a step removed on one side and changed or wired on the other,
- two wires from one output port,
- a different flow format on each side (upgrade both first).

The driver then leaves the file with **your** value at each conflict, with no `<<<<<<<` markers,
so it is still a flow the designer opens. Git reports the file as conflicted.

Open the flow: a **Merge** note above the canvas lists each conflict with **Mine** and **Theirs**.
Picking one changes the flow at once (one undo step each), and a conflict on a step shows the step
when you click its name. A choice can be changed back. When all is as it should be, **Finish
merge** marks the file as merged (`git add`); commit to finish the merge.

The three versions wait in the repository's git folder (`.git/afd-merge/`), never in the work
tree. A merged flow that breaks a rule neither side broke is also left for you, with the rule
named in the note.

A file that is not a flow the designer can read (broken YAML on either side) is merged as text, as
git would.

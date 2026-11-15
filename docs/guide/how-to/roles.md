# Roles in a flow

A role runs as one step: the step is bound to the role and its hosts leave by `ok_hosts` or
`failed_hosts` as the role's tasks went. When the parts of a role need routing of their own (a
failed check that should go round the change, a restart only on some hosts), expand it into a
subflow.

## Roles or shared subflows

|                       | A role                                       | A shared subflow                                   |
| --------------------- | -------------------------------------------- | -------------------------------------------------- |
| What it is            | Ansible's unit: tasks, handlers, files, vars | steps of another flow, copied here                 |
| Routing inside        | none: the role runs whole                    | per step: each step has its ports                  |
| Where it is edited    | its folder under `roles/` (or a collection)  | the flow it comes from, then Update Shared Subflow |
| Used outside the flow | yes: any playbook can run it                 | no: flows only                                     |

Keep a role for what configures one thing and travels with its files. Use a
[shared subflow](subflows.md#shared-subflows) for a process with steps and decisions that several flows repeat.

## Expand into Subflow

Right-click a step bound to a role and choose **Expand into Subflow** (flow format 2). The step
becomes a subflow in its place, with its key, wires and position:

- A role whose `tasks/main.yml` only includes task files becomes a step per file, each still the
  role (`include_role` with `tasks_from`). Its handlers, defaults and files work as before.
- Any other role is copied: a step per task, read as an import reads a playbook. Its handlers become
  [notify links](handlers.md), its defaults and vars (and what the step passed to the role) the
  subflow's inputs, and its templates and files are read from the role's folder (from the
  repository root when the flow runs).

A copy is no longer the role: inventory and group_vars can now set the role's `vars`, which they
could not before, and a change to the role does not reach the copy by itself. The designer shows a
role that changed since as information on the subflow, with **Update Expanded Role**, which reads
the role again (changes made in the subflow are lost; it asks first).

A step that runs one task file of a role (`tasks_from`) and a role of a collection cannot be
expanded.

## Collapse to Role Step

While the subflow is as it was made, **Collapse to Role Step** turns it back into the role step,
with its binding and inputs as before. Once its steps were changed, it stays a subflow.

## For agents

`flow_edit` takes `expand_role` (`node`; on an expanded subflow it reads the role again,
`replace_changes: true` when it was changed since) and `collapse_role` (`node`).

## See also

- [Subflows](subflows.md)
- [Handlers: notify and listen](handlers.md)
- [Files from the repository](repository-files.md)

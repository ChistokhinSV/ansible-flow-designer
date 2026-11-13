# Approvals

An **approval** node lets a person decide whether hosts go on: `approved`, `rejected`, and an
optional `timeout` port.

## Who decides

An approval node can say who may decide it, who is told it waits, and what they read first. Set
them in the node's Details (Approvers, Notify, Message), or in the flow file:

```yaml
- key: change-approval
  type: approval
  title: Approve the change
  settings:
    timeout: 4h
  approval:
    approvers: [change-board, dana]
    notify: [netops-oncall]
    message: Check the change ticket and the maintenance window
```

- `approvers`: users or groups, by login or group name, who may decide. Without it, whoever the
  runner lets approve.
- `notify`: users or groups told it waits, beside the approvers.
- `message`: what the approvers read before deciding. In AWX it becomes the approval's
  description.

[Ansible Flow Server](https://github.com/ChistokhinSV/ansible-flow-server) reads them. AWX sets
its approvers in AWX, and local runs approve by themselves. Who approves is not part of what the
node does: changing it keeps the node tested.

## Runs that wait for a person

A runner that waits between the segments (Ansible Flow Server, or a program using `runSegments`
from `@ansible-flow/node`) runs the same segments as AWX, with one difference: it can tell a
**timeout** from a **rejection**, so hosts that waited too long take the approval's `timeout` port.
In Run mode the approval shows **waiting for approval**, then who decided, when and their comment.
Where the runner lets you decide, its Run tab has **Approve** and **Reject** with a comment.

## In AWX: real approval nodes

A flow whose approvals are on the **top level**, with **one waiting at a time**, runs in AWX as a
**workflow**:
- the playbook is cut into segments at each approval (`generated/<key>.seg_*.yml`, written on save);
- _Set Up AWX Template_ creates a job template per segment and the workflow, with an approval node
  at each gate. The approval's `settings.timeout` becomes the AWX timeout;
- approving continues with the hosts that waited at the gate; denying, or a timeout, sends them to
  `rejected` (AWX cannot tell the two apart, so route `rejected` and `timeout` the same way);
- if nobody reaches a gate, AWX skips it without asking anyone.

In Run mode the approval node shows **waiting**, **approved**, **denied** or **timed out**, with a
link to decide it in AWX. See [AWX](awx.md).

Approvals inside subflows, or two that could wait at once, cannot become segments, for AWX or for
a runner that waits for a person. The validator says why (`awx-segments`); they still run locally.

## In local runs: you choose

Local runs (skeleton and real, from VS Code) approve every approval by themselves. The generated
playbook says so in its header, and logs "Change approval: approved in this local run".

To take another port, pass the extra var `afd_approvals` with the approval's key path when you run
the generated playbook from a terminal:

```bash
ansible-playbook -i inventories/lab/hosts.yml generated/firewall-upgrade.yml -e '{"afd_approvals": {"approve": "rejected"}}'
```

- The key is the approval's key, or `subflow/approval` inside a subflow.
- Values: `approved`, `rejected`, and `timeout` when the approval has that port.
- Any other value stops the run with an error naming the allowed values.

## Patterns for approvals

On `rejected` or `timeout`: **Stop Flow**, **Notify On-Call and Stop** (it notifies the
requester), or **Escalate Approval** (a second approver whose `approved` rejoins the flow).

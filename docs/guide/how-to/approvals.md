# Approvals

An **approval** node lets a person decide whether hosts go on: `approved`, `rejected`, and an
optional `timeout` port.

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

Approvals inside subflows, or two that could wait at once, cannot become AWX segments. The
validator says why (`awx-segments`); they still run locally.

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

On `rejected` or `timeout`: **Stop flow**, **Notify on-call and stop** (it notifies the
requester), or **Escalate approval** (a second approver whose `approved` rejoins the flow).

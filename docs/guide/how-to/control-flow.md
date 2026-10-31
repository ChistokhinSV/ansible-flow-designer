# Decisions, parallel branches, approvals and ends

## Decision

A decision sends each host to `true` or `false` by a **condition**: a Jinja test without braces,
evaluated per host.

```yaml
condition: fw_version == target_version
```

- A condition reads the node's **inputs**, like a task's parameters: give the decision inputs
  `fw_version` (`from: normalize.fw_version`) and `target_version` (`from: flow.target_version`).
- The validator warns (`condition-unknown-var`) when a condition reads anything else, and says where
  the value could come from. Ansible's own variables (`inventory_hostname`, `ansible_*`, …) are
  always fine.

## Parallel and join

A **parallel** node sends every host down each branch (`branch_1` … `branch_n`; set the number of
branches in the inspector). A **join** waits for the branches:
- **all** (default): a host continues when every branch it took finished. With the optional
  `failed_hosts` port, hosts that missed a branch go there;
- **any**: hosts continue as they arrive.

Use parallel branches for independent work, such as draining traffic on two load balancers. For
one host list processed in batches, use **serial** in the step's Execution settings instead.

## Approval

An approval lets a person decide: `approved`, `rejected`, and optionally `timeout`.

- **In AWX**, top-level approvals become approval nodes of an AWX workflow
  ([approvals](approvals.md)).
- **In local runs** they approve by themselves, unless you choose another outcome with
  `afd_approvals`.
- **Escalate approval** (a pattern on `rejected` or `timeout`) adds a second approver.

## End

An end node finishes the hosts that reach it, with an **outcome**:
- `success`, like **Done**;
- `failed`, like **Rolled back**, **Excluded** or **Manual recovery**. Hosts on a failed end fail
  in the outcome play at the end of the run, with the end's name in the message.

Use several failed ends with clear names: the run summary then says _why_ each host failed.

## Run on another target

A task, or a subflow (its inner steps inherit it), can run its work once on another host pattern:
**Inventory target** in the Execution settings, e.g. `edge_switches,core_spines` or
`{{ lb_group }}`.
- The arriving hosts wait and leave together: `ok_hosts` when the target finished, `failed_hosts`
  when a target host failed (`max_fail_percentage` tolerates a share).
- A pattern that matches no host fails them.
- Real-run and AWX confirmations name every target and its host count.

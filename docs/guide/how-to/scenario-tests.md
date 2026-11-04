# Scenario tests

A scenario says what happens to each host when chosen steps go wrong, and the designer checks it:
the flow runs with every step as its stub (no module, role or playbook runs, nothing leaves the
machine), the outcomes you force send hosts down other ports, and each host must end where the
scenario says. Scenarios live next to the flow, in `<flow key>.scenarios.yaml`, so a pull request
that changes the routing shows the scenarios it changes.

## Write one

**Run ▾ › Run Scenarios** on a flow without scenarios offers **Create Scenarios File**: one scenario
where every host reaches the end. A scenario has:

- `inputs`: the run inputs; the flow's targets input (a host list) names the hosts, any names you
  like (they connect locally).
- `force`: per step (its key, or `subflow/step` inside a subflow), the hosts sent down a port:
  `failed` (failed_hosts), `unreachable`, `timeout` and `unchanged` when the step has that port, and
  `false` on a decision. A decision sends every other host to `true`: the steps that feed its
  condition are stubs.
- `approvals`: per approval, `approved` (the default) or `rejected`.
- `groups`: hosts for the patterns an `inventory_target` names.
- `expect`: per host, the end node it reaches (`done`, or `subflow/end`), or `<step>.<port>` for an
  output nobody wired, where the host stops.

```yaml
flow: edge-baseline
scenarios:
  - name: a failed validation rolls back that switch only
    inputs:
      devices: [sw-01, sw-02]
      site: lab
    force:
      validate:
        failed: [sw-02]
    expect:
      sw-01: done
      sw-02: failed
```

The Problems panel checks the file against the flow as you type: steps, ports, hosts and ends that
do not exist.

## Run them

**Run Scenarios** (Run ▾, or the Command Palette) runs every scenario in the run environment (the
Ansible image or Python you run flows with). A notification says how many failed. Each scenario
runs every step as its stub, so nothing reaches a device.

- **Show on Canvas** (in the notification) opens the first failing scenario in **Run** mode, like a
  run: each step shows the hosts that took its ports, and each wire how many took it.
- **The run panel** (Run mode, nothing selected) lists every scenario: pass or fail, and each host
  that ended elsewhere ("lab-sw-04: expected reported, ended at stopped"). Click one to show it;
  **Back to Last Run** puts the last run back.
- **An end node** in a scenario lists the hosts expected there and the hosts that came, with where
  each ended.
- The full output stays in the Ansible Flow log (**Show Log**).

## In CI

**Ansible Flow: Copy Scenario Runner to Repository** puts the command-line runner into
`.afd/afd-scenarios.js`; commit it. A CI job with Node and Docker runs every flow's scenarios:

```bash
node .afd/afd-scenarios.js --image ghcr.io/example/netops-ee:2.19 --junit scenarios.xml flows
```

It exits 1 when a scenario fails and writes JUnit XML for the CI's test report. Without `--image`
it uses `ansible-playbook` on the runner (Linux, with `--python` for the interpreter).

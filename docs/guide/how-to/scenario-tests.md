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
Ansible image or Python you run flows with) and says which pass; the hosts that ended elsewhere are
in the Ansible Flow log (**Show Log**).

## In CI

**Ansible Flow: Copy Scenario Runner to Repository** puts the command-line runner into
`.afd/afd-scenarios.js`; commit it. A CI job with Node and Docker runs every flow's scenarios:

```bash
node .afd/afd-scenarios.js --image ghcr.io/example/netops-ee:2.19 --junit scenarios.xml flows
```

It exits 1 when a scenario fails and writes JUnit XML for the CI's test report. Without `--image`
it uses `ansible-playbook` on the runner (Linux, with `--python` for the interpreter).

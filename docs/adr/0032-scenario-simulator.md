# ADR-0032: The scenario simulator

- Status: accepted (2026-11-07, AFD-114)
- Context: wave 11, scenarios you can write without typing YAML

## Context

A scenario (ADR-0026, AFD-58) says where each host must end when chosen steps fail. It was
checked only by a real run: the scenario build of the flow (every step its stub) ran in
ansible-playbook, one container per scenario. A file of five scenarios took minutes. That is fine
for CI but too slow to write scenarios with: the author changes a forced outcome and wants to see
where the hosts go now.

Wave 11 makes scenarios authored on the canvas, by AI tools, and kept current as the flow changes.
All of that needs an answer in milliseconds.

Product-owner decisions (2026-11-07):

- An in-process simulator gives the instant answer. The Ansible stub run stays, as "Verify in
  Ansible" and for CI.
- The simulator must not disagree with the generated code.

## Decision

- **The generator records a plan.** A simulate build with `stubAll` (a scenario build, not an AWX
  segment) records `GenerateResult.plan`, a `RunPlan`:
  - `steps`: the plays of the root playbook in run order. Each step has its kind, the host terms
    of its `hosts:` (routing groups, or the start pattern), the routing group each output port
    leads to, `serial`, and `max_fail_percentage` with the groups it counts.
  - Subflow levels, rolling subflows and `inventory_target` plays are recorded as the generator
    writes them, so the plan already has the wiring, boundary exits and bubbling.
  - `outcome`: the outcome play's entries in order.
  - The YAML does not change; the golden files are the same.
- **The simulator runs the plan** (`src/core/scenario/simulate.ts`). It keeps the hosts of each
  routing group, as `group_by` does, and treats each kind of play as the generated tasks do:
  - **A task stub** fails for the hosts forced `failed`, or `timeout` when it has that port, and
    the rescue routes them to `timeout` or `failed_hosts`. Other hosts go to `unreachable`, then
    `unchanged`, then `ok_hosts`. `always` takes every host. A forced port the step does not have
    is ignored, as the code ignores it.
  - **max_fail_percentage**: over the limit, every host of the play fails, and Ansible stops the
    playbook.
  - **A decision** takes true unless the host is forced false.
  - **An approval** takes the scenario's choice for the run (approved by default), or the port a
    host is forced to. A choice the approval has no port for stops the run, as the `fail` task does.
  - **A parallel** sends hosts down every branch. **A join** passes hosts with `any`, or with `all`
    when every member group holds them.
  - **inventory_target**: the pattern is matched against the scenario's inventory
    (`hostPattern.ts`), and the target's failures against the limit. The arriving hosts leave
    together.
  - **The outcome play**: the first entry that holds a host fails it there.

  The result is the `RunSummary` that `summarizeRun` makes from a run's events, so `judge`, the
  canvas and the run panel read both the same way. A scenario result says `engine: 'simulated'`
  or `engine: 'ansible'`.
- **What it does not model** is listed in `needsAnsible`, and that verdict is a best effort:
  - `serial-max-fail`: Ansible checks the limit per batch.
  - `target-pattern`: regex (`~`), ranges or slices.
  - `start-pattern`: the hosts to run on include a pattern.
  - `jinja-text`: a title, intent or output default that a stub run renders.

  The command line skips those scenarios (`SKIP`, JUnit `<skipped/>`) rather than judge them on a
  guess.
- **Scenario file checks.** These came with the simulator, because the simulator made the gaps
  visible:
  - `force` lists must be lists.
  - An expectation on a wired port is an error: a host goes on from there.
  - An approval choice must be one of the approval's ports. `timeout` is now allowed, as the
    generated code always allowed it.
  - A host that runs but has no expectation is a warning. A `ScenarioProblem` has a `severity`, and
    `blocking()` keeps the errors. Warnings do not stop a run.
  - `targetsInput` reads `targets: true` first, then the first host list, as the start play does.
    Before, a host list declared before the targets input was taken.
- **The command line** (`afd-scenarios.js`) gets `--simulate` (no Ansible) and `--check` (the
  files only). It also names an unknown option, and says so when there are no scenarios instead of
  exiting 0 silently.

## Verification

- **The engine suite** (`test/engine/simulate.test.ts`) runs each case in ansible-playbook in each
  image and compares the summaries. Timings and run order are left out. The cases are:
  - the engine fixtures and both examples;
  - the extracted, rolled and privileged transforms;
  - seeded random flows from `test/shared/flowFuzz.ts`, each with a random scenario.
- **The unit tier**:
  - every simulator rule on the fixtures;
  - properties on 150 random flows: every group filled maps to a port, a host leaves every step it
    runs, and rolling batches do not move a host's end;
  - the cases generate, and the simulator models nearly all of them;
  - under 10 ms for 200 steps and 50 hosts.

The suite found a codegen bug on its first run. An `inventory_target` step copied a register-based
output back to the arriving hosts without checking that the target host had set it. A stub
registers nothing, so every arriving host failed. The copy is now one task per variable, guarded
with `is defined`, as a step's captures are (AFD-53).

## Consequences

- The simulator follows the generator. A codegen change that changes how a play treats its hosts
  must change `simulate.ts` too. Routing changes need nothing, because the plan carries them. The
  engine suite fails on drift.
- Rolling batches change nothing in the simulation, except a limit counted per batch, which is
  flagged.
- A scenario that the simulator passes can still fail in Ansible where it said `needsAnsible`.
  Verify in Ansible remains the reference.

## Alternatives

- **Derive routing from the flow model again.** Rejected: it would repeat the generator's wiring,
  boundary exits and bubbling, and drift from it.
- **Read the generated YAML.** Rejected: it would mean evaluating Jinja `when:` conditions and
  `group_by` keys.
- **Run `ansible-playbook --check` or keep the stub run.** Rejected: both still take minutes.

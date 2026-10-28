# Spike M3 · Option A semantics (AFD-4)

Date 2026-10-28. ansible-core 2.19.14, 2.20.10 and 2.21.5 (`ps-probe-env` images), fictional inventory (`m3-option-a/inventory.ini`): reachable hosts use the local connection, `sw-edge-03` points ssh at a closed port, so it is unreachable. Nothing outside the container is contacted.

Reproduce: `docker run --rm -v "<repo>/docs/spikes/m3-option-a:/work:ro" ps-probe-env:2.19 sh /work/run.sh`

All three versions behave the same. The only difference: the registered result of `include_role` is `{changed, include_args}` on 2.19/2.20 and `{changed, failed}` on 2.21.

## Results

| # | Question | Result |
|---|---|---|
| s01 | Does `rescue` catch an unreachable host? | **No.** The host drops out of every later play; rc 4. |
| s02 | `ignore_unreachable: true` on the block, `register` on the module task | Works. `result.unreachable` routes the host with `group_by` (no connection needed), and a later handler play targets it. rc 0. |
| s03 | Same for `include_role` | `ignore_unreachable` is inherited by the role's tasks, so the role carries on and the host lands on `ok_hosts`. **The outcome cannot be seen**: the registered include result has no task outcome. |
| s04 | Every host of one play fails (open port, no rescue) while another branch still has hosts | **The whole playbook stops.** The other branch's handler never runs. rc 2. Source: `PlaybookExecutor.run` breaks out of the play loop when `len(batch) == failed + unreachable` (unconditional). |
| s05 | Same with every host unreachable | Same stop. rc 4. |
| s06 | Rescue on every node, open ports routed to a group, a final play fails those hosts | Every branch runs; the job still ends failed (rc 2). Same in `--check`. |
| s07 | Parallel and join with dynamic groups | Host in every `branch_n` group; `a:&b` = intersection (join all), `a:b` = union (join any). A pattern with no hosts warns and the playbook continues. Same in `--check`. |
| s08 | `unchanged`; task `timeout` | Modules: `register` + `changed` routes `ok_hosts`/`unchanged`. Roles: no per-host changed signal. Timeout: the task fails, `rescue` sees `ansible_failed_result.timedout = {period, frame}`, so `timeout` is told apart from `failed_hosts`. |
| s09 | `max_fail_percentage` | The play keyword never fires when failures are rescued. A threshold task after the block that fails every host of the play stops the whole flow (rc 2), which is D-08's "whole-flow failure". |
| s10 | Approval segments; templated start; `--check` | `add_host` looped over an artifact var (`afd_hostsets`) rebuilds the routing groups at the start of the next segment. `hosts: "{{ devices \| join(',') }}"` works; an unknown host only warns. `group_by`, `add_host`, `debug`, `fail` all run in `--check`. |
| s11 | Subflow level as `import_playbook` | Inner plays target the parent's groups and route into the parent's port groups (bubbling); the parent continues on them. |
| s12 | Role node: let Ansible drop unreachable hosts, route them at the end of the play (`ansible_play_hosts_all` minus `ansible_play_hosts`) | The group is filled, but **no later play can target a dropped host**, not even after `meta: clear_host_errors` (the executor keeps its own unreachable set). |
| s13 | Role node whose every host is unreachable while another branch has work | The whole playbook stops; the other branch's handler never runs. |

## Consequences for code generation

1. **No host may fail inside a node play.** Otherwise a single node where every host fails stops every other branch (s04, s05). Every task-like node gets `block`/`rescue`. An open fail port routes into its own group, like a wired one. A final **outcome play** then fails the hosts held by open ports, with a message naming the node, the port and the open-on-purpose reason. The job still ends failed and nothing is swallowed (s06). This replaces the "rescue only when wired" rule of ADR-0003.
2. **Unreachable is routable only where the generated code owns the connecting task:** module bindings get `ignore_unreachable` + `register` (s02). Draft nodes never connect.
   - Role bindings cannot route unreachable per host (s03, s12).
   - If every host of a role node is unreachable, the run stops (s13).
   - The validator should say so and suggest putting the connecting step into its own module node or subflow, as `os-upgrade` does with `wait-for-ssh`.
3. **`max_fail_percentage`** becomes a generated threshold task (s09), not the play keyword.
4. **`unchanged`** works for module bindings only (s08); for role nodes the validator warns.
5. **`timeout`** = the task `timeout:` keyword plus a rescue that tests `ansible_failed_result.timedout` (s08).
6. **Join, parallel, subflow levels and approval hand-over** work as designed (s07, s10, s11). The approval segments are built for AWX in M7. Local and skeleton runs auto-approve.

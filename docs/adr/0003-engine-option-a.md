# ADR-0003 · Engine: Option A now, B later

Status: Accepted · 2026-10-28 · AFD-1

## Decision
- **Option A** (handoff 05): one generated playbook per flow level; each node is a play; host sets are routed with `block`/`rescue` + `ansible.builtin.group_by`; downstream plays target the group of the port they are wired to. Code generation sits behind an `Engine` interface so an Option B runner can be added after v1.
- **Rescue rule:** block/rescue is generated only when a fail port is wired. An open fail port lets the host fail visibly (the job ends failed); an open-on-purpose port stops the host, with a comment in the generated code. The reference skeleton's `precheck` play is corrected accordingly.
- **Join:** per host. `join_mode: all` (default) = intersection of the branch groups, `any` = union. Branches run one after another; no real concurrency in v1.
- **Approvals:** AWX approval nodes between playbook segments (an AWX workflow). The validator warns when `rejected` and `timeout` go to different targets, since AWX cannot tell them apart. Skeleton and local runs auto-approve with a TODO debug message.
- **Hard ports:** `cancelled` exists in the model and Run mode only (the validator warns it cannot be routed); `timeout` maps to the task `timeout:` keyword; `unchanged` uses `register.changed` for module nodes, and for role nodes only if the M3 spike proves a mechanism.
- **`runtime.kind`** is inferred by the validator: `ansible_playbook` (local), `awx_job` (one segment), `awx_workflow` (segments split by approvals).
- **Launching:** real runs through AWX (its RBAC and activity stream are the audit) and local real runs after a confirmation modal naming inventory, host count and production-looking groups. Every launch is appended to a local audit log. Local credentials come from the environment (ssh-agent, keys; in Docker an optional key directory mounted read-only); the vault password is prompted per run and never stored. Node `credential` names apply to AWX only.
- **M3 starts with a spike** in the probe containers (debug and group_by need no devices): unreachable routing (localhost handlers vs `meta: clear_host_errors`), `max_fail_percentage` through a router play, join intersection, `unchanged`, approval segments.

## Rejected
Option B for v1: with no backend, the orchestrator would live in a VS Code window and a run would die when the window closes.

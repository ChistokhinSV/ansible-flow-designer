# ADR-0013 · Run mode with AWX

Status: Accepted · 2026-10-29 · AFD-10 (M7)

## Context

04 §10 describes Run mode only in outline: the same canvas, nodes with per-run status and timing, wires with host counts, a selected wire listing its hosts, a selected node listing per-host results with links to the AWX job. 05 maps runs back through the `[key]` play names and `node_<ULID>` tags. Decision 18 makes AWX the launcher for real runs, with its RBAC and activity stream as the audit of record. Decision 15 defines `tested`: a passing non-check run of the current `flow.version`, proposed by the extension and saved by the user. Decision 25 puts AWX into the GNS3 lab.

Decisions by the user at the start of M7:
1. Approvals: one job now; approval segments chained by an AWX workflow come later (AFD-11).
2. Code to AWX: a lab Git server. Tests may push fixture repositories to that lab remote only. AFD warns when AWX ran another commit than the local HEAD.
3. Templates: AFD creates them on request. A command picks the project, inventory, EE and credentials, creates or updates the job template and writes `flow.runtime.template`.
4. Docker suites while Docker Desktop is off: a throwaway container on the GNS3 VM.
5. The GNS3 VM's dead DNS server is replaced permanently (netplan).

## Decision

**Connection.**
- Settings `afd.awx.url` and `afd.awx.verifyTls` (resource scope).
- The token lives in SecretStorage only, under `afd.awx.token:<url>`. _Set AWX Token_ checks it against `/api/v2/me/` before storing it. It never appears in settings, logs, the audit log or messages.
- The client uses `node:http(s)` with a timeout on every request. A 401 says to set a new token.

**Job template (decision 3).** _Set Up AWX Template_:
- picks the AWX project, inventory, execution environment and credentials (quick picks; fixed names in tests);
- sets the playbook to the flow's generated root playbook, relative to the repository root, after checking the project's playbook list; when the playbook is missing it updates the project once, then says to commit and push;
- creates or updates `AFD · <flow key>` with `ask_variables_on_launch` and `ask_limit_on_launch`, and syncs the credential associations;
- writes `flow.runtime: {kind: awx_job, template}` in one edit, only when it changed.

**Launch in AWX.**
- Saves the flow, generates the code, then asks for the flow inputs with the same prompts as local runs (remembered per flow).
- A modal confirmation names the template, the targets, and either the uncommitted files of the flow folder or the HEAD commit to push.
- Launches with the inputs as `extra_vars`. The local audit log records the launch and the finish (job id, status, host count, no input values).
- Polls the job and its new events every 2 s (`counter__gt`, ordered by counter). After the job finishes it waits for `event_processing_finished`, at most 20 s.
- The revision AWX checked out (`scm_revision`) is compared with the local HEAD. A difference is shown in the run panel and as a warning.

**Event mapping.** AWX already stores everything the `afd_events` callback writes for local runs: play starts, `runner_on_*` results with `group_by`'s `res.add_group`, and timestamps. `core/awx/events.awxEventsToLines` converts AWX events into the same JSON lines, so local and AWX runs share one summarizer (`summarizeRun`). Plays map to nodes by their generated name `[key] Title`. The EE does not need our callback.

The summary gained:
- `timings`: per node, the first and last event of its plays;
- `problems`: per node and host, the first failed or unreachable result, rescued or not, with the task and message.

**Run mode (04 §10).**
- The mode toggle enables Run. _Launch in AWX_ is in Implementation and Run modes, _Run as skeleton_ in Run mode too.
- **Nodes** show hosts, failed hosts and time ("3 hosts · 1 failed · 2.1 s"), and a run state:
  - ok: every host left through a normal port;
  - warn: some took a fail port;
  - failed: a failure was not routed;
  - idle: the run did not reach the node.
- **Wires** show host counts instead of port names. Wires no host took are dimmed.
- **Selection:**
  - a wire lists the hosts that took it;
  - a node lists each host, the port it left through and the first failure with its message;
  - nothing selected shows the run panel: run (AWX job or local), status, time, environment, commit, flow version, the revision warning, _Open in AWX_ (the job output), and failed outcomes.
- Run mode is read-only: no wiring, port menus or deletes.

**Tested (decision 15).**
- A run passes when:
  - it is a real run (not check mode) with exit 0;
  - every failure was routed and no host ended at a failed end;
  - it did not stop early.
- After a passing run of the current `flow.version`, the run panel proposes marking the implemented nodes it ran as tested.
- The new command `setStatuses` applies the proposal in one edit; the user saves it. Status is never rewritten automatically (decision 24).

**Lab (GNS3 project snow_AWX).**
- AWX 24.6.1 on k3s (awx-operator 2.19.1) on `ops1`. The NodePort is 30080, reached through an SSH tunnel.
- AWX's own `awx-ee` 24.6.1 ships ansible-core 2.15, below the 2.19 minimum. `docker/afd-awx-ee.Dockerfile` (`afd-ee` plus ansible-runner 2.4.3) is imported into k3s.
- `git daemon` on ops1 serves `/srv/git/afd-lab.git` as the project's remote (`lab/ops1-git-daemon.sh`).
- `just awx-lab` creates the EE, project and inventory idempotently.

**Tests.**
- Unit tests run on a trimmed real job of the `awx-e2e` fixture flow: ports, outcome, timings, problems, the tested candidates, `setStatuses`.
- Webview tests cover Run mode: node states, the host table, wire hosts, the run panel, the proposal, the top bar.
- `just test-awx` is the lab suite. It:
  - pushes the test workspace to the lab remote;
  - checks the token;
  - sets up the template;
  - launches one failing and one passing job and asserts ports, outcome and revision;
  - checks Run mode on the canvas, the audit log, and the tested proposal applied in VS Code.
- `just test-docker-lab` runs the engine, probe and Docker integration suites in a throwaway container on the GNS3 VM, sharing its Docker socket, with `/tmp` at the same path on both sides (decision 4).

## Consequences

- Approval nodes still run as auto-approved TODOs in one job. Workflow segments are AFD-11.
- The AWX link opens the job output; per-host filtering is left to AWX's own search.
- AWX runs the commit its project checks out. Unpushed changes show as a revision mismatch, never as silently different results.
- Not done: a `tested` node does not drop back to implemented when its semantics change (decision 15 vs decision 24, open question). `cancelled` stays model-only.

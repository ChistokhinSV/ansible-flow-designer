# ADR-0013 · Run mode with AWX

Status: Accepted · 2026-10-29 · AFD-10 (M7)

## Context

04 §10 describes Run mode only in outline: the same canvas, nodes with per-run status and timing, wires with host counts, a selected wire listing its hosts, a selected node listing per-host results with links to the AWX job. 05 maps runs back through the `[key]` play names and `node_<ULID>` tags. Decision 18 makes AWX the launcher for real runs, with its RBAC and activity stream as the audit of record. Decision 15 defines `tested`: a passing non-check run of the current `flow.version`, proposed by the extension and saved by the user. Decision 25 puts AWX into the GNS3 lab.

Decisions by the user at the start of M7:
1. Approvals: one job now; approval segments chained by an AWX workflow come later (AFD-11, done: ADR-0016).
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
- The new command `setStatuses` applies the proposal in one edit; the user saves it.
- A run records each node's design fingerprint at its start. A node changed since then is not proposed.
- A tested node whose design changes drops back to implemented (AFD-12, ADR-0004): in the same edit on the canvas, on save for hand edits.

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

- Approval nodes ran as auto-approved TODOs in one job. Since AFD-11 (ADR-0016), flows with top-level approvals run as an AWX workflow of segment jobs with real approval nodes.
- The AWX link opens the job output; per-host filtering is left to AWX's own search.
- AWX runs the commit its project checks out. Unpushed changes show as a revision mismatch, never as silently different results.
- `cancelled` stays model-only.

## Amendment: run data, token origin, Restricted Mode (AFD-29, 2026-10-31)

Found in the improvement review (KB AFD-A-17): `vars.json` kept every run input, secrets included, in the extension storage for good; the AWX client followed any `next` link with the token; run folders and the audit log grew without limit; AWX follow loops had no end but the job's; the extension declared no workspace-trust support.

- **Secret inputs** (the import's `SECRET` name rule) go to the run as JSON in `AFD_SECRET_VARS`. The run's shell writes them to a `mktemp` file passed with `-e @file` and removes it when `ansible-playbook` exits, the same way as the vault password. The host never writes them. `vars.json` holds the other inputs and is deleted after the run; a startup sweep deletes those left by earlier versions.
- **Token origin:** `AwxClient.request` refuses any URL whose origin is not the configured AWX's; `all()` follows a foreign `next` on the configured origin (path and query only).
- **Retention:** `afd.runs.keep` (default 30) run folders per flow, pruned when a run starts and at startup; `audit.jsonl` rotates at 1 MB to `audit.1.jsonl` and `audit.2.jsonl`.
- **Following AWX:** a cancellable notification and a 12-hour limit (`FOLLOW_HOURS`). Stopping ends the polling only; a message offers _Cancel It in AWX_ (job or workflow job cancel) and _Open in AWX_.
- **Restricted Mode:** `capabilities.untrustedWorkspaces: limited`. `environmentFor` refuses in an untrusted workspace, so runs, syntax checks and every probe use (catalog, lenses, Re-sync) wait for trust; `afd.environment.*`, `afd.awx.url` and `afd.awx.verifyTls` are restricted configurations. AWX launches and imports stay available: they run nothing locally, and the AWX address comes from user settings only.
- **Known limit:** AWX itself stores a launch's extra vars, secrets included, in the job record. Survey password fields generated from flow inputs (planned, AFD-58) will keep them masked there.

## Amendment: stopping runs, cancellation, timeouts (AFD-39, 2026-10-31)

- **Stop Run** (`afd.stopRun`, the top bar's **Stop** while `run.state` is `running`, palette when `afd.running`): `run/stop.ts` keeps one stop function per flow while a run goes. A local run registers `TaskExecution.terminate()`; the run ends with `state: error`, `errorCode: cancelled`, "Stopped by the user" (no error dialog; the top bar says "Run interrupted"). The runner ends on `onDidEndTaskProcess` or, after a stop, `onDidEndTask`. An AWX launch registers the job's `cancel` (or the workflow job's), and following continues until AWX reports `canceled`.
- **Cancellation:** `ProbeClient.call(…, signal)`: a queued call leaves the queue; a running one fails and the probe restarts for the calls behind it (the serial probe cannot drop one request). _Check Generated Code_ runs under a cancellable notification. The catalog dump and Re-sync are not cancellable yet (background work with window progress).
- **Timeouts:** `src/node/timeouts.ts` (`TIMEOUTS`) holds the probe, AWX, designer and typing waits.

## Amendment (AFD-52, 2026-11-01): credentials and environment on the flow

An AWX job or workflow template has one set of credentials and one execution environment, so a
format 2 flow keeps them in `flow.runtime` (`credentials`, `execution_environment`, by name), next
to the template. Set Up AWX Template uses them when they are there and records what was chosen
when they were asked. Node-level `credential` and `execution_environment` (format 1) were never
applied; the upgrade and the AWX import move them to the flow (`core/flow/awxSettings.ts`), keeping
the first environment and naming the others, and format 2 warns about one left on a node
(`setting-on-flow`). The Access lens reads the flow's credentials for every node in format 2.

## Amendment (AFD-59, 2026-11-01): surveys from the flow inputs

Set Up AWX Template writes the template's survey (job template or workflow) from the flow inputs,
in their order (`core/awx/survey.ts`): host lists as text (comma-separated), strings as text,
integers, secret-looking names as passwords; an empty default is left out (AWX checks defaults
against the type). Booleans, lists and mappings are not asked: AWX answers a survey with text, and
`'false'` is true in Jinja; they stay extra variables, which the template accepts at launch. The
survey's description carries a fingerprint of the questions we wrote: a survey with no questions,
or ours as we left it, is written; one that already says what we would write is left alone; one
changed in AWX, or written by hand, is replaced only after asking (product-owner decision). The
survey is then enabled.

A survey answers a host list as text, so the generated start play reads the targets input as
`{{ devices if devices is string else devices | join(',') }}`: a list from the run inputs and
comma-separated text both work. AWX checks launch variables against the survey's types, so Launch in
AWX sends a host list as that text too (`launchVars`); a step that reads the host list then gets
text in AWX runs.

## Amendment (AFD-81, 2026-11-04): live local runs, a quiet terminal, per-host output

Wave 8 group A. At 0.50.0 a local run read `events.jsonl` only after the process exited: the
first node result reached the canvas at 11.6 s of an 11.6 s Hello run (wave8-start), and the
terminal took the room under the canvas. Round 1's participant looked for results on the canvas,
which stayed in Design mode.

- **Events while the run goes.**
  - The host polls `events.jsonl` (`node/run/tail.ts`, 250 ms) rather than `fs.watch`, whose change
    events do not reach Docker bind mounts or WSL paths reliably on Windows.
  - Lines feed `createSummarizer` (`core/run/events.ts`), which `summarizeRun` now wraps.
  - The canvas gets a partial summary at most every 500 ms (`LIVE_MS`). A partial summary holds
    back failures not settled yet (a rescue later in the same play routes them), never says the
    run stopped early, and names the running play's node (`running`), so AWX-style "failed"
    flicker cannot appear.
  - `NodeRunState` gains `running`, for the node and every subflow around it.
- **The callback** records `changed`, `rc` and `out` (stdout, stderr, msg; 2000 characters each)
  on task results. A no_log result says only `censored`. Routing tasks (add_host, group_by, meta)
  carry no output.
- **Secrets.** The output can echo a secret input, so every string inside each event has the
  secret values replaced (`core/run/redact.ts`): live, before the summarizer, and in the kept file
  when the run ends.
- **The terminal.**
  - While the flow's designer is open the run's task reveals `Silent`; without a designer it
    reveals `Always`, as before.
  - `revealAfterRun` brings it forward when the canvas cannot explain the run: no start, no
    events, or a failure the summary does not cover.
  - After 20 s without events (`STALL_MS`), a notification and the top bar offer Show Terminal,
    since a quiet terminal can hide an SSH host key question or a `pause`.
  - Show Terminal reveals that run's own terminal (`extension/run/terminal.ts`, matched by the
    task label).
- **Run mode.** A run started from the designer's own controls switches the canvas to Run mode
  when it starts. The Command Palette and the keybinding leave the mode alone. The top bar names
  the running step.
- **Per-host output.** A host's Output in a node's Run tab asks the host (`runOutput`), which
  reads that node's results for that host from the kept, redacted events. It is offered for
  local runs once they end; AWX has its own job output page.

## Amendment (AFD-82, 2026-11-04): one launch dialog for local runs

Wave 8 group B. A real run of a flow with three inputs asked four or five times: an input box per
input (a `list` parsed as JSON only, so `a, b` passed as one string), then the modal, then the vault
password. Round 1's participant took about five minutes to run on the lab group, and their first
run went to the suggested localhost.

- **The designer's Run opens the launch dialog** (`panels/LaunchDialog.tsx`). This covers the top
  bar, Run for Real…, the first-flow checklist and Ctrl+F5 (`afd.run.launch`, internal).
  - The dialog lists every input by name and type, with the remembered value or the default
    (`core/run/launch.ts` `launchFields`).
  - It says what each list or dict reads as (`parseInput`: comma-separated or JSON lists, YAML or
    JSON dicts; text that does not read is a problem, never a silent string).
  - It offers the inventory's groups for host lists, and shows the facts for the current targets,
    which the host counts again as they change (`launchCheck`).
  - A real run's confirmation lines are `realRunLines`, the same words as the Command Palette's
    modal (golden test).
- **The token.**
  - A plan (`extension/run/launch.ts` `planLaunch`) carries a random token the host keeps:
    single-use, for that flow file and mode, ten minutes.
  - Only `afd.run.launched` with a live token skips the input boxes, and the modal is skipped only
    when the dialog showed the facts. The token is taken in the host; no command argument skips a
    confirmation on its own.
  - Before the run starts, `runFlow` reads the inventory again. When `sameFacts` fails, nothing
    runs (`errorCode: 'changed'`) and the dialog opens again with the new facts and a notice.
- **The Command Palette** and a flow with no designer open keep the input boxes and the modal.
- **Not in this change:** Launch in AWX keeps its prompts; input descriptions need a flow schema
  field (ADR-0004) and come later.

## Amendment (AFD-91, 2026-11-04): the dialog counts hosts as soon as they read

The dialog sent `launchCheck` only once every non-secret field read. In round 2 (S5) the
participant set the host list first, and the dialog kept the opening's "devices is required", with
Run disabled. `checkInputs` now sends every field that reads and holds the count back only for a
host list that does not read; that problem then replaces the old one at once. Run still checks
every field (`readFields`).

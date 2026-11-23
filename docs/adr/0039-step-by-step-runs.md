# ADR-0039: Step-by-step runs: a pausing strategy and a file channel

- Status: accepted (2026-11-22, AFD-346 design spike; the engine of AFD-347; server parts AFS-177
  and AFS-179 later)
- Context: AFD-346 asks for a run that pauses before each step (or at pause points) with Step,
  Continue and Stop, in VS Code (local, WSL, SSH, container) and later on Ansible Flow Server.
  The product owner settled the approach on 2026-11-20: step-by-step is the debugger engine of
  AFD-347 with a breakpoint on every step, not a playbook split at every step. AFD-347's rules
  apply: our own code, written from Ansible's plugin API (clean room, no ansibug code; ansibug is
  GPL), nothing listening on a network port, segments and subflows keep their step identity.
- Facts the design rests on (read from ansible-core 2.19 to 2.21, checked on 2.22):
  - every generated step is one or more plays with `vars.flow_node_id: <ULID>` (also tagged
    `node_<ULID>`); a step can have several plays (`: arriving hosts`, the step, `: route`), a
    subflow's inner steps are plays of their own (inline or `import_playbook`), the outcome play has
    no `flow_node_id`;
  - a play no host matches never reaches the strategy (`v2_playbook_on_no_hosts_matched`);
  - the task queue manager creates a new strategy object per play and lives for the whole
    `ansible-playbook` process; `RUN_FAILED_BREAK_PLAY` from a strategy ends the play loop and the
    stats callback still runs;
  - approvals outside AWX run as segments, one `ansible-playbook` process each (ADR-0016, AFD-272).

## Decision

### 1. Where the pause happens: a strategy plugin `afd_step` (linear)

`probe/strategy_plugins/afd_step.py` subclasses `ansible.plugins.strategy.linear`. Its `run()`
looks at the play's `flow_node_id` before calling linear's `run()`:

- the first play of a step that has hosts (a node id other than the previous play's) is a **step
  boundary**: the strategy computes the hosts that run it (`get_hosts_left` after
  `_set_hosts_cache`), asks the channel, and pauses there: before the step's first task, all hosts
  together (linear keeps them in lockstep anyway);
- the other plays of the same step (arriving hosts, route) go on without asking: one pause per
  step;
- plays without a node id (the outcome) never pause;
- a step no host reaches never pauses (Ansible skips the play before the strategy);
- **Stop** returns `RUN_FAILED_BREAK_PLAY`: the playbook ends there, the stats event is written,
  the exit code is 2; later plays of the same process (if any) return at once;
- **segments:** each segment process reads the same control file; `AFD_STEP_INSIDE=<approval
  node id>` tells a later segment that it starts inside the approval step (its route play), which
  paused in the segment before;
- **subflows:** their inner steps pause as steps (their own node ids); the subflow node itself has
  no play and no pause. Step into/out/over a subflow is AFD-347's.

It is enabled only for a step-by-step run, by environment: `ANSIBLE_STRATEGY=afd_step`,
`ANSIBLE_STRATEGY_PLUGINS=<probe>/strategy_plugins`, `AFD_STEP_CONTROL`, `AFD_STEP_TIMEOUT`
(`runProcess` with `step: {timeoutS}`, prototype in `src/core/run/command.ts`). The generated
playbook does not change; a run without `step` sets none of these variables.

Alternatives:

- **A callback that blocks in `v2_playbook_on_task_start`.** Callbacks run in the main process, so
  blocking works, but: `send_callback` swallows a callback's exceptions (a Stop cannot end the
  run), callbacks are notifications (other callbacks and their order see a blocked one), it fires
  per task, not per step, and AFD-347 needs the iterator, hosts and variable manager while paused,
  which a strategy has and a callback does not. Rejected.
- **Split the playbook at every step (segments, as approvals).** Works everywhere today, but loses
  facts and registered values between processes, starts Ansible again per step (seconds), and
  AFD-347 cannot be built on it. Rejected by the 2026-11-20 decision.
- **Ansible's own `--step`.** Asks on the terminal before each task (not each step), only yes/no
  per task, no Stop with stats. Not drivable. Rejected.
- **Wrapping whatever strategy is configured (`free`, mitogen).** Steps need hosts together; a
  step-by-step run is linear. A repository `ansible.cfg` that sets `strategy` is overridden for that
  run only (the environment variable wins); said in the guide.

### 2. The channel: files in the run folder

The run already writes `events.jsonl` into its run folder and every environment already brings it
back (a shared folder for local and WSL, a bind mount for containers, `followRunFile` for SSH). The
channel adds one file the other way:

- **run to driver:** `pause`, `resume` and `stopped` events, appended to `events.jsonl` (the
  strategy and the `afd_events` callback write lines in the same process and thread):
  - `{"event":"pause","id":"<token>-<n>","node":"<ULID>","play":"[key] Title","hosts":[...],"timeout":3600,"ts":...}`
  - `{"event":"resume","id":"<token>-<n>","node":"<ULID>","command":"step"|"continue","ts":...}`
  - `{"event":"stopped","id":"<token>-<n>"?,"node":"<ULID>","play":"...","hosts":[...],"reason":"driver"|"timeout","ts":...}`
  - `id`: a random token per process (segments are several processes) and a counter.
- **driver to run:** `control.json` in the run folder (`AFD_STEP_CONTROL`), always replaced whole
  (write a temporary file, rename), read by the strategy at each step boundary and every 100 ms
  while paused: `{"v":1,"command":"step"|"continue"|"pause"|"stop","points":["<ULID>",...],"reply":"<pause id>"|null}`.
  A half-written or other-version file is ignored: the last whole control read stands.
- Security: nothing listens on any port; only who can write the run folder drives the run (the
  run's owner: the run folder is under the extension's storage; on an SSH host under the account's
  `.afd/` folder; in a container the bind mount of that folder). The server (AFS-177) writes the
  same file inside its run container from the run's own channel (run token), never a port opened
  to the browser.
- For SSH the driver writes `control.json` with `putRunFile` (one SSH command). `putRunFile`
  writes with `cat >`, not whole: the build makes it write a temporary file and `mv` it for
  `control.json`. The strategy also keeps the last whole control it read, so a half-written file
  never counts as "no pause".

Alternatives: a socket or named pipe (fast, but a port or a socket file per environment: WSL 1,
Docker Desktop on Windows and an SSH host all need their own forwarding, and the Windows side of a
Unix socket on a bind mount does not work); stdin of `ansible-playbook` (VS Code runs it in a
terminal task, the SSH run feeds secrets on stdin and closes it, a container would need `-i`, and a
second reader of the terminal's input is fragile). Files reuse what already works everywhere; the
cost is a 100 ms poll, measured below as unnoticeable. AFD-347 may add a request/answer pair of
files for variables (section 5); a socket can replace the transport later behind the same events.

### 3. Commands

| Command  | Sent                     | Effect                                                                         |
| -------- | ------------------------ | ------------------------------------------------------------------------------ |
| step     | as the reply to a pause  | run this step; pause before the next one (any)                                 |
| continue | as the reply to a pause  | run on; pause only before a pause point (`points`)                             |
| pause    | while running (no reply) | pause before the next step ("pausing again from Continue")                     |
| stop     | reply, or while running  | end the run before the next step (now, when paused); hosts read "stopped here" |
- A step-by-step run starts with `{"command":"step","points":[...]}` written before the process
  starts: it pauses before the first step. A run with pause points only (no "every step") starts
  with `continue`. Pause points can change while paused (the next answer carries them).
- A `stop` sent while a step is running takes effect at the next step boundary; the existing Stop
  (end the process) stays for "stop now".
- **Pause timeout:** a setting `afd.run.stepTimeout` (seconds, default 3600) becomes
  `AFD_STEP_TIMEOUT`; when nobody answers a pause in time the strategy writes `stopped` with
  `reason: timeout` and stops the run by itself (also when VS Code was closed). The driver says
  "Stopped: nobody answered for 60 minutes".

### 4. What the run view needs (described; build in AFD-346)

- `RunView.step?: { paused?: StepPause; stopped?: {...}; points: Ulid[]; every: boolean }` from
  `stepState(events)` (`src/core/run/step.ts`): a paused run is still `state: 'running'` (as one
  waiting for an approval), with the step and its waiting hosts. The last step's result per host is
  already in the summary (results, changed, failed, outputs, recorded inputs).
- **Canvas:** the paused step gets a "paused here" ring and badge with the number of waiting hosts;
  hosts already through earlier steps show what they did (the live run overlay); the steps no host
  reaches stay dim. A pause point is a marker on a node (set from the node's menu or the run
  toolbar), kept per flow in workspace state, not in the flow file.
- **Run panel / toolbar:** "Paused before <Title> · 3 hosts · stops by itself in 59 min", buttons
  Step (F10), Continue (F5), Stop (Shift+F5), and Pause while running. Hosts that were stopped
  read "stopped before <Title>"; the run ends as "stopped" (`errorCode: 'cancelled'`, `stoppedAt`
  = the node) not as failed, though rc is 2.
- The quiet-run warning (`STALL_MS`) is off while paused.

### 5. Seam for AFD-347 (not built)

- The pause loop in `StrategyModule._afd_gate` is where requests about the current pause are
  served: it has the play, the hosts, the iterator and `self._variable_manager`
  (`get_vars(play=, host=)`) at hand. AFD-347 adds request files (`request-<n>.json` from the
  driver, `answer-<n>.json` from the run, both replaced whole, with the pause id) for: variables of
  a host (lazy, by path, secret-looking names and vaulted values masked as the `afd_events`
  callback masks recorded inputs), evaluate a Jinja expression for a host, set a variable for a
  host (`set_host_variable`), audited.
- Breakpoints are pause points with a condition: the gate evaluates the condition per host and
  pauses when any host matches; per-task breakpoints wrap `_get_next_task_lockstep` (the play's
  tasks carry the step's name prefix `[key]`). Step into/out uses the subflow structure from
  `routes`/the model, not Ansible.
- The DAP adapter (VS Code) and the server's pages translate their protocols to these files; the
  `pause`/`resume`/`stopped` events are the same.

### 6. AWX

Not supported: AWX starts `ansible-playbook` itself, with its own strategy settings and no channel
back. "Run Step by Step" is not offered when the run target is AWX; where it is listed (the Run
menu, the command palette) it is disabled with "Step-by-step runs run here (local, WSL, SSH,
container) or on Ansible Flow Server, not on AWX". The MCP and Copilot tools answer the same.

## Evidence (prototype, 2026-11-22)

- `test/engine/step.test.ts` (engine suite, real ansible-core in `ps-probe-env:2.19`, `2.20`,
  `2.21`; the run folder a bind mount as for a container run; this process the driver): edge
  sample in check mode on simulated hosts pauses before precheck (4 hosts), backup-config,
  push-baseline, validate (3 hosts), once per step; Continue to a pause point; Stop at the second
  pause (stopped event with its 3 hosts, no task of that step ran, stats written, rc 2); timeout
  2 s ends the run by itself; a subflow's inner steps pause one by one; an approval's two segment
  processes share the control file with ids of their own, the approval pausing once. All green on
  the three images.
- Plugin off: the same suite runs edge with no step variables and with the strategy on but no
  control file: identical results per host and task, no step event. The generator is unchanged
  (no file under `src/core/engine` changed); the full engine suite passes (489 tests) except
  `import.test.ts` (9), which fails the same way on `main`: its vault password file is executable
  on a Windows bind mount (a lab matter, not this change). `step.test.ts` passed 3 runs in a row
  on all three images, and under the full suite's load.
- As the designer starts runs (`runProcess` + `startProcess`, Hello sample on localhost): container
  `ps-probe-env:2.21` and `2.19`, WSL 1 Debian with ansible-core 2.22.0: pauses before ping, facts,
  say-hello; Step, Continue, Stop all behave as above.
- Latency (control.json written to the run's `resume` event seen, driver polling at 20 ms): median
  94 ms (123 ms in one run), max 154 ms over 45 answers per run on 2.19/2.20/2.21 in containers;
  89 to 130 ms on WSL 1. The
  strategy polls every 100 ms; the extension's events tail (250 ms) adds up to that before the
  canvas shows the next pause. SSH: writing the file is one SSH command, ~470 ms to the GNS3 VM
  without connection reuse (not run end to end in the spike).

### Remeasured on an idle machine (2026-11-22)

The numbers above were taken while other work loaded the machine. Again with the PC idle (CPU 0%
before), Docker Desktop, the same images:

- Latency: three runs of `test/engine/step.test.ts` (21/21 each, `AFD_KEEP=1` to read the fresh
  `latency.txt`): median 95 to 125 ms, max 127 to 189 ms over 15 answers per image, on 2.19, 2.20
  and 2.21. The same as under load: the 100 ms read of `control.json` sets it, not the machine.
- Cost when nobody pauses: the edge sample in check mode, 10 runs each, alternating, normal
  strategy against `afd_step` with `continue` and no pause point: 2.19 2,608 ms against 2,704 ms
  (+96 ms, runs spread by ±130 ms), 2.21 2,810 ms against 2,811 ms. Within the noise. A run that
  is not step-by-step does not load the plugin at all.
- Cost while paused: one run left paused before its first step for 12 s: 0.5 to 0.6% of one CPU
  and 47 MB (the `ansible-playbook` process itself) in `docker stats`.

## Consequences and risks

- The strategy relies on linear's internals (`_set_hosts_cache`, `get_hosts_left`,
  `RUN_FAILED_BREAK_PLAY`, one `_tqm` per process), present in every supported ansible-core
  (checked 2.19 to 2.22). The engine suite on every supported image guards them.
- A repository that sets `strategy` (free, mitogen_linear) in `ansible.cfg` or in its own plays runs
  linear when stepped; a play keyword `strategy:` in a bound playbook (`import_playbook` of the
  user's playbook) would bypass the pause for that play: steps are generated plays, so only a
  playbook step's inner plays are affected; documented.
- `ANSIBLE_STRATEGY_PLUGINS` replaces the repository's `strategy_plugins` setting for the run; the
  build keeps the repository's paths first, as for callbacks (`RepositoryConfig.plugins`).
- Shared subflows (ADR-0027) used twice pause twice on the same node ids; the pause event carries
  the play name; AFD-347 will need the caller path for step out.
- A stopped run exits 2: the driver must read the `stopped` event, not the exit code.
- A killed driver leaves a paused run: the timeout ends it.
- Windows refuses to replace `control.json` while the run has it open for its 100 ms read (seen as
  `EPERM` on a Docker Desktop bind mount under load): `writeControl` retries the rename (40 times,
  25 ms apart) before it gives up.

## Build plan (AFD-346)

1. **core:** `src/core/run/step.ts` (protocol, `stepState`, `startControl`, `answer`; prototype
   here); `RunRequest.step` in `command.ts` (prototype here) plus the repository's strategy paths
   kept; `RunView.step` in `protocol.ts`; `afd.run.stepTimeout` setting; run summary keeps
   ignoring step events (it does); unit tests.
2. **node:** `runFlow` takes `step?: {every, points, timeoutS}`: writes the start control before
   the process starts (SSH: `putRunFile`), passes `step` to `runProcess`, folds `stepState` into the
   live view, suppresses `quiet` while paused, ends a stopped run as `cancelled` with `stoppedAt`;
   a `control(command, points)` hook returned from `started` (local file write via
   `writeControl`, SSH via `putRunFile`). `runSegments`: the next segment's run folder gets the
   current control and `AFD_STEP_INSIDE=<gate>`.
3. **callback/plugin:** ship `probe/strategy_plugins/afd_step.py` (prototype here) like
   `callback_plugins`: add `strategy_plugins` to the folder lists in `scripts/build.mjs` (VSIX
   `dist/probe/`) and `scripts/packages.mjs` (the server's package); `syncWorkspace` already copies
   the whole probe folder to an SSH host.
4. **extension:** command `afd.run.step` ("Run Step by Step", beside Run and Run a Check, check or
   real), Step/Continue/Pause/Stop commands with keys when a run is paused (F10, F5, Shift+F5),
   pause point toggle per node (workspace state), disabled for AWX with the words above, the MCP
   and Copilot tools refuse step-by-step on AWX.
5. **webview:** the paused ring and badge on the canvas, Run panel line and buttons, "stopped
   before" per host, pause point markers; component tests.
6. **tests:** keep `test/engine/step.test.ts` in the engine suite (add 2.22 when an image exists);
   an integration test runs Hello step by step in a container and presses Step, Continue, Stop;
   the scenario runner is not touched (it never sets `step`).

## As built (AFD-346, branch afd-346-step)

- core: `RunView.step` (`RunStep`: `every`, `points`, `pauses`, `paused`, `stopped`), `stepEvent`,
  `pausedLine`/`stoppedLine` words, `stepRefusal('awx')`; `RunRequest.step.inside` becomes
  `AFD_STEP_INSIDE` (node ids only); `ANSIBLE_STRATEGY_PLUGINS` keeps the repository's
  `strategy_plugins` paths (the probe's `run_config` now reports `DEFAULT_STRATEGY_PLUGIN_PATH`)
  and its root `strategy_plugins/`, ours last; setting `afd.run.stepTimeout` (default 3600 s).
- node: `runFlow` `step: {every, points, timeoutS, control?, inside?}` writes the start control
  before the process (SSH: `putRunFile(..., whole)`: `cat >` a `.tmp`, then `mv -f`), folds the
  step events into the live view, keeps the quiet-run timer off while paused, and ends a run with
  a `stopped` event as `error`/`cancelled` with `stoppedAt` and "Stopped before <Title>" (or
  "…: nobody answered for N minutes"), whatever its exit code. `started(stop, driver)` hands a
  `StepDriver` (`send`, `setPoints`, `paused`, `control`). `runSegments` starts each segment with
  the control the one before ended with and, after a decision, `inside` the gate.
- extension: `afd.run.stepByStep` (Run ▾, Command Palette, the launch dialog's tick for check and
  real runs), `afd.run.step` F10, `afd.run.continue` F5, `afd.run.pause` F6 (VS Code's debug
  Pause key), Shift+F5 Stop: while paused it sends `stop` (the run ends at its step, stats
  written), while a step runs it ends the process as before. Context keys `afd.stepping`,
  `afd.stepPaused`. Pause points per flow id in workspace state (`afd.pausePoints.<flow id>`),
  toggled from a step's menu (`afd.run.togglePausePoint`), sent to the run going.
- AWX: VS Code has no AWX target for Run (AWX is its own Launch in AWX), so Run Step by Step is
  never offered for AWX; the command with `{target: 'awx'}` answers the §6 words. The MCP server
  and the Copilot tools have no run tool (only scenarios, which never step): nothing to refuse
  there yet.
- webview: `config.stepRuns` (VS Code sets it, a past version and a server's pages do not), the
  `pausePoints` message, `stepRun`/`togglePausePoint` messages, `launchRun.step`,
  `LaunchPlan.steps`. Without `stepRuns` nothing new shows.

## Server pages (AFS-205)

- A viewer sends `stepRun` and `togglePausePoint` (`core/viewer.ts`); the host checks who may drive
  the run. Without them the canvas buttons on a server's flow page sent nothing.
- A viewer's step menu offers only **Add/Remove Pause Point** (`canvasMenu` with `viewer`); in Run
  mode a dot at a step's corner (on hover) toggles it.
- Keys in a web page: F10 Step, F8 Continue or Pause (F5 reloads the page); VS Code keeps its key
  bindings. `stepKeys()` gives each host's keys to the buttons' titles.
- `StepState.running` (from `resume`): the bar says "Running <step>…" with Pause; `RunStep.who`
  tells a reader who may go on; `stepPath` names a step inside a subflow by its path.
- `RunSummary.waited`: the seconds paused before each step, left out of its time.
- The strategy's pause line is plain words and flushed at once, so a server's output has it before
  who answered it.

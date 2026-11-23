# ADR-0040: Flow debugger: variables at a pause, watch, evaluate, conditions, failure pause

- Status: accepted (2026-11-23, 1.2; AFD-347, AFD-361, AFD-370, AFD-371, AFD-372, server AFS-179,
  AFS-223). It builds on ADR-0039 §5 (the reserved seam). The engine is built: see "As built".
- Context: 1.2 turns step-by-step runs into a debugger, in VS Code and in Ansible Flow Server's
  pages, using one engine. The minimal set agreed for 1.2:
  - variables of each host at a paused step;
  - watch;
  - evaluate;
  - conditional pause points, hit counts and log points;
  - pause on failure.

  Setting a variable and step into / step out come later. Product owner decisions (2026-11-23):
  - every pause holds all hosts;
  - a failure pause offers Retry, Continue and Stop;
  - Debug this failure starts in check mode (real if asked).

  Research: KB "1.2 Debugger: how other debuggers and workflow tools do it". Spikes AFD-362 to
  AFD-368 ran on ansible-core 2.19.14, 2.20.10 and 2.21.5; their numbers are in the tickets, and
  the prototypes are in `C:\DOWNLOADS_TEMP\afs-1.2-spikes`.

## Decision

### 1. One engine, in the `afd_step` strategy

The debugger is not a new plugin. It is what `afd_step` does while it is paused, and it is on only
when the run is a debug run (the env `AFD_DEBUG=1`, set by `runEnv` beside `AFD_STEP_CONTROL`).
Without it, runs behave exactly as in 1.1.

Shared Python code moves into `probe/afd_lib/`: masking (§4), safe render (§5) and capture (§3).
`afd_events.py` and `afd_step.py` both import it, and the build copies it next to the plugins.

### 2. Channel: request and answer files per pause

- The driver writes `request-<n>.json`:
  `{v:1, pause:"<pause id>", n, op, host?, path?, expr?, scope?}`.
- The gate loop answers with `answer-<n>.json`, written to a temporary file and renamed, using the
  same 100 ms tick. A request whose `pause` is not the current pause is answered `{gone:true}`.
- Ops:
  - `scopes`: the scopes of a host, with each value's name, type and size, but no values;
  - `vars`: the values under a path, paged, with `cut` marked;
  - `eval`;
  - `watch`: a list of expressions for a list of hosts, which also gives "compare across hosts";
  - `facts`.
- Commands stay in `control.json`. The new commands are `retry` (§7) and the per-point settings
  (§6).
- **Latency (AFD-367):** local, WSL and container answer in 70–130 ms, at the median and at p95.
  - For SSH, one ssh command per request takes about 740 ms (more than 2 s under load), and
    ControlMaster does not work from Windows. So SSH runs keep **one ssh channel open per paused
    run**, a small relay that reads requests on stdin and writes answers on stdout (68 ms median).
  - If that channel dies, the driver falls back to one ssh command per request.
  - Answers never go through `events.jsonl`: the 250 ms tail plus the 500 ms ticker is too slow.
- The driver polls an answer file every 20–50 ms, and only while a request is waiting. It does
  not use `fs.watch`, which is unreliable on bind mounts and `/mnt`.

### 3. Capture: only at a pause, lazily, with limits (AFD-361, spike AFD-362)

- **Source:** one `variable_manager.get_vars(play, host)` per host per gate, shared by conditions,
  log points and requests. It costs 0.5–1.6 ms per host without facts and 4–6 ms with them.
- **Scopes:**
  - **Step inputs**: the step's inputs rendered as `recordInputs` renders them;
  - **Host variables**: inventory variables, set_fact values and registers;
  - **Flow data**: the run's extra vars;
  - **Facts**: only when asked for (marked `expensive`).
- **Never sent:** `vars` (in 2.19+ a second copy of everything) and `hostvars`. Walking `hostvars`
  renders every variable and runs lookups: in the spike a `pipe` lookup host variable ran for 50
  hosts.
- **Values are not rendered.** A raw template is shown as text and flagged as a template.
- **Limits:** 64 KB per value and 1 MB per answer, with paging (`start`, `count`); a cut value says
  `cut`. A first answer is about 66 KB per host with default scopes, and 107 KB with facts.
- **Vault:**
  - A vaulted value is shown as `masked: vault` and is never turned into a string.
  - Plain texts are decrypted at most once per ciphertext per run, which is most of the cost:
    PBKDF2 takes about 10 ms each. They are kept only for masking (§4).

### 4. Masking in the engine (AFS-223, spike AFD-363)

A value leaves the run masked as `{masked: "vault"|"no_log"|"credential"|"external"|"name"}`,
never with its length. Five checks, which together masked every case in the spike's matrix:

1. data tags (`EncryptedString`, `VaultedValue`): these survive a whole value and set_fact, and
   each leaf of a dict or list;
2. origin in a vault file, because whole-file vault values carry no `VaultedValue` tag, only an
   `Origin` naming a file that starts with `$ANSIBLE_VAULT`;
3. secret-looking names at any depth (`SECRET_NAME` from `afd_events.py`);
4. no_log results (`_ansible_no_log`): the whole register is masked;
5. known values:
   - `AFD_SECRETS_FILE`: credential values and resolved external secrets (the server adds those);
   - the vault password;
   - vault plain texts found through the tags.

   Each is matched in its plain, base64, JSON-escaped and URL-quoted forms, ignoring case. This
   catches derived copies, because filters (b64encode, to_json, regex_replace, `~`) drop the tags.

The one leak we accept and document: a plain secret under a harmless name that appears in no list.
The page and VS Code show the mask's reason, and the server's `hide()` still runs on output as a
second layer.

### 5. Evaluate and watch (spike AFD-364)

- **Before rendering:** the Jinja AST is checked, and `lookup`, `query`, `q` and the `unvault` and
  `vault` filters are refused.
- **The render:**
  - it runs in a forked child, with a memory cap and lookups blocked while it runs (this also
    catches lazy variables whose value is a lookup, which `disable_lookups` misses);
  - the parent kills the child at the time limit (2 s by default);
  - the result is masked as in §4.
- **No `SIGALRM`.** An in-process alarm corrupted the template context on 2.19 and did not stop a
  loop on 2.21.
- **Cost:** 20–60 ms per evaluate.
- **Risk:** this relies on a private module global (`_jinja_plugins.lookup_loader`). The engine
  suite covers it on every supported core.
- **Errors** come back as text. Evaluate is read-only: no set_fact, no tasks.

### 6. Pause points: condition, hit count, log point (spike AFD-366)

- `control.json` `points` becomes a list of `{node, condition?, hits?, log?}`. A bare id still
  means an unconditional point.
- **Condition:**
  - Jinja, checked per host at the gate;
  - all hosts pause if any host matches, and the pause names the hosts that matched;
  - a condition error is reported and does not pause.
- **Hit count:** pause on the Nth arrival.
  - Counted per process; approval segments get the count carried by the driver.
- **Log point:** renders `log` per host and appends a masked `log` event, without pausing.
- **Cost:** about 1.5–1.8 ms per host per condition. Budget 5 ms per host per condition and 2 s per
  gate; conditions stay at step gates, not per task.

### 7. Pause on failure, Retry (spike AFD-365)

- **What a failed host is:** the generator wraps each step in block/rescue. A failed host is
  rescued into `flow_<key>_failed_hosts` with `afd_failed_*` facts set; it is not failed in
  Ansible's terms.
- **The hook:** in the strategy's `run()` for the step's play, right after linear's `run()`
  returns. The failed hosts are those whose rescued count grew and that now hold `afd_failed_node`,
  plus `tqm._failed_hosts`.
- **The pause:** `kind: "failure"`, with `{host, task, msg}` per host and the attempt number.
- **Answers:**
  - **Continue:** routes as today.
  - **Stop:** ends the run.
  - **Retry:** clears the failed attempt for those hosts, then runs linear `run()` again on a fresh
    `PlayIterator` restricted to them. A second failure pauses again. Clearing the attempt means:
    - group memberships the play added are removed;
    - `afd_failed_*` and `ansible_failed_*` facts are restored;
    - `rescued` and `_failed_hosts` are reset;
    - the pattern cache is cleared.
- Works the same on 2.19, 2.20 and 2.21, for wired and open fail ports, `inventory_target` steps
  and `serial`.
- **Refused** (Retry offers "rerun from this step" as a new run):
  - rolling subflows (one play for the whole subflow);
  - hard fails outside the rescue, until tested.
- **Run summary:** a `retry` event means "forget this step's results for these hosts".
  `ok`/`changed` count both attempts.
- **The UI warns** that Retry runs the step again, and that changes on hosts are not undone.
- **Filters:** "a host failed" (on by default in debug runs) and "a host is unreachable".

### 8. VS Code: a Debug Adapter Protocol adapter (spike AFD-368)

- **The adapter:** an inline adapter in the extension (`DebugAdapterInlineImplementation`). The
  `@vscode/debugadapter` package is not needed.
- **Threads:** one per host, named host first ("edge-rtr-07 · failed"). A pause is one `stopped`
  event with `allThreadsStopped` on the first failed or matching host. Its `description` is short,
  and the long reason goes in `text` and in exception info.
  - With 50 threads VS Code made 6 requests per stop and fetched no other thread's stack until it
    was expanded.
- **Stack frames:** the subflow path, pointing at the step's `- key:` line in the .flow.yaml. The
  canvas follows `onDidChangeActiveStackItem`.
- **Scopes:** as in §3 (Facts marked expensive). Variables are paged by VS Code. The Debug Console
  runs Evaluate.
- **Breakpoints:**
  - canvas pause points become function breakpoints named by step key;
  - source breakpoints are accepted only on `- key:` lines; others are `verified:false` with a
    message;
  - a condition, a hit condition and a log message map to §6;
  - `exceptionBreakpointFilters` "Host failed" (default on) and "Host unreachable" map to §7.
- Run ▾ › **Debug** and a launch configuration type `ansible-flow`. Step-by-step keys stay as in
  1.1.

### 9. Not in 1.2

- Set a variable.
- Step into / step out.
- Pause inside a task loop.
- Per-task breakpoints.
- AWX (it starts `ansible-playbook` itself).
- Pausing only some hosts (non-stop).

## Consequences

- One engine and one masking module serve VS Code, the server and its MCP. The server adds
  provider-resolved values to `AFD_SECRETS_FILE`.
- More reliance on ansible-core internals (`_datatag`, `_jinja_plugins`, `PlayIterator`,
  `inventory._restriction`, `_nonpersistent_fact_cache`). The engine suite (`test/engine`) covers
  every op, every mask kind, conditions, log points, failure pause and Retry on each supported
  image.
- Debug runs fork a process per evaluate. The child avoids display and logging and ends with
  `os._exit`.
- Cores before 2.19 would need other code paths; debugging there is refused with a clear message.

## As built (engine, 2026-11-23)

The engine part (§1 to §7) is built in `probe/afd_lib/` (`mask.py`, `capture.py`, `render.py`,
`debug.py`), `probe/strategy_plugins/afd_step.py`, `src/core/run/step.ts`, `src/node/run/inspect.ts`
and `runFlow.ts`; the VS Code adapter (§8) comes next. The engine suite (`test/engine/debug.test.ts`)
runs on 2.19, 2.20 and 2.21. Deviations and details:

- **afd_events.py does not import `afd_lib`.** The scenario CLI ships the callback alone, so it keeps
  its own copy of `SECRET_NAME`; only `afd_step.py` loads the library, and only in debug runs (the
  probe folder goes on `sys.path`). Runs that are not debug runs never load it.
- **External secrets come in `AFD_EXTERNAL_SECRETS_FILE`** (a JSON object or list), not inside
  `AFD_SECRETS_FILE`: that file is also passed as extra vars (`-e @"$sv"`), so keys added there
  would become variables. A server writes resolved values to the new file; they mask as `external`.
- **no_log registers.** From 2.19 a registered result of a `no_log` task keeps its whole output and
  no `_ansible_no_log` flag. The engine collects the register names of `no_log` tasks from every
  play it runs and masks those variables, and any expression naming them, as `no_log`. A result's
  `censored` text masks as `no_log` too.
- **Values under secret-looking names are learned as known values** (kind `name`), so their copies
  (`db_password ~ '!'`) are masked as well.
- **A known value masks the whole string** it is found in; only log lines keep their text, with the
  matched part replaced by `********`.
- **Masked values** go out as `{"__afd__": "masked", "masked": kind}` inside a value, and as
  `{name, type: "masked", masked}` in a list; other markers are `template` (with its text), `lazy`,
  `bytes` and `deep`.
- **Step inputs** are the step's play vars without the generator's own (`flow_node_id`, `afd_sim`);
  an input the record inputs task marks secret masks as `credential`.
- **Ops:** `scopes` (with `facts: true` the facts are listed too), `vars` (`scope`, `path` of names
  and indexes, `start`, `count` up to 1000, default 100), `facts`, `eval` and `watch` (one child for
  all hosts and expressions, 2 s per expression, at most 10 s). A request for another pause is
  answered `{gone: true}`; an unknown host is an error.
- **Evaluate refusals:** every `lookup`, `query` and `q` (also used as a name), the `vault` and
  `unvault` filters, `{{ }}` or `{% %}` inside an expression, and attributes starting with `_`. At
  render time a lazy variable may still use the lookups that only read what is there (`vars`,
  `items`, `list`, ...); every other lookup fails with "not allowed while debugging".
- **Hit counts** count the hosts arriving at the step (those the condition matches, when there is
  one); the point pauses at the gate where the count reaches N. Each count is a `hits` event, and
  the driver carries the counts into an approval's later segment in `control.json` (`hits`).
- **Log points** write `{event: "log", node, host, message, masked?}`; a condition or message that
  fails writes `{event: "log", node, host?, source, error}`. A log point never pauses, also with a
  condition (it then logs the matching hosts only).
- **Pause events of a debug run** carry `kind` (`condition` before `point` before `step`),
  `matched`, and `debug: true`; on a core the library refuses, `debug: false` and `why`. A failure
  pause carries `failed` (`{host, task, msg, hard?, unreachable?}`), `attempt`, `hosts` (all the
  play's hosts: every pause holds all hosts) and `retry: {refused}` where Retry is not offered.
- **Retry** is `{command: "retry", reply, after: "step"|"continue"}`: `after` says how the run goes
  on at the next steps. A refused Retry leaves the run paused and writes a `refused` event;
  `StepDriver.send('retry')` returns the words without writing.
- **Failure filters** travel in `control.json` as `failures: {failed, unreachable}`; a debug run
  starts with `{failed: true}`. Unreachable hosts are those the play routed to a step's
  unreachable port (`flow_<key>_unreachable`: module steps ignore unreachable), or whose `dark`
  count grew, or that joined `tqm._unreachable_hosts`. Hard fails (outside the rescue) come from
  `tqm._failed_hosts`; the suite has no case that makes one yet.
- **Outside debug runs** point settings are not read: a point with settings pauses like a plain
  point, and a log-only point does not pause. Pause events are as in 1.1.
- **The SSH relay is POSIX sh**, not Python (an SSH host whose runs go in a container may have no
  Python): two lines in (the request's number, its JSON), one line out (`<n> <answer>`). It waits up
  to 30 s for an answer; when the channel dies, each request goes as one ssh command.
- **Not tested yet:** the SSH relay against a real host (the commands are unit tested), handlers
  notified by a failed attempt, `add_host` routes, `include_tasks` steps, approval segments with a
  failure pause, Retry in a rolling subflow (refused by the play's name and `serial`).

## As built (front end, 2026-11-23)

The VS Code adapter (§8) and the canvas parts of §6 and §7 (AFD-369, AFD-371, AFD-372).

- **The adapter** is `src/node/debug/adapter.ts` (no vscode import; the unit tests drive it with a
  fake StepDriver), wrapped by `src/extension/debug/flowDebugger.ts` as an inline adapter for the
  debug type `ansible-flow` (`flow`, `mode`, `stopOnEntry`, `inputs`). Run ▾ › Debug opens the
  launch dialog (`plan.steps.debug`); its answers (inputs, vault password) are kept in memory by a
  one-time `launch` id, never in the debug configuration. A debug run is `RunOptions.debug` in the
  runner: `every` is `stopOnEntry`, the points and filters come from the session.
- **Threads:** before the first pause one thread named after the flow; then a thread per host of
  the pause (failed, then matched, then the others), `<host> · failed|unreachable|matched|waiting`.
  Thread ids stay with their host for the session. Stopped reasons: `exception` (failure),
  `breakpoint` (point or condition), `entry` (the first pause with stopOnEntry), `step`. A pause seen
  to end without a new one sends `continued` (the canvas or a key answered it).
- **Frames:** the step, each subflow around it (`stepPath` names), then `<flow name> (flow)` on line
  1 (subtle). Lines are the nodes' `key:` lines (`keyLines`, from the YAML ranges): flows written
  with `- id:` first have `key:` on the next line, so "the `- key:` line" is the `key:` line. A
  custom request `afd/frame {frameId}` answers `{node}`; the extension reveals it on the canvas on
  `onDidChangeActiveStackItem`. VS Code opens the frame's file with the default editor, which is
  the designer.
- **Variables:** a scope's items come from `vars` with `path: []`; containers get `indexedVariables`
  (lists) or `namedVariables` (dicts); without a count from VS Code the adapter reads pages of 1000
  up to 5000 items. Handles are dropped at each new pause. Masked values read `masked: <why>`.
- **Evaluate:** `{{ }}` around the expression is taken off. In the console (`repl`) an error or a
  refusal is a successful answer whose text is `Refused: …` / `Error: …`; in Watch it is a failed
  answer (VS Code shows it inline). A dict or list result can be expanded (from the value the
  answer carried). `supportsEvaluateForHovers` is off: hovering YAML would evaluate noise.
- **Breakpoints:** function breakpoints are named `<flow key>:<step key path>`; a bare key path
  works for the flow being debugged; another flow's are `verified:false`. Hit conditions accept
  `N`, `=N`, `==N`, `>=N` (all mean "on the Nth arrival"); anything else is unverified with words.
  Source breakpoints must be on a pausable step's `key:` line. A function breakpoint and a source
  breakpoint on the same step merge (settings from the one that has them). The canvas's points are
  mirrored into function breakpoints when they change and before a debug session starts (the
  points of both kept), and a person's change in the Breakpoints view is written back to the
  workspace state of an open flow. A disabled breakpoint is not a point.
- **Step Into / Step Out** are refused with words. **Retry** is the custom request `retry`, the
  command `afd.debug.retry` (`sendStep('retry')`, so the canvas and the debugger share it) and the
  exception text says where to find it.
- **Workspace state:** `afd.pausePoints.<flowId>` now holds `PointSpec[]` (bare ids as in 1.1, or
  points with settings); `afd.failureFilters.<flowId>` holds `{failed, unreachable}` (failed on by
  default). Step-by-step runs get the specs too (settings are ignored outside debug runs).
- **Tested:** the adapter (`test/unit/core/debugAdapter.test.ts`), the canvas
  (`test/unit/webview/debugRun.test.tsx`), and `test/integration/debugRun.test.ts` (`just
  test-debug`): a flow where h02 fails, debugged in a container (afd-ee:2.19), WSL (Ubuntu,
  ansible-core 2.21) and over SSH (`gns3`, in afd-ee:2.21): threads, frames, scopes, evaluate and
  its refusal, Retry (attempt 2), Continue to the end.

### Designer ↔ host messages for the server's pages

The canvas sends and takes these, so a server wires the same UI (all additions are optional):

- `config.debugRuns: true` (with `stepRuns`): Run ▾ › Debug…, **Edit Pause Point…** in a step's
  menu, the failure filters, Retry at a failure pause. Without it nothing of this shows.
- Host → designer `pausePoints`: `{points: Ulid[], settings?: PausePoint[], failures?:
  FailureFilters}`. `settings` lists the points with a condition, a hit count or a log message
  (`{node, condition?, hits?, log?}`); `failures` is `{failed?, unreachable?}` (the popover's
  checkboxes; failed counts as on unless false).
- Designer → host `setPausePoint {node, point: PausePoint | null}`: Save in the popover (a point
  without settings is `{node}`, meaning always), `null` removes the point. The condition comes
  without `{{ }}`. Answer with a new `pausePoints`.
- Designer → host `setFailureFilters {failures: {failed, unreachable}}`: answer with a new
  `pausePoints` carrying `failures`.
- Designer → host `stepRun {command: 'retry'}`: Retry at a failure pause (`StepDriver.send('retry')`
  returns the refusal words, which the host shows; the run's `refused` event also reaches the Run
  panel). Offered only when `run.step.paused.kind === 'failure'` and not `retryRefused`.
- Designer → host `run {mode, step: true, debug: true}`: Run ▾ › Debug…; answer with a `launch`
  plan whose `steps: {on, debug: true}`; its Run says **Debug** and `launchRun` carries
  `debug: true` (and `step: true`; `on` is "pause before the first step").
- The failure bar, the reason line and the Run panel's **Log points** read `RunView.step`
  (`paused.kind`, `failed`, `attempt`, `retryRefused`, `logs`, `refused`) as `stepState` gives it.
  For a reader who may not drive the run (`stepRuns` false), the bar shows the reason line only.
- `VIEWER_MESSAGES` allows `setPausePoint` and `setFailureFilters`; the host checks who may.

# ADR-0040: Flow debugger: variables at a pause, watch, evaluate, conditions, failure pause

- Status: proposed (2026-11-23, 1.2 design; AFD-347, AFD-361, server AFS-179, AFS-223). It builds
  on ADR-0039 §5 (the reserved seam).
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

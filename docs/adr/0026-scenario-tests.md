# ADR-0026: Scenario tests

- Status: accepted (2026-11-01, AFD-58)
- Context: wave 5 of the improvement program (KB AFD-A-17)

## Context

A flow's value is its routing: which hosts go where when a step fails. Runs check it only on real
devices or with hand-made `afd_simulate` vars; nothing recorded what a flow should do, so a change to
a wire or a port could change a host's fate unnoticed. The engine contract tests (ADR-0009) already
ran simulated builds and read the routing events, for our own fixtures.

## Decision

Scenario tests, product-owner decision (2026-11-01): a separate `<flow key>.scenarios.yaml` next to
the flow, run from the designer and in CI.

- **What a scenario says:** inputs (the targets input lists the hosts), outcomes forced per step and
  host (`failed`, `unreachable`, `timeout`, `unchanged`, `false` on decisions), approvals, groups for
  inventory_target patterns, and per host where it must end: an end node (by key path) or
  `<step>.<port>` for an unwired output. JSON schema `schema/scenarios.schema.json` (Red Hat YAML);
  `checkScenarios` names steps, ports, hosts and ends that do not exist (Problems panel).
- **SCENARIO build:** `GenerateOptions.stubAll` with `simulate`: every step runs as its stub (no
  binding runs, playbook bindings included), and a decision takes true unless forced false (its
  condition reads stubbed outputs). The inventory has the scenario's hosts with
  `ansible_connection=local`: nothing leaves the machine.
- **One runner** (`src/node/scenario/runner.ts`) for the designer and CI: per scenario a folder with
  the build, `vars.json` (inputs, `afd_simulate`, `afd_approvals`) and the inventory, run through
  `runProcess` in the run environment (container or local), then `summarizeRun` on the routing events
  and `hostEnds`: the end reached, the unwired port, or `stopped`. The folder is writable by the
  image's own user.
- **Designer:** Run ▾ › Run Scenarios (`afd.run.scenarios`), with a starter file when there is none;
  results in a notification and the log.
- **CI:** `dist/afd-scenarios.js`, one file with the routing callback inside; Copy Scenario Runner to
  Repository puts it into `.afd/`. `--image` (Docker or Podman) or a local ansible-playbook; exit 1 on
  a failure; `--junit` for test reports.

## Consequences

- Scenarios test the routing, not the bindings: what a module does is for runs, the catalog and Code
  sync.
- A decision's own condition is not exercised; scenarios choose its outcome.
- Engine contract: the routing-levels scenarios pass, and a wrong end is named, on 2.19, 2.20 and 2.21
  through the shared runner.
- Not yet: running scenarios from the AI tools (agents run the command line), and scenario results
  on the canvas.

## Amendment: results on the canvas (AFD-84, 2026-11-04)

Wave 8 group E. Results were a notification and log lines. Round 1's participant could not tell which
host ended where or why, and ran the flow for real while looking for them (P18).

- **Results keep their runs.** `judge` keeps each scenario's run summary (`ScenarioResult.summary`).
  `core/scenario/view.ts` turns a result into a `RunView` with source `scenario` (`scenarioRun`),
  so Run mode shows it as it shows a run. `scenarioMisses` lists the hosts that ended elsewhere, and
  `endRows` gives an end node's expected and ended hosts.
- **The session** sends the results to its designer panels (`scenarios` message), again when a
  panel becomes ready. The run panel lists them, and a click shows one on the canvas
  (`showScenario`). Back to Last Run restores the run it hid, and a run from the host replaces it.
- **The notification** is one line, with Show on Canvas (it opens the designer if needed, then the
  first failing scenario) and Show Log.
- **Test Explorer** integration is still not done.

## Amendment: results in words (AFD-94, 2026-11-05)

Round 2's participant answered T8 with the host line ("[check-power] TODO · TODO: ...") and missed
the miss line above it, which gave the ends' keys (S9). The data stays in keys (scenario files,
`judge`, JUnit's machine side); what people read uses `endWords` and `missText`
(`core/scenario/view.ts`): an end's title, "<step>'s open <port>", "dropped out of the run". The
run panel, an end node's table, the notification (its first miss) and the log and command line
(titles with the keys in brackets) use them; a scenario run's failures read "the scenario fails it
in <step>", since its steps are stubs. The dropped-out sentinel is now `(dropped out)`: `stopped`
was also the key of a common end, so a host that dropped out passed `expect: stopped`.

## Amendment: planted outcomes in words (AFD-105, wave 10, 2026-11-07)

Usability round 3 (R8): "the scenario fails it here" (AFD-94) did not say what it meant; to find
why a host failed, the participant read the step's binding and the inventory. The results did not
carry the scenario's `force` map, so the panel assumed every failure was planted.

- `ScenarioResult.forced` (`forcedOf`): per host, the step's key path, the forced outcome and the
  port it sends to; `scenarioRun` passes it into `RunView.scenario.forced`.
- `forcedText`: "the scenario forces <step title> to fail for it (force: failed), so it leaves by
  failed_hosts". The run's failures and a step's Run tab ("Forced by the scenario (failed)") use it
  only for a host the scenario forced at that step (`forcedAt`); any other failure keeps the run's
  own message.
- One wording for a miss (`missText`): "X ended at A; the scenario expected B", in the panel, the
  notification, the log and JUnit (they differed). `missWhy` adds ", because the scenario forces
  …" in the panel and the log; the log keeps the keys in brackets.

## Amendment: a forced row says where the host was expected (AFD-111, 2026-11-07)

Usability round 4 (Q5): the participant answered from a step's forced row, which said why but not
where the host ended or where the scenario expected it; that was only in the miss line and the
row's tooltip. When the host missed, the row adds `missWords` ("ended at Stopped; the scenario
expected Reported to the NOC"), `missText` without the host's name, which the row already shows.

## Amendment: scenarios stay current (AFD-115, wave 11, 2026-11-07)

A scenarios file was text that nothing kept in step with its flow:

- renaming a step broke the scenarios that named it, silently;
- errors showed only while the file was open;
- a verdict lived until VS Code closed, and never said when the flow had changed since.

- **The file is a document** (`core/scenario/edit.ts`). The canvas and the tools change it through
  byte-preserving commands: add, rename, duplicate and delete a scenario; set its hosts (a host
  taken out loses its expectation and forced outcomes); force or unforce an outcome; set an
  approval; set expectations. Each is one edit, so one undo.
  - A first scenario creates the file, with the list indented and host lists on one line, as the
    hand-written files have them.
  - `FlowList` in the YAML renderer writes a short list inline.
- **Key paths follow the flow** (`core/scenario/follow.ts`).
  - `pathChanges(before, after)` matches nodes by ID: a step or end renamed, a subflow renamed
    (every path inside it), or a step moved into a subflow by an extraction.
  - `followPaths` rewrites `force` and `approvals` keys and `expect` values (`<step>.<port>`
    included).
  - Where it runs:
    - the designer adds the edit to the flow's `WorkspaceEdit`, and saves the scenarios file with
      the flow (`saveFollowed`);
    - the Copilot tools do the same, and their answer says what followed;
    - the MCP server writes the file next to the flow.
  - A key path whose node was deleted stays; the check names it.
- **The live check** (`core/scenario/live.ts`, `extension/run/scenarioLive.ts`) runs about 200 ms
  after a flow or its scenarios file changes, on the open buffers when there are any:
  - `checkScenarios`, then the simulator (ADR-0032) for each scenario when the file has no errors;
  - Problems shows the file's errors and warnings;
  - a host the simulation sends elsewhere gets a warning on its `expect` line ("Simulated: h03
    ended at Gate's open failed_hosts; the scenario expected Done");
  - a failing scenario gets a `scenario-miss` warning on the flow;
  - a scenario the simulator models only as a best effort gets an information line;
  - the designer gets the whole check (`scenarioCheck` message), for the canvas (AFD-116).
- **Verdicts from Ansible are kept** in workspace storage per flow. Each keeps when it ran,
  `routingDesign(doc)` (node designs, top-level wires and flow inputs; statuses, positions and notes
  do not count), and the scenario's hash. A verdict is out of date when either changed. Verdicts of
  scenarios no longer in the file are dropped.

## Amendment: scenarios authored on the canvas (AFD-116, wave 11, 2026-11-07)

Writing a scenario meant typing keys, outcome words and where each host ends. The designer now
writes the file:

- **The way in.** The top bar's chip says "Add Scenarios", "Scenarios · 3 pass", "Scenarios · 1
  failing" or "fix the file" (`scenarioChip`). It opens a **Scenarios** tab beside the panel and the
  lens tab.
- **The tab** (`ScenariosPanel`) shows each scenario: the simulated verdict, what it plants in words
  ("Gate fails for h03"), the hosts that moved ("h03 now ends at Gate's open failed_hosts; expected
  Done"), best-effort notes, and the last Ansible verdict with "out of date". Its actions are:
  - Show on Canvas;
  - Accept New Ends;
  - Verify in Ansible (`runScenarios` with `names`) and Verify All in Ansible;
  - Rename, Duplicate, Delete;
  - New Scenario;
  - Undo.
- **What-if.** Show on Canvas makes the scenario the one being edited (`scenarioEditing`). The canvas
  shows its simulated run in Run mode and follows every new check. A step's right-click menu gets
  "In "<scenario>"" items from the canvas menu model (`CanvasMenuContext.scenario`):
  - steps: Fail / Unreachable / Time Out / Unchanged for… (only the ports the step has), opening a
    host checklist;
  - decisions: Take False for…;
  - approvals: Approved / Rejected / Timed Out for the run;
  - ends: Expect <host> Here.

  Run mode stays read-only for the flow; only the scenarios file changes.
- **Expectations without typing.** The host completes two requests from the simulation
  (`ScenarioRequest`, `simulatedEnds`):
  - `add` with no expectations gets the ends the simulation gives;
  - `acceptEnds` writes them.
- **Undo.** The canvas's Undo covers the flow's document. So each scenario change is one edit of
  the scenarios file, saved, and the host keeps the file's text before each change (30 deep, per
  flow). The tab's Undo puts it back, or deletes a file the change created.

# Round 4 walkthrough (Claude, 0.68.1)

AFD-109. A cognitive walkthrough of round 4's tasks (`tasks.md`) before the session, with the method
of rounds 1-3 (`../wave8-usability/protocol.md`). It is an expert review, not a user test.

- **Webview steps:** checked in the harness during wave 10, with real keys in Chromium:
  - the Execution tab (AFD-103);
  - the @ result and its fields (AFD-106, AFD-108);
  - the Privilege note (AFD-106).
- **Host steps:** read from the code and the integration tests.
- **The kit:** a dry run, below.

The four questions per step:

1. Will the person try to do it?
2. Will they notice the control?
3. Will they connect it with the effect?
4. Will they see it worked?

## Findings

Z numbers go on from the wave 10 walkthrough's Z1-Z3. Severity is Nielsen's 0-4; for a walkthrough
it is a prediction.

| ID  | Task | Finding                                                                                                                                                                                                                                                                                                                                     | Sev | Area |
| --- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ---- |
| Z4  | D10  | The colleague's change list has six lines for four changes. Inserting a step on a wire also gives "Drain the balancer: boundary changed" and "Wire removed: move-vips.ok_hosts → wait-sessions". The wire line names steps by key, not by title. The four real changes read well. A person may count six changes, or stop at the wire line. | 1   | H    |
| Z5  | D4   | Once a loop is set, the @ list still does not offer `item`, so `{{ item }}` is typed by hand. It stays text until the binding is saved, then shows as a chip. Round 3's T9 passed this way.                                                                                                                                                 | 1   | C    |

Z2, a fold's open state kept for every step, should not get in the way here. If Timing is closed
in D2, D3 and D4 need the Task keywords fold, not Timing.

## The tasks

| Task | Shortest path on 0.68.1                                                                                                                                                                                                                                                                                | Expected | Notes                                                                                                |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | ---------------------------------------------------------------------------------------------------- |
| D1   | Problems panel (every flow), the flow panel's workspace line, or the Flows view: VIP audit's error, Certificate renewal's playbook warning                                                                                                                                                             | pass     | control (round 3 T13: 1.2 min)                                                                       |
| D2   | Select Wait for the pool to drain. Execution: Timing is open on a module step. Retries 12, Delay 10, and Until from its suggestions (`wait_drain_result.stdout`) as `'drained' in wait_drain_result.stdout`. The sentence then reads "Tries up to 12 times, 10 s apart, until …; each try at most 30s" | pass     | R1, R2. The answer (30 s) is in the sentence and in the Timeout field                                |
| D3   | Execution, Task keywords fold: + no_log saves `no_log: true`                                                                                                                                                                                                                                           | pass     | R3                                                                                                   |
| D4   | Task keywords: + loop, then `- web-01` Enter `web-02` Enter `web-03` (the box indents and colours). Binding: `cmd` with `{{ item }}` in place of MEMBER; Save Binding                                                                                                                                  | pass     | R3, R4; Z5                                                                                           |
| D5   | Report the pool state, Binding, `msg`: @, pick "result of Read the pool state · makes it an output there", then `stdout` from the fields that follow; Save Binding                                                                                                                                     | pass     | R7, Z1 (0.68.1). Typing `.` after the chip offers the fields too                                     |
| D6   | Flow panel, Inputs: new input (integer), Default 300 (required clears), description; save                                                                                                                                                                                                              | pass     | R6. A string input with "300" passes too                                                             |
| D7   | Run as Check; the group chip `dc_east · 3`; Run; Run Results: Check the zone serial is current on lab-lb-42, Check the resolver answers on lab-lb-43                                                                                                                                                   | pass     | control (round 3 T10: 3.3 min)                                                                       |
| D8   | Run Scenarios. The miss reads "lab-lb-46 ended at Stopped; the scenario expected Reported to the NOC, because the scenario forces Check the peer is in sync to fail for it (force: failed), so it leaves by failed_hosts"                                                                              | pass     | R8                                                                                                   |
| D9   | Restart the health daemon: Execution, Privilege, where the note offers Accept with Reason (or the Access lens, Accept first); a reason. Write the change summary: clear Become; save                                                                                                                   | pass     | R10: does the note get acted on without the card's push? The card says "record why" as round 3's did |
| D10  | Reopen Load balancer upgrade: the note lists what changed (six lines, Z4), and the marked steps; or the Changes lens, compared with the flow as last shown                                                                                                                                             | pass     | R9. D9 has just shown the flow, so the closed-flow marks apply                                       |

## The kit's dry run

On 0.68.1, session r4-d-20261107-1327 was built with `--no-launch`, so VS Code was never opened.

- **The workspace:** seven flows. VIP audit has its planted error (and the open port it causes);
  the other six have no problems and no stray `input-unfed` (Z3).
- **The checks on the untouched workspace:** every task fails. Partial answers go to review (D1,
  the D2 answer, D8, D10).
- **The self-test:** it solves D2-D6 and D9, and the solved flows validate clean. Fed the planted
  answers, the verifier passes every task but D7, which needs a check run in VS Code.
- **The planted facts are real:**
  - **D7:** a check run of DNS record sync's playbook in afd-ee:2.19 on `dc_east` fails Check the
    zone serial is current on lab-lb-42 and Check the resolver answers on lab-lb-43. The other
    east host goes through.
  - **D8:** the scenario CLI runs Pool health check: one pass, and one miss for lab-lb-46 with the
    forced reason.
  - **D10:** the designer's change list for the colleague's commit has the four changes, plus Z4's
    two lines.
- **The runner:**
  - the intro says 10 tasks in three parts, about 45 minutes;
  - each part shows its note, and every card reads as in `tasks.md`;
  - D10 shows its before-text. On Start, the kit committed "Work so far", then M. Lindqvist's
    change, and showed the message.
  - `shownAt` was "never", because this dry run never opened VS Code. In a session, D9 shows the
    flow first.
- **Round 3 after the helper move:** a fresh variant C workspace, solved, passes T1-T9, T14 and T15,
  as before.

## Before the session

- No bug blocks a task. Z4 and Z5 are predictions for the session to confirm or not; the cards stay
  as they are.
- The session runs on 0.68.1 or later: `just usability-kit 4 d out/ansible-flow-designer-0.68.1.vsix`.

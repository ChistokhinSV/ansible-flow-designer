# Round 1 walkthrough (Claude, 0.50.0, variant A)

A cognitive walkthrough of the eleven tasks on 0.50.0 (protocol: four questions per step). It is an
expert review, not a user test: it finds where the product does not lead, not how often people
stumble. Evidence is the code at 0.50.0, the harness, the wave8-start baseline and the kit's dry run
(the planted faults fire as designed: lab-sw-03 ends in Reported to NetOps, lab-sw-04 in Stopped,
the second scenario fails with "lab-sw-04: expected reported, ended at stopped").

Severity is Nielsen's 0-4 (protocol). Group is the wave 8 group that addresses the finding, or
"new" for one no group covers yet.

## Findings

| ID  | Task | Step where the walkthrough fails                                                                                                                                                                                                                                                                                                                                                 | Question | Sev | Group |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- | ----- |
| W1  | T1   | After the first step (the empty level's Add a Step), nothing on the canvas offers the next one. N, Add Next Node in the context menu and the port menu's Insert work, but none is visible; the palette's Task opens Quick Add in the middle of the canvas and leaves the step unwired (`Palette.tsx:68-77`).                                                                     | 2        | 2   | new   |
| W2  | T2   | On a bound step the Binding tab opens with the module search: 6 results above the docs, the first Configure field 1099 px down a 762 px panel, 24 controls before it (wave8-start, `hello-binding-340-1280.png`). The person has to know to scroll past the search to the form.                                                                                                  | 2        | 3   | C     |
| W3  | T2   | `line` is not a required parameter, so it is not in the form; it is one of about 20 entries of a native select ("Add a parameter…") or a + on a docs row, and the docs show 6 rows.                                                                                                                                                                                              | 2, 3     | 2   | C     |
| W4  | T2   | The binding is staged: Save Binding is a separate step after the form. Hiding the side panel or opening the lens tab before saving drops the draft without a word (`Details.tsx:100-105`).                                                                                                                                                                                       | 4        | 3   | C     |
| W5  | T3   | The banner's first two choices are Rollback from Backup and Notify On-Call and Stop; Stop Flow, the plain answer, is under Other Choices. Notify On-Call and Stop also ends in Stopped, so the task passes, with a step the person did not ask for.                                                                                                                              | 3        | 1   | new   |
| W6  | T4   | Run as Skeleton asks for the hosts with `localhost` filled in (`core/run/prompt.ts:6-14`). The task needs the group `lab`; the box lists no inventory groups. Enter on the suggestion runs on localhost, where the asserts fail for a reason that has nothing to do with the flow (no `firmware_version`).                                                                       | 2, 3     | 2   | B     |
| W7  | T4   | The terminal opens in a dedicated panel and takes the space under the canvas (`runner.ts:266-270`). The canvas stays in Design mode; the results show only in Run mode, which the person has to find (Alt+3 or the mode switch). During the run, Run mode shows every node as "waiting" for the whole run (11.6 s of 11.6 s on Hello in Docker on an idle PC, wave8-start perf). | 4        | 3   | A     |
| W8  | T4   | Which step failed for which host: the Run tab of each failed node lists hosts with their message; the run panel with nothing selected lists failures. Doable, after W7.                                                                                                                                                                                                          | 4        | 1   | A     |
| W9  | T5   | Run for Real is in the Run ▾ menu, not on the primary button. Then five prompts in a row: devices, ntp_servers, timezone, change_ticket, the confirmation. Each box names the input and its type only; it does not say what the input is for.                                                                                                                                    | 2        | 2   | B     |
| W10 | T5   | `ntp_servers` is a `list`: the box says "list" and parses only JSON (`run/inputs.ts:23-28`). "10.20.0.10, 10.20.0.11" is passed as one string; the run passes (rc 0) and the debug step prints the string's characters joined. Nothing tells the person the value is wrong; the verifier cannot see it either.                                                                   | 4        | 3   | B     |
| W11 | T6   | Find matches words in titles, keys and modules; there is no way to ask for "not implemented" or "approval". Readiness in the flow panel counts the statuses but names no step (`FlowDescription.tsx:105-121`). The person opens each of the 5 subflows and reads every badge.                                                                                                    | 2        | 3   | D     |
| W12 | T7   | Problems lists only flows open in a designer (diagnostics come from `FlowSession`). The Flows view is a flat list with no problem or code state. "Edited by hand" shows only inside that flow (Code mode or a save warning). The person opens all 7 flows.                                                                                                                       | 2        | 3   | D     |
| W13 | T8   | Run Scenarios gives a notification with the first failure ("lab-sw-04: expected reported, ended at stopped") and a log. "Why" needs the canvas: the person finds Check uplink is redundant's failed_hosts wire by hand. The notification has no way to the canvas.                                                                                                               | 3, 4     | 2   | E     |
| W14 | T9   | The Access lens lists both findings with Remove Become and Accept with Reason…, so the task can be done from the lens tab. Selecting a step to check it leaves the tab and its scroll position; the step's Details show no lens finding.                                                                                                                                         | 4        | 2   | F     |
| W15 | T10  | No align or distribute: three drags by eye, with no guide for even gaps. Tidy Up does it in one action but moves every node of the level and leaves the section where it was, which the task forbids.                                                                                                                                                                            | 2        | 2   | G     |
| W16 | T11  | The agent's edit reloads the canvas with no mark. The Changes lens compares with Git, but it also shows the person's own T9 edits, so it does not answer "what did the agent change". Source Control's diff has the same mix.                                                                                                                                                    | 4        | 3   | H     |

## What round 1 changes in wave 8

- **B (AFD-81):** `list` and `dict` inputs accept comma-separated text as well as JSON, and the
  dialog shows the parsed value before the run (W10). The hosts field offers the inventory's groups
  and hosts, not only the suggestion (W6). Each field shows what the input is for when the flow says
  so (W9; a `description` on flow inputs is new, ADR-0004 amendment).
- **D (AFD-84):** the Readiness counts in the flow panel are links that run the matching Find
  filter (`status:draft`), so the counts lead somewhere (W11).
- **H (AFD-83):** the outside-edit marks are kept apart from the Changes lens; the note says
  "changed outside the designer since you opened it", not "since the last commit" (W16).
- **New, not in a wave 8 group:** W1 (a visible way to the next step) and W5 (Stop Flow among the
  banner's first choices). Both are small; they wait for the participant's round 1 before a
  decision.

## Not a finding

- T9 can be done from the lens tab alone (W14 is about checking a step, not about the fix).
- Tidy Up keeping hand-made positions is not expected (ADR-0002): T10 tests arranging a few nodes.

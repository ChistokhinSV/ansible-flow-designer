# Round 3 (P1, 0.64.2, variant C)

AFD-101. Session `r3-c-20261105-2041`, 2026-11-05, 20:41-21:58 local time, in one sitting. Build
0.64.2, image `afd-ee:2.19`, the kit's variant C workspace (`tasks.md`). As in rounds 1 and 2, P1's
notes and answers are paraphrased. The raw data stays in the session folder and in
`usability-sessions/`, which Git ignores.

## The participant

P1 again, with the same background answers: Ansible for under a year, VS Code daily, the designer
tried before. This is P1's third session in three days. The tasks are new in half the set
(parameters and settings), and the names are new in all of it. Learning the product carries over,
as in round 2.

## Results

| Task | Goal                      | Verifier | Analyst | Self-rated | Minutes (limit)  | Ease (1-7) |
| ---- | ------------------------- | -------- | ------- | ---------- | ---------------- | ---------- |
| T1   | Add a check in the middle | pass     | pass    | yes        | 1.7 (4)          | 7          |
| T2   | Write the login banner    | pass     | pass    | yes        | 2.7 (6)          | 7          |
| T3   | Change parameters         | pass     | pass    | yes        | 1.5 (4)          | 6          |
| T4   | Pass a result on          | review   | partial | yes        | 5.3 (6)          | 6          |
| T5   | A value at run time       | review   | partial | yes        | 4.3 (7)          | 5          |
| T6   | Wait until it is ready    | fail     | fail    | yes        | 12.6 (5)         | 3          |
| T7   | One at a time             | pass     | pass    | yes        | 3.2 (4)          | 5          |
| T8   | Handle a secret           | pass     | pass    | yes        | 8.5 (5)          | 5          |
| T9   | Once per zone             | pass     | pass    | yes        | 6.6 (6)          | 5          |
| T10  | Check one site            | pass     | pass    | yes        | 3.3 (8)          | 5          |
| T11  | A real run from a ticket  | pass     | pass    | yes        | 2.4 (6)          | 6          |
| T12  | Scenario tests            | review   | partial | partly     | 8.5 (5)          | 4          |
| T13  | Know your workspace       | pass     | pass    | yes        | 1.2 (5)          | 7          |
| T14  | Keep a fix made by hand   | pass     | pass    | yes        | 1.1 (6)          | 7          |
| T15  | Privileges                | fail     | partial | yes        | 1.2 (5)          | 7          |
| T16  | A colleague's change      | fail     | fail    | partly     | 4.0 (5), gave up | 4          |
- **Task time:** 68 minutes, within the 87 minutes of limits. Wall time was 77 minutes with the
  ratings and the questionnaires.
- **Part 1, change a flow:** 11 minutes. Three passes, T4 in part. Median ease 6.5.
- **Part 2, settings and inputs:** 35 minutes, half the session's task time. Three passes, T5 in
  part, T6 failed. T6 took 12.6 minutes and T8 8.5. Median ease 5.
- **Part 3, run and test:** 14 minutes. Two passes, T12 in part. Median ease 5.
- **Part 4, review the workspace:** 8 minutes. Two passes, T15 in part, T16 given up. Median ease
  7.
- **SUS: 65** (items 4, 3, 4, 2, 5, 2, 3, 2, 2, 3). Round 2 had 75, round 1 30.
  - Compared with round 2, four items fell by a point: using it often, learning it quickly,
    feeling confident, and needing to learn a lot first.
  - The other six stayed.
- **After the session:** P1 said the designer feels much more intuitive to use.

Notes on the verdicts:

- **T4:** P1 put the register name, `read_version_result`, into the message. The step got a
  required input of that name, with no source, and Read the software version got no output.
  - The flow validates clean.
  - The generated task prints the whole registered result through a host variable, not the
    version.
  - Analyst: partial. The right step's result reaches the message, but not as the card asked, and
    not the designer's way (R7).
- **T5:** the input has the description and the upload reads it, but it is not required (R6). The
  @ picker put the variable at the end of the URL, and P1 moved it by hand (R5).
- **T6:** Retries is 10, but "15 seconds apart" went into Timeout (15s); Delay is empty. Until reads
  `wait_policy_result == "installed"`, which compares the whole result with a string and never
  holds. P1 found the Timing fold only after the guide (R1, R2).
- **T10:** one check run, on the three hosts of `site_south`. The answer names both pairs.
- **T11:** a real run on all six hosts, nothing failed. The run's output has edge-v42, CHG-3121 and
  22:00-23:00, so the descriptions did their job on 0.64.2 (AFD-100).
- **T12:** the answer names lab-fw-36 and the HA step, and quotes the scenario's own words. P1's
  note gives where it ended (Stopped). Neither says where it was expected (Reported to SecOps), nor
  why (R8).
- **T15:** become is gone from Write the upgrade summary. Restart the log daemon keeps it, but no
  reason is recorded, and its lens finding stays. P1 rated it done after 75 seconds and left no
  note (R10).
- **T16:** the change arrived while the flow was closed. The designer had last remembered it 23
  seconds before Start, so P1 saw the marks for a closed flow. P1 liked the overview of what
  changed, found the steps, but not what had changed in them, and gave up with no answer (R9).

## Findings

R = this session. Y = the walkthrough (`walkthrough-r3.md`). Severity is Nielsen's 0-4. Area: C is
a step's Details (binding and Execution), D the workspace, E scenarios, F lenses, H outside changes,
I inputs; **bug** goes to a patch.

| ID  | Task   | Finding                                                                                                                                                                                                                                                                                                                                                                               | Sev | Area    | Y   |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------- | --- |
| R1  | T6     | The Execution tab shows four closed folds. P1 did not find Timing until the guide said where it is; to P1, the tab looked as if it had nothing in it. This was P1's most confusing moment, and P1 asked for Timing open by default.                                                                                                                                                   | 3   | C       |     |
| R2  | T6     | The Timing fields do not say how they work together. "15 seconds apart" went into Timeout (a limit for each try), not Delay (the wait between tries). Until took a test that can never hold: the whole result compared with a string. The field offers no completion, example or colouring, and no check of the test. P1 asked for completion and colouring there.                    | 3   | C       |     |
| R3  | T8, T9 | Task keywords are inside the fold titled Tags, as the walkthrough predicted. In a visual tool, P1 expected `no_log` among the controls. P1 asked how to offer the popular keywords (loop, no_log, delegate_to) without adding clutter.                                                                                                                                                | 2   | C       | Y7  |
| R4  | T9     | The Task keywords box neither colours the YAML nor marks a wrong line. Enter after a list item does not indent the next one, as an editor would.                                                                                                                                                                                                                                      | 1   | C       |     |
| R5  | T5     | **Bug:** the @ button adds the input at the end of the value, not at the cursor, and not in place of selected text. P1 selected the server name in the URL and picked the input; the input went to the end. Typing `@` does insert at the cursor.                                                                                                                                     | 2   | bug (C) |     |
| R6  | T5     | A new flow input is optional, and nothing asks whether a run must give it. With no default value either (Y5), a run without it uploads to an empty server name. P1 did not tick required.                                                                                                                                                                                             | 2   | I       | Y5  |
| R7  | T4     | A step input with no source is not a problem in the designer. P1 used the register name, the step got an input that nothing feeds, and the flow validated clean. The message prints the whole result, not the version, and P1 rated it a success. The path the guide describes is to make the version an output of the first step and pick it with @; it was only one fold away (Y8). | 2   | C       | Y8  |
| R8  | T12    | "The scenario fails it here" (wave 9's wording for a planted failure) did not say what it means. To find why lab-fw-36 failed, P1 read the HA step's binding and then looked for the inventory variables. Nothing says that the scenario forces this step to fail for this host. The expected end is not in P1's answer.                                                              | 2   | E       |     |
| R9  | T16    | The marks say which steps changed, not what changed in each: added, renamed from what, binding changed. P1 found the three steps and gave up on what the colleague did. A pulled commit is in HEAD, so the Changes lens, which compares with HEAD, shows none of it.                                                                                                                  | 3   | H       |     |
| R10 | T15    | The step that needs root kept become, but no reason was recorded, and P1 rated the task done. Nothing on the path said that keeping it needs a reason; the finding stays in the lens. There is no note on it, so the cause is not known.                                                                                                                                              | 2   | F       |     |
| R11 | T6     | The right panel's resize handle works only on the upper half of its edge.                                                                                                                                                                                                                                                                                                             | 1   | bug     |     |
| R12 | T6     | A module's Returns chips sit on one line, so the panel scrolls sideways: about a third of it was hidden.                                                                                                                                                                                                                                                                              | 1   | bug (C) |     |
| R13 | T6     | The multi-select hint (AFD-96) has no gap from the panel's edge, unlike the text around it.                                                                                                                                                                                                                                                                                           | 1   | bug     |     |

What P1 said beyond the tasks (paraphrased):

- **Liked most:** searching modules and their parameters.
- **One thing to change:** more help in context, at the fields.
- **Most confusing:** the hidden Timing section and an Execution tab that seemed to say nothing.

### What wave 9 changed, seen in the session

| Wave 9 change                              | Task | Round 2                       | Round 3                                               |
| ------------------------------------------ | ---- | ----------------------------- | ----------------------------------------------------- |
| Problems for every flow, the flow line     | T13  | gave up after 6.9 min, ease 2 | 1.2 min, ease 7                                       |
| A group's hosts, no host list, Run Results | T10  | 7.2 min, ease 5               | 3.3 min on the right site, ease 5                     |
| Input descriptions, Run in view            | T11  | 5.1 min, ease 6               | 2.4 min, every value in its place, ease 6             |
| Palette after the step, Stop Flow          | T1   | (T3) 2.0 min                  | 1.7 min, ease 7                                       |
| Marks for a closed flow                    | T16  | gave up, no marks, ease 1     | marks seen; gave up on what changed, ease 4           |
| Scenario results in words                  | T12  | 1.2 min, partial, ease 7      | 8.5 min, partial, ease 4: the new words confused (R8) |
| Lens rows that stay put                    | T15  | wrong step changed (S10)      | the right step changed, no jumping noted              |

### Walkthrough against the session

- **Confirmed:** Y7 (R3). Y5 shows up as R6: the input was left optional.
- **Not seen:**
  - Y8: P1 opened the About fold (R12 is from there), but used the register name instead;
  - Y9: T3 took 1.5 minutes.
- **Missed by the walkthrough:**
  - the worst task, T6: the closed Timing fold and fields that do not explain each other (R1,
    R2);
  - the @ button's insertion (R5);
  - the unfed input that validates clean (R7);
  - the scenario wording (R8);
  - what the marks do not say (R9);
  - the unrecorded reason (R10);
  - three layout slips (R11-R13).

  As in rounds 1 and 2, the walkthrough checked that a control exists and is reachable. The
  session shows whether a person can tell what it does.

## Compared with rounds 1 and 2

Each cell: verdict, minutes (limit), ease. Rounds 1 and 2 from `../wave8-usability/report.md`.

| Round 3 (round 2/1 task) | Shape                  | Round 1             | Round 2             | Round 3             |
| ------------------------ | ---------------------- | ------------------- | ------------------- | ------------------- |
| T1 (T3)                  | a failure path         | pass, 0.8 (5), 7    | pass, 2.0 (5), 7    | pass, 1.7 (4), 7    |
| T2 (T2)                  | bind a step            | pass, 6.9 (6), 4    | pass, 2.0 (6), 6    | pass, 2.7 (6), 7    |
| T10 (T4)                 | a check run            | partial, 3.4 (8), 3 | pass, 7.2 (8), 5    | pass, 3.3 (8), 5    |
| T11 (T5)                 | a real run with inputs | pass, 2.6 (8), 4    | pass, 5.1 (8), 6    | pass, 2.4 (6), 6    |
| T12 (T8)                 | the failing scenario   | fail, 7.1 (6), 2    | partial, 1.2 (6), 7 | partial, 8.5 (5), 4 |
| T13 (T7)                 | the workspace's state  | fail, 5.8 (5), 1    | fail, 6.9 (5), 2    | pass, 1.2 (5), 7    |
| T15 (T9)                 | the Access lens        | fail, 3.6 (6), 5    | fail, 2.6 (6), 5    | partial, 1.2 (5), 7 |
| T16 (T11)                | an outside change      | partial, 5.6 (6), 2 | fail, 2.2 (6), 1    | fail, 4.0 (5), 4    |

The round 3 tasks of the same shape are not the same tasks: T10 picks a site, T11's inputs have short names, T16's flow is closed. So the
times show direction, not size.

**SUS 65 against 75:** round 3 asked more of P1. Half the tasks were settings that rounds 1 and 2
never touched, and they hold the session's one failure and its two slowest tasks (T6, T8). The four
items that fell are about confidence and learning. That fits a person meeting the Execution tab for
the first time. Of the eight tasks round 2 already had, five went faster. T2 took longer, with two more
parameters to set. T12 and T16 took longer too: they are the two where wave 9's new words or marks
fell short (R8, R9). One participant cannot say more.

## What round 3 changes

- **Patch candidates (bugs):** R5 (the @ button inserts at the cursor or over the selection), R11
  (the resize handle along the whole edge), R12 (Returns chips wrap), R13 (the hint's gap).
- **Wave 10 candidates, by severity:**
  - **C, the Execution tab (R1, R2, R3, R4):**
    - say what is set in each fold, and open Timing (or every fold with a value) for a step
      bound to a module;
    - say how Retries, Delay, Until and Timeout combine ("try up to 10 times, 15 s apart, each
      try at most 15 s");
    - Until with the result's fields (from the module's returns: `stdout`, `rc`) and an example;
    - the most used task keywords as controls, and a YAML box that colours and checks.
  - **H, what an outside change did (R9):** each mark says what changed (added, renamed from,
    binding, settings, wires), and the note lists the changes, so a pulled commit can be read
    without Git.
  - **E, planted failures in words (R8):** "the scenario forces Check the HA pair to fail for
    lab-fw-36 (force), so it ends at Stopped; the scenario expected Reported to SecOps".
  - **C and I, data in and out (R7, R6):**
    - a step input that nothing feeds is a problem;
    - a register name typed in a value is offered as that step's output;
    - a new run-time input is required, or gets a default (Y5).
  - **F, keeping a finding (R10):** keeping a step that the lens flags says it needs a reason.
- **Round 4:** to be decided. A participant new to the product would show the first hour again;
  P1 would show whether wave 10 makes the Execution tab readable.

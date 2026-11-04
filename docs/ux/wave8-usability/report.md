# Wave 8 usability report

Two sessions with one participant, P1:

| Round | Build  | Variant | Session              | Write-up    |
| ----- | ------ | ------- | -------------------- | ----------- |
| 1     | 0.50.0 | A       | `r1-a-20261103-2337` | `round1.md` |
| 2     | 0.59.2 | B       | `r2-b-20261104-2004` | `round2.md` |

Round 1 was before wave 8. Round 2 was after it: tickets AFD-79 to AFD-89, groups A-I. A
cognitive walkthrough went with each round (`walkthrough-r1.md`, `walkthrough-r2.md`). The
measures without a participant are in [docs/ux/wave8](../wave8/README.md). With one participant,
everything below is an observation, not a rate.

## In short

P1 needed 36 minutes of task time instead of 58, and rated the tasks easier: mean ease went from
3.6 to 5.4. SUS rose from 30 to 75. The building and running tasks (T1-T6, T10) all passed, and
the slowest of them, T6, went from 16.8 to 5.0 minutes. Three tasks still failed:

- **T7, the repository's state:** the Flows view had the answer, but P1 never reached it.
- **T9, privileges:** a wave 8 bug moved the lens rows under the pointer, so P1 fixed the wrong
  step without noticing.
- **T11, an agent's change:** the kit made the edit before P1 could open the flow, so the marks
  wave 8 added had nothing to mark.

The bug and the two gaps go to a patch and to wave 9 (end of this page).

## Per task

Analyst's verdict, minutes (soft limit), ease 1-7.

| Task | Goal                   | Round 1               | Round 2             | Group   |
| ---- | ---------------------- | --------------------- | ------------------- | ------- |
| T1   | First flow             | pass, 3.0 (6), 5      | pass, 1.6 (6), 7    | G       |
| T2   | Bind a step            | pass, 6.9 (6), 4      | pass, 2.0 (6), 6    | C       |
| T3   | Handle a failure       | pass, 0.8 (5), 7      | pass, 2.0 (5), 7    | core    |
| T4   | Check run              | partial, 3.4 (8), 3   | pass, 7.2 (8), 5    | A, B, I |
| T5   | Real run with inputs   | pass, 2.6 (8), 4      | pass, 5.1 (8), 6    | B       |
| T6   | Find in a large flow   | pass, 16.8 (6), 2     | pass, 5.0 (6), 6    | D       |
| T7   | Know the repository    | fail, 5.8 (5), 1      | fail, 6.9 (5), 2    | D       |
| T8   | Scenario tests         | fail, 7.1 (6), 2      | partial, 1.2 (6), 7 | E       |
| T9   | Privileges             | fail, 3.6 (6), 5      | fail, 2.6 (6), 5    | F       |
| T10  | Tidy three steps       | pass, 2.5 (5), 5      | pass, 0.5 (5), 7    | G       |
| T11  | Spot an agent's change | partial, 5.6 (6), 2   | fail, 2.2 (6), 1    | H       |
| All  |                        | 6 pass, 2 partial, 3 fail; 58.1 min; mean ease 3.6 | 7 pass, 1 partial, 3 fail; 36.3 min; mean ease 5.4 | |

- **Over the soft limit:** four tasks in round 1 (T2, T6, T7, T8), one in round 2 (T7).
- **Round 1's T4** started about 5 minutes late (P1's note), so its 3.4 minutes leave out the search
  for how to run on the lab group.
- **Round 2's T5** took longer than round 1's, for two new reasons: a stale message in the dialog
  and a Run button below its fold (S5, S6).

What the numbers can and cannot say:

- **The build:** the changes with a cause in wave 8 are T6 (Find filters), T2 (Configure first),
  T4 (results on the canvas, groups in the dialog), T8 (the notification and the run panel) and T10
  (guides, Align and Distribute). Each removed the obstacle round 1 recorded.
- **Learning:** T1, T3 and part of T5 are tasks P1 had done the day before, with other names. Their
  times say little about the build.
- **Three fails:** T7 and T11 failed for reasons the build did not remove, and T9 for one it
  introduced.

## SUS

| Item                                          | Round 1 | Round 2 |
| --------------------------------------------- | ------- | ------- |
| 1 I would like to use it frequently           | 3       | 5       |
| 2 Unnecessarily complex                       | 5       | 3       |
| 3 Easy to use                                 | 2       | 4       |
| 4 I would need a technical person's support   | 4       | 2       |
| 5 The functions are well integrated           | 4       | 5       |
| 6 Too much inconsistency                      | 2       | 2       |
| 7 Most people would learn it quickly          | 1       | 4       |
| 8 Cumbersome to use                           | 4       | 2       |
| 9 I felt confident using it                   | 1       | 3       |
| 10 I needed to learn a lot first              | 4       | 2       |
| **Score**                                     | **30**  | **75**  |

The largest moves are learning (7) and confidence (9). Those are the items a second hour moves by
itself, so part of the gain is P1's, not the build's. P1 also owns the product, which the protocol
notes can soften the score. 75 is above the commonly quoted SUS average of 68, but with one
participant it says how P1 felt, not where the product stands.

## Round 1's findings after wave 8

| Finding                                   | Group | Round 2                                                                          |
| ----------------------------------------- | ----- | -------------------------------------------------------------------------------- |
| P1 drop a step on a wire                  | G     | Fixed: T1 in 1.6 min, ease 7                                                     |
| P2, P14 Configure below the search        | C     | Fixed: T2 in 2.0 min, nothing about the panel                                    |
| P3 Ctrl+V in a parameter field            | bug   | Fixed (AFD-79); not met again                                                    |
| P4 how to run on the lab group            | B     | Fixed: one run, on the group                                                     |
| P5 the answer names hosts, not steps      | A     | Fixed: both step/host pairs named; a new detail (S3)                             |
| P6 where the inventory is                 | I, B  | Better: groups in the dialog; their hosts stay hidden until chosen (S2)          |
| P7 broken guide images                    | bug   | Fixed (AFD-79); not met again                                                    |
| P8 one prompt per input                   | B     | Fixed: one dialog; two new problems in it (S5, S6)                               |
| P9 no way to list steps across levels     | D     | Fixed: T6 in 5.0 min, all six named                                              |
| P10 a lens with nothing to show           | I     | Not met again; P1 found the Access lens's explanation helpful                    |
| P11 the modes read as stages              | I     | Not met again                                                                    |
| P12 "Task" on a draft step                | D     | Fixed: P1 read "not implemented yet" on the cards                                |
| P13 the condition editor                  | later | Open (proposal 2.3)                                                              |
| P15 docs take room, hidden panel edge     | C     | Not met again                                                                    |
| P16 no view of the repository             | D     | **Open:** the view exists, P1 did not reach it (S8)                              |
| P17 escape codes in the scenario log      | bug   | Fixed (AFD-79): the session's log is plain text                                  |
| P18 scenario results nowhere to be seen   | E     | Better: answered in 1.2 min, in part (S9)                                        |
| P19 lens entries without their subflow    | F     | Fixed, but the fix made the rows move (S10)                                      |
| P20 no multi-select, no sign of alignment | G     | Fixed: T10 in 30 s                                                               |
| P21 an agent's edit leaves no mark        | H     | **Not tested as designed:** the flow was closed during the edit (S12)            |

Round 2 found twelve findings of its own, S1-S12 in `round2.md`: severity 3 for S8, S10 and S12,
2 for six more, 1 for three.

## Each group

| Group | What it did                       | Verdict from round 2                                                     |
| ----- | --------------------------------- | ------------------------------------------------------------------------ |
| A     | Live local runs, quiet terminal   | Works (T4); two details (S3, S4)                                         |
| B     | One launch dialog                 | Works (T4, T5); a stale message (S5, bug) and the fold (S6)              |
| C     | Binding panel at 340 px           | Works (T2)                                                               |
| D     | Find filters, Flows view          | Find works (T6); the Flows view is not found (T7, S8)                    |
| E     | Scenario results on the canvas    | Mostly: fast, but the miss line is not the one read (S9)                 |
| F     | Lens findings in Details          | Not shown: the jumping rows (S10) decided T9                             |
| G     | Align, distribute, drop on a wire | Works (T1, T10)                                                          |
| H     | Marks for outside edits           | Not shown: the kit's timing, and closed flows are not covered (S12)      |
| I     | Lenses and inventory explained    | Mostly: no lens confusion; a group's hosts still hidden (S2)             |

## The walkthroughs

The walkthroughs predicted what a control or a label would make hard. Of round 2's walkthrough
findings, two of the five new ones held (X1, X2). X5, the only one at severity 2, did not come up,
and neither did the three left at severity 1 from round 1 (W1, W5, W9). The walkthroughs missed
both of round 2's bugs (S5, S10) and everything that happens around the intended path:

- the editor tab closing under the designer;
- the run results replaced by a click;
- the step's tooltip over the ports.

A walkthrough on a build its author knows is a cheap first pass. It does not stand in for a
session.

## Limits

- **One participant, twice:** P1 took both rounds, one day apart, with tasks of the same shape.
  Round 2 measures the build and P1's first day together.
- **P1 owns the product.**
- **T11 in round 2** tested an edit to a closed flow, not the edit to an open one that AFD-85
  marks. The runner shows a goal only on Start, a round 1 change, and here Start also makes the
  edit.
- **Speed** was not measured on an idle PC after AFD-81 (`docs/ux/wave8/README.md`).

## Next

1. **Patch 0.59.3:**
   - S10: lens rows keep their height on every level, and a row for another level lights its
     subflow (S11);
   - S5: the dialog counts the hosts whenever a host list reads.
2. **Wave 9 candidates**, by severity:
   - S12: marks for edits made while the flow was closed, against what the designer last showed;
   - S8: the repository's state in the Problems panel and in the flow panel;
   - S9: scenario misses by the ends' titles, and no "TODO" from stubs;
   - S2, S3, S6, S1, S4, S7, as listed in `round2.md`.
3. **Decisions for the product owner:** X5, whether a check run's host list starts at localhost
   (round 2 did not see it hurt), and the scope of wave 9.
4. **Before round 3:**
   - fix T11's text before Start;
   - find a participant who has not seen the product;
   - run the perf gate on an idle PC;
   - rerun the lab AWX import tests once the afd-awx VM answers on the network.

# Round 2 (P1, 0.59.2, variant B)

Session `r2-b-20261104-2004`, 2026-11-04, 20:06-20:54 local time with the break and the
questionnaires. Build 0.59.2, image `afd-ee:2.19`, the kit's workspace with variant B's names
(protocol). As in round 1, P1's notes and answers are paraphrased; the raw data stays in the session
folder and in `usability-sessions/`, which Git ignores. `report.md` compares the two rounds.

## The participant

P1 again, with the same background answers (Ansible for less than a year, VS Code daily). Round 2
is P1's second hour with the designer, one day after the first, on tasks of the same shape with
other names. Some of the gains below are P1 knowing the product and the tasks better; `report.md`
says which.

## Results

| Task | Goal                   | Verifier | Analyst | Self-rated | Minutes (limit)  | Ease (1-7) |
| ---- | ---------------------- | -------- | ------- | ---------- | ---------------- | ---------- |
| T1   | First flow             | pass     | pass    | yes        | 1.6 (6)          | 7          |
| T2   | Bind a step            | pass     | pass    | yes        | 2.0 (6)          | 6          |
| T3   | Handle a failure       | pass     | pass    | yes        | 2.0 (5)          | 7          |
| T4   | Check run              | pass     | pass    | yes        | 7.2 (8)          | 5          |
| T5   | Real run with inputs   | pass     | pass    | yes        | 5.1 (8)          | 6          |
| T6   | Find in a large flow   | pass     | pass    | yes        | 5.0 (6)          | 6          |
| T7   | Know the repository    | review   | fail    | no         | 6.9 (5), gave up | 2          |
| T8   | Scenario tests         | review   | partial | yes        | 1.2 (6)          | 7          |
| T9   | Privileges             | fail     | fail    | yes        | 2.6 (6)          | 5          |
| T10  | Tidy three steps       | pass     | pass    | yes        | 0.5 (5)          | 7          |
| T11  | Spot an agent's change | review   | fail    | no         | 2.2 (6), gave up | 1          |

- **Part 1 (build and run):** every task done, within its limit. Median ease 6.
- **Part 2 (find and review):** 2 passes in 6 tasks, T8 in part, 2 give-ups. Median ease 5.5.
- **SUS: 75** (items 5, 3, 4, 2, 5, 2, 4, 2, 3, 2). The two items that got 1 in round 1, learning
  quickly and feeling confident, got 4 and 3.

Notes on the verdicts:

- **T4:** one check run, on the four lab hosts (the run audit: 4 hosts, rc 2, 2 failed), and the
  answer names both failing step/host pairs. The walkthrough's X5 (the host list starts at
  localhost) did not come up: P1 picked the group.
- **T6:** all six named. P1 found the approvals with `type:approval`. With `has:no-binding`, P1 was
  sure of what it listed only after opening each result and seeing "not implemented yet".
- **T7:** gave up with nothing typed. After the session, the Flows view's own code was run on the
  session's workspace. It gives ACL audit "1 error · 1 warning" and Log archive rotation "code
  edited by hand". Every other flow is clean. So the answer was in the view, but P1 never reached
  it (S8).
- **T8:** the answer names lab-rt-14 and the step it failed in, check-power. It does not say where
  the router ended (Stopped) or where the scenario expected it (Reported to NetOps). Analyst:
  partial (S9).
- **T9:** become is gone from Reload the routing daemon, the step that needs root, and is still on
  Write the audit summary. No finding is accepted. P1 rated it a success. The cause is a bug, now
  reproduced (S10).
- **T10:** 30 seconds: the three steps in a column with even gaps, no other node moved.
- **T11:** gave up. The kit made the agent's edit when P1 pressed Start (all three changes are in
  the file). But the designer was not open at that moment, so nothing was marked (S12).

## Findings

S = this session, W and X = the walkthroughs (`walkthrough-r1.md`, `walkthrough-r2.md`). Severity is
Nielsen's 0-4. Area is the wave 8 group the finding follows up; **bug** goes to a patch.

| ID  | Task | Finding | Sev | Area | W/X |
| --- | ---- | ------- | --- | ---- | --- |
| S1  | T3   | Hovering a port shows its name only for a moment, before the step's tooltip covers it. This was P1's one thing to change. | 2 | canvas | |
| S2  | T4   | A group in the launch dialog is a plain button. Nothing says it is an inventory group or which hosts are in it until it is added. P1 wanted to see a group's hosts before choosing it. | 2 | B, I | |
| S3  | T4   | After the check run, a click on a failed step put the step's Details in place of the run's results, with no way back. P1 then clicked node after node to collect the answer. | 2 | A | |
| S4  | T4   | In a step's Run tab, the Output label of the hosts table breaks over three lines at the panel's width. P1 suggested a shorter word or an icon with a tooltip. | 1 | A | |
| S5  | T5   | The dialog said "devices is required" while the devices field showed `lab`. The dialog counts the hosts again only once every required input reads, so the message from its opening stayed until P1 typed devices again after filling in the rest. P1 also asked for the input's name to read as a field name. | 2 | bug (B) | |
| S6  | T5   | The Run button sits below the dialog's fold, though the form is short. For a moment P1 could not find it, and asked for the buttons to stay at the bottom with only the fields scrolling. | 2 | B | |
| S7  | T6   | `has:no-binding` found the steps, but the list does not say in words what it holds. P1 checked it result by result. | 1 | D | X1 |
| S8  | T7   | Gave up again, at ease 2. P1 read the guide and saved again, expecting a warning. P1 also ran Generate Code on Edge router upgrade (it said up to date) and looked inside flows for a step edited by hand. The Flows view had both answers, but nothing on P1's path led to it: the guide, the Problems panel, the flow panel's last line. | 3 | D | X2 |
| S9  | T8   | The Scenarios line says where the router was expected and where it ended, but by key (`reported`, `stopped`), not by the ends' titles. P1 copied the host line under it instead. A scenario runs every step as a stub, so that line reads "[check-power] TODO · TODO: …", noise from the stub's name and message. | 2 | E | |
| S10 | T9   | The Access lens's rows move under the pointer. A row for a step on another level has a line naming its subflow (AFD-87). A click opens that subflow, so the line goes and the row shrinks from 44 to 25 px. The next row moves up 19 px into the pointer, so the next click opens the other step (reproduced in the harness). This is how become was removed from the wrong step, unnoticed. | 3 | bug (F) | |
| S11 | T9   | Hovering a row for a step on another level dims every node on this level and lights none: its step is not on the canvas. | 1 | F | |
| S12 | T11  | Marks for outside edits start when the designer opens, so an edit made while the flow is closed leaves none. In the kit that was the case. The runner shows T11's goal, "keep Edge router upgrade open", only on Start, which also makes the edit. T10's flow had replaced the T9 designer: one preview tab, the same file opened again last (VS Code's saved editor state). P1 tried Undo and Redo, then the Changes lens, which also shows P1's own T9 edit. | 3 | H, kit | W16 |

What P1 said beyond the tasks (paraphrased):

- the Run as Skeleton dialog is much better than in round 1, and P1 liked the run experience
  overall;
- the Access lens's explanation helped;
- `type:approval` made the approvals easy to find.

**Most confusing:** the jumping rows in the Access lens (S10). **The one thing to change:** the
step's tooltip over the port names (S1).

### Walkthrough against the session

- **Confirmed:** X1 (S7) and X2 (S8; the Flows View link is in the flow panel, but P1 did not get
  there).
- **Not seen:** W1, W5 and W9 (T1 in 1.6 minutes, T3 in 2.0, T5 named every input), X3 (T10 in 30
  seconds), X4, and X5 (T4's run went to the group).
- **Missed by the walkthrough:**
  - both bugs: S10, a regression of AFD-87, checked there on one level only, and S5;
  - the editor tab closing under the designer (S12), and the kit's timing for T11;
  - the tooltip over the ports (S1), the run results replaced by a click (S3), the group's hosts
    (S2), and the dialog's fold (S6);
  - the line P1 actually reads in a scenario run (S9).

  As in round 1, the walkthrough followed the intended path. The session found what happens around
  it.

## What round 2 changes

- **Patch (0.59.3):**
  - S10: a lens row's height does not depend on the level shown. The place line is on every row of
    a section that spans levels, "on this level" included. Hovering a row for another level lights
    that level's subflow (S11).
  - S5: the dialog counts the hosts again whenever a host list reads, whatever the other fields
    hold, and shows the problem as it is now.
- **Wave 9 candidates**, by severity:
  - **H, S12:** marks for edits made while the flow was closed. The designer remembers what it last
    showed of each flow, per workspace. On opening, it marks what changed since then that it did not
    write itself: "3 steps changed since you last had this flow open".
  - **D, S8:** the repository's state where people already look:
    - the Problems panel for flows that are not open;
    - a warning on a generated playbook edited by hand;
    - a line in the flow panel: "In this repository: 1 flow with errors, 1 with code edited by
      hand · Flows View".
  - **E, S9:** a scenario's miss named by the ends' titles, first in the notification and in the
    panel; a stub's failure that says the scenario failed the host there, not "TODO".
  - **A, S3, S4:** the run's results one click away from a step's Details; the hosts table without
    the wrapped label.
  - **B, S2, S6:** a group's hosts shown before it is chosen; the dialog's buttons fixed at its
    bottom.
  - **Canvas, S1:** no step tooltip while the pointer is on a port.
  - **D, S7:** a filter's results say what they are ("4 steps not implemented yet").
- **X5** (a check run's host list starting at localhost) is still a product decision. Round 2 did
  not see it hurt.

## For round 3

- **Runner:** T11's text before Start tells P1 to open the flow in the designer first and keep its
  tab (double-click it, so it is not a preview).
- **Verifier:** T8 accepts an ended and an expected end named by key or by title.
- **Participants:** a second participant who has not seen the product, so the next round is not
  P1's third pass through the same tasks.

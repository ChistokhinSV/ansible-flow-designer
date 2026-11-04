# Round 1 (P1, 0.50.0, variant A)

Session `r1-a-20261103-2337`, 2026-11-03, 23:38-01:06 local time with the break and the
questionnaires. Build 0.50.0, image `afd-ee:2.19`, the kit's workspace (protocol). P1's notes and
answers are paraphrased here, at P1's request; the raw data (`progress.json`, `results.json`,
`summary.md`) stays in the session folder and in `usability-sessions/`, which Git ignores.

## The participant

P1's background answers: Ansible for less than a year, VS Code daily, Ansible Flow Designer tried
before. The protocol expected an expert who knows the product well; P1 is closer to an informed
newcomer. So round 1 shows what a person with some Ansible meets in their first real hour with the
designer, which is the case wave 7 designed for. The protocol is corrected (Participants, Limits).

## Results

The verifier's verdict, then the analyst's after reading the answer and the workspace. Times are
from Start to Done or Give Up; the limit is the task's soft limit.

| Task | Goal                   | Verifier | Analyst | Self-rated | Minutes (limit)  | Ease (1-7) |
| ---- | ---------------------- | -------- | ------- | ---------- | ---------------- | ---------- |
| T1   | First flow             | pass     | pass    | yes        | 3.0 (6)          | 5          |
| T2   | Bind a step            | pass     | pass    | yes        | 6.9 (6)          | 4          |
| T3   | Handle a failure       | pass     | pass    | yes        | 0.8 (5)          | 7          |
| T4   | Check run              | review   | partial | yes        | 3.4 + ~5 (8)     | 3          |
| T5   | Real run with inputs   | pass     | pass    | yes        | 2.6 (8)          | 4          |
| T6   | Find in a large flow   | review   | pass    | yes        | 16.8 (6)         | 2          |
| T7   | Know the repository    | review   | fail    | no         | 5.8 (5), gave up | 1          |
| T8   | Scenario tests         | review   | fail    | partly     | 7.1 (6), gave up | 2          |
| T9   | Privileges             | fail     | fail    | yes        | 3.6 (6)          | 5          |
| T10  | Tidy three steps       | pass     | pass    | partly     | 2.5 (5)          | 5          |
| T11  | Spot an agent's change | review   | partial | partly     | 5.6 (6)          | 2          |
- **Part 1 (build and run):** every task done, T4's answer in part. Median ease 4.
- **Part 2 (find and review):** 2 passes in 6 tasks, 2 give-ups. Median ease 2.
- **SUS: 30** (items 3, 5, 2, 4, 4, 2, 1, 4, 1, 4). The items on learning quickly and on feeling
  confident got 1; "unnecessarily complex" got 5. One person's score: it says how P1 felt, not how
  good the product is.

Notes on the verdicts:

- **T4:** the answer names the failing hosts (lab-sw-03 and -04), not the steps. The first check
  run went to localhost (1 host, rc 2: walkthrough W6); the next two ran on the lab group. P1
  pressed Start about 5 minutes late (their note), so the task took about 8.5 minutes.
- **T6:** all four steps without an implementation are named; the verifier missed one because the
  answer said "session" for "sessions". The approvals are recognised by their label and colour, but
  not named.
- **T9:** become is removed from "Write the drift report" (right). "Restart the time service" keeps
  become, but no reason is recorded, which the task asked for. P1 rated it a success: the missing
  step went unnoticed.
- **T10:** the three steps are at x 320 with gaps of 134 and 136 px, dragged one at a time. P1 had
  no sign that they lined up.
- **T11:** two of the agent's three changes are named (Copy the image, Verify services). The new
  step "Check BGP sessions" shows only as its subflow, "Drain the switch", changed. "Write the drift
  report" is named too, but that was P1's own T9 edit: the Changes lens mixes the two (W16).

## Findings

P = this session; W = the walkthrough (`walkthrough-r1.md`). Severity is Nielsen's 0-4. Group is the
wave 8 group that addresses it; **I** is the group round 1 adds (below); **bug** goes to the patch
before wave 8.

| ID  | Task | Finding                                                                                                                                                                                                                                                                           | Sev | Group | W       |
| --- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ----- | ------- |
| P1  | T1   | P1 wanted to drag a step from the palette onto a wire and have it inserted there. The first flow took more than one try.                                                                                                                                                          | 2   | G     | W1      |
| P2  | T2   | On Bind, the help and the module search come first and the fields sit below them. `line` and `state` are not in the form, so P1 looked them up on the web; that more parameters are added after the list and the example was not clear.                                           | 3   | C     | W2, W3  |
| P3  | T2   | Ctrl+V of the path into the parameter field did nothing. A parameter value is a contenteditable chip field with its own paste handler (`ChipField.tsx`); not reproduced yet.                                                                                                      | 3   | bug   |         |
| P4  | T4   | About 5 minutes to find how to run on the lab group; the first run went to localhost.                                                                                                                                                                                             | 3   | B     | W6, W7  |
| P5  | T4   | The answer names the hosts that failed, not the steps: the run's results, in Run mode, were not where P1 looked.                                                                                                                                                                  | 2   | A     | W7, W8  |
| P6  | T4   | P1 did not see how a flow gets its inventory or where to look at it, and expected the run to offer the groups from the inventory file.                                                                                                                                            | 3   | I, B  | W6      |
| P7  | T4   | Broken images in the guide's lens page (the inventory lens screenshot first) and in the extension's description. The images ship; the Markdown preview of a page outside the workspace loads files only from that page's folder, and the Extensions view loads only https images. | 2   | bug   |         |
| P8  | T5   | The prompt says "list" where P1 expected the input's name. One box per input: no way to correct a value or see all of them before the run starts.                                                                                                                                 | 2   | B     | W9, W10 |
| P9  | T6   | 16.8 minutes on a 6-minute task: no way to list the steps without an implementation or the approvals but opening every level.                                                                                                                                                     | 3   | D     | W11     |
| P10 | T6   | P1 tried the Inventory and Data lenses for T6; to P1 the canvas looked emptied. A lens with nothing to show does not say why (here: no step sets targets).                                                                                                                        | 3   | I     |         |
| P11 | T6   | P1 read the Design / Code / Run switch as stages of designing, not as views of the same flow.                                                                                                                                                                                     | 2   | I     |         |
| P12 | T6   | A step without an implementation reads as "Task", which told P1 nothing about its state.                                                                                                                                                                                          | 2   | D     |         |
| P13 | T6   | The condition field is too small for real expressions; P1 asked for colours, operators and completion.                                                                                                                                                                            | 2   | later | (2.3)   |
| P14 | T6   | Again: on a bound step, the module search comes first and the settings are far below it.                                                                                                                                                                                          | 3   | C     | W2      |
| P15 | T6   | Module docs take a lot of room, the See full docs link sits in a sideways-scrolled row, and the panel seemed not to widen. It does, by a 6 px edge that shows only on hover.                                                                                                      | 2   | C     |         |
| P16 | T7   | Gave up (ease 1). P1 looked inside flows (hovering subflows, Code mode) for errors and for code edited by hand, a term P1 did not know; nothing pointed to a view of the whole repository.                                                                                        | 4   | D     | W12     |
| P17 | T8   | The scenario log shows escape codes (`\u001b[0;31m`) instead of colour: runs set `ANSIBLE_FORCE_COLOR=1` for the terminal, and Run Scenarios writes the same lines to the log channel.                                                                                            | 3   | bug   |         |
| P18 | T8   | Gave up. P1 found the scenarios file but not how it relates to the flow; the notification ran several sentences together; nothing showed on the canvas. P1 also ran the flow for real while looking for the results (audit: a real run, rc 2).                                    | 3   | E     | W13     |
| P19 | T9   | The reason for keeping become was not recorded, and P1 did not notice. A lens entry does not say which subflow its step is in; after Remove Become the fixed entry stays selected.                                                                                                | 3   | F     | W14     |
| P20 | T10  | P1 found no way to select several steps: Ctrl+click and Shift+drag exist, but only the guide mentions them. Nothing shows that dragged steps line up.                                                                                                                             | 3   | G     | W15     |
| P21 | T11  | At first P1 saw no change at all. The Changes lens helped find the differences, but it shows P1's own edits too, and there is no unsaved mark because the agent saved the file. Changed wires are hard to see.                                                                    | 3   | H     | W16     |

**Liked most:** the Changes lens, with the commits and their messages. **Most confusing:** what a
lens is, and how to work with the inventory (still unclear at the end). **The one thing to change:**
working with the inventory.

### Walkthrough against the session

- **Confirmed:** W2, W3, W6 (the audit shows the localhost run), W7, W9, W10, W11, W12, W13, W14,
  W15 and W16 (P1's own T9 edit is in the T11 answer).
- **Not seen:** W4 (losing a staged binding) and W5 (the banner's choices): P1 wired the failure to
  the existing Stopped end in 48 seconds.
- **Missed by the walkthrough:** the lens concept (P10), the inventory (P6), the modes (P11), the
  "Task" label on a draft (P12), the condition editor (P13), the hidden panel edge (P15), and three
  bugs (P3, P7, P17). The walkthrough read the build as its author does; most of what it missed is
  concepts, not controls.

## What round 1 changes in wave 8

Every group A-H is confirmed by at least one finding of severity 3 or more. Round 1 adds a patch
before the wave and group I after B; the tickets are renumbered:

| Ticket | Version | Work                                                                                   |
| ------ | ------- | -------------------------------------------------------------------------------------- |
| AFD-79 | 0.50.1  | Bugs: paste in parameter fields (P3), guide images (P7), escape codes in the log (P17) |
| AFD-80 | 0.51.0  | C: binding panel at 340 px                                                             |
| AFD-81 | 0.52.0  | A: live local runs, quiet terminal                                                     |
| AFD-82 | 0.53.0  | B: one launch dialog                                                                   |
| AFD-83 | 0.54.0  | I: lenses and inventory, explained                                                     |
| AFD-84 | 0.55.0  | E: scenario results on the canvas                                                      |
| AFD-85 | 0.56.0  | H: mark outside edits                                                                  |
| AFD-86 | 0.57.0  | D: Flows view and Find filters                                                         |
| AFD-87 | 0.58.0  | F: lens findings in Details                                                            |
| AFD-88 | 0.59.0  | G: align, distribute, Reset Position                                                   |
| AFD-89 | 0.59.1  | D follow-up: `has:no-binding`, a link to the Flows view (found before round 2)         |
| AFD-90 | none    | Wave 8 report and round 2 (variant B, 0.59.1)                                          |

Additions to the groups:

- **C:** the About fold starts closed, with Full Docs at its top, not in a sideways-scrolled row;
  the panel edge shows a grip at rest, not only on hover (P15).
- **D:** the flow panel links to the Flows view, and the view explains "edited by hand" in its
  tooltip (P16). A step without an implementation says so on its card ("Not implemented yet"), not
  only "Task" (P12).
- **I (new):**
  - each lens says what it shows, and why it shows nothing on this level (P10);
  - an Inventory view: the groups and hosts the runs use (`ansible-inventory --list` in the run
    environment), with a group as the target of a run, through B's dialog (P6);
  - the Design / Code / Run switch says what each mode is for (P11).
- **E:** the notification is one short line ("1 of 2 scenarios failed · Show on Canvas"); the
  details are in the run panel (P18).
- **F:** a lens entry names its subflow; the selection moves on after a fix (P19).
- **G:** guide lines while dragging show when a step lines up with another or the gaps are even;
  the empty-selection panel says how to select several (P20); a palette step dropped on a wire is
  inserted there (P1, W1).
- **H:** changed wires get the same mark as changed steps (P21).
- **Later:** the condition editor (P13) is proposal 2.3, deferred; round 1 is the first user
  evidence for it.

## For round 2

- **Runner:** a task's goal shows only after Start, so the clock cannot be missed (T4).
- **Verifier:** names match by their words, so singular/plural and a shorter title count ("Wait for
  session to drop", "Verify services"). In T11 a change named only by its subflow is review, not
  missed.
- **Task cards:** T6 asks for the approvals by name.
- **Kit:** Finish also copies the raw data to `usability-sessions/<session>/` in the checkout,
  which Git ignores.

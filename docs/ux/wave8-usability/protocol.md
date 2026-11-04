# Wave 8 usability test: protocol

AFD-78. Wave 8 (KB AFD-A-1) changes runs, the binding panel, navigation, scenarios, lenses, layout
and edits from agents. This test watches a person do the same eleven tasks before wave 8 (0.50.0)
and after it (the wave 8 build), so the wave is judged by what people manage to do, not by what it
adds.

## What the test answers

| Group | Question                                                                         | Tasks |
| ----- | -------------------------------------------------------------------------------- | ----- |
| core  | Can a person build a flow, handle a failure and bind a step without help?        | T1-T3 |
| A     | Does a run show progress where the person looks, and where a step failed?        | T4-T5 |
| B     | How much does starting a run with inputs cost, and does the person trust it?     | T5    |
| C     | At the default panel width, how far is the person from the parameters they need? | T2    |
| D     | Can the person find steps by kind and state, and see the repository's health?    | T6-T7 |
| E     | Can the person tell which host a failing scenario routed where, and why?         | T8    |
| F     | Can the person act on lens findings without losing their place?                  | T9    |
| G     | Can the person tidy a few steps without disturbing a hand-made layout?           | T10   |
| H     | Does the person notice what an agent changed?                                    | T11   |

## Participants and rounds

- **P1**, the product owner, does both rounds. Round 1's background answers (Ansible for less than
  a year, the designer tried before) make P1 an informed newcomer, not the expert this protocol
  first assumed: the test shows what a person with some Ansible meets in their first real hours.
- **Claude** walks through the same tasks as a cognitive walkthrough (below). That is an expert
  review, not a user test; the report keeps the two apart.
- **Round 1:** 0.50.0, workspace variant A, before any wave 8 change. Its findings can still change
  wave 8's details.
- **Round 2:** the last wave 8 build (0.59.0), variant B. Variant B has the same flows, faults and
  wiring with other names (switches become routers, NTP becomes syslog), so P1 cannot answer from
  memory. Learning the product itself still carries over; the report says so.

## Setup (about 10 minutes before the session)

1. Start Docker Desktop. The image `afd-ee:2.19` must exist (`just ee-build 2.19` builds it).
2. Run the kit with the build under test:

   ```bash
   just usability-kit 1 a out/ansible-flow-designer-0.50.0.vsix
   ```

   The kit:
   - creates `C:\DOWNLOADS_TEMP\afd-usability\r<round>-<variant>-<date>-<time>\`;
   - installs the VSIX into a VS Code profile and extensions folder of that session only, so the
     first-run state is fresh and the everyday VS Code is not touched;
   - builds the fictional workspace with the repository's own flow code (8 flows, a scenarios file,
     a lab inventory whose hosts use the local connection) and commits it as a Git repository;
   - sets `afd.environment.image` to the lab image, as Set Up Ansible Environment would;
   - opens VS Code on the workspace and the task runner in the browser at
     `http://127.0.0.1:5199/`.
3. Put the browser beside VS Code (a second screen, or snap the two windows). Close everything else
   that notifies.
4. The kit keeps running in its terminal. Leave it: the runner saves progress through it and asks it
   for the agent's edit in T11. If it stops, `just usability serve <session folder>` reopens it where
   the runner left off.

## During the session

- The runner opens on **Start Session**; nothing is timed before it, nor on the questionnaires.
- It shows one task at a time. Each task's **Start** shows its goal and starts its clock, **Done**
  or **Give Up** stops it, **Pause** stops it for an interruption. A task left running when the page closes comes back
  paused at the last moment the page was open (it notes that every 15 seconds), with **Resume**.
- Tasks say what to achieve, never which control to use. The user guide, the Command Palette and web
  search are allowed; the rating asks which were used.
- Think aloud into the notes box (Ctrl+Enter adds a note with the time). Short notes are enough: "I
  expected the run to show here", "where is the parameter".
- Each task has a soft limit (5-8 minutes). Past it the runner says it is fine to give up. Giving
  up is a result, not a failure.
- Part 1 (T1-T5) builds and runs; part 2 (T6-T11) finds and reviews. Take the break between them.
- In T11 the kit plays a coding agent: when P1 presses Start, it edits the upgrade flow on disk
  through the same flow tools an agent uses. Save all files before pressing Start.

The whole session takes 60-75 minutes.

## What is measured

| Measure              | How                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------ |
| Task success         | The verifier checks the workspace, the extension's run audit and the typed answers (below) |
| Self-rated success   | Yes / Partly / No after each task                                                          |
| Time on task         | Start to Done or Give Up, pauses taken out                                                 |
| Ease                 | Single Ease Question after each task: 1 very difficult to 7 very easy                      |
| Help used            | User guide, Command Palette search, web search, other                                      |
| Obstacles            | Free text after each task, and the timed notes                                             |
| Usability as a whole | System Usability Scale (Brooke 1996), 10 items, 0-100, at the end                          |
| Open questions       | The most confusing moment, what P1 liked most, the one thing to change                     |

The verifier gives each task **pass**, **fail** or **review**. Review means a typed answer it could
not match with confidence; the analyst reads it. File-checked tasks:

- T1 a new flow runs start, the two steps in order, an end;
- T2 the step is bound to the module with both parameters;
- T3 the step's failed hosts reach a failed end;
- T4 and T5 the audit has a finished check run, and a real run on all four lab hosts with nothing
  failed;
- T9 one step keeps become with the lens finding accepted and a reason, the other loses become;
- T10 the three steps share a column (or row) with even gaps, and no other node moved.

`just usability verify <session folder>` runs the checks again; `just usability solve <session
folder>` is the kit's self-test (it solves the file-checked tasks so the verifier can be checked).

## After the session

1. The kit writes `progress.json` (everything the runner recorded), `results.json` (with the
   checks and the SUS score) and `summary.md` into the session folder, and copies them to
   `usability-sessions/<session>/` in the checkout, which Git ignores.
2. P1 reads the analysis before it is committed. The repository gets P1's notes and answers
   paraphrased, never word for word; the raw data stays local.
3. The analyst writes `docs/ux/wave8-usability/round<n>.md`: each finding with its evidence (task,
   note, time, check), its severity and the wave 8 group it belongs to. Round 1 also lists what it
   changes in wave 8.
4. After round 2, `report.md` compares the rounds per task (success, time, ease), the SUS scores and
   the findings fixed, new or still open.

## Severity

Nielsen's scale, applied to each finding:

| Severity | Meaning                                                   |
| -------- | --------------------------------------------------------- |
| 0        | Not a usability problem                                   |
| 1        | Cosmetic: fix when there is time                          |
| 2        | Minor: slows the person down; worth fixing                |
| 3        | Major: the person fails or needs help; fix before release |
| 4        | Blocker: the task cannot be done; fix now                 |

## Cognitive walkthrough (Claude)

For each task, the walkthrough writes down the shortest path through the build under test and asks
at every step:

1. Will the person try to achieve this effect?
2. Will they notice that the right control is there?
3. Will they connect the control with the effect they want?
4. After acting, will they see that it worked?

The webview parts run in the harness (`just harness`) with the same flows; host parts (prompts, the
terminal, the Flows view, scenarios) are read from the code and the integration test API. Each "no"
is a finding with a severity, in `walkthrough-r<n>.md`.

## Privacy

- Only "P1" identifies the participant. The workspace's Git author and the decisions recorded in it
  are fictional ("P1 (usability session)").
- Every repository, host, address and ticket in the workspace is fictional; hosts use the local
  connection, so no run reaches a device.
- The session folder stays in `C:\DOWNLOADS_TEMP`, and its copy in `usability-sessions/` is
  ignored by Git. Only the analysis P1 has reviewed is committed, with the notes paraphrased.
- The runner talks only to the kit on 127.0.0.1, with a token of the session; nothing is sent
  elsewhere.

## Limits

- One participant: the results show problems, not rates. A pass or a time is an observation.
- P1 owns the product, which can soften the SUS score; P1 had used the designer only briefly
  before round 1, so it does not hide a newcomer's problems the way an author's test would.
- Round 2 follows round 1 with the same participant. The variants stop recall of answers, not of
  the product.
- Thinking aloud and writing notes lengthen the times. Compare times between rounds, not with other
  studies.

# Round 4 usability test: tasks

AFD-109. Round 4 tests the wave 10 build (0.68.1) with a person, as round 3 tested wave 9
(`../wave9-usability/`). The method, measures, severity scale and privacy rules are the same
(`../wave8-usability/protocol.md`). This page says what changes and lists the tasks. The kit runs it
as variant D; the walkthrough is `walkthrough-r4.md`.

## Why round 4

Round 3 (SUS 65) found that controls existed but did not explain themselves (R1-R13,
`../wave9-usability/round3.md`). Wave 10 and patch 0.68.1 answered those findings. The wave 10
walkthrough (`../wave10/walkthrough.md`) predicts every finding at 0 except three, which stay at 1
until a person shows otherwise:

- **R2:** does anyone read the Timing sentence?
- **R7:** is a step's result passed on without help?
- **R10:** does a flagged step get kept with a reason?

Round 4 is that session.

## What changes from round 3

- **Shorter and focused.** 10 tasks, about 35-40 minutes of task time in three parts. With the
  questionnaires, about 45 minutes in all (product owner's decision, 2026-11-07).
- **Each task repeats the shape of a round 3 task** whose finding wave 10 changed. Two of round 3's
  passes (T13 and T10) come back unchanged as controls, so a drop elsewhere would show.
- **R2 is measured directly.** D2 asks how long one try can take. The step has a 30 s timeout, and
  the Timing sentence says "each try at most 30s".
- **Variant D:** new names (load balancers in two data centres), so no answer comes from memory.
- **The kit:**
  - shares round 3's Git and check helpers (`scripts/usability/git.ts`, `flowChecks.ts`);
  - D9's check reads the accepted finding in either decision format (`findAccepted`).

## Parts and timing

| Part | Tasks  | Theme                               | Expected minutes | Limits (sum) |
| ---- | ------ | ----------------------------------- | ---------------- | ------------ |
| 1    | D1-D4  | The workspace and a step's settings | 11               | 18           |
| 2    | D5-D6  | Data in and out                     | 8                | 12           |
| 3    | D7-D10 | Runs, tests and the team            | 16               | 21           |

Expected minutes are the walkthrough's estimate on 0.68.1, below round 3's times for the same
shapes. A short break between parts is fine: the clock runs only inside a task.

## The cards

As before, a card says what to achieve, never which control to use. The goal shows on Start, and
the check is what the verifier looks at. **Round 3** names the task of the same shape and the
finding wave 10 changed for it.

### Part 1: the workspace and a step's settings

| Task | Card                                                                                                                                                                                                                                             | Limit | Check                                                                                                                                  | Round 3       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D1   | Get an overview of this workspace's flows, opening as few of them as you can. Answer: which flow has an error that stops it from generating code? Which flow's generated playbook was changed by hand?                                           | 3     | the answer names VIP audit and Certificate renewal                                                                                     | T13 (control) |
| D2   | In "Pool maintenance", "Wait for the pool to drain" checks only once. Make it keep checking, up to 12 times, 10 seconds apart, until its output says drained. Save the flow. Answer: how long can one of those checks take at most?              | 6     | retries 12, delay 10; Until tests "drained" in a field of the result, not the whole result; a second check: the answer says 30 seconds | T6 (R1, R2)   |
| D3   | In "Pool maintenance", what "Read the API key" reads must never show in logs or run output. Save the flow.                                                                                                                                       | 3     | `no_log: true` on the step                                                                                                             | T8 (R3)       |
| D4   | In "Pool maintenance", "Disable the pool members" disables the member MEMBER, which does not exist. Make it run once for each of the members web-01, web-02 and web-03, with the member's name in its command in place of MEMBER. Save the flow. | 6     | a loop over the three members; the command reads the loop variable, and MEMBER is gone                                                 | T9 (R3, R4)   |

### Part 2: data in and out

| Task | Card                                                                                                                                                                                                                   | Limit | Check                                                                                                                                                                        | Round 3     |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| D5   | In "Pool maintenance", "Report the pool state" always prints "unknown". Make it print what "Read the pool state" printed (its standard output). Save the flow.                                                         | 6     | the report has an input fed by Read the pool state, and its message reads its stdout (the whole result plus `.stdout`, or an output that is the stdout); no input left unfed | T4 (R7, Z1) |
| D6   | In "Pool maintenance", whoever runs the flow should be able to say how many seconds to wait for the pool to drain: 300 unless they give another number. Explain the value, so they know what it is for. Save the flow. | 6     | a flow input with the default 300, a description, and not required                                                                                                           | T5 (R6)     |

### Part 3: runs, tests and the team

| Task | Card                                                                                                                                                                                                                                                                            | Limit | Check                                                                                                                                                 | Round 3       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| D7   | Run "DNS record sync" as a check, so nothing is changed, on the load balancers of the data centre lab-lb-42 belongs to, and only those. Some of them fail. Answer: which step failed, and for which load balancer? Name every pair you find.                                    | 6     | a finished check run on `dc_east` only; the answer names both pairs there, and not lab-lb-45                                                          | T10 (control) |
| D8   | "Pool health check" has scenario tests. Run them. One of them fails. Answer: which load balancer ended where, where was it expected to end, and why?                                                                                                                            | 5     | the answer names lab-lb-46, Stopped, Reported to the NOC, and the forced peer check                                                                   | T12 (R8)      |
| D9   | In "Load balancer upgrade", the Access lens flags two steps that run as root unlike their neighbours. "Restart the health daemon" really needs root: keep it and record why. "Write the change summary" does not need root: fix it. Save the flow.                              | 5     | Restart the health daemon keeps become, with its Access finding accepted with a reason; Write the change summary loses become                         | T15 (R10)     |
| D10  | _Before Start: save all files and close the designer tabs._ When you pressed Start, the kit committed your work so far, then brought in a colleague's change to "Load balancer upgrade", as a Git pull would. Find out what the colleague changed. Answer: say it step by step. | 5     | the answer names the four changes: the added health probe check, the renamed VIP check, the image copy's new binding, and the balancer wait's retries | T16 (R9)      |

## What the workspace holds (variant D)

All names and hosts are fictional. Every host uses the local connection.

- **Inventory `lab`:**
  - `dc_east`: lab-lb-41, lab-lb-42, lab-lb-43;
  - `dc_west`: lab-lb-44, lab-lb-45, lab-lb-46.
  - Host vars drive the planted failures:
    - lab-lb-42 and lab-lb-45 have an old zone serial;
    - lab-lb-43's resolver is down;
    - lab-lb-44 has one pool member up;
    - lab-lb-46's peer is out of sync.
- **`flows/edge`:**
  - **Pool maintenance** (D2-D6): Read the API key, Read the pool state, Disable the pool members, Wait for the pool to drain (timeout 30s), Report the pool state ("Pool state: unknown"). Every step is bound to a module.
  - **DNS record sync** (D7): Check the zone serial is current, Check the resolver answers, Push the records, Reload the resolver. A check run on `dc_east` fails the first check on lab-lb-42 and the second on lab-lb-43. On `dc_west`, lab-lb-45 fails the first.
  - **Pool health check** (D8), with two scenarios. "A load balancer whose peer is out of sync is reported to the NOC" forces Check the peer is in sync to fail for lab-lb-46. That step's failures go to Stopped, so the scenario misses.
  - **Load balancer upgrade** (D9, D10): two approvals and five subflows. Restart the health daemon and Write the change summary run as root, unlike their neighbours.
  - **VIP audit** (D1): a wire to the port `failed_host`, which does not exist. An error, so no code.
- **`flows/platform`:**
  - **Certificate renewal** (D1): its generated playbook was edited by hand (`--expiring 30d` to `45d`).
  - **Config bundle pipeline:** a clean flow.
- **D10's change** (M. Lindqvist's commit):
  - Check the health probes pass is added after Move the VIPs to the peer;
  - Check the VIPs answer is renamed to Check the VIPs and their certificates answer;
  - Copy the image gets a new binding;
  - Wait for the balancer gets retries 5 and delay 30.

## Participant and session

- **P1 only.** This is P1's fourth session. The variant's names stop P1 recalling answers, but not
  the product.
- **One sitting** of about 45 minutes.

## Running it

```bash
just usability-kit 4 d out/ansible-flow-designer-0.68.1.vsix
```

- `just usability verify <session folder>` checks a session again.
- `just usability solve <session folder>` is the kit's self-test: it solves D2-D6 and D9.

What the kit does for round 4:

- **The runner** shows three parts, ten cards and the intro's length (about 45 minutes).
- **D10:** on Start, the kit:
  1. commits the workspace as it is ("Work so far");
  2. applies the colleague's change through the flow tools and commits it as M. Lindqvist;
  3. keeps in `session.json` when the designer last showed the flow (`outsideFacts.shownAt`). D9 opens it just before.
- **The checks:**
  - D7 reads the run audit and the run's events;
  - D2 adds a second check for its answer (`D2 answer`);
  - an empty answer fails, and an answer the check cannot match goes to review.

## Wave 10 coverage

| Wave 10 change (round 3 finding)                                        | Task   |
| ----------------------------------------------------------------------- | ------ |
| Folds name their fields; Timing open on a module step (R1)              | D2     |
| The Timing sentence; Until suggestions; `until-whole-result` (R2)       | D2     |
| Task keywords in their own fold, with chips (R3)                        | D3, D4 |
| The YAML box colours, marks and indents (R4)                            | D4     |
| `input-unfed`; the @ list offers a result (R7); its fields (Z1, 0.68.1) | D5     |
| Flow inputs get a Default; a new one is required until it has one (R6)  | D6     |
| Planted scenario failures in words (R8)                                 | D8     |
| Accept with Reason first; the Privilege note (R10)                      | D9     |
| What changed outside, in words; the lens since last open (R9)           | D10    |

## Comparison with round 3

Times compare by direction only: the tasks have the same shape, but other names and a fourth
session. With one participant the results show problems, not rates.

| Round 4 | Round 3 | Round 3 result                 |
| ------- | ------- | ------------------------------ |
| D1      | T13     | pass, 1.2 min                  |
| D2      | T6      | fail, 12.6 min (R1, R2)        |
| D3      | T8      | pass, 8.5 min with become (R3) |
| D4      | T9      | pass, 6.6 min (R3, R4)         |
| D5      | T4      | partial, 5.3 min (R7)          |
| D6      | T5      | partial, 4.3 min (R5, R6)      |
| D7      | T10     | pass, 3.3 min                  |
| D8      | T12     | partial, 8.5 min (R8)          |
| D9      | T15     | partial, 1.2 min (R10)         |
| D10     | T16     | fail, 4.0 min, gave up (R9)    |

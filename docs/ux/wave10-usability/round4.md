# Round 4 (P1, 0.68.1, variant D)

AFD-110. Session `r4-d-20261107-1431`, 2026-11-07, 14:31-14:50 local time, in one sitting. Build
0.68.1, image `afd-ee:2.19`, the kit's variant D workspace (`tasks.md`). As in rounds 1-3, P1's
notes and answers are paraphrased. The raw data stays in the session folder and in
`usability-sessions/`, which Git ignores.

## The participant

P1 again, with the same background answers: Ansible for under a year, VS Code daily, the designer
tried before. This is P1's fourth session, two days after round 3. Every task repeats the shape of a
round 3 task, with new names (load balancers), so learning carries over and answers do not.

## Results

| Task | Goal                          | Verifier | Analyst | Self-rated | Minutes (limit) | Ease (1-7) |
| ---- | ----------------------------- | -------- | ------- | ---------- | --------------- | ---------- |
| D1   | Know your workspace           | pass     | pass    | yes        | 0.6 (3)         | 7          |
| D2   | Wait until it has drained     | pass     | pass    | yes        | 5.0 (6)         | 5          |
| D3   | Keep a secret out of the logs | pass     | pass    | yes        | 0.4 (3)         | 7          |
| D4   | Once per member               | pass     | pass    | yes        | 1.9 (6)         | 6          |
| D5   | Pass a result on              | pass     | pass    | yes        | 1.4 (6)         | 7          |
| D6   | A value with a default        | fail     | fail    | partly     | 2.8 (6)         | 5          |
| D7   | Check one data centre         | pass     | pass    | yes        | 1.7 (6)         | 6          |
| D8   | Scenario tests                | review   | partial | yes        | 0.7 (5)         | 7          |
| D9   | Privileges                    | pass     | pass    | yes        | 0.9 (5)         | 7          |
| D10  | A colleague's change          | pass     | pass    | yes        | 1.3 (5)         | 7          |
- **Task time:** 16.8 minutes, against 51 minutes of limits and the walkthrough's 35. Wall time
  was 20 minutes with the ratings and the questionnaires. No task recorded any help.
- **Part 1, a step's settings:** 7.9 minutes, all four passed, D2 the slowest task of the session.
  Median ease 6.5.
- **Part 2, data in and out:** 4.1 minutes. D5 passed, D6 failed. Median ease 6.
- **Part 3, runs, tests and the team:** 4.7 minutes. Three passes, D8 in part. Median ease 7.
- **SUS: 82.5** (items 5, 2, 4, 1, 5, 2, 4, 1, 4, 3). Round 3 had 65, round 2 75, round 1 30.
  - Against round 3, six items moved the right way and none the wrong way. Confidence moved most
    (two points), then using it often, less complex, needing no support, learning it quickly and
    less cumbersome (one point each).
  - The other four stayed, among them needing to learn a lot first (3).
- **After the session:** P1 said it is significantly better, naming the variable substitution and
  the syntax highlighting.

Notes on the verdicts:

- **D2:** Retries 12, Delay 10, Timeout 30s kept. Until reads a field,
  `wait_drain_result.stdout == "drained"`, not the whole result. To "how long can one check take",
  P1 worked out the whole wait: 12 tries of 30 s plus 10 s, 480 s. The 30 s a try is in it, so R2's
  point holds (each try at most 30 s, the delay between them). Two things around it are Q1 and Q3.
  On the way, P1 asked why Delay takes only seconds while Timeout takes `30s` (Q2).
- **D4:** a loop over web-01, web-02 and web-03 in the Task keywords box, and `{{item}}` in the
  command. P1 liked the new YAML box and the keyword choice.
- **D5:** the message reads `{{ read_state_result.stdout }}`. The @ list made the result an output
  of Read the pool state and an input of the report: the designer's way, in 1.4 minutes. P1 called
  the variable substitution excellent.
- **D6:** no flow input. P1 wrote into the flow's goal "Up to 300 seconds total", followed by the
  Timing sentence copied from D2's step, and rated it "partly". There is no note; the likely cause
  is below (Q4).
- **D7:** one check run on `dc_east` only. The answer is the two failure rows copied from the run
  results. P1 liked the new icon for a host's output.
- **D8:** the answer names lab-lb-46, the port it left by (failed_hosts), and that the scenario
  forced it. That is the step's Run tab row. It does not say where the host ended (Stopped) or where
  the scenario expected it (Reported to the NOC). Analyst: partial (Q5).
- **D9:** Write the change summary lost become. Restart the health daemon keeps it, and its Access
  finding is accepted with the reason "needs root to restart the service".
- **D10:** the answer is the designer's change list, all six lines. The four changes are in it,
  and so are the two noise lines the walkthrough predicted (Z4, now Q6).

## Findings

Q = this session. Z = the walkthrough (`walkthrough-r4.md`). Severity is Nielsen's 0-4. Area: C is
a step's Details (binding and Execution), E scenarios, H outside changes, I inputs; **bug** goes to a
patch.

| ID  | Task   | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Sev | Area    | Z   |
| --- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --- | ------- | --- |
| Q1  | D2     | **Bug:** the Timing sentence and the Retries hint count one try too few. Ansible runs a task once, then retries it up to Retries times: ansible-core 2.19 (`task_executor.py`) makes 1 + retries tries, and 1 + 3 with Until and no Retries. Retries 12 is 13 tries, but the sentence says "Tries up to 12 times", the hint "How many tries at most", and the guide's example `retries: 40 # tries`. P1 did not notice, but P1's sum used the count. The kit took the designer's word too: D2's card asks for "up to 12 times" and the check wants Retries 12. | 2   | bug (C) |     |
| Q2  | D2     | Delay takes only a whole number of seconds; `10s` is refused with "A whole number". Timeout, in the same fold, takes `30s`, `15m` or `1h30m`. P1 asked whether that is by design.                                                                                                                                                                                                                                                                                                                                                                              | 1   | C       |     |
| Q3  | D2, D6 | The Timing sentence gives each try's limit, not how long the step can take in all. P1 worked it out by hand twice: 480 s in D2's answer, and "up to 300 seconds total" in D6. The real worst case is 13 tries of 30 s and 12 waits of 10 s, 510 s.                                                                                                                                                                                                                                                                                                             | 1   | C       |     |
| Q4  | D6     | No flow input; the wait went into the flow's goal. The card is part of the cause: "how many seconds to wait for the pool to drain" names the wait D2 had just set with Retries and Delay, so P1 described that wait. The product is the other part: Retries and Delay take only numbers, so an input could not drive the wait. Nothing on the path tied "a value given at run time" to a step's Timing. Round 3's T5, with a URL to fill, did get an input. Cause inferred: there is no note.                                                                  | 2   | I, C    |     |
| Q5  | D8     | The step's Run tab row for a planted failure says "Forced by the scenario (failed)", and P1 answered from it in 42 seconds. Where the host ended and where the scenario expected it are in the run's miss line and the row's tooltip, not on the row. R8's question (why) is answered; the expected end is not in the answer, as in round 3.                                                                                                                                                                                                                   | 1   | E       |     |
| Q6  | D10    | Confirms Z4. P1's answer lists all six lines of the change list as changes, including "Drain the balancer: boundary changed" and "Wire removed: move-vips.ok_hosts → wait-sessions". Both come from inserting one step on a wire, and the wire line names steps by key. It did not slow P1 (1.3 minutes, ease 7), but the answer counts six changes for four.                                                                                                                                                                                                  | 1   | H       | Z4  |

What P1 said beyond the tasks (paraphrased):

- **Liked most:** the syntax highlighting and the variable substitution.
- **Most confusing, one thing to change:** left empty.
- **In passing:** liked the YAML box, the task keyword choice, and the output icon in the run
  results.

### Round 3's findings in round 4

The wave 10 walkthrough (`../wave10/walkthrough.md`) predicted each finding after wave 10. Round 4
is the first look by a person.

| Round 3 | Finding (round 3 severity)                        | Predicted | Task | Round 4                                                                              | Now |
| ------- | ------------------------------------------------- | --------- | ---- | ------------------------------------------------------------------------------------ | --- |
| R1      | Timing found only through the guide (3)           | 0         | D2   | found unaided, no help used                                                          | 0   |
| R2      | Timing fields do not say how they combine (3)     | 1         | D2   | Delay and Timeout in their places, Until on a field, 30 s a try in the answer; Q1-Q3 | 0   |
| R3      | Task keywords under Tags (2)                      | 0         | D3   | 0.4 minutes (round 3: 8.5)                                                           | 0   |
| R4      | The YAML box neither colours nor marks (1)        | 0         | D4   | 1.9 minutes, and P1 liked the box                                                    | 0   |
| R6      | A new flow input is optional, with no default (2) | 0         | D6   | not met: no input was made (Q4)                                                      | ?   |
| R7      | A step input nothing feeds validated clean (2)    | 1         | D5   | the designer's way through @ in 1.4 minutes                                          | 0   |
| R8      | "The scenario fails it here" not understood (2)   | 0         | D8   | why answered at once; the expected end still missing (Q5)                            | 0   |
| R9      | Marks say which steps changed, not what (3)       | 0         | D10  | four of four changes in 1.3 minutes; two noise lines (Q6)                            | 0   |
| R10     | Keeping a flagged become never asked a reason (2) | 1         | D9   | accepted with a reason, unaided, in 0.9 minutes                                      | 0   |

R5 and R11-R13 were bugs fixed in 0.64.3 and were not looked at again.

### Walkthrough against the session

- **Confirmed:** Z4, as Q6.
- **Not seen:** Z5. P1 typed `{{item}}` by hand, but left no note on the @ list, and D4 took 1.9
  minutes.
- **Missed by the walkthrough:**
  - D6's failure: the walkthrough checked that the path exists, not how the card reads after D2
    (Q4);
  - the try count (Q1): the walkthrough quoted the sentence as the right answer;
  - Delay's format and the total wait (Q2, Q3);
  - the partial D8 answer (Q5).
- **Times:** 16.8 minutes against the walkthrough's 35. Each part took about half of what the
  walkthrough expected (7.9, 4.1 and 4.7 minutes against 11, 8 and 16).

## Compared with round 3

Each cell: verdict, minutes (limit), ease. Round 3 from `../wave9-usability/round3.md`.

| Round 4 (round 3) | Shape                     | Round 3                   | Round 4             |
| ----------------- | ------------------------- | ------------------------- | ------------------- |
| D1 (T13)          | the workspace's state     | pass, 1.2 (5), 7          | pass, 0.6 (3), 7    |
| D2 (T6)           | retry until a state holds | fail, 12.6 (5), 3         | pass, 5.0 (6), 5    |
| D3 (T8)           | keep a secret out of logs | pass, 8.5 (5), 5          | pass, 0.4 (3), 7    |
| D4 (T9)           | once per item             | pass, 6.6 (6), 5          | pass, 1.9 (6), 6    |
| D5 (T4)           | pass a result on          | partial, 5.3 (6), 6       | pass, 1.4 (6), 7    |
| D6 (T5)           | a value at run time       | partial, 4.3 (7), 5       | fail, 2.8 (6), 5    |
| D7 (T10)          | a check run on a group    | pass, 3.3 (8), 5          | pass, 1.7 (6), 6    |
| D8 (T12)          | the failing scenario      | partial, 8.5 (5), 4       | partial, 0.7 (5), 7 |
| D9 (T15)          | keep a flagged step       | partial, 1.2 (5), 7       | pass, 0.9 (5), 7    |
| D10 (T16)         | a colleague's change      | fail, 4.0 (5), gave up, 4 | pass, 1.3 (5), 7    |

The tasks have the same shape, not the same content, and this was P1's fourth session, so the times
show direction, not size.

- **Both controls held** (D1, D7), and both got quicker. Nothing wave 10 did set them back.
- **The two failures of round 3 now pass:** D2 in 5.0 minutes instead of a failure after 12.6, and
  D10 in 1.3 minutes instead of giving up.
- **Two partials now pass** (D5, D9). D8 stays partial, but only on the expected end: the why came
  at once, after 8.5 minutes of searching in round 3.
- **D6 went from partial to fail**, for a reason that is half the card's (Q4).
- **SUS 82.5 against 65:** the Execution tab and the outside change, the two places round 3 found
  hardest, are where round 4 gained most. One participant cannot say more.

## What round 4 changes

Patched in 0.68.2 (AFD-111): Q1, Q2, Q3, Q5 and Q6, as proposed below. D2's card now says "check
again up to 12 more times".

- **Patch, proposed:** Q1. Count the first try: "Tries up to 13 times (once, then 12 retries)", the
  Retries hint "Tries again up to this many times", the guide's example. With it, D2's card and
  check (`tasks.md`) should ask for Retries 11, or say "retry up to 12 times".
- **Small, proposed for the same patch:**
  - **Q2:** Delay takes a duration like Timeout (`10s`, `1m`), stored as seconds, since Ansible's
    delay is a number.
  - **Q3:** the sentence ends with the longest the step can take, "at most 8 min 30 s in all", when
    Timeout is set.
  - **Q6:** an inserted step reads as one change ("Added Check the health probes pass, in Drain the
    balancer, after Move the VIPs to the peer"), and a wire line names steps by title.
  - **Q5:** a forced row adds where the scenario expected the host, when the host missed.
- **Needs a decision (Q4):** let Retries and Delay take an input (`{{ drain_wait }}`), so a value
  given at run time can drive a step's Timing. It touches the setting fields, codegen and
  validation, so it is wave work, not a patch.
- **Round 5:** not needed for wave 10's changes; every round 3 finding a person could see is at 0.
  A later round could test R6 and Q4 with a card that does not follow D2, or a newcomer's first
  hour.

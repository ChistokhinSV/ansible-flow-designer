# wave10

The measures after wave 10: 0.68.0, from `just ux-baseline wave10` (2026-11-07), against
[wave9](../wave9/README.md) (0.64.0).

- `metrics.md` has the harness measures.
- `compare-*.png` puts the first-hour screens of both builds side by side.
- `walkthrough.md` checks round 3's findings on this build.

Wave 10 worked from usability round 3 (`docs/ux/wave9-usability/round3.md`, SUS 65). Patch 0.64.3
(AFD-102) had already fixed its four small bugs.

| Ticket  | Version | Work                                                                                           |
| ------- | ------- | ---------------------------------------------------------------------------------------------- |
| AFD-103 | 0.65.0  | The Execution tab explains itself (R1-R4)                                                      |
| AFD-104 | 0.66.0  | What changed outside, in words; the Changes lens since last open (R9)                          |
| AFD-105 | 0.67.0  | Planted scenario failures in words; one wording for a miss (R8)                                |
| AFD-106 | 0.68.0  | Unfed inputs, upstream results in @, flow input defaults, keeping a flagged step (R7, R6, R10) |

| Measure                                          | wave9 (0.64.0)         | wave10 (0.68.0)         |
| ------------------------------------------------ | ---------------------- | ----------------------- |
| Controls on a new flow (budget 35)               | 35                     | 35                      |
| Controls after the first step                    | 64                     | 64                      |
| Bound step at 340 px: first Configure field      | 176 px down, on screen | 176 px down, on screen  |
| A real run from the designer (edge-baseline)     | 1 dialog, no prompt    | 1 dialog, no prompt     |
| Perf round trip, median (idle PC, budget 100 ms) | 43 ms (AFD-96)         | 46-71 ms (AFD-103..106) |
| Webview bundle (budget)                          | 1,140 KB (1,152)       | 1,156 KB (1,216)        |
| Extension bundle (budget 864 KB)                 | 842 KB                 | 848 KB                  |
- **First screens.** Wave 10 changed screens a person opens later: the Execution tab, the
  outside note, the scenario results, the inputs editor. A new flow's first screen and the screen
  after its first step are as they were.
- **Webview budget.** It was raised to 1,216 KB for this wave (ADR-0023), with no new library. The
  YAML box colours its lines with its own small tokenizer.
- **Perf** was green in every ticket on an idle PC (CPU 5-12%). It fails only under load, as
  round 3's day showed (0.64.2, CPU about 45%).
- **Integration.** 86 tests pass on stable and on 1.140.0 (wave 9 had 84; AFD-104 and AFD-106
  added one each). The two lab AWX imports still fail while the afd-awx VM does not answer.

## Round 4 (proposal)

Round 4 is the product owner's call (decided after wave 10). A proposal:

- **Who:** P1. Wave 10 changed what P1 found hard, so P1 shows whether it now explains itself. A
  newcomer would test the first hour again instead, which waves 8-9 already reached (35 controls).
- **What:** a variant D (new names), 8-10 tasks, about 45 minutes, one sitting:
  - the Execution tab: retry until a state holds; keep output out of logs; run once per item;
  - a pulled change to a closed flow: what changed, step by step;
  - a failing scenario: who ended where, and why;
  - passing a step's result on, and an input given at run time with a default;
  - keeping a privileged step with its reason;
  - two of round 3's passes as controls (the workspace's state, a check run on a group).
- **When:** any time; Z1 (`walkthrough.md`), which round 4's data task would meet, is patched in
  0.68.1 (AFD-108). Round 4 should run on 0.68.1 or later.

**Decided (2026-11-07):** as proposed, 10 tasks, about 45 minutes, load balancers as variant D, and D2
asks how long one try can take (R2). The test set is `../wave10-usability/tasks.md` (AFD-109).

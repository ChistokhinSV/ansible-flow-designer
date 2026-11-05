# wave9

The measures after wave 9: 0.64.0, from `just ux-baseline wave9` (2026-11-05), against
[wave8](../wave8/README.md) (0.59.2).

- `metrics.md` has the harness measures.
- `compare-*.png` puts the first-hour screens of both builds side by side.
- `walkthrough.md` checks round 2's findings on this build.

Wave 9 worked from usability round 2 (`docs/ux/wave8-usability/round2.md`):

| Ticket | Version | Work                                                      |
| ------ | ------- | --------------------------------------------------------- |
| AFD-91 | 0.59.3  | Round 2's two bugs (lens rows moving, a stale host check) |
| AFD-92 | 0.60.0  | Marks for flows edited while closed                       |
| AFD-93 | 0.61.0  | The workspace's state where people look                   |
| AFD-94 | 0.62.0  | Scenario results in words                                 |
| AFD-95 | 0.63.0  | The launch dialog and input descriptions                  |
| AFD-96 | 0.64.0  | Run results, the canvas and the leftovers                 |

| Measure                                          | wave8 (0.59.2)          | wave9 (0.64.0)               |
| ------------------------------------------------ | ----------------------- | ---------------------------- |
| Controls on a new flow (budget 35)               | 35                      | 35                           |
| Controls after the first step                    | 63                      | 64 (Stop Flow in the banner) |
| Bound step at 340 px: first Configure field      | 176 px down, on screen  | 176 px down, on screen       |
| A real run from the designer (edge-baseline)     | 1 dialog, no prompt     | 1 dialog, no prompt          |
| First node result on the canvas (idle PC)        | 4.9 s of 6.1 s (AFD-81) | 4.2 s of 5.4 s (AFD-96)      |
| Perf round trip, median (idle PC, budget 100 ms) | 45 ms (AFD-91)          | 43 ms (AFD-96)               |
- **Perf** ran green on an idle PC in every wave 9 ticket (CPU 1-34%).
- **Integration tests:**
  - **Undo checks** need the test window to keep the OS focus. They fail whenever another application is in front during a run (AFD-93).
  - **M1 checks:** they failed now and then in a full run (AFD-97). A reopened designer was read before it had drawn. Fixed in 0.64.1: 20 of 20 runs and four full runs green.
- **Not in the numbers.** Wave 9 added a choice to the dialog (a group's hosts, before it is picked) and to the Problems panel (every flow). Neither shows on a new flow's first screen.

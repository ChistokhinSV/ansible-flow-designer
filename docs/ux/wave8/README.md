# wave8

The measures after wave 8: 0.59.2, `just ux-baseline wave8` (2026-11-04), against
[wave8-start](../wave8-start/README.md) (0.50.0). `metrics.md` has the harness measures;
`compare-*.png` puts the first-hour screens of both builds side by side. `proposals.md` and
`review.md` are where the wave started.

| Measure                                                       | wave8-start (0.50.0)     | wave8 (0.59.2)             |
| ------------------------------------------------------------- | ------------------------ | -------------------------- |
| Controls on a new flow (budget 35)                            | 35                       | 35                         |
| Controls after the first step                                 | 63                       | 63                         |
| Bound step at 340 px: first Configure field                   | 1099 px down, off screen | 176 px down, on screen     |
| Bound step at 340 px: controls above it                       | 24 (6 search results)    | 11 (no search until asked) |
| A real run from the designer (edge-baseline)                  | 3 prompts in a row       | 1 dialog, no prompt        |
| First node result on the canvas, Hello skeleton run (idle PC) | 11.6 s of 11.6 s         | 4.9 s of 6.1 s (AFD-81)    |
- **The run measure** comes from `just perf` on an idle PC at AFD-81, the last time the PC was idle.
  From AFD-86 on, every perf gate ran under load (CPU 70-91%: another heavy application and two
  VMs). The round trips came in at 117-217 ms against the 100 ms budget. An A/B against AFD-85
  under the same load failed the same way (172-217 ms), so the cause is the load. On an idle PC at
  0.59.3 (AFD-91) the gate passes:
  - first render 91 ms;
  - round trip median 45 ms (max 155);
  - pattern round trip 53 ms;
  - first node result 5.0 s of a 6.6 s run.
- **Canvas readability** (the level table in `metrics.md`) is unchanged from wave8-start: wave 8
  did not touch node sizes, labels or the layout.
- **The prompts** are counted from the flows' inputs, because a script cannot drive VS Code's input
  boxes. The integration tests check that the dialog's run asks nothing more.

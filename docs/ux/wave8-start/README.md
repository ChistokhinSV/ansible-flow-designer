# wave8-start

The baseline before wave 8: 0.50.0, `just ux-baseline wave8-start` (2026-11-03). `metrics.md` has the
harness measures, with **Wave 8 measures** at the end.

Measured outside the harness, in VS Code 1.144.1 with `afd-ee:2.19` on Docker Desktop
(`AFD_TEST_IMAGE=afd-ee:2.19 just perf`, the case "first node result on the canvas during a run"),
on an idle PC:

| Run                            | First node result on the canvas | Run length |
| ------------------------------ | ------------------------------- | ---------- |
| Hello skeleton run (localhost) | 11.6 s                          | 11.6 s     |

The first node result appears when the run ends: the run reads its events only after the process
exits. With another heavy application running, the same run took 29.6 s, still with nothing on the
canvas before the end. The perf budgets need an idle PC: under that load the round trips came in at
107 and 123 ms against 100; idle they were 43-78 ms.

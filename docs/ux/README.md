# UX measurements

The improvement program (YouTrack AFD-A-17) measures the designer's UI before and after each wave.
Nothing here ships in the extension.

- `baseline/`: the state before the UI redesign (0.23.x, AFD-33).
  - `*.png`: four flows (`new` empty, `edge-baseline` branching, `firewall-upgrade` with
    subflows, `playbook-import` imported as is) in each mode (`design`, `code`, `run`, `lens`) at
    1280×800 and 1920×1080.
  - `metrics.json` and `metrics.md`: canvas readability per level, wire labels, overlaps, model
    builds per snapshot.
  - `tasks.md`: the steps of eight core tasks, and whether each works with the keyboard only.
- `wave2/`: metrics after wave 2 (0.24.x, foundations): one model build per snapshot instead of six,
  nothing else changed. Its screenshots matched `baseline/` byte for byte except the Data lens shots
  (a few anti-aliased pixels on the dotted data wires, which also differ between two runs), so
  they are not kept.
- `wave3/`: after the UI redesign (0.27.3, AFD-41..48): the same screenshot matrix and metrics, and
  `tasks.md` with the eight tasks counted again. Every node readable where it opens (62 of 62, was
  50; smallest title 13.2 px, was 6.2), wire labels at rest 24 (was 88, −73%), no overlapping
  labels (was 2), two labels on a node (was 3), every task doable with the keyboard only.
- `wave4/` to `wave6/`: the same matrix after format 2, scenarios and shared subflows, and
  annotations; nothing measured changed.
- `wave7-start/` and `wave7/`: the first hour (AFD-71..74), before (0.45.0) and after (0.49.0).
  `metrics.md` adds **Learnability**: the controls a newcomer takes in on a new flow, per region,
  before and after the first step, and nodes the minimap covers. `wave7/tasks.md` counts the first
  hour's tasks and the eight core tasks; `compare-*.png` put the screens side by side (`node
  scripts/ux-baseline.mjs --compare wave7-start wave7`). A new flow shows 35 controls (was 46: top
  bar 7, was 10; palette 10, was 17); readability, overlaps and builds are unchanged; the minimap
  covers no node (was 1).
- `wave8/`: runs, binding, navigation (AFD-78..89). `proposals.md` is the proposals document
  wave 8 started from (written by another agent for 0.50.0); `review.md` checks each proposal
  against the code and records what wave 8 takes, defers or skips. `wave8-start/` is the baseline
  on 0.50.0; its `metrics.md` adds **Wave 8 measures**: the binding panel at its default width and
  the prompts before a real run.
- `wave8-usability/`: the usability test of wave 8, with a person instead of the harness: the
  protocol, the task cards, and per round the session's results and the findings (`round1.md`:
  SUS 30 on 0.50.0, which added a bug patch and group I to the wave). The kit
  (`just usability-kit`, `scripts/usability/`) sets up a session; the raw notes stay in
  `usability-sessions/`, which Git ignores.
- `wave9-usability/`: round 3, on the wave 9 build (AFD-99). It has 16 tasks in four parts, about
  90 minutes, half of them on parameters and settings. The kit runs it as variant C (`just
  usability-kit 3 c <vsix>`). `walkthrough-r3.md` is the walkthrough before the session; `round3.md`
  has the session's results (SUS 65) and findings R1-R13.
- `wave10/`: the measures after wave 10 (0.68.0, AFD-103..107), compared with `wave9/`. Its
  `walkthrough.md` checks round 3's findings on that build, and its README proposes round 4.
- `wave10-usability/`: round 4, on 0.68.1 (AFD-109). It has 10 tasks in three parts, about 45
  minutes, each a round 3 task whose finding wave 10 changed, plus two controls. The kit runs it as
  variant D (`just usability-kit 4 d <vsix>`). `walkthrough-r4.md` is the walkthrough before the
  session.
- `a11y-checklist.md`: the accessibility checks for each surface, with the baseline and wave 3
  results, the annotations (wave 6) and the first hour (wave 7).

Regenerate with `just ux-baseline <label>` (the harness in the installed Edge, fixed clock). After
a UI change, write a new label (for example `just ux-baseline wave3`) and compare it with
`baseline`. The Design, Code and Run shots come out byte-identical from run to run; the Data lens
shots do not (their wires and labels land a pixel apart between runs), so compare those by eye.

## Targets for the redesign (wave 3)

- Every node title at least 11 px on screen at the zoom a level opens with, for levels up to 25
  nodes at 1280×800.
- At least 60% fewer wire labels at rest.
- No label on a node, no overlapping labels.
- One model build per snapshot.
- Fewer steps for the eight tasks, and every task doable with the keyboard only.
- Every item of the accessibility checklist passing in light, dark and high contrast.

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
- `a11y-checklist.md`: the accessibility checks for each surface, with the baseline result.

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

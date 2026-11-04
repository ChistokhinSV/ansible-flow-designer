# Round 2 walkthrough (Claude, 0.59.2, variant B)

The same cognitive walkthrough as round 1 (`walkthrough-r1.md`), on the wave 8 build with variant
B's names. It is an expert review, not a user test. Evidence:

- the code at 0.59.2;
- the checks made in the webview harness while each ticket was built (AFD-87 lens fold, AFD-88 snap
  and drop on a wire);
- the integration tests (live runs, the launch dialog, outside edits, Peek Code);
- the kit's dry run on variant B (below).

Severity is Nielsen's 0-4, as in round 1.

## Round 1's findings on 0.59.2

| ID  | Task | Round 1 (sev)                                                   | On 0.59.2                                                                                                                                                                          | Sev now |
| --- | ---- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| W1  | T1   | Nothing offers the next step; the palette adds it unwired (2)   | A palette step dropped on the Start → Done wire goes into it, and the wire lights while dragging over it (AFD-88). A click on the palette still adds the step unwired, mid-canvas. | 1       |
| W2  | T2   | First Configure field 1099 px down (3)                          | Configure comes first once a module is chosen; the first field is 176 px down a 762 px panel (AFD-80).                                                                             | 0       |
| W3  | T2   | `line` hidden in a native select (2)                            | The parameter picker searches by name, alias and description (AFD-80).                                                                                                             | 0       |
| W4  | T2   | An unsaved binding is lost without a word (3)                   | Hiding the panel, the lens tab and turning a lens on ask first or keep the Details (AFD-80).                                                                                       | 0       |
| W5  | T3   | Stop Flow is under Other Choices (1)                            | Unchanged: not in wave 8.                                                                                                                                                          | 1       |
| W6  | T4   | The hosts box offers localhost only (2)                         | The launch dialog has the inventory groups as buttons and counts the matched hosts again as the targets change (AFD-82, AFD-83).                                                   | 0       |
| W7  | T4   | The run shows only at the end, the terminal takes the space (3) | The canvas switches to Run mode and follows the run as it goes; the terminal stays quiet while the designer is open (AFD-81).                                                      | 0       |
| W8  | T4   | Which step failed for which host: doable after W7 (1)           | As before, plus per-host output in the Run tab (AFD-81).                                                                                                                           | 0       |
| W9  | T5   | Five prompts; a box says only the input's name and type (2)     | One dialog with every input. What an input is for is still not shown: flows have no input descriptions yet (deferred in AFD-82).                                                   | 1       |
| W10 | T5   | A comma-separated list is passed as one string (3)              | Comma-separated lists and YAML dicts parse, and the dialog shows what they read as (AFD-82).                                                                                       | 0       |
| W11 | T6   | No way to list unimplemented steps or approvals (3)             | `has:no-binding` and `type:approval` list them on every level (AFD-86, AFD-89); Readiness counts open Find.                                                                        | 0       |
| W12 | T7   | Problems only for open flows; the Flows view a flat list (3)    | The Flows view gives each flow's problems and code state, by folder; the flow panel links to it (AFD-86, AFD-89).                                                                  | 0       |
| W13 | T8   | No way from the notification to the canvas (2)                  | One line with Show on Canvas; the run panel lists the scenarios and who ended elsewhere; end nodes show expected against ended (AFD-84).                                           | 0       |
| W14 | T9   | A step's Details show no lens finding (2)                       | A fold with the step's findings, their fixes and Accept with Reason… (AFD-87).                                                                                                     | 0       |
| W15 | T10  | No align or distribute (2)                                      | Align Centers and Distribute Vertically on a selection; guides and snap while dragging (AFD-88).                                                                                   | 0       |
| W16 | T11  | The agent's edit leaves no mark (3)                             | Steps and wires changed outside the designer are dashed, with a note offering Show and Clear; a subflow with a changed step inside has a thin outline (AFD-85).                    | 0       |

## New on 0.59.2

| ID  | Task | Step where the walkthrough fails                                                                                                                                                                                                                                                                                                                                 | Question | Sev |
| --- | ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --- |
| X1  | T6   | The Find box's offers are filter syntax (`has:no-binding`, `type:approval`). A newcomer has to guess that `has:no-binding` means "not implemented yet". Fixed before round 2: each offer has a tooltip in words (AFD-89).                                                                                                                                        | 2        | 1   |
| X2  | T7   | The Flows View link is the last line of the flow panel, under the inputs and Readiness; on a flow with many inputs it is below the fold. The Activity Bar icon is the other way in.                                                                                                                                                                              | 1        | 1   |
| X3  | T10  | Align and Distribute need several steps selected. The flow panel's hint says how (Ctrl+click, Shift+drag), but only while nothing is selected, and only from two steps up.                                                                                                                                                                                       | 1        | 1   |
| X4  | T9   | The lens fold sits between the step's problems and its tabs. On a step with several problems at 340 px, the tabs move down the panel. The fold closes once every finding is accepted.                                                                                                                                                                            | 4        | 1   |
| X5  | T4   | A check run's dialog still starts the host list at `localhost`, the skeleton suggestion (`inputSuggestion`), unless the flow remembers other hosts. The groups are buttons beside it and the matched count says "1 host", but Run is one click from the wrong hosts, as in round 1's first T4 run. Whether a check run should start empty is a product decision. | 3        | 2   |

## What the walkthrough cannot judge

- **Speed:** the perf gate failed under load on every wave 8 ticket (CPU 70-91%, another heavy
  application and two VMs running). An A/B against AFD-85 under the same load failed the same
  way, so the code is not the cause, but no wave 8 number is measured on an idle PC yet.
- **Concepts:** round 1 showed the walkthrough misses what a newcomer does not know (lenses, modes,
  inventory). Round 2's session is the test of group I.

## Kit dry run (variant B)

`just usability-kit 2 b out/ansible-flow-designer-0.59.1.vsix --no-launch`, then `just usability
verify`, `solve` and `verify` again. The kit builds the workspace with the repository's flow code,
which 0.59.2 does not change (it only moves the flow panel's Flows View link):

- **Fresh workspace:** every task fails or waits for review.
  - ACL audit has its error (`edge-bad-port`, a wire to a port that does not exist); the other flows
    have none.
  - Syslog baseline's failed_hosts are not wired (T3's fault).
  - T9 sees become on both steps and no acceptance.
  - T10 sees the three steps unaligned and unevenly spaced.
- **Solved (T1, T2, T3, T9, T10):** all five pass, the other nodes untouched in T10.
- **T6 on Edge router upgrade:**

  | Filter           | Lists                                                                  |
  | ---------------- | ---------------------------------------------------------------------- |
  | `has:no-binding` | exactly the 4 steps not implemented yet, each with its subflow         |
  | `type:approval`  | the 2 approvals                                                        |
  | `status:draft`   | 8 rows: the same 4 steps and the 4 subflows around them (hence AFD-89) |
- **Not covered:** T4, T5 and T8 need runs from VS Code; T6, T7 and T11 are typed answers. Round 1's
  dry run showed the planted run faults fire, and variant B only renames them.

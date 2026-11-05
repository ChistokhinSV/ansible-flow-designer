# Walkthrough of round 2's findings on 0.64.0

The cognitive walkthrough of the protocol (`docs/ux/wave8-usability/protocol.md`), run on the
wave 9 build against what usability round 2 found (`round2.md`, S1-S12) and what the walkthroughs
left open (W, X). It is an expert review, not a user test.

Evidence:

- the code at 0.64.0;
- the harness checks made while each ticket was built (the lens rows, the repository line and the
  Find summary, the launch dialog at 800×420, the palette click and the banner);
- the integration tests (marks for a closed flow, Problems for a closed flow, the hand-edit
  warning).

Severity is Nielsen's 0-4.

## Round 2's findings on 0.64.0

| ID  | Task | Round 2 (sev)                                     | On 0.64.0                                                                                                                                                                                                                                         | Sev now |
| --- | ---- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| S1  | T3   | The step's tooltip covers the port labels (2)     | No preview card while the pointer is on a port (AFD-96).                                                                                                                                                                                          | 0       |
| S2  | T4   | A group is a plain button (2)                     | "lab · 4", the hosts in the tooltip, under "Inventory groups" (AFD-95).                                                                                                                                                                           | 0       |
| S3  | T4   | A failed step's click loses the run's results (2) | "‹ Run Results" heads the step's Details in Run mode (AFD-96).                                                                                                                                                                                    | 0       |
| S4  | T4   | The Output label breaks over three lines (1)      | An icon button with the same name (AFD-96).                                                                                                                                                                                                       | 0       |
| S5  | T5   | A stale "devices is required" (2, bug)            | The hosts are counted as soon as a host list reads (AFD-91).                                                                                                                                                                                      | 0       |
| S6  | T5   | Run below the dialog's fold (2)                   | The buttons stay at the dialog's bottom (AFD-95).                                                                                                                                                                                                 | 0       |
| S7  | T6   | A filter's list does not say what it holds (1)    | "4 steps not implemented yet" over the results (AFD-93).                                                                                                                                                                                          | 0       |
| S8  | T7   | The Flows view was not reached (3)                | The Problems panel lists every flow; a hand-edited playbook says so; the flow panel names what the workspace's flows need, at its top when one does (AFD-93). The answer is now where P1 looked. Whether people read it is for a session to show. | 1       |
| S9  | T8   | The miss in keys; stub noise (2)                  | Ends by title in the panel, the table and the notification; "the scenario fails it in <step>" (AFD-94).                                                                                                                                           | 0       |
| S10 | T9   | Lens rows move under the pointer (3, bug)         | Place lines per list, not per level (AFD-91).                                                                                                                                                                                                     | 0       |
| S11 | T9   | Hovering a nested step dims everything (1)        | Its subflow lights (AFD-91).                                                                                                                                                                                                                      | 0       |
| S12 | T11  | No marks for a flow edited while closed (3)       | Marked against what the designer last showed, "since you last had this flow open" (AFD-92).                                                                                                                                                       | 0       |

## The walkthroughs' leftovers

| ID  | Finding                                          | On 0.64.0                                                                                                 | Sev now |
| --- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | ------- |
| W1  | A palette click adds the step unwired            | After the selected step, wired; onto Start → Done on an empty level; placed as before otherwise (AFD-96). | 0       |
| W5  | Stop Flow only under Other Choices               | One of the banner's buttons (AFD-96).                                                                     | 0       |
| W9  | An input does not say what it is for             | Input descriptions in the dialog, the prompts and the AWX survey (AFD-95).                                | 0       |
| X1  | Filter syntax to guess                           | Tooltips (AFD-89) and the result line (AFD-93).                                                           | 0       |
| X2  | The Flows View link low in the panel             | The workspace's line at the top when a flow needs a look (AFD-93).                                        | 0       |
| X3  | The multi-select hint only with nothing selected | Also in a step's Details on a level of 3+ steps (AFD-96).                                                 | 0       |
| X4  | The lens fold pushes the tabs down               | Under the tabs (AFD-96).                                                                                  | 0       |
| X5  | A check run's hosts start at localhost           | Empty when the inventory has groups, the product owner's decision (AFD-95).                               | 0       |

## New on 0.64.0

| ID  | Where         | What the walkthrough sees                                                                                                                                                      | Sev |
| --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --- |
| Y1  | Problems      | A workspace with many old or broken flows now fills the Problems panel at start-up. `afd.problems.scope: open` keeps it to open flows, but nothing points to that setting.     | 1   |
| Y2  | Outside marks | A Git checkout that changes a flow marks every step it touched when the flow opens (the product owner's decision). On a large change the note says so in one line, with Clear. | 1   |
| Y3  | Launch dialog | With groups, the dialog opens with no hosts and Run disabled until one is picked. The facts say why ("Pick the hosts to run on"), but a newcomer may first look at Run.        | 1   |
| Y4  | Palette       | With nothing selected on a level with steps, a click still adds the step unwired, by design. The drop on a wire and Add Next Node are the wired ways.                          | 0   |

## For a round 3

These come from round 2's analysis (`round2.md`, For round 3) and are not done yet:

- **Runner:** T11's text before Start names the flow and says to open it in the designer and keep
  its tab. Since AFD-92 a closed flow is marked too, so the task now works either way. The text still
  helps the timing.
- **Verifier:** T8 checks which end is "ended" and which is "expected".
- **Participant:** someone new to the product. P1 has done both rounds.

# Wave 8: review of the proposals

`proposals.md` (written by another agent for 0.50.0) lists 10 friction points and 20 proposals. Each
claim was checked against the 0.50.0 code (2026-11-03). The product owner chose all eight groups
that hold up; this page records what wave 8 takes, what it leaves and why.

## Taken (wave 8 groups)

| Group | Proposals | What the code does today                                                                                                                                                                                                                           | Ticket |
| ----- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| C     | 2.1, 2.2  | Up to 20 search results sit above the docs even when a module is bound; optional parameters only through a native select. An unsaved binding is lost without a word when the side panel is hidden, the lens tab is clicked or a lens is turned on. | AFD-79 |
| A     | 1.1, 1.3  | A local run reads `events.jsonl` only after the process ends; until then every node reads "waiting". The terminal opens every time. Per-host output is the first failure message only.                                                             | AFD-80 |
| B     | 1.2       | A real run with three inputs asks four or five times: one box per input, the confirmation, the vault password.                                                                                                                                     | AFD-81 |
| E     | 4.1       | Scenario results are a notification and log lines; ADR-0026 lists results on the canvas as not yet done.                                                                                                                                           | AFD-82 |
| H     | 7.1       | An edit from an agent, the text editor or the disk rebuilds the canvas with no trace of what changed.                                                                                                                                              | AFD-83 |
| D     | 5.1, 5.2  | The Flows view is a flat list with no problems, code state or item actions; Find matches words in titles, keys and modules only.                                                                                                                   | AFD-84 |
| F     | 6.1       | Selecting a step leaves the lens tab (ADR-0024, on purpose), loses its scroll position, and Details shows no lens finding of that step.                                                                                                            | AFD-85 |
| G     | 3.1       | No align or distribute; Tidy Up moves every node of the level; Reset Position exists for agents only.                                                                                                                                              | AFD-86 |

## Claims that did not hold

- **Tidy Up after adding nodes (friction 4).** New nodes are placed around the hand-placed ones
  (ADR-0002), so adding two steps never needs Tidy Up. What is missing is arranging a few nodes
  (group G).
- **Full module docs in the way (friction 3).** The docs are already short: the first line, six
  parameters, the first example, a link to the full page. The search results above them push
  Configure down (group C).
- **Only a spinner during a run (friction 1).** A local run shows no spinner at all; the run button
  turns into Stop and the nodes read "waiting". AWX runs already update every 2 seconds.
- **Prompt order (friction 2).** The confirmation comes before the vault password, not after it.
- **Wire snapping (3.2).** React Flow's default connection radius of 20 px already applies.

## Skipped

| Proposal                           | Why                                                                                                      |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------- |
| 1.4 Approve in VS Code             | The product owner's decision in ADR-0016: no approve or deny from VS Code.                               |
| 2.4 Bindings saved as you type     | ADR-0024 keeps a binding staged until Save; wave 8 fixes the exits that lose it instead (group C).       |
| 3.2 Magnetic wire snapping         | Already there (20 px); the port hit areas are padded too.                                                |
| 3.3 A subflow opened in place      | ADR-0010 keeps one level on the canvas; the hover card lists a subflow's steps.                          |
| 3.4 Buttons over the selected node | A summary card like it was removed in AFD-43; it adds controls the first screen does without (ADR-0029). |
| 7.2 Ctrl+K AI command bar          | The chat route (AFD-27) already sends a request with the flow to the AI assistant.                       |

## Deferred

| Proposal                         | Why                                                                                          |
| -------------------------------- | -------------------------------------------------------------------------------------------- |
| 2.3 Jinja filters in input chips | Chips are `{{ name }}` only (`core/flow/jinja.ts`); filters and paths need a new chip model. |
| 4.2 Scenarios built by clicking  | Needs E first, and a scenario editor.                                                        |
| 6.2 Accept several findings      | ADR-0014 asks for a reason per finding; one reason for many needs a decision first.          |

## Also found

- Show Terminal focuses the terminal panel, not the run's own terminal (fixed in group A).
- Dragging the side panel stops at 720 px, so the three-column binding layout (from 900 px) shows
  only when Expanded, and not at all in a window narrower than about 1125 px (fixed in group C).
- Comments out of date: `core/flow/jinja.ts` (attribute chips), `panels/LensPanel.tsx` ("left
  panel"), `14-node-properties-page.css` ("or dragged wide").

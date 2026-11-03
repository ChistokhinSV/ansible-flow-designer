# Core tasks and the first hour: wave 7 (0.49.0)

Counted on 0.49.0 against `../wave7-start` (0.45.0): pointer actions and key presses, and typing a
name or a value counts as one step.

## The first hour (new in wave 7)

| Task                                                 | 0.45.0                                                                                                     | 0.49.0                                                                                                                                                                       |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Find a way in, in an empty window                    | the Command Palette or the Welcome page only; New Flow with no folder ended in an error                    | the **Ansible Flows** icon: Open Folder, then New Flow, Open Sample Flow, Get Started                                                                                        |
| New flow → see its first playbook                    | 10: Ctrl+Shift+P, type "New Flow", Enter, the name, Enter, Add a Step, the title, Enter, Ctrl+S, Peek Code | 9: the Ansible Flows icon, New Flow, the name, Enter, Add a Step, the title, Enter, Ctrl+S, Peek Code (or the checklist's Show Me, which offers Generate Code before a save) |
| Handle the first failure                             | 3: Show on the banner (it selects the step), click the amber port, a pattern                               | 1: the pattern button on the banner                                                                                                                                          |
| First skeleton run, Ansible environment set          | 3: Run as Skeleton, type the hosts, Enter                                                                  | 2: Run as Skeleton, Enter on the suggested `localhost`                                                                                                                       |
| First skeleton run on native Windows, nothing set up | a dead end: an error naming a setting; the image had to be known                                           | 6: Run as Skeleton, Set Up Ansible Environment…, Docker, Enter on the proposed image, Run as Skeleton, Enter (the first run pulls the image)                                 |
| Know what to do next                                 | nothing after the empty-level card                                                                         | the Your first flow checklist (four items, each with Show Me); "?" beside the Details tabs and panel titles                                                                  |

## The eight core tasks

| #   | Task                                 | Wave 3 (0.27.3) → wave 7 (0.49.0)                                                                                                                                                          |
| --- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Add a step after another             | 4 → 4: select, N, the title, Enter. On a step that already leads on, the new one now goes onto that wire, not off `always`                                                                 |
| 2   | Wire a failure path                  | 2 → 2 (1 from the banner: its pattern button)                                                                                                                                              |
| 3   | Bind a module and set two parameters | 9 → 9                                                                                                                                                                                      |
| 4   | Set become and serial on a step      | 4 → 6 the first time: the Privilege and Targeting groups are folds, closed while nothing in them is set; each stays open afterwards (the viewer's choice is kept), so 4 again from then on |
| 5   | Edit a step inside a subflow         | 3 → 3                                                                                                                                                                                      |
| 6   | Accept an open port with a reason    | 4 → 3 from the banner (Accept with Reason…, the reason, Accept); 4 from the port                                                                                                           |
| 7   | Run a check and find the failed step | 4 → 4: Run as Skeleton, Enter on the inputs (on a first run it now suggests `localhost` instead of an empty box), Run mode, the step under Failed steps                                    |
| 8   | Find a step by name                  | 3 → 3                                                                                                                                                                                      |

Every task stays doable with the keyboard only: folds are native `<details>` (Tab to the summary,
Enter or Space), and the banner's choices and the checklist's Show Me are buttons.

The one cost: task 4 takes two more clicks the first time, because the Execution groups fold.
That is the trade ADR-0029 makes, so that a newcomer sees four lines instead of eleven fields.

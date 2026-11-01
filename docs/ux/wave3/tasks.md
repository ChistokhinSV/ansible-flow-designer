# Core tasks: wave 3 (0.27.3)

The eight tasks of the baseline (`../baseline/tasks.md`), counted again on 0.27.3: pointer actions and
key presses, typing a name counts as one step. "Keyboard only" gives the keys.

| #   | Task                                 | Steps (pointer), baseline → wave 3                                                                                                                                         | Keyboard only, baseline → wave 3                                                                                                 |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Add a step after another             | 4 → 4: click the node, N (or the `ok_hosts` port, _Add Next Node…_), type the title, Enter                                                                                 | yes (6) → yes (4): Tab to the node, N, type, Enter                                                                               |
| 2   | Wire a failure path                  | 2 → 2: click the open fail port, pick a pattern                                                                                                                            | yes (4) → yes (4): on the selected node Tab to the port, Enter, the pattern, Enter                                               |
| 3   | Bind a module and set two parameters | 9 → 9: select, _Binding_ tab, type a search, pick the result, **+** on parameter 1 in the docs, set it, the same for parameter 2, _Save Binding_; the canvas stays in view | partly → yes: Enter into the Details, the arrow keys to _Binding_, Tab to the search and results, **+** on a docs row with Enter |
| 4   | Set become and serial on a step      | 5 → 4: select, _Execution_ tab, tick become (Privilege), type serial (Targeting)                                                                                           | yes → yes: Enter, the arrow keys to _Execution_, Tab, Space, Tab, type                                                           |
| 5   | Edit a step inside a subflow         | 3 → 3: double-click the subflow, select the step, edit in the Details (or Ctrl+F, the name, Enter)                                                                         | yes → yes: Ctrl+F, the name, Enter opens it where it is, Esc, Enter into its Details                                             |
| 6   | Accept an open port with a reason    | 4 → 4: click the port, _Accept with Reason…_, type the reason, _Accept_; one dialog for every reason                                                                       | yes → yes: Tab to the port, Enter, _Accept with Reason…_, type, Enter; the focus comes back to the port                          |
| 7   | Run a check and find the failed step | 3 + a search of the canvas and each subflow → 4: _Run as Skeleton_, Enter on the inputs prompt, _Run_ mode, click the step under _Failed steps_                            | partly → yes: Ctrl+F5, Enter, Alt+3, Tab to _Failed steps_, Enter                                                                |
| 8   | Find a step by name                  | no direct way → 3: Ctrl+F, type the name, Enter (on any level)                                                                                                             | no → yes (3)                                                                                                                     |

Pick mode ("Connect to Another Node…", "Rewire…") now ends from the keyboard too: Tab or the arrow
keys show a node, Enter wires it.

Not counted here, and still to check by hand in a VS Code window: real key presses reach the page
only with a real keyboard (Ctrl+A, Alt+1/2/3, Ctrl+F, Tab into ports). The jsdom checks in
`test/unit/webview/a11y.test.tsx` and `navigation.test.tsx` and the harness cover the page side.

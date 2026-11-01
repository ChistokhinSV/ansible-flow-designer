# Review what the agent did

- The **canvas** shows the change at once; **Ctrl+Z** undoes a Copilot edit in one step.
- Terminal agents write the file like a save: `flow.version` moves once per commit, and
  `generated/` is refreshed. Use `git diff` to review, and Git to undo.
- The agent's answer lists the nodes it created, the problems the edit added or solved, and
  anything it did besides what was asked (a subflow output it lifted, the end a pattern used).
- **Check Flow** (top bar "…" menu) or the Problems panel lists what is left. Each problem
  names its fix.

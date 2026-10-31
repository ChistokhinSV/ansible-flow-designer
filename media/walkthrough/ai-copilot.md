# Copilot is ready

Nothing to install. In Copilot's **agent mode** the extension adds:

- the `ansible-flow` skill, loaded when you ask about Ansible flows;
- instructions for `*.flow.yaml` files;
- seven tools: `#flowList`, `#flowDescribe`, `#flowValidate`, `#flowReference`, `#flowEdit`,
  `#flowNew`, `#flowCompleteIds`.

Every edit asks for confirmation and is **one undo step** in the designer. When the file had no
unsaved changes, it is saved, so `generated/` follows.

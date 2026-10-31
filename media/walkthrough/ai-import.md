# Import playbooks with an assistant

Right-click a playbook or a folder → **Import Ansible Playbooks…** → **With an AI assistant**.
Copilot Chat opens with the prompt ready to send; for Claude Code, Codex and others it is on the
clipboard to paste.

The assistant:
- reads the playbooks with `source_outline`: plays, blocks, roles, handlers, variables, and for
  every task the exact module, parameters and keywords;
- groups the tasks into a few subflows by purpose (pre-checks, the change, verification, rollback);
- keeps failure handling where the playbooks have it, and leaves the rest open;
- validates the flow and reports what it grouped, changed or left out.

You can also just ask:

> Turn `site.yml` into a flow, grouped by purpose.

> Import `site.yml` as is.

An exact copy (`flow_import`) keeps one step per task. Secrets are only ever imported by name.

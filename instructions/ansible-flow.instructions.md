---
applyTo: '**/*.flow.yaml'
---

This file is an Ansible flow (Ansible Flow Designer): a diagram of typed nodes wired port to port.

- Prefer the flow tools (`#flowDescribe`, `#flowEdit`, `#flowValidate`) over editing the YAML; they
  name nodes by key and keep the file valid. The `ansible-flow` skill explains the format.
- When editing the YAML by hand: never write `id:` values or ULIDs; name nodes by key in wires and
  references, then run **Complete IDs** (designer banner or the quick fix).
- One wire per output port; wires stay on one level; handle every fail port (wire it or leave it
  open on purpose with a reason); never set `status: tested`.
- Put the steps of one purpose (pre-checks, backup, change, verify, rollback) in a subflow, not one
  long chain. When an edit grows a level past 8 steps, `#flowEdit`'s answer hints; group them with
  `extract_subflow`.
- Steps read data through inputs (`from:`), including parameters, `assert` `that:` and decision
  conditions; inside a subflow `<subflow>.<input>` reads its input. Inputs are play vars: a fact
  of the same name set earlier wins. Repository paths: `{{ afd_repo_root }}/...`.
- Notes, sections and text (`annotate` in `#flowEdit`, format 2) explain the flow and never run;
  a note on a node becomes a comment above its code. Add a note without being asked for a reason
  the user gave that the flow cannot show (a limit, why this order, a manual step, a runbook link);
  not on every node, and not to repeat what the node shows. A section around steps of one level
  that belong together but are not a subflow: `around: [keys]` sizes it to hold them. On a format
  1 flow, only when asked.
- For a draw.io file or an image of a flow use `#flowExport`, not a drawing by hand.
- To import playbooks, roles or AWX templates, read them with `#sourceOutline` and build the flow by
  intent (copying each task's `impl`); `#flowImport` only for an exact copy.
- Scenario tests (`<key>.scenarios.yaml`) say which hosts fail where and where each must end. Use
  `#flowScenarios` to list, check, add, update or verify them; after changing a flow's wiring,
  check its scenarios.
- Do not change `flow.version` or files under `generated/`. Leave positions out unless asked: the
  canvas places nodes; to arrange them use `position` on `add_node`, `move` or `unplace`.

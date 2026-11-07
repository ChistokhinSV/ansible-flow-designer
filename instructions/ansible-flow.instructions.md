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
- Steps read data through inputs (`from:`), including parameters, `assert` `that:` and decision
  conditions; inside a subflow `<subflow>.<input>` reads its input.
- For a draw.io file or an image of a flow use `#flowExport`, not a drawing by hand.
- To import playbooks, roles or AWX templates, read them with `#sourceOutline` and build the flow by
  intent (copying each task's `impl`); `#flowImport` only for an exact copy.
- Scenario tests (`<key>.scenarios.yaml`) say which hosts fail where and where each must end. Use
  `#flowScenarios` to list, check, add, update or verify them; after changing a flow's wiring,
  check its scenarios.
- Do not change `flow.version` or files under `generated/`. Leave positions out unless asked: the
  canvas places nodes; to arrange them use `position` on `add_node`, `move` or `unplace`.

# ADR-0038: Where a value comes from, as a chain of hops

- Status: accepted (2026-11-20, AFD-339; research in AFD-338)
- Context: a step reads a value through an input, a `from:` path or a `{{ name }}` in a parameter.
  The designer knew each link (`resolveFrom`, `factSource`, `refChoices`) but showed one at a time:
  the Details row said `← "Check version" · version` and stopped there. A user who wanted to know
  what a step gets had to walk the chain by hand: through subflow inputs, lifted outputs, the
  register of a module step, a set_fact that templates another variable, a flow input's default.

## Decision

- **One pure function answers it** (`core/flow/origin.ts`): `inputOrigin`, `fromOrigin`,
  `nameOrigin` and `flowInputOrigin` return an `Origin`: a list of hops, precedence notes, and
  whether the chain is secret. The designer's tooltips, the Details rows, the Data lens and
  `flow_describe` render the same answer; the server's embedded viewer gets it for free.
- **A hop** is `{kind, label, name, path, node?, depth, value?, fallback?, template?, static,
  secret?, doc?}` plus `file?`, `line?` and `rank?`, which phase 1 never sets. Phase 2 (repository
  variables, AFD-340) adds kinds such as group_vars or role defaults with a file, a line and a
  precedence rank; callers render whatever hops come, so they do not change.
- **Kinds in phase 1:** node input, subflow input, flow input (asked when the run starts, with its
  default), upstream output, output lifted from an inner step, registered result (with the result
  field's doc from the catalog when the caller passes `fieldsOf`), set_fact, set by a role or
  playbook when it runs, placeholder of an unbound step, external var (`flow.external_vars`),
  Ansible magic var, unknown.
- **Values:** a literal (an input's default, a set_fact literal, a flow input's default) is shown
  as one line of YAML, cut in the middle past 80 characters. A templated value shows its template
  and each variable it reads becomes a deeper hop (`depth + 1`), resolved as read by that step.
  Nothing is rendered: only Ansible evaluates Jinja.
- **Limits:** a cycle guard per hop (node and name) and at most 24 hops; a cut chain says so.
- **Secrets:** a chain is secret when any hop's name looks secret (the import rules' `SECRET`),
  a value holds a vault or AWX secret, or a step on the chain has `no_log`. A secret chain carries
  no values, defaults or templates at all, on any hop: a variable a secret template reads would
  otherwise show the secret's parts.
- **Precedence notes** only where the flow already knows them: the validator's `input-shadowed`
  and `register-collision` findings for that input (when the caller passes the findings), a flow
  input or external var of the input's own name (an extra var wins over the play var an input is
  generated as), and a same-name read with a default (AFD-293: the host's own variable wins over
  the default).
- **Unknown is said, not guessed:** a name the flow does not set reads "not set in this flow:
  decided at run time (inventory, group_vars, facts or extra vars)". Phase 2 replaces that hop
  with what the repository holds.

## Consequences

- The webview needs the model and the node under the pointer: Details provides them through a
  React context, and the Jinja fields ask the origin through `CompleteContext.origin`.
- A click on a hop with a node selects that node and opens its Details (the same on the server).
- `flow_describe` with `nodes` adds one `origins:` line per node (each input's chain in short); the
  whole-flow answer stays as it was, to keep its size.

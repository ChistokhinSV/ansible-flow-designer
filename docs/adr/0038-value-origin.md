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

## Phase 2: the repository's variables (AFD-340, 2026-11-20)

- **An index, built by the host** (`core/inventory/varIndex.ts`, `buildVarIndex`): pure apart
  from the file interface the inventory uses (`InventoryFs`), so VS Code (from the workspace),
  the MCP tools (from Node's file system) and later Ansible Flow Server build the same index. It
  reads the inventory's own files (inline group and host variables), `group_vars/` and
  `host_vars/` beside the inventory and at the repository root, the `defaults`, `vars` and
  `meta/argument_specs` of the roles the flow's steps run (`roles/`, `roles_path`, a collection
  in the repository), and the literal `vars_files` and `include_vars` of the playbooks and task
  files the steps run. At most 400 files and 2 seconds; a cut index says so.
- **The index is plain JSON:** each definition is `{name, scope, file, line, rank, value?,
  template?, secret?, doc?}`, plus the static inventory's groups (parents, hosts, priority) and
  hosts. The host sends it to the designer in a `varIndex` message (`openFiles` when it can open a
  file at a line). A secret (a vaulted value, a secret-looking name or value) is stored with no
  value at all, so nothing secret ever leaves the host.
- **Ranks** follow Ansible's precedence, restricted to what is known statically, lowest first:
  role default; the inventory file's group vars (`all`, then the other groups); group_vars of
  `all` beside the inventory, then at the root; the other groups' group_vars beside the inventory,
  then at the root (Ansible's default `precedence` setting: inventory-file groups, then vars
  plugins; the root's are loaded by `afd_repo_vars` as a playbook's, AFD-291); the inventory
  file's host vars; host_vars beside the inventory, then at the root; play var (node inputs);
  play vars_files; role var; include_vars; set_fact and register; role param; extra var (flow
  inputs, external_vars). Among groups of one rank, Ansible's order: depth, then
  `ansible_group_priority` (when written as a number), then name; the later one wins. A rank is
  shown as a word (`rankWord`), never a number. An argument_specs option is documentation: Ansible
  does not set its default, so it never wins.
- **Who sees what:** the inventory's variables, every step; a role's defaults and vars, the step
  that runs it; vars_files, the step that runs that playbook; include_vars, that step and every
  step after it (they stay with the host).
- **A winner only when certain** (`repoAnswer`): for a picked host, the highest definition that
  applies to it; with no host, only when every definition applies to every host. Never with a
  dynamic inventory source, a cut index, a host the static files do not name, or an include_vars
  under a condition: the candidates are listed and the reason given.
- **In the chain:** the `unknown` hop ("decided at run time") becomes the winner as a hop with
  file, line and rank (a templated winner's variables follow one level deeper), or says the value
  depends on the host. `Origin.defined` lists every definition of the asked name, highest first,
  the winner marked and other hosts' dimmed. Notes compare the flow's own rank with the
  repository's: an input (a play var) against group or host vars, a role var or include_vars that
  ranks above an input, a role param of the same name, the host's own value against a same-name
  read's default.
- **Finding `input-hides-inventory`** (info): an input with a default and no `from:` while the
  inventory sets the same name. The validator has no repository, so the host adds it
  (`repoFindings`) next to the validator's findings when it has the index.
- **Host picked:** the Details' Data section has a host picker (the index's hosts); the
  Inventory view's selected host is sent to the designer too. The tooltips use the host picked.
- **Without an index** (Ansible Flow Server's pages until phase 4, AFD-342) everything answers
  as in phase 1.

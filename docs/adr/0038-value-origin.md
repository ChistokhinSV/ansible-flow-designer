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

## Phase 3: the value a host had in a run (AFD-341, 2026-11-21)

- **Context:** the chain says where a value comes from and, when the flow or the repository states
  it, what it is. What a host really got is known only when the step runs: facts, a dynamic
  inventory, extra vars, an upstream step's result.
- **Recording, by Ansible:** each step with inputs gets one task before its own, `[<key>] record
  inputs`, a `set_fact` of `afd_inputs` to a dict of the step's inputs (the play vars it gets, so
  exactly what the step sees, per host, rendered by Ansible; the designer evaluates nothing). Only
  the step's own inputs, not hostvars or facts in general. Not in scenario builds (`stubAll`), not
  for playbook bindings (`import_playbook` takes no task), not for decision, approval, parallel
  and join nodes (no inputs of their own to record). The task has `ignore_errors: true`: recording
  never changes a run. The afd_events callback turns its result into an `inputs` event and writes
  no task result for it, so it shows in no host's Output and counts in no routing.
- **Event format:** `{"event": "inputs", "host", "node", "task", "inputs": {<name>: {"value": <JSON>}
  | {"value": "<cut JSON text>", "cut": <length>} | {"missing": "secret" | "undefined" | "limit"}}}`.
  The start event carries `record_inputs: true|false`. The run summary keeps them as
  `RunSummary.inputs[node][host][name]` (`RecordedInput`) and `inputsOff`; a run before this
  version has neither, and the view says the run did not record values.
- **Never recorded** (a placeholder `missing: "secret"`, so the reader knows, never a silent gap):
  - every input of a `no_log` step, an input with a secret-looking name, and one whose chain
    (phase 1) is secret: the generated task writes a constant marker and never renders them;
  - a value holding a vaulted value anywhere inside: a Jinja macro in the task walks dicts and
    lists with `vault_encrypted` (ansible-core before 2.22 hands the callback the plain text; 2.22
    masks it as `$REDACTED$`, which the callback also treats as secret);
  - a value holding one of the run's secret inputs or the vault password (the callback's
    `AFD_SECRETS_FILE` / `AFD_VAULT_FILE`, AFD-139);
  - inside a recorded dict, the value of a secret-looking key, at any depth, becomes `********`;
  - the run summary drops any value of a secret-looking name again, and the extension's
    `redact.ts` pass over events.jsonl applies to these events as to every other.
- **Size:** one value is at most 2000 characters of JSON; a longer one is cut in the middle and
  says how long it was. A run records at most 256 KB of values; past that, a value is
  `missing: "limit"` ("not recorded: the run's limit for values was reached").
  `AFD_RECORD_INPUTS_BUDGET` sets the budget (tests).
- **Switch, on by default:** `AFD_RECORD_INPUTS=0` in the run's environment turns it off: the task
  is skipped (`when` reads the variable on the controller) and the callback writes no `inputs`
  event, so no input value is in the events at all. The designer sets it from
  `afd.run.recordInputs` (default true); Ansible Flow Server from `AFS_RUN_RECORD_INPUTS` (default
  true), both through `RunFlowRequest.recordInputs`. Runs outside the designer (AWX) set the fact
  and, without our callback, record nothing.
- **Shown:** in Run mode, a step's Details › Data shows under each input **In this run**: the
  values, hosts with the same value together (four values, then "and N more"), or the value of the
  host picked (a **For host** picker of the run's hosts, outside the read-only fieldset). When the
  chain has a static, uncut value for that host (phase 1, or phase 2's winner for the host) and
  the run had another, it says "differs from what the flow/the repository predicted (value)". A
  variable's tooltip adds "In this run: value (host)" when one host is picked, or the run has one.
  The step's Run tab has an **Inputs of <host>** toggle per host row. The server's embedded viewer
  shows the same from the run summary; no extra API.
- **Not done:** values of a playbook binding's vars, of a role's own defaults it reads, and of
  facts. Phase 4 (AFD-342) gives the server the repository index, so "differs from what the
  repository predicted" works on the server too.

## Phase 4: the server's pages (AFD-342, 2026-11-21)

Ansible Flow Server embeds the designer as a viewer (a flow, a run, a flow at a commit) and as an
editor (a draft). Phase 2 already sent the index as a message, so the seam is mostly that message;
this phase closes what was missing for a host other than VS Code and gives the launch form its words.

- **The seam is the message.** A host posts `{type:'varIndex', index, openFiles}` (protocol, phase
  2); no new config key. Ansible Flow Server builds the index on the server from git (its own
  `InventoryFs` over the commit's tree) with `buildVarIndex` and the flow's `indexInputs`, and posts
  it from its page. `openFiles: true` when the page handles `openCode {path, line}` (1-based).
- **`openCode` is a viewer message now** (`VIEWER_MESSAGES`, and `PAST_MESSAGES` for later use):
  opening a definition's file reads, it changes nothing. Before, the viewer dropped it, so a hop's
  file:line could not open anything on the server's pages.
- **The host picker in a read-only Details.** The viewer is always in Run mode, and Details there is
  a disabled fieldset. The Run mode picker (phase 3) showed only when the run recorded values, so a
  viewer before any run had no way to pick a host. Now: in Run mode without recorded values the
  picker lists the repository's hosts (`OriginHostPicker`); in a read-only Details outside Run mode
  (Code mode) the picker sits outside the fieldset too. The page need not send `originHost`.
- **`withRepoFindings(findings, model, index)`** (origin.ts): `quietRepoReads` plus `repoFindings` in
  one call, for a host that adds the repository's part to the snapshot it posts. Without an index it
  returns the findings unchanged.
- **`flowInputUse(model, name, {index})` / `flowInputUses(model, {index})`** (origin.ts), for a launch
  form: how a run gives the input (`asked`, from `flowInputOrigin`), its default (one line, never
  for a secret-looking name or value), `readBy` (the non-subflow steps whose input chain reaches the
  flow input, with that input, and those that read the name directly in their binding, keywords or
  condition), `overrides` (a flow input is an extra var: a step input of the same name not fed by it,
  and, with an index, every repository definition of the name below extra vars, highest first; file,
  line, rank, never a value), and `text`, one line: "Read by A (as x), B; default 30; wins over the
  default of input timeout of "Wait", group_vars of edge (inventory/group_vars/edge.yml:3)." Three
  names at most per list, then "and N more".
- **Choices:** subflow steps are not readers (the steps inside them are); a direct read is found by
  the names the binding and condition reference, not by a full walk (as the unknown-variable checks
  do); argument_specs defaults are documentation and are never "won over"; the targets input
  starts "The hosts the run starts on" (no step needs to read it, so no "No step reads it").

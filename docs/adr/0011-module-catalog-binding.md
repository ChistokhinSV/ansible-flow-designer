# ADR-0011 · Module catalog, node properties and binding

Status: Accepted · 2026-10-29 · AFD-8 (M5)

## Context

M5 turns draft nodes into real tasks (06, mockup 11). The engineer finds a module, role or playbook in the execution environment, reads its docs, configures it with input chips, and saves the binding. The generated code then has to pass data between nodes. Decision 5 put the catalog in SQLite FTS5 through `node:sqlite` in the extension host, with the probe only dumping docs. The gates are the predecessor's 20 intent queries (19 with every expected plugin in the top 5) and a p95 search latency under 50 ms.

The user decided on four points:
- the properties page is a full page over the canvas;
- edits are staged and written by "Save binding" as one edit;
- data passing between nodes is in M5;
- roles without `argument_specs` get free-form variables (spec generation not before M6).

## Decision

**`node:sqlite` spike (passed).**
- Desktop: Electron 43.7.3 (Node 24.21) in VS Code 1.140 and Electron 43.8.3 (Node 24.22) in 1.144.
- Remote server: Node 24.21 and 24.22.
- All have SQLite 3.53.4 with FTS5 and bm25.
- The MiniSearch fallback is not needed.

**Dump (probe).**
- `catalog(cache, jobs, only?)`:
  - runs `ansible-doc --metadata-dump --no-fail-on-errors <collection>` per installed collection, in a thread pool;
  - adds ansible.builtin with its runtime routing;
  - writes `<cache>/<core-minor>/<name>@<version>.json` (format 1) atomically;
  - dumps only versions it has not seen, and returns the manifest.
- A full ps-probe-env:2.19 takes 27.7 s the first time (93 collections, 10,065 plugins); later calls take about 2 s.
- Doc markup becomes plain text.
- Each plugin record has options with aliases, returns, examples, attributes (`check_mode`, `diff_mode`) and deprecation.
- Keywords come from ansible.builtin only.
- Routing (redirects, deprecations, tombstones) comes from each collection's `meta/runtime.yml` and the builtin runtime.
- `roles()` lists `roles_path` roles with their `meta/argument_specs.yml` entry points.
- The cache is global storage, mounted read-write into the container as `/afd-cache`. It is the container's only writable mount.

**Index (host).**
- A worker thread (`dist/catalogWorker.js`) builds `index-<hash>.db`. The hash covers the index schema, ansible-core and every `name@version`, so another EE or collection set gets its own file. The newest six are kept.
- The build takes about 3–4 s; in the worker it never blocks the extension host.
- Tables:
  - `plugins`: narrow rows with precomputed rerank texts;
  - `docs`: full JSON, separate, so searches never page through it;
  - `fts`: FTS5, contentless, `porter unicode61`, columns name / short / option names / body / collection with bm25 weights 10 / 6 / 3 / 1 / 2, set as the table's rank;
  - `df`: document frequency per stem, copied from `fts5vocab` at build time;
  - `routing`.
- The last index path per folder is kept in workspace state. Validation opens it without starting the probe; the next search checks the EE again.

**Search ranking.**
- Query words lose stop words. A type word (filter, lookup, test, keyword) becomes a type hint.
- Porter stems for the df lookup come from a scratch in-memory FTS5 table's `instance` vocabulary, so they are the index's own stems.
- Words in more than 50% of plugins are dropped, unless they are a plugin name ("create user" keeps `user`).
- Words in more than 12% are matched in name, summary and option names only. This is the p95 lever: bm25 runs over every match.
- Every word also prefix-matches the plugin's local name, not the collection, so "open" no longer matches every `openstack.*` module.
- Name candidates are added straight from the name index: each word, `a_b` for neighbouring words, and the abbreviations they run into ("ip address" → `ipaddr`).
- Additive rerank:
  - relative bm25, plus a name match (1.6 × √(covered words / words) for a spelled name, else partial word and prefix credit);
  - plus coverage of the query words in name, summary and option names, and in the prose (computed in SQL as bitmasks);
  - then multiplied by: ansible.builtin ×1.9; the named type ×2.5 (others ×0.6); inventory platforms ×2.2; collections in use by rank (grab bags ×1.15); another platform ×0.5 (dimmed); deprecated ×0.4.
- "Another platform" uses the inventory's `ansible_network_os`, or else the platform collections the repository already uses.
- Context comes from a scan of the repository: requirements files, FQCN task keys, flow bindings, and `ansible_network_os` in inventories and vars.
- Resolver: the play's collections, then ansible.builtin, then up to 5 redirect hops; a tombstone means removed.

**Gates.**
- `just test-catalog <dir>` on the full 2.19 dump: 20/20 intents (14/14 module-only), p95 29 ms. The p95 covers 3 passes after a warm-up pass, and the parsed files are freed before timing.
- Early runs had p95 over 200 ms. Causes: a name lookup without an index, docs in the searched rows, bm25 over common words, and prefix noise.

**Properties page (mockup 11).**
- A dialog over the canvas with tabs General, Implementation, Inputs and outputs, Ports, Execution.
- Implementation:
  - Find: Module / Role / Playbook. The search starts from the node's intent. Results carry badges (in EE, check mode, diff, read-only, other platform, deprecated) and chips for the environment and platform.
  - Understand: docs as text, the parameter table (6 rows, then "show more"), returns that can be toggled as node outputs, and an example.
  - Configure:
    - a form from the argument spec: bool, choice, list (one chip line per item), number, text, or YAML for dicts;
    - required and set parameters first, the rest under "More parameters";
    - the register name, and whether to expose it as a node output;
    - a checklist: required parameters, where each referenced variable comes from, check mode, deprecation, role spec, playbook targets;
    - the generated task.
- Roles without specs and playbooks get free-form variables.
- Chips (D-26):
  - the stored text is Jinja; `{{ name }}` shows as a purple chip;
  - `@`, typed or from the @ button, offers node inputs, flow inputs and upstream outputs;
  - choosing one that is not an input yet stages a new node input with its `from:`.
- A Jinja scanner (`core/flow/jinja.ts`) finds variable reads (not attributes, filters, kwargs, functions or literals). Renaming a node input rewrites the reads in `impl.params` in the same edit.
- "Save binding" sends `setBinding`: impl, staged inputs and outputs, and status in one edit and one undo step. A binding sets `implemented`; unbinding sets `specified`.

**Code generation with data (Option A).**
- Inputs `from: <key>.<output>[.path]` become play vars that read the upstream output's host variable:
  - `impl.register[.path]` reads the registered result;
  - anything else is a fact of the output's own name.
- `from: flow.<input>` reads the extra var.
- Same-name references are skipped (`x: "{{ x }}"` would recurse).
- Unbound nodes with outputs set typed placeholder facts (`set_fact`), so skeleton runs carry data.
- Playbook bindings emit `import_playbook` with `afd_hosts` set to the arriving hosts (plus params and input vars), then a play that routes the hosts still active to ok_hosts. Hosts that fail inside the playbook stop there. Refs are repository paths, so the generator gets the root relative to `generated/`.

**Validator.**
- Pure (core): `binding-unknown-var`: params read a variable that is not a node input. Flow inputs read directly are info only. Magic variables are allowed.
- With the catalog (host):
  - `binding-not-in-ee` (warning), `binding-removed` (error);
  - `binding-redirect` and `binding-no-check-mode` (info);
  - `binding-deprecated`, `binding-missing-param` and `binding-unknown-param` (warnings). Free-form modules are exempt from the unknown-parameter check.

## Consequences

- The catalog needs one probe call per folder and environment. The status reaches the page (loading, ready, error), and _Rebuild Module Catalog_ re-dumps.
- A playbook binding cannot route failed or unreachable hosts. The page explains this, and the validator still treats its fail ports like any other.
- Variable precedence: a fact (a registered result or a stub) of the same name as an input's play var wins over the play var. Inputs should not reuse another node's output names; the checklist shows where each variable comes from.
- M6 compares compiled plays with bindings (drift). Role spec generation can build on the free-form vars.

## Amendment: the Binding tab at the side panel's width (AFD-80, 2026-11-04)

Wave 8 group C, with evidence from usability round 1 (`docs/ux/wave8-usability/round1.md`, P2,
P14, P15). At the default 340 px, the first Configure field of a bound step was 1099 px down a
762 px panel, under the module search and the docs.

- **Order:** an unbound step shows Find alone. Once the draft has a ref, Configure comes first.
  Two folds follow (ADR-0029):
  - **Change module** holds Find. It renders lazily, so a closed fold runs no search. It opens by
    itself while the draft's ref differs from the saved one, while the module is missing from the
    environment, or on a finding that asks for another module (`CHANGE_MODULE_CODES`:
    not-in-ee, removed, redirect, deprecated).
  - **About** holds the docs, with Full Docs at its top.

  Expanded (`THREE_COLUMNS_PX`, 760), the three sit side by side with both folds open.
- **Configure** shows Required, then Optional (set, or added in this session).
  - The **parameter picker** (`properties/ParamPicker.tsx`, ARIA combobox) offers the rest by
    name, alias or description (`filterParams`), each with its first description line. It
    replaces the native select of bare names.
  - `paramGroups` and `filterParams` live in `core/catalog/draft.ts`.

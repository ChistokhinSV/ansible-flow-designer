# 07 · Lessons from Playbook Studio (verified knowledge to reuse)

Before this bundle, a predecessor project, **Playbook Studio** (`C:\HOME\1.SCRIPTS\122.ansible_playbook_studio`), built a read-only "Explorer" for existing Ansible repos as a local web app. It ran from 2026-10-27 to 2026-10-28 (R0 spikes + R1 milestones M0–M5, all committed).

It is **paused** in favour of this design. Its product goal differed (explain existing playbooks, edit them later), but most of the hard Ansible plumbing this designer needs was built there and verified against real ansible-core.

This document lists what is **known to work, measured, or known to break**, mapped to the decisions (D-xx) and milestones (06) of this bundle. Treat it as engineering input, not as product scope. Nothing here overrides 01–06.

All facts were verified on Windows 11 + Docker Desktop with:
- ansible-core **2.19.14 / 2.20.10 / 2.21.5** (`ansible` 14.5.0, 93 collections) in local images `ps-probe-env:2.19|2.20|2.21`
- Node 24, React 19.3, `@xyflow/react` 12.12, `yaml` 2.9.1, elkjs 0.12, Vite 8, Vitest 5, TypeScript 7
- Python 3.12+ with uv

Re-check versions before adding any dependency.

## 1. Ansible must answer Ansible questions: the "probe"

**Pattern (proven).** A small **stdlib-only Python program** runs *inside the target Ansible environment* (venv, EE container, WSL, SSH host) and answers questions with Ansible's own APIs:
- module docs
- inventory
- variables
- playbook loading
- template rendering

Never re-implement Ansible semantics in TypeScript. Re-implementing variable precedence was the top risk identified in v1 of that project.

- Code: `122…/probe/ps_probe/` (`__main__.py`, `serve.py`, `catalog.py`, `inventory.py`, `variables.py`). Syntax is limited to Python 3.9, and it ships as a zipapp (`.pyz`).
- **Long-lived session:** `ps_probe serve --root <repo>` reads JSON requests per line on stdin and writes `{id, result|error}` per line on stdout. The first line is `{"kind":"ready", ansible_core, python, root}`. One failing request never ends the session.
- **Launch modes**, from `core/playbook_studio/envs.py` (`Environment`, `ProbeSession`):
  - `docker:<image>`: `docker run -i --rm --name … --mount type=bind,source=<repo>,target=/work,readonly --mount <probe dir>:/probe:ro -e PYTHONPATH=/probe -w /work <image> python -m ps_probe serve --root /work`
  - `ssh:<host>`: copies the `.pyz` once per content hash; the repo is synced with `tar | ssh tar -x` into `~/.cache/…/projects/<id>/`, incrementally on file changes
  - `local:<python>`
  - Probe paths map back to repo paths with `to_repo_path()`.
- **Pitfalls found:**
  - **The protocol owns stdout.** Inside `serve`, set `sys.stdout = sys.stderr` and keep a private handle for responses. Ansible's `Display` and plugins print.
  - **Docker Desktop on Windows mounts are world-writable (0777), so Ansible silently ignores `./ansible.cfg`** ("world writable directory"). Set `ANSIBLE_CONFIG=<repo>/ansible.cfg` **before importing ansible**. Without it, `roles_path`, the default inventory, etc. are wrong.
  - For the same reason the exec bit means nothing on such mounts. Detect inventory scripts by a `#!` shebang.
  - `init_plugin_loader()` is required once before using plugin APIs outside the CLI (2.15+).
  - Ansible cannot be a control node on native Windows: a Windows user always needs Docker/Podman, WSL, SSH, or VS Code Remote (see 08).
- **Contract tests:** run the real probe in all three images. The pattern: `tests/python/test_probe_contract.py`, `test_probe_inventory.py`, `test_probe_variables.py`, marked `docker`. They caught real API differences between core versions.

## 2. Module documentation and search (D-24, D-25, M5)

The approach in 05 (`ansible-doc --json -t module <fqcn>` per module, or `--list`) is too slow at catalog scale. What worked:

| Approach | Result (93 collections, 9,656 plugins, 8,907 modules) |
|---|---|
| One `ansible-doc --metadata-dump` of everything | 257 s, 158 MB JSON. Too slow |
| `ansible-doc --metadata-dump --no-fail-on-errors <collection>`, **one process per collection in parallel** | **37 s** (20 jobs), 54 s (4 jobs) |
| Incremental: re-dump only collections whose version changed (key = env id + collection version) | seconds |

- **Normalize** the dump (internal ansible-core format) in the probe: `normalize_plugin` / `normalize_option` in `probe/ps_probe/catalog.py`. Keep options (type, required, default, choices, elements, aliases, suboptions), description, notes, requirements, attributes (**`attributes.check_mode.support`**, which gives the "check mode" badge D-25 needs), deprecated, examples, return. Keywords come with the `ansible.builtin` dump and include `applies_to` (Play / Role / Block / Task).
- **Routing tables are essential for binding and the Code lens.** ansible-core's `ansible/config/ansible_builtin_runtime.yml` redirects **3,757** legacy module names (`ios_config` → `cisco.ios.ios_config`). The collections' `meta/runtime.yml` add 762 redirects, 327 deprecations and **230 tombstones** (removed modules, e.g. `community.general.docker_image_facts`). 45 collections define `action_groups`; most network collections define none.
  - Resolution order: play/role `collections:` → local `library/` → ansible.builtin → builtin redirects → collection redirects (max 5 hops).
  - Spec and code: `122…/docs/adr/0009-module-resolution-and-routing.md`, `core/playbook_studio/catalog.py` (`_Resolver`).
- **Search by intent** (D-24 "ranked by intent text"): SQLite FTS5 with porter stemming and weighted bm25 over the name, short description, option names, description, options, examples and returns. On top of that:
  - a name bonus
  - **context boost:** collections the repo uses, or the inventory's `ansible_network_os`; the bonus shrinks for grab-bag collections like `community.general`
  - a deprecated penalty
  - **common-term pruning:** drop query words found in more than 50% of docs
  - "why it matched" snippets built in Python, not FTS `snippet()`, which cost 158 ms
  - Results: p95 **17 ms**. Quality on 20 intent queries: **11/20 → 19/20** with context. Code: `catalog.py`, bench in `scripts/catalog_bench.py`.
- "Similar modules" (`ios_vlans` ↔ `eos_vlans`): rarest shared option names + name stem, 6/6 in the top 3.
- **Doc markup:** Ansible docs use `C()`, `I()`, `O(fqcn#module:opt)`, `V()`, `L(text,url)`, `U()`, `RV()`, RST roles. Convert them to text (`web/apps/studio/src/markup.ts`, `core/playbook_studio/markup.py`). **Never render plugin docs as HTML**: they are third-party content. The predecessor had a DOMPurify advisory issue via Monaco's vendored copy.
- **Docs links:** `https://docs.ansible.com/projects/ansible/latest/collections/<ns>/<coll>/<name>_<type>.html`. The site moved in 2026; the old `/ansible/latest/` paths redirect.
- Plugin dependencies matter. The `netbox.netbox.nb_inventory` plugin failed in the stock image because **`pytz` was missing**. EE images must carry plugin Python deps, and the UI should show Ansible's per-plugin failure reasons.

## 3. Inventory (Inventory lens, D-18 / M8, D-08 host sets)

- Read inventories with **`InventoryManager` + `VariableManager` in the probe**. The graph then equals `ansible-inventory --list`; a contract test checks this on 2.19/2.20/2.21.
- `--list` omits empty groups; `--graph` shows them.
- `inv.get_hosts(pattern)` handles `routers:&core`, `all:!switches`, `sw*`, lists. Unknown names only produce a warning, so report them yourself (that is the "group not in inventory" check).
- **Templated `hosts:`** (e.g. the skeleton's `"{{ devices | join(',') }}"`) can only be resolved with the flow inputs. Render it with the probe's Templar using the inputs as extra vars.
- **Origin tags (2.19+):** every loaded value carries `Origin(path, line, col)`, which gives "defined in group_vars/core.yml:2" for free. Booleans and null cannot be tagged: name the defining group or host instead.
- Per-group vars: `ansible.vars.plugins.get_vars_from_inventory_sources(loader, sources, [group], 'task')`. It **must be stage `'task'`**; with the default `RUN_VARS_PLUGINS=demand`, stage `'inventory'` returns nothing.
- `ansible_group_priority` only works in the inventory source itself, not in `group_vars`.
- **Vault:**
  - inline `!vault` values are lazy `EncryptedString` objects; converting one to text raises
  - a whole-file vault `group_vars` file makes `get_vars` fail for its hosts, so fall back per entity and name the skipped file
  - never decrypt without an explicit action
- **Dynamic sources** (netbox, aws_ec2, scripts) run plugin code and call APIs with credentials from the environment. Load them **on demand**, with a timeout. Local plugins (`constructed`, `generator`, `ini`, `yaml`, `toml`, `auto`) are safe to auto-load.
- **Cost:** after the first load (~1.4–2.5 s incl. imports), `get_vars` is ~0.7 ms per host: 500 hosts in 374 ms. Host counts per node and lens chips are cheap.
- Prod detection by name (`prod|production|prd|live`) worked well for highlighting.
- Code: `probe/ps_probe/inventory.py`, `core/playbook_studio/inventories.py`, ADR-0010.

## 4. Variables, templating and conditions (D-26 chips, Data lens, contracts)

- **The winner** is `VariableManager.get_vars(play=…, host=…, task=…)` after `Playbook.load(path, variable_manager, loader)`, with an Origin per value. A static "ladder" (every definition in precedence order) explains it. **Flag any disagreement** rather than trusting static logic: a repo's `ansible.cfg` can reorder `precedence`.
- **2.19+ data tagging changes that bite:**
  - Only **trusted** strings are templated. A Python string passed to `Templar.template()` comes back verbatim: wrap user expressions with `ansible.template.trust_as_template()`.
  - `Task.evaluate_conditional` is gone. Use `Templar.evaluate_conditional(trust_as_template(cond))`. It raises `AnsibleUndefinedVariable` for facts and `register` results: show "unknown until run", never guess.
  - Plugin failures are reported through `Display.error_as_warning`, not `warning`.
  - Magic variables to hide from user lists include `vars`, `hostvars`, `groups`, `group_names`, `inventory_hostname*`, `ansible_play_*`, `role_*`, `ansible_facts`, `omit`, `playbook_dir`, …
- **Safe previews:** wrap `lookup_loader.get` so only pure lookups run (`vars`, `items`, `list`, `dict`, `sequence`, `nested`, `together`, `subelements`, …). `env` / `pipe` / `file` / `password` / `url` must not run while rendering a UI. That was a user decision in the predecessor.
- **Static Jinja reference scanner** (good enough for chips and drift):
  - finds root names in `{{ }}`/`{% %}` and in bare `when`/`until`/`changed_when`/`failed_when`/assert `that`
  - skips attributes, filter/test names, kwargs, strings and `for`/`set` locals
  - tracks `default()` / `is defined` guards
  - Levenshtein typo hints

  Code: `web/apps/studio/src/vars/{jinja,collect,diagnostics}.ts`, with tests. D-26's "chips serialize to Jinja" needs the reverse direction too: parse expressions back into chips, flagging anything that isn't a plain reference.
- Code: `probe/ps_probe/variables.py`, ADR-0011.

## 5. Generated code, the skeleton and runs (D-03, D-28, D-29, M3, M6, M7)

Verified behaviour that this bundle's Option A depends on:
- **`ansible.builtin.debug` and `group_by` do not open the managed host's connection**, even with `ansible_connection: network_cli`. A walking skeleton (TODO debug + `group_by` routing) can therefore be **run for real in the probe container against a fictional inventory without any device**. It is ideal for CI tests of generated skeletons.
- **Oracle pattern** (how the predecessor proved correctness):
  - generate a debug-only play
  - import roles as `import_role` with `tags: [never]` so their defaults and vars apply but no task runs
  - run `ansible-playbook --tags oracle` with `ANSIBLE_STDOUT_CALLBACK=json`, `ANSIBLE_LOAD_CALLBACK_PLUGINS=1`
  - compare with the expected values
  - `query('vars', *names, default='__undefined__')` prints many variables in one task
- Roles with `meta/argument_specs.yml` get an **automatic task "Validating arguments against arg spec …"** (action `validate_argument_spec`) at compile time. Run-mode mapping and drift detection must ignore it, or treat it as the role's input check. It also confirms 05's advice to generate `argument_specs` from node contracts.
- **Code → design (M6):** do not regex-parse YAML.
  - `Playbook.load(...).get_plays()` then `play.compile()` gives every task, including tasks from `roles:` and `import_role`, with **`task._origin` (path, line)**, `task.tags`, `task.action` and `task._role`; the play `_ds` has an Origin too.
  - That is the reliable way to find `node_<ULID>` tags and `[key]` prefixes.
  - **Dynamic `include_role` / `include_tasks` are NOT expanded** by compile. To list a role's tasks for "task not in design", compile a synthetic play that `import_role`s it.
- Behaviours from 05 that still need a prototype (not verified there):
  - `unreachable` hosts are not caught by `rescue` and drop out of later plays
  - deriving them from `ansible_play_hosts_all` minus `ansible_play_hosts`
  - `max_fail_percentage` across the router plays
- `ansible-playbook --syntax-check` fails on modules that aren't installed in the environment. Validate generated code inside the node's EE, not on the host.

## 6. Canvas performance (M1, D-19 semantic zoom)

The predecessor rendered up to 2,000-task graphs. This bundle keeps 5–15 nodes per level (D-05), so most issues won't arise. These still apply:
- **Measure only production builds.** React 19 dev instrumentation made every timing 3–5× worse.
- React Flow 12: give nodes an explicit `width`/`height` so `onlyRenderVisibleElements` can skip unmounted nodes without measuring.
  - Reuse node objects whose content is unchanged ("structural sharing" keyed by content, not by array position).
  - Split each node into a cheap shell and a memoized body.
  - Never use `animated` edges.
  - Draw secondary edges (notify-like) only for the selection.
  - Use opaque group fills.
  - Show a plain level-of-detail box below zoom ~0.45; it maps directly to D-19's "far = title only".
  - Hide the MiniMap above ~800 nodes.
- **ELK:** layered layout with compound nodes took 8.5 s for 523 items and did not finish for 2,061. At 5–15 nodes per level it is fine for "tidy up" and AWX import (D-31), but run it in a worker. Code: `122…/web/packages/canvas/`, report `docs/spikes/C-canvas.md`.

## 7. Byte-preserving YAML editing (M1 round-trip, D-30, drift actions)

M1 requires that `examples/*.flow.yaml` **load and round-trip without changes**, and Git diffs must stay minimal. The predecessor's **doc-engine** does exactly this for Ansible YAML:
- parse with the `yaml` library's CST, then build a model with offsets
- every edit is a minimal `TextEdit[]`; comments, quoting and indentation are kept byte-for-byte outside the edited lines

**41,593 / 41,593 fuzzed edits were correct over 34 public repos.** A ruamel.yaml round-trip baseline was clearly worse (it reformats).

- Code: `122…/web/packages/doc-engine/` (`parse.ts`, `ops.ts`, `text.ts`), ADR-0003, `docs/spikes/A-doc-engine.md`, corpus list `tests/corpus/repos.txt` + `scripts/fetch_corpus.py`.
- Guards that mattered: anchors/aliases (an edit inside an anchored subtree changes every alias), flow-style sequences (not editable in place), CRLF files, indentation style detection (indentless sequences).

## 8. Security and UI hygiene

- Plugin docs, inventory values and repo content are untrusted: render them as text, never `innerHTML`.
- The predecessor's local web server needed a session token, a Host allowlist (DNS rebinding), an Origin check and loopback-only binding (ADR-0008). **A VS Code webview avoids that server entirely** (see 08), but the webview still needs a strict CSP.
- Value labels that users trusted: `static`, `templated` (rendered by Ansible), `runtime` (facts, register, blocked lookups: never guessed), `vault` (lock, never decrypted).

## 9. Test fixtures and assets worth reusing

| Asset | Path in `122.ansible_playbook_studio` | Reuse for |
|---|---|---|
| Fictional network repo (cisco.ios / arista.eos, dev/prod/netbox inventories, roles with `argument_specs`, precedence cases, hot spots) | `examples/netops-demo/` (README documents every case) | Binding nodes to real roles, Inventory lens, skeleton runs, drift tests |
| Probe images (2.19/2.20/2.21) and an sshd image | `docker/probe-env.Dockerfile`, `docker/sshd-probe.Dockerfile` | EE stand-ins, contract tests, remote env tests |
| Probe | `probe/ps_probe/*.py` | Port as-is: catalog, inventory, variables; add codegen validation |
| Catalog index/search/resolution | `core/playbook_studio/{catalog,categories,context,markup}.py` | M5 module search |
| Doc-engine (TS) | `web/packages/doc-engine/` | flow.yaml minimal edits |
| Jinja scanner, diagnostics | `web/apps/studio/src/vars/` | D-26 chips, Data lens findings |
| Pattern hints (shell → module, CLI config → resource module) | `web/apps/studio/src/discover/rules.ts` | D-27 flow-aware hints, intent suggestions |
| 10 syntax-checked task snippets | `core/playbook_studio/snippet_library/` | Failure-pattern templates (D-16): keep them syntax-checked in CI |
| Corpus of 34 public Ansible repos | `tests/corpus/repos.txt` | Import / round-trip robustness |
| Decisions and spikes | `docs/adr/0001–0011`, `docs/spikes/A,B,C`, `docs/spec/playbook-studio-spec-v2.md` | Background reading |

## 10. Mapping to this bundle's milestones (06)

| Milestone | What the predecessor gives you |
|---|---|
| M1 canvas + document | Byte-preserving YAML edits (7), React Flow rules (6), a strict webview (8) |
| M3 skeleton | debug/group_by run without devices, oracle runs in the probe image, `--syntax-check` in the EE (5) |
| M5 binding | Catalog pipeline, routing/resolution, intent search with context, check-mode attribute, docs-as-text (2) |
| M6 drift | `Playbook.load` + `compile()` + `_origin`; the `validate_argument_spec` task; dynamic includes not expanded (5) |
| M8 lenses | Inventory (3), Data (4), Code (2 routing: "collection not in EE", deprecated/removed), Access (vault handling in 3) |
| Open question 1 (engine A/B) | Option A can be prototyped and tested end-to-end in the probe container today (5) |

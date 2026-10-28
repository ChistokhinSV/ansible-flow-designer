# Kickoff prompt for a new Claude Code session

Start Claude Code in `C:\HOME\1.SCRIPTS\123.Ansible_Studio_VSCODE` and paste the block below.

---

```text
We are starting a new project here: a VS Code extension, "Ansible Flow Designer" (working name). It is a visual, top-down designer for Ansible automation flows: engineers sketch a flow as a graph of typed nodes and ports, run it as a walking skeleton, then bind nodes to modules, roles and playbooks. The flow document (flow.yaml) stays the source of truth; Ansible code is generated from it and drift is detected both ways. The product design is finished. This session plans the implementation; do not write product code until I approve a plan.

Read first, in this order (all inside ansible-flow-designer-handoff/):
1. README.md
2. docs/01-product-overview.md … docs/06-implementation-plan.md
3. schema/flow.schema.json and examples/ (two flows + a generated skeleton)
4. docs/07-lessons-from-playbook-studio.md: verified engineering knowledge from my previous project (numbers, pitfalls, reusable code)
5. docs/08-vscode-extension-target.md: what changes because the target is a VS Code extension (it supersedes the architecture section of 06)

The mockups/ folder is visual reference only (static HTML). docs/04-ui-spec.md wins where they disagree. Mockups 02 and 03 still use the retired port names success/failure; the final names are in D-07.

Context you must take into account:
- Predecessor project: C:\HOME\1.SCRIPTS\122.ansible_playbook_studio ("Playbook Studio"). It is paused and read-only for you: never modify or commit there.
  - It contains working, tested code that 07 points to: the stdlib Python "probe" that answers questions inside the Ansible environment, the module catalog pipeline and search, inventory and variable tracing, a byte-preserving YAML edit engine, React Flow performance patterns, Docker probe images and contract tests.
  - Ask me before copying any of it; once I say yes, copy rather than rewrite, and note the origin in the commit message.
  - Its docs/adr/0001–0011 and docs/spikes/ explain why things are the way they are.
- Machine: Windows 11 + Docker Desktop. Ansible cannot run natively on Windows. Local images already exist: ps-probe-env:2.19, ps-probe-env:2.20, ps-probe-env:2.21 (ansible-core 2.19.14 / 2.20.10 / 2.21.5, ansible 14.5.0) and ps-probe-sshd. They can serve as stand-in execution environments for development and contract tests.
- Pitfalls already paid for (details in 07):
  - Docker Desktop mounts are world-writable, so Ansible ignores ./ansible.cfg unless ANSIBLE_CONFIG is set before importing ansible.
  - ansible-core 2.19+ only templates trusted strings: use trust_as_template and Templar.evaluate_conditional.
  - Origin tags give file:line for loaded values (but not for true/false/null).
  - debug and group_by never open a device connection, so walking skeletons can be run in a container against a fictional inventory.
  - Dynamic include_role/include_tasks are not expanded by play.compile().
  - Measure UI performance on production builds only (the React dev build was 3–5x slower).
  - @vscode/webview-ui-toolkit was archived in January 2025: use --vscode-* theme variables and codicons instead.
- The fictional demo repo C:\HOME\1.SCRIPTS\122.ansible_playbook_studio\examples\netops-demo (cisco.ios / arista.eos roles with argument_specs, dev/prod/netbox inventories) is a good fixture for binding nodes and running skeletons.

What I want from this first session (plan mode):
1. A short summary of the product in your own words, and anything in the design you think is inconsistent, risky or under-specified (especially per-host port semantics: Option A vs B in 05).
2. The open questions from 06 and 08, each with your recommendation, put to me with AskUserQuestion. Repeat any that I leave unanswered, and add new ones my answers raise, until the spec is complete. Settle at least these before M1: layout storage under VS Code undo (08), catalog storage (08), target environments (Remote/WSL, Docker EE, venv), minimum ansible-core (proposed 2.19+), relationship to the redhat.ansible extension, and whether to copy code from the predecessor.
3. A repository layout for the extension: extension host, webview, probe, schema, tests, fixtures.
4. A detailed plan for milestone M1 (06) adapted to a CustomTextEditorProvider for *.flow.yaml. It must meet the M1 acceptance checks, including "examples/*.flow.yaml load, render and round-trip without changes". Include how each check is verified.
5. A rough ordering for M2–M9 with which predecessor assets each one reuses.

Working rules (my global CLAUDE.md also applies):
- Check context7 and the web for the latest stable versions and current APIs before choosing any dependency (VS Code API, @xyflow/react, yaml, elkjs, ulid, esbuild, vite, vitest, @vscode/test-cli, ajv, …).
- Git: init the repo in this folder at the start of implementation; commit per milestone; never push unless I ask.
- YouTrack: propose a new project for this extension (key and name) and wait for my confirmation before creating it. Then follow the ticket and knowledge-base rules from CLAUDE.md: assign tickets to 'claude', and update the KB in the same change as each feature. For background only, the old project's KB is in YouTrack project PS (feature map PS-A-1); don't edit it.
- Keep secrets out of code, logs and examples. All sample data must be fictional (RFC 5737 addresses, example.net domains).
```

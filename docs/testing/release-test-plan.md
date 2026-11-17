# Release test plan: Ansible Flow Designer

Every release candidate is tested by hand before it is released ([RELEASING.md](../../RELEASING.md)):

- **Core**: every check below, for every candidate. A check that cannot be done (the lab's AWX is
  down) is written down as not done, with why, and does not pass.
- **What changed**: for each line under `## Unreleased` in `CHANGELOG.md`, at least one check
  that does what the line says, written into the release ticket before testing starts.

The designer with Ansible Flow Server (Run on Server, the server's pages, which carry the
designer's canvas) is in the server's plan, section 12 and sections 4 to 6.

Setup: VS Code (stable) with the candidate's VSIX from its GitHub pre-release, a clean profile
(**Profiles: New Profile**), Docker or WSL with Ansible for runs, the GNS3 lab for real hosts, the
lab's AWX for section 9. Fictional names only in anything kept.

## Results

Copy into the release ticket and fill in: `pass`, `fail` (with a ticket), or `not done` (with why).

| #   | Area                               | Result | Notes |
| --- | ---------------------------------- | ------ | ----- |
| 1   | Install and first start            |        |       |
| 2   | Designing a flow                   |        |       |
| 3   | Subflows and the library           |        |       |
| 4   | Binding: modules, roles, playbooks |        |       |
| 5   | Data between steps                 |        |       |
| 6   | Code and drift                     |        |       |
| 7   | Runs: skeleton and real            |        |       |
| 8   | Approvals and scenarios            |        |       |
| 9   | AWX                                |        |       |
| 10  | Import playbooks                   |        |       |
| 11  | Lenses and the canvas              |        |       |
| 12  | AI assistants and MCP              |        |       |
| 13  | Themes and the panel               |        |       |
| 14  | Packages on npm                    |        |       |
| 15+ | What changed (one row per line)    |        |       |

## 1. Install and first start

1. **Install from VSIX**: the Extensions view shows the candidate's version; the **Ansible Flows**
   icon is in the Activity Bar; the Output channel "Ansible Flow Designer" has no error.
2. **Ansible Flow: Get Started** opens the walkthrough; **Open Sample Flow…** → Hello, Ansible
   opens on the canvas.
3. A candidate after a release installed over it: flows open as before; settings are kept.

## 2. Designing a flow

1. **New Flow**: name it; it opens with Start and Done.
2. Add steps from the palette and from the wire's **+**; drop a step on a wire (it makes room);
   wire `ok_hosts` and `failed_hosts`; a fail port left open is a finding until handled.
3. Undo and redo (Ctrl+Z, Ctrl+Y) across several edits; the file on disk follows; **Tidy Up**
   lays out the level.
4. Copy and paste steps within a flow and into another; delete a step and its wires.
5. Notes, sections and text on the canvas: add, move with their step, edit Markdown.
6. Close and reopen: the flow is as it was; the file is valid YAML a reviewer can read.

## 3. Subflows and the library

1. Select several steps → **Extract into Subflow**: the level opens; Back returns; the outer
   flow's wires are kept.
2. Expand a subflow in place; collapse it.
3. **Insert Shared Subflow…** from a library (with a server, or a folder library): the copy is
   pinned; a newer version offers Update.

## 4. Binding: modules, roles, playbooks

1. The catalog builds for the environment (status bar); search finds `ansible.builtin.ping` by
   name and by intent ("connect python").
2. Bind a step to a module: Configure shows required and optional parameters; `@` offers inputs
   and upstream outputs as chips; **Full Docs** opens the module's page (docs.ansible.com for
   ansible.builtin, Galaxy for others).
3. Bind to a role of the repository (entry points from its argument spec) and to a playbook.
4. A module missing from the environment is a finding with a fix.

## 5. Data between steps

1. A step's output used as another's input (`from:`), across a subflow's edge.
2. The Data lens shows who reads what; a read with no source is offered a fix.
3. **Run outputs** in the Flow panel: an output from a step; a run lists it per host.

## 6. Code and drift

1. **Generate Code** writes `generated/`; `ansible-playbook --syntax-check` passes on it.
2. Code mode shows each step's generated task; **Peek Code** on a step.
3. Change a generated file by hand: the drift panel shows it, with actions both ways.

## 7. Runs: skeleton and real

1. **Run as Skeleton** of the Hello sample (Docker environment `afd-ee`, or WSL): live status on
   the canvas, hosts per wire, each step's host output; the run ends well.
2. **Run for Real** against a lab host over SSH (an environment with the lab's inventory): the
   launch dialog names inventory and hosts; the run's output shows the device's answer.
3. **Stop** a long run; **Earlier runs** lists past runs with host counts; picking one shows it.
4. Run part of the flow (from a step) and see it marked partial.

## 8. Approvals and scenarios

1. A flow with an approval: a local Real run waits; Approve and Reject from the canvas decide.
2. **Run Scenarios**: each scenario's hosts end where expected; change a wire so one fails; the
   failure says which host and where.
3. Add a scenario from the simulation; it is written to `<key>.scenarios.yaml`.

## 9. AWX

With the lab's AWX (settings `afd.awx.*`):

1. **Launch in AWX**: the job runs; events map to the steps on the canvas.
2. A flow with approvals runs as an AWX workflow; the approval is decided from the canvas.
3. **Import AWX Workflow or Job Template…**: a job template or workflow becomes a flow.

## 10. Import playbooks

1. Right-click a folder of playbooks → **Import Ansible Playbooks…**: flows are made; blocks,
   roles and handlers are on the canvas; a skeleton run of an imported flow ends well.

## 11. Lenses and the canvas

1. Each lens (inventory, code, data, outdated collections, …) shows its chips; zooming out
   switches to the summary view and back.
2. Find a node (Ctrl+F); breadcrumbs; the minimap; Fit view.

## 12. AI assistants and MCP

1. **Ansible Flow: Set Up AI Assistants…** for Claude Code: the MCP server and skill are written.
2. In Claude Code: ask for a small flow; it is made with the flow tools, validates with no
   error, and opens on the canvas.
3. Copilot (agent mode) with the language model tools: describe and edit a flow.

## 13. Themes and the panel

1. Light, dark and high-contrast themes: the canvas, Details and dialogs are readable.
2. The side panel at its narrowest and widest; a step's Details scroll back to the top for each
   selected step; nothing overlaps.

## 14. Packages on npm

1. `npm view @ansible-flow/core@next version` is the candidate's version; `npm view
   @ansible-flow/core version` (latest) is still the last release.
2. The four packages install together in an empty folder (`npm install
   @ansible-flow/core@<candidate> @ansible-flow/node@<candidate> …`) with no peer warning.

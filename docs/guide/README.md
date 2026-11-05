# Ansible Flow Designer — user guide

Ansible Flow Designer lets you design Ansible automation top-down, as a diagram. You draw the steps
and wire them port to port: `ok_hosts` to the next step, `failed_hosts` to a rollback. Then you run
the diagram as a walking skeleton before any code exists. Later you bind each step to a module, a
role or a playbook. The diagram is a YAML file (`*.flow.yaml`) in your repository, and the
playbooks are generated from it.

![A firewall upgrade flow in the designer](images/canvas-light.png)

## Start here

- New to the designer? Follow **[Tutorial 1: your first flow](tutorials/01-first-flow.md)** (10
  minutes: a playbook after two steps, no Ansible needed until the last step).
- Prefer to click through? The **Ansible Flows** icon in the Activity Bar, or **Ansible Flow: Get
  Started** in the Command Palette, which opens the walkthrough on VS Code's Welcome page.
- Want something to look at first? **Open Sample Flow…** → **Hello, Ansible**: three steps that
  run on `localhost` (with inventory groups, you pick one instead).
- What is going on? **[How flows work](explanation/how-flows-work.md)**: hosts, wires, plays.
- Already have playbooks? Follow **[Tutorial 5: bring existing playbooks into flows](tutorials/05-import-playbooks.md)**,
  or right-click a playbook or folder → **Import Ansible Playbooks…**.

## Tutorials

| Tutorial                                                                   | You will                                                                                                        | Time   |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| [1. Your first flow](tutorials/01-first-flow.md)                           | create a flow, add two steps, see the playbook, handle failures, run a skeleton                                 | 10 min |
| [2. From design to production](tutorials/02-design-to-production.md)       | use a subflow, bind modules, pass data between steps, poll a device, compare with the code, run for real        | 30 min |
| [3. AWX end to end](tutorials/03-awx-end-to-end.md)                        | set up a template, run approvals as an AWX workflow, follow the run, import a workflow                          | 30 min |
| [4. With an AI assistant](tutorials/04-ai-assistant.md)                    | let Copilot or Claude Code build and fix a flow                                                                 | 20 min |
| [5. Bring existing playbooks into flows](tutorials/05-import-playbooks.md) | import playbooks as is, find blocks, roles and handlers on the canvas, run them, let an assistant redesign them | 25 min |

## Understand

- [How flows work](explanation/how-flows-work.md): hosts travel along wires, a step is a play, how
  failures end, what a skeleton run is.

## How-to pages

**Designing**
- [Canvas basics: levels, menus, keyboard shortcuts](how-to/canvas-basics.md)
- [Ports and failure patterns](how-to/ports-and-failure-patterns.md)
- [Subflows](how-to/subflows.md)
- [Decisions, parallel branches, approvals and ends](how-to/control-flow.md)
- [Copy and paste nodes](how-to/copy-paste.md)
- [Notes, sections and text](how-to/annotations.md)
- [Hand-written YAML and Complete IDs](how-to/hand-written-yaml.md)
- [Export as draw.io or an image](how-to/export.md)

**Implementing**
- [Bind a step to a module, role or playbook](how-to/binding-and-catalog.md)
- [Data between steps](how-to/data-between-steps.md)
- [Retries and polling](how-to/polling-and-retries.md)
- [Generated code](how-to/code-generation.md)
- [Code mode: design vs code](how-to/code-mode.md)
- [Lenses](how-to/lenses.md)

**Running**
- [Runs and environments](how-to/runs-and-environments.md)
- [Scenario tests](how-to/scenario-tests.md)
- [Approvals](how-to/approvals.md)
- [AWX](how-to/awx.md)
- [Import playbooks and AWX templates](how-to/import.md)

**AI and setup**
- [AI assistants](how-to/ai-assistants.md)
- [Settings](how-to/settings.md)

## Reference

- [Commands](reference/commands.md)
- [Settings](reference/settings.md)
- [Problem codes](reference/problems.md)
- [Flow file format](reference/flow-format.md)
- [Glossary](reference/glossary.md): every word the designer and this guide use
- [Features](reference/features.md): everything the extension does, in one list
- [Troubleshooting](troubleshooting.md)

<p align="center"><img src="media/icon.png" width="96" alt="Ansible Flow Designer icon"></p>

<h1 align="center">Ansible Flow Designer</h1>

<p align="center">Design Ansible automation as a diagram in VS Code. Draw the steps and decide what
happens when each one fails; the extension writes the playbook and runs it.</p>

![A step inserted from a port, a rollback for its failure in one click, the play it makes, and a skeleton run that shows where each host went](media/readme/hero.gif)

## Why

- **The diagram is the source.** A flow is a YAML file (`*.flow.yaml`) in your repository. The
  playbook is generated from it on every save, and edits to the code are shown as drift, not lost.
- **Failure paths are designed, not forgotten.** Every step has a `failed_hosts` port, and the
  flow is not done until each one is handled or kept open with a reason.
- **It runs before the code exists.** A new flow runs as a skeleton in check mode. You then bind
  each step to a module, a role or a playbook, one at a time.

## Main features

- **Top-down canvas:** steps, decisions, approvals, parallel branches and subflows, with notes
  and sections that explain the flow.
- **Failures in one click:** rollback from backup, notify on-call and stop, exclude and report,
  retry.
- **Bind steps** to modules, roles and playbooks from your execution environment's catalog, with
  their docs. Pass data between steps with `@`, and let whoever runs the flow set a step's
  retries, delay or timeout.
- **Design versus code:** Code mode compares the flow with the code it runs and fixes drift in
  either direction.
- **Run** locally (check mode, or for real and audited) or in AWX with approvals. Run mode shows
  where every host went.
- **Scenario tests:** make chosen steps fail for chosen hosts and say where each must end. A
  simulation checks them as you edit; they also run in Ansible and in CI.
- **Lenses** over the whole flow: inventory, data, code, access, timing, and changes since a
  commit.
- **Bring what you have:** import playbooks and AWX workflows. AI assistants (Copilot, Claude Code
  and others) build and fix flows, and their scenario tests, through flow tools. Export to draw.io.

## See it work

**Handle a failure in one click.** An open fail port offers the failure patterns; a rollback the
flow already has is reused.

![The fail port menus of Pre-checks and Validate: Notify On-Call and Stop, then the existing Rollback](media/readme/failure.gif)

**See where every host went.** A run fills the canvas as it goes: how many hosts took each wire,
which hosts, and each host's result at the step that failed it.

![A skeleton run of three hosts: host-03 fails its ping and ends at Stopped](media/readme/run.gif)

**Test where hosts end, without a run.** Show a scenario on the canvas, make a step fail for a
host, and the simulation says at once where that host now ends.

![A scenario on the canvas: Validate fails for sw-01, which now ends at an open fail port, so the scenario fails](media/readme/whatif.gif)

| Bind a step to a module                                                     | Design versus code                                                         |
| --------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ![Binding with the catalog](docs/guide/images/properties-binding-light.png) | ![Drift between flow and code](docs/guide/images/implementation-light.png) |

## Get started

1. Install the extension. Designing needs nothing else; runs need ansible-core 2.19 or later in
   an execution environment image, WSL or a local venv (**Set Up Ansible Environment…** helps).
2. Click the **Ansible Flows** icon in the Activity Bar, then **New Flow** (or **Open Sample
   Flow…** for a flow that already runs).
3. Add steps with **Add a Step** and **N**, answer the banner about failures, then **Run as
   Skeleton** on `localhost`.

The **[first tutorial](docs/guide/tutorials/01-first-flow.md)** takes 10 minutes. Then:

- **[The user guide](docs/guide/README.md)**, which also opens in VS Code (**Ansible Flow: Open
  User Guide**);
- **[every feature](docs/guide/reference/features.md)**;
- **[details](docs/details.md):** requirements, settings, repository layout and building from
  source.

Requires VS Code 1.94 or later (the module catalog: 1.101 or later). MIT licensed.

## Feedback and privacy

The extension sends no telemetry and nothing about your flows. It only opens links:

- **Ansible Flow: Send Feedback…** (also in the designer's **…** menu) opens a short form in the
  browser; **Report a Problem…** opens a GitHub issue.
- After a week of real use (three days with a flow open in the designer), one notice asks for a
  rating or a few words. **Not Now** asks once more a month later at most; **Don't Ask Again**
  ends it. The days are counted on your machine only.
- When you uninstall it, a notice in the editor asks whether you would say why. The form opens in
  the browser only if you click **Tell Us Why**; nothing opens by itself. It does not ask after
  **Don't Ask Again**.
- The setting `afd.feedback.prompt` turns off both notices.

What you send through the form goes to the author's issue tracker, with a chat notification that
leaves out the email. The email is optional and used only to answer you. The form page itself
counts that it was opened: which page (in use or after uninstall), the version and the editor, once
per browser tab. No cookie is set and no address is kept; the count is deleted after 400 days.

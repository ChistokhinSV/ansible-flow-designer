# ADR-0030: Guided first use

- Status: accepted (2026-11-03, AFD-73)
- Context: wave 7, a gentler first hour (KB AFD-A-19)

## Context

The three walkthroughs (ADR-0019) live on VS Code's Welcome page. A newcomer who never opens that page had no way in except the Command Palette, which listed 14 commands before any flow existed, 8 of them about AWX, scenarios, audits or removing an AI setup.

The first walkthrough had 9 steps; import, subflows and validation came before the first playbook. Inside the designer nothing said what to do next once the empty-level card was gone.

The AI setup was offered in any workspace at startup, before the user had seen a flow. One click on Set Up wrote user-level agent configs without showing them.

Product-owner decisions (2026-11-03): an Activity Bar icon, and a first-flow checklist for everyone until it is done or hidden once.

## Decision

- **First-flow checklist** (`webview/panels/FirstFlow.tsx`; the items come from the pure `core/view/firstFlow.ts`).
  - **Items:**
    - add a step (a step exists);
    - see the playbook it makes (tour key `codeSeen`: Peek Code showed it, or Generate Code wrote it);
    - decide what happens when it fails (steps and no open fail port);
    - run it as a skeleton (`skeletonRun`: a check run finished).
  - **Show Me** does the step, or opens where it is done: Add a Step, Peek Code on the first step, the first open port's menu, a skeleton run.
  - **Where it shows:** over the canvas's bottom left (where a first flow, which grows down from the top, leaves room; the minimap keeps out of that corner), in Design mode, editable, top level, on flows with 1–5 top-level steps.
  - **Hide Checklist** hides it for good; "…" › Show First-Flow Checklist brings it back. When all four are done it says so and points at Tutorial 2.
- **Progress is the user's** (`extension/tour.ts`).
  - The tour keys, which also check off the walkthrough, are kept in globalState `afd.firstFlow {hidden, done[]}`, and the context keys are restored at activation.
  - Every open designer gets `firstFlow` messages, and the webview sends `firstFlow {hidden}` back.
  - The harness sends it hidden, so other screenshots stay as they were.
- **Ansible Flows view** (`extension/flowsView.ts`): an Activity Bar container `afd` with the view `afd.flows`.
  - The view is a tree of `**/*.flow.yaml`, kept current by a watcher; an item opens the designer. New Flow and Refresh are on its title bar.
  - **Welcome content:**
    - no folder: Open Folder and Get Started;
    - a folder with no flows: New Flow, Open Sample Flow, Import Ansible Playbooks, Get Started and the User Guide.
- **"?" links** (`HelpLink`, pages in `webview/helpPages.ts`, checked by the docs test):
  - beside the Details tabs, for the tab shown;
  - on the palette's Failure patterns heading;
  - on the Run, Design vs code and lens panels.

  They send the existing `openGuide`; the host's `guidePage` is the allowlist.
- **AI offer:** made once the first designer shows a flow with a step, not at startup. The stale-setup check stays at activation.
  - **Set Up…** previews what it writes before writing it.
  - An agent counts as offered once the notice is answered or closed.
- **Command Palette:** Launch in AWX, Set Up AWX Template and Clear AWX Token show once `afd.awx.url` is set. Remove AI Assistant Setup… shows once there is one (`afd.ai.configured`). The view's Refresh never shows. Set AWX Token and Import AWX stay as ways in.
- **Walkthrough "Design your first Ansible flow"** has 6 steps that match the checklist:
  1. Start a flow (with Import as an alternative);
  2. Add a step;
  3. See the playbook it makes;
  4. Decide what happens when it fails;
  5. Run it as a skeleton (with Set Up Ansible Environment…);
  6. Keep going (subflows and the rest).

  Its three dark images that only the removed steps used are deleted.
- **The empty-level card** links Get Started (`startFrom` `tour`).

## Consequences

- People who already had flows see the checklist on a flow with 1–5 steps until they hide it once.
- Users with an AI agent installed are offered the setup later than before, and only after they meet a flow. The setup command is unchanged.
- An AWX user starts from Set AWX Token or the AWX walkthrough. The AWX commands appear once the URL is set.

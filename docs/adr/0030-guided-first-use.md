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

## Amendment: the Inventory view (AFD-83, 2026-11-04)

Round 1's participant could not see the inventory or point a run at a group (P6). The inventory was
their most confusing part and their one thing to change.

- **The view.** The Ansible Flows view container gains **Inventory** (`afd.inventory`,
  `extension/inventoryView.ts`): the groups and hosts the runs use, read in the run environment by
  the probe's `inventory_tree` (each group's own hosts, child groups and host count). It starts
  from the children of `all` (`core/view/inventoryTree.ts`), with `ungrouped` only when it has
  hosts. It is read when first shown and again on Refresh Inventory or a change to
  `afd.run.inventory` or the environment settings. With no environment it says so and offers Set
  Up Ansible Environment….
- **Run Flow on This Group…** (inline on a group or a host) opens the designer's launch dialog
  (AFD-82) for the flow being worked on, with that name as the targets (`planLaunch` prefill). The
  person still sees the facts and presses Run.

## Amendment: the Flows view says what needs a look (AFD-86, 2026-11-04)

Round 1's participant gave up getting an overview of the repository (T7, ease 1). They opened flows
one by one, and did not know what "edited by hand" meant (P16).

- **By folder.** The Flows view groups flows by folder (`core/view/flowFacts.ts` `flowTree`). A
  folder that only holds its own flow (the New Flow layout) is not a level of its own.
- **Per flow.** Each flow says its errors and warnings (`validateFlow`) and its code state:
  - out of date;
  - edited by hand;
  - no code yet;
  - blocked by errors.

  The code state comes from the same write plan a save uses (`planGenerated`), so it matches what
  a save does. The tooltip explains each state. An open flow answers from its editor's text.
- **When it reads.** Facts are read lazily and cached by the flow's and its `generated/` folder's
  modification times. A watcher on both refreshes the view, debounced by 300 ms.
- **Excludes.** `findFiles` no longer passes a pattern that replaced `files.exclude`; node_modules is
  filtered by hand.
- **Actions.** Run as Skeleton (inline) opens the designer and its launch dialog (AFD-82). Peek
  Code opens the generated root playbook.
- **Not done.** A badge on flow files in the Explorer (a FileDecorationProvider) is left for later.

## Amendment: the flow panel leads to the Flows view (AFD-89, 2026-11-04)

Round 1 added this to group D, and AFD-86 left it out. The flow panel now ends with "Other flows of
this workspace, with their problems and code state: Flows View". The webview sends `showFlows`, and
the host runs `afd.flows.focus`.

## Amendment: the workspace where people already look (AFD-93, 2026-11-05)

Round 2's participant gave up T7 again (S8). The Flows view had both answers, but P1 looked in the
guide, the Problems panel and inside flows. Three changes:

- **One index of the workspace's flows** (`extension/flowIndex.ts`) for the Flows view, Problems
  and the flow panel. Facts per flow are kept by stamp; every flow is read in the background 3 s
  after start-up, two at a time, up to 500. A root per workspace folder.
- **Problems for every flow:** closed flows publish their validation findings with places
  (`flowFacts` `problems`, `lineCol`); an open flow's session owns its URI and adds binding and
  shared-source checks. `afd.problems.scope: open` keeps Problems to open flows. A generated
  playbook edited by hand (ours, checksum off) gets a warning in its own collection, with Open the
  Flow.
- **The flow panel's line** (`repoState`, `repoLine`): the Readiness link says what the workspace's
  flows need; when one has errors or code edited by hand, the line also shows at the top of the
  panel (X2). A new flow in a clean workspace adds nothing (35 controls).
- **Find** says what a single filter lists (`findSummary`, S7).

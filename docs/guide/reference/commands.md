# Commands

All commands are in the Command Palette (Ctrl+Shift+P) under **Ansible Flow:**. Commands that act
on a flow use the one open in the designer. Some show there only when they can act: the designer's
commands with a flow open, Stop Run while a run goes, Launch in AWX, Set Up AWX Template and Clear
AWX Token once `afd.awx.url` is set, Remove AI Assistant Setup… once there is a setup. The words follow the [glossary](glossary.md). Back to
the [guide](../README.md).

## Getting started

| Command                                                 | Does                                                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `afd.help.getStarted` · Get Started                     | opens the "Design your first Ansible flow" walkthrough                                                                       |
| `afd.help.openGuide` · Open User Guide                  | opens this guide in the Markdown preview                                                                                     |
| `afd.help.openSample` · Open Sample Flow…               | copies a sample flow into the workspace and opens it, or sample playbooks to import into an empty folder (Tutorial 5)        |
| `afd.flows.refresh` · Refresh                           | reads the flows of the **Ansible Flows** view (Activity Bar) again; on the view's title bar                                  |
| `afd.flows.run` · Run as Skeleton                       | on a flow in the **Ansible Flows** view: opens it and its launch dialog                                                      |
| `afd.flows.peekCode` · Peek Code                        | on a flow in the **Ansible Flows** view: opens its generated root playbook                                                   |
| `afd.inventory.refresh` · Refresh Inventory             | reads the **Inventory** view again (groups and hosts the runs use); on the view's title bar                                  |
| `afd.inventory.runOn` · Run Flow on This Group…         | the launch dialog of the flow in the designer, with that group or host as its targets                                        |
| `afd.flow.new` · New Flow…                              | creates `flows/<key>/<key>.flow.yaml` with a start and a done node                                                           |
| `afd.import.playbooks` · Import Ansible Playbooks…      | turns a playbook, or the playbooks of a folder, into new flows, one step per task (also on the Explorer's right-click)       |
| `afd.import.awx` · Import AWX Workflow or Job Template… | turns an AWX workflow or job template (from AWX or an export file) into a new flow; playbooks in the repository become steps |
| `afd.import.reimport` · Re-import from Source           | merges the playbook's later changes into a flow imported from it, keeping yours; previewed, then one edit                    |

## Designing

| Command                                           | Does                                                                                                                          |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `afd.flow.check` · Check Flow                     | checks the design (problems in the Problems panel) and, when it has no errors, the generated code in your Ansible environment |
| `afd.canvas.tidyUp` · Tidy Up                     | lays out the open level again                                                                                                 |
| `afd.flow.openInTextEditor` · Open in Text Editor | the flow's YAML in the text editor                                                                                            |
| `afd.edit.copy` · Copy Nodes                      | copies the selected nodes as YAML                                                                                             |
| `afd.edit.paste` · Paste Nodes                    | pastes nodes on the open level                                                                                                |
| `afd.flow.completeIds` · Complete IDs             | adds the IDs a hand-written flow lacks, in one edit                                                                           |
| `afd.flow.upgradeFormat` · Upgrade Flow Format    | moves a format 1 flow to format 2, in one edit (one undo step); nothing in the design changes                                 |
| `afd.flow.insertShared` · Insert Shared Subflow…  | copies a subflow of another flow in the workspace here, pinned to that flow's version (format 2; also in the canvas menu)     |
| `afd.flow.updateShared` · Update Shared Subflow   | copies a shared subflow again from the newer version of its source (a quick fix on its problem)                               |
| `afd.flow.unlinkShared` · Unlink Shared Subflow   | makes a shared subflow this flow's own, to edit here (a quick fix on its problem)                                             |

## Export

| Command                                          | Does                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------ |
| `afd.export.drawio` · Export as draw.io Diagram… | every level as a page of a `.drawio` file, with the node details as data |
| `afd.export.image` · Export as Image (SVG, PNG)… | the top level or every level as `.drawio.svg` or `.drawio.png` images    |

Both are also in the Explorer's right-click menu on a `*.flow.yaml` and in the designer's "…" menu
([export](../how-to/export.md)).

## Code and runs

| Command                                                           | Does                                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afd.code.generate` · Generate Code                               | writes `generated/` now                                                                                                                                               |
| `afd.environment.setup` · Set Up Ansible Environment…             | finds Docker, Podman or WSL and sets where runs, the probe and the catalog run (offered on the error when there is nowhere to run)                                    |
| `afd.run.skeleton` · Run as Skeleton (Check Mode)                 | generates the code and runs it in check mode                                                                                                                          |
| `afd.run.real` · Run for Real…                                    | runs it for real, after a confirmation                                                                                                                                |
| `afd.run.launch` · Open Launch Dialog                             | the designer's Run and Ctrl+F5: one dialog with the flow's inputs and what the run touches, then Run (not in the Command Palette)                                     |
| `afd.run.stop` · Stop Run                                         | stops the run going: ends the local run, or cancels the job or workflow in AWX (also the **Stop** button in the top bar while a run goes)                             |
| `afd.run.scenarios` · Run Scenarios                               | runs the scenario tests next to the flow (`<key>.scenarios.yaml`): every step as its stub on local hosts, then where each host ended (also **Run ▾ › Run Scenarios**) |
| `afd.run.copyScenarioRunner` · Copy Scenario Runner to Repository | copies the command-line scenario runner to `.afd/afd-scenarios.js`, for CI                                                                                            |
| `afd.run.showAudit` · Show Run Audit Log                          | the local log of every launch (no input values)                                                                                                                       |
| `afd.catalog.rebuild` · Rebuild Module Catalog                    | reads the environment's collection docs again                                                                                                                         |

## AWX

| Command                                       | Does                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `afd.awx.setToken` · Set AWX Token            | stores a personal access token in SecretStorage                         |
| `afd.awx.clearToken` · Clear AWX Token        | removes it                                                              |
| `afd.awx.setupTemplate` · Set Up AWX Template | creates or updates the job template (or approval workflow) for the flow |
| `afd.awx.launch` · Launch in AWX              | launches it and follows the job on the canvas                           |

## AI assistants

| Command                                      | Does                                                                  |
| -------------------------------------------- | --------------------------------------------------------------------- |
| `afd.ai.setup` · Set Up AI Assistants…       | copies the skill and registers the flow tools for the agents you pick |
| `afd.ai.remove` · Remove AI Assistant Setup… | removes what setup wrote                                              |

## Keyboard

While the flow designer has focus (Keyboard Shortcuts in VS Code can change them):

| Keys (macOS)       | Command         |
| ------------------ | --------------- |
| Ctrl+F5            | Run as Skeleton |
| Shift+F5           | Stop Run        |
| Ctrl+Shift+B (⇧⌘B) | Generate Code   |
| Shift+Alt+F (⇧⌥F)  | Tidy Up         |
| F7                 | Check Flow      |

The designer's own keys (copy, paste, rename, moving around) are in its **?** sheet.

## Ids before 0.25

The ids before 0.25 ran their command as hidden aliases through 0.27 and are gone since 0.28. A
keybinding or a link that still uses one needs the new id from the table above: `afd.newFlow`, `afd.validate` and `afd.syntaxCheck` (both now
Check Flow), `afd.completeIds`, `afd.openAsText`, `afd.generate`, `afd.tidyUp`, `afd.copyNodes`,
`afd.pasteNodes`, `afd.runSkeleton`, `afd.runReal`, `afd.stopRun`, `afd.showAudit`,
`afd.importPlaybooks`, `afd.importAwxWorkflow`, `afd.exportDrawio`, `afd.exportImage`,
`afd.setupAi`, `afd.removeAi`, `afd.openGuide`, `afd.openWalkthrough`, `afd.openSample`.

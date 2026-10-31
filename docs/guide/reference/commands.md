# Commands

All commands are in the Command Palette (Ctrl+Shift+P) under **Ansible Flow:**. Commands that act
on a flow use the one open in the designer. Back to the [guide](../README.md).

## Getting started

| Command                                        | Does                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `afd.openWalkthrough` · Get Started            | opens the "Design your first Ansible flow" walkthrough             |
| `afd.openGuide` · Open User Guide              | opens this guide in the Markdown preview                           |
| `afd.openSample` · Open Sample Flow…           | copies a sample flow into the workspace and opens it               |
| `afd.newFlow` · New Flow…                      | creates `flows/<key>/<key>.flow.yaml` with a start and a done node |
| `afd.importAwxWorkflow` · Import AWX Workflow… | turns an AWX workflow (from AWX or an export file) into a new flow |

## Designing

| Command                          | Does                                                |
| -------------------------------- | --------------------------------------------------- |
| `afd.validate` · Validate Design | checks the flow again and shows the Problems panel  |
| `afd.tidyUp` · Tidy Up Layout    | auto-layout of the open level                       |
| `afd.openAsText` · Open as Text  | the flow's YAML next to the designer                |
| `afd.copyNodes` · Copy Nodes     | copies the selected nodes as YAML                   |
| `afd.pasteNodes` · Paste Nodes   | pastes nodes on the open level                      |
| `afd.completeIds` · Complete IDs | adds the IDs a hand-written flow lacks, in one edit |

## Code and runs

| Command                                           | Does                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| `afd.generate` · Generate Playbook                | writes `generated/` now                               |
| `afd.syntaxCheck` · Check Generated Code (Syntax) | `ansible-playbook --syntax-check` in your environment |
| `afd.runSkeleton` · Run as Skeleton (Check Mode)  | generates the code and runs it in check mode          |
| `afd.runReal` · Run for Real…                     | runs it for real, after a confirmation                |
| `afd.showAudit` · Show Run Audit Log              | the local log of every launch (no input values)       |
| `afd.catalog.rebuild` · Rebuild Module Catalog    | reads the environment's collection docs again         |

## AWX

| Command                                       | Does                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------- |
| `afd.awx.setToken` · Set AWX Token            | stores a personal access token in SecretStorage                         |
| `afd.awx.clearToken` · Clear AWX Token        | removes it                                                              |
| `afd.awx.setupTemplate` · Set Up AWX Template | creates or updates the job template (or approval workflow) for the flow |
| `afd.awx.launch` · Launch in AWX              | launches it and follows the job on the canvas                           |

## AI assistants

| Command                                     | Does                                                                  |
| ------------------------------------------- | --------------------------------------------------------------------- |
| `afd.setupAi` · Set Up AI Assistants…       | copies the skill and registers the flow tools for the agents you pick |
| `afd.removeAi` · Remove AI Assistant Setup… | removes what setup wrote                                              |

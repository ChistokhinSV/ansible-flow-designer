# Glossary

The words the designer, its commands and this guide use, one word per thing. The designer's labels,
the Command Palette and these pages are checked against the **Not** column. Back to the
[guide](../README.md).

## Writing rules

- **Actions** (commands, menu items, buttons) are in Title Case, as in VS Code's own menus:
  **Tidy Up**, **Add Node Here…**, **Open in Text Editor**. An action that asks for something before
  it acts ends with "…".
- **Messages, descriptions and tooltips** are sentences: "Lay out the whole level again".
- **Port names** are written as in the file: `ok_hosts`, `failed_hosts`, `unreachable`.
- No milestone or decision codes in what users read: no "(M5)", no "decision 3".

## The flow

| Term            | Meaning                                                                                                      | Not                   |
| --------------- | ------------------------------------------------------------------------------------------------------------ | --------------------- |
| flow            | the diagram in a `*.flow.yaml` file, and the automation it describes                                         |                       |
| node            | a box on the canvas: start, end, task, subflow, decision, approval, parallel or join                         | `New node`            |
| step            | a node that runs something: a task, an approval, or a subflow                                                |                       |
| port            | where a wire starts or ends on a node; hosts leave a node through one of its output ports                    |                       |
| wire            | a connection from an output port to the `in` port of the next node: the hosts that left by the port go there |                       |
| open port       | a fail-type port without a wire: its hosts fail in the outcome, and the banner counts it                     |                       |
| open on purpose | an open port accepted with a reason: its hosts stop in the outcome, and the banner no longer counts it       |                       |
| level           | what the canvas shows at a time: the top level, or the inside of one subflow                                 |                       |
| subflow         | a node that holds its own level; hosts enter through its entry and leave through its ports                   |                       |
| entry, exit     | where hosts enter a subflow's inside, and the inner port that leaves through one of the subflow's ports      |                       |
| binding         | what a step runs: a module, a role or a playbook, with its parameters                                        | `Bind implementation` |
| status          | how far a node is: draft, specified, implemented, tested                                                     |                       |
| problem         | something the design check found, in the banner and the Problems panel                                       |                       |
| finding         | something a lens found, in the lens's panel                                                                  |                       |
| lens            | a view over the whole flow (Inventory, Access, Data, Timing, Code) with chips on the nodes and findings      |                       |
| drift           | a difference between the design and the code it runs, shown in Code mode                                     |                       |

## Modes and panels

| Term        | Meaning                                                                             | Not                              |
| ----------- | ----------------------------------------------------------------------------------- | -------------------------------- |
| Design mode | drawing the flow: nodes, wires, ports, subflows                                     |                                  |
| Code mode   | what each step runs and how it stands against the code (drift)                      | `Implementation mode`            |
| Run mode    | the last run on the canvas, read-only                                               |                                  |
| Details     | the panel that edits a node: General, Binding, Inputs and outputs, Ports, Execution | `Properties…`, `Open properties` |
| Binding tab | the Details tab that sets the binding                                               | `Implementation tab`             |

## Actions

| Action                               | Does                                                                                                                                                                                           | Not                                                                                                                                                                                |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Add Node                             | adds a node (from the palette, a port, or the canvas menu's **Add Node Here…**)                                                                                                                | `Add node`, `Add step`                                                                                                                                                             |
| Tidy Up                              | lays out the open level again                                                                                                                                                                  | `Tidy up`, `Tidy Up Layout`, `Auto-layout`                                                                                                                                         |
| Open in Text Editor                  | opens the flow file, or a node's place in it, in VS Code's text editor                                                                                                                         | `Open as text`, `Open as Text`, `Show as text`, `Show in text`                                                                                                                     |
| Check Flow                           | checks the design, then the generated code in your Ansible environment                                                                                                                         | `Validate design`, `Validate Design`, `Check Generated Code`                                                                                                                       |
| Generate Code                        | writes the playbooks in `generated/`                                                                                                                                                           | `Generate Playbook`                                                                                                                                                                |
| Accept with Reason…                  | records why something stays as it is: an open port (open on purpose), drift, a lens finding                                                                                                    | `Leave open on purpose…`, `Mark expected`, `Mark as expected`                                                                                                                      |
| Reopen                               | takes back an Accept with Reason…                                                                                                                                                              | `Stop ignoring`                                                                                                                                                                    |
| Re-sync                              | compiles the code in your environment and compares it with the design                                                                                                                          | `Resync`, `Re-sync from git`                                                                                                                                                       |
| Run as Skeleton                      | runs the flow in check mode; steps without a binding run as TODO messages                                                                                                                      | `dry run`, `Run as skeleton`                                                                                                                                                       |
| Run for Real…                        | runs the flow for real, after a confirmation                                                                                                                                                   | `Run for real…`                                                                                                                                                                    |
| Stop Run                             | ends the local run, or cancels the job or workflow in AWX                                                                                                                                      |                                                                                                                                                                                    |
| Launch in AWX                        | runs the flow as its AWX job template or workflow                                                                                                                                              |                                                                                                                                                                                    |
| Import AWX Workflow or Job Template… | turns a workflow or job template, from AWX or an `awx export` file, into a new flow                                                                                                            | `Import from AWX`                                                                                                                                                                  |
| canvas and port menus                | Title Case like every action: Open Subflow, Peek Code, Fit View, Select All, Paste Here, Up to Parent, Add Next Node, Insert Node on This Wire, Extract into Subflow…, Rewire to Another Node… | `Open subflow`, `Peek code`, `Fit view`, `Select all`, `Paste here`, `Up to parent`, `Add next node`, `Insert node on this wire`, `Extract into subflow`, `Rewire to another node` |

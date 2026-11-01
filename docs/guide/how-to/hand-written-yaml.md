# Hand-written YAML and Complete IDs

A flow file is YAML you can read and write. The designer uses 26-character IDs (ULIDs) so that
renames never break anything. You do not have to write them: name nodes by **key**, and let
**Complete IDs** add the IDs.

## Write a flow by key

```yaml
schema_version: 1
flow:
  key: ntp-check
  name: NTP check
  version: 1
  inputs:
    devices: { type: host_list, required: true, targets: true }
nodes:
  - { key: start, type: start, title: Start }
  - { key: check-ntp, type: task, title: Check NTP, intent: Read the NTP peers }
  - { key: done, type: end, title: Done, outcome: success }
edges:
  - from: { node: start, port: ok_hosts }
    to: { node: check-ntp, port: in }
  - from: { node: check-ntp, port: ok_hosts }
    to: { node: done, port: in }
```

- Keys are lowercase letters, digits and dashes, unique on their level.
- Wires, subflow entries and exits, decisions and layout may name nodes by key.
- The [flow file format](../reference/flow-format.md) lists every field.

## Complete the IDs

The designer opens such a file with a **Written by hand** banner. It shows the flow, but locks
canvas edits, runs and code generation until the IDs are there. The Problems panel lists each gap
(`missing-id`).

![The written-by-hand banner](../images/hand-written-light.png)

Click **Complete IDs** in the banner, use the lightbulb quick fix in the text editor, or run
**Ansible Flow: Complete IDs**. It adds every ID and turns key references into ID references, in one
edit that one undo reverts. Comments and formatting stay as they are.

Paste does the same for snippets ([copy and paste](copy-paste.md)).

## Edit with the Red Hat YAML extension

With the Red Hat YAML extension installed, **Open in Text Editor** gets completion, hovers and validation
from the flow schema. The schema is registered for `*.flow.yaml`.

## Keep in mind

- Do not edit `flow.version`, `layout` or files in `generated/`. The designer bumps the version on
  save (once per commit) and regenerates the code.
- Every fail port needs a wire or a `decisions:` entry with a reason.
- `status: tested` is set only by a passing run.

# 01 · Product overview

## Problem

Production Ansible work is usually designed in someone's head and then written straight into YAML. The result works but is hard to review, hard to explain to approvers, and failure handling tends to be added only after the first incident. Existing visual tools either show code that already exists (AWX workflow visualizer) or are generic workflow builders with no understanding of Ansible concepts such as hosts, inventories, check mode or idempotency.

## Product goal

Let engineers design automation top-down: outcome first, then structure, then data contracts, then implementation. Keep one graph as the single source of truth from the first sketch to production runs.

## Primary users

- Network and infrastructure engineers who write Ansible (primary). Comfortable with YAML, inventories, AWX.
- Reviewers and change approvers who need to understand what a flow will touch without reading code.
- On-call engineers reading a run after a failure.

## Core capabilities

1. Sketch a flow with draft nodes and typed ports before any code exists. A draft flow is runnable as a "walking skeleton" (each draft node emits a TODO debug task).
2. Define data contracts (inputs and outputs) per node and per flow.
3. Decompose large nodes into subflows, with a preview on hover and a drill-down view.
4. Bind leaf nodes to modules, roles or playbooks with in-place search and documentation.
5. Make failure handling visible and cheap to add: typed failure ports, open-port warnings, failure patterns, compensation (`undo`).
6. Render the same graph in three modes (Design, Implementation, Run) and through lenses (Inventory, Data, Code, Access, Timing) without cluttering the canvas.
7. Keep design and code in sync through stable node IDs embedded in generated code, with drift detection in both directions.
8. Export to Git and run through AWX.

## Out of scope for the first version

- Visualizing individual tasks inside a role on the main canvas (stop at role or playbook granularity; tasks belong in the inspector or code view).
- A full YAML or Jinja editor inside the app (link to Git or an external editor instead).
- Multi-user real-time co-editing.
- Non-Ansible execution engines.

## Success signals

- A new flow can be sketched and run as a skeleton in under 15 minutes.
- Every node in a production flow has either a connected fail port or an explicit "open on purpose" decision.
- Reviewers can answer "which devices and credentials does this touch" from the Inventory and Access lenses alone.

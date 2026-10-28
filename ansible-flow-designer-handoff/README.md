# Ansible Flow Designer — design handoff bundle

This bundle describes a visual, top-down designer for Ansible automation flows. It is written for an implementer (Claude Code or a developer) starting from zero. Everything here is a design specification and visual reference, not production code.

> **Target platform update (2026-10-28):** the product ships as a **VS Code extension**, not a standalone web app. Product docs 01–05 still hold. The architecture in 06 is superseded by `docs/08-vscode-extension-target.md`. `docs/07-lessons-from-playbook-studio.md` records verified engineering knowledge from the predecessor project (`C:\HOME\1.SCRIPTS\122.ansible_playbook_studio`, paused). Read both before planning.

## What the product is

A web UI (now: a VS Code custom editor, see 08) where an engineer first sketches an automation flow as a graph of nodes and ports, without writing any Ansible, and then progressively binds each node to real implementation (modules, roles, playbooks). The same graph stays the source of truth afterwards: it renders the design, the implementation (with drift against Git), and live or past runs from AWX.

## Reading order

1. `docs/01-product-overview.md` — problem, goals, users, scope.
2. `docs/02-design-decisions.md` — every decision made during design, with rationale and rejected alternatives. Read this before writing code.
3. `docs/03-data-model.md` — the flow document (`flow.yaml`), IDs, nodes, ports, edges, statuses.
4. `schema/flow.schema.json` — JSON Schema for the flow document.
5. `docs/04-ui-spec.md` — every screen and interaction, mapped to the mockups.
6. `docs/05-ansible-mapping.md` — how the graph becomes Ansible and AWX objects, and how code maps back.
7. `docs/06-implementation-plan.md` — milestones and open questions (its architecture section is superseded by 08).
8. `docs/07-lessons-from-playbook-studio.md` — what is already proven about Ansible: the probe, module docs at scale, inventory, variables, generated-code checks, YAML round-trip, with numbers and pitfalls.
9. `docs/08-vscode-extension-target.md` — what changes as a VS Code extension, the suggested architecture and the questions to settle.
10. `mockups/index.html` — open in a browser; one file per screen.
11. `examples/` — two complete flow documents and a generated skeleton playbook.

## Bundle contents

```
README.md
docs/
  01-product-overview.md
  02-design-decisions.md
  03-data-model.md
  04-ui-spec.md
  05-ansible-mapping.md
  06-implementation-plan.md
  07-lessons-from-playbook-studio.md
  08-vscode-extension-target.md
schema/
  flow.schema.json
examples/
  edge-baseline.flow.yaml
  os-upgrade.flow.yaml
  edge-baseline.skeleton.yml
mockups/
  index.html
  01-designer-main.html ... 11-node-properties.html
```

## Notes on the mockups

- They are static HTML exports of design artboards. Pixel values, colors and copy are indicative; the spec in `docs/04-ui-spec.md` wins where they disagree.
- `07-hover-ports-interactive.html` is the only interactive one (hover a node, click a port).
- `02` and `03` were drawn before port names were finalized and still say `success`/`failure`. The final names are in `docs/03-data-model.md`.
- Values in square brackets such as `[JOB ID]` and `[AUTHOR]` are placeholders.

## Suggested first prompt for Claude Code

Use `../KICKOFF_PROMPT.md` (one level up, in the project root). It replaces the short prompt that used to be here, and covers the VS Code target and the predecessor's knowledge.

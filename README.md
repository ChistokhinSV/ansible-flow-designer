# Ansible Flow Designer

A VS Code extension for designing Ansible automation top-down. You sketch a flow as a graph of typed nodes and ports, run it as a walking skeleton, and then bind each node to a module, role or playbook. The flow document (`*.flow.yaml`) stays the source of truth: Ansible code is generated from it, and drift is detected in both directions.

**Status: M1 done.** The designer opens flow documents, validates them and edits them on a canvas. Code generation and skeleton runs arrive in M3, binding in M5, Run mode in M7 (plan: `docs/adr/`, handoff `docs/06`). Tracking: YouTrack project AFD (epic AFD-1, M1 = AFD-2), knowledge base AFD-A-1.

## What M1 does

- `*.flow.yaml` opens in the **Ansible Flow Designer** custom editor; _Open as Text_ (editor title bar) shows the YAML. Both views edit the same document, so save, dirty state, undo/redo, Git diff and hot exit are VS Code's own.
- **Canvas (Design mode):** nodes by type (task, subflow, decision, approval, parallel, join, start, end) and lifecycle status (draft, specified, implemented, tested); ports placed by role (control in on top, outcomes at the bottom, problems on the right, undo on the left); wires colored by port, dashed for problem paths; far zoom shows titles only.
- **Editing:** drag to move, drag from a port to another node to wire it, release on empty canvas to add a node there (Quick add), Delete/Backspace to remove, palette click or drag to add. The inspector edits title, key, intent, status, contract (inputs and outputs), optional ports and type-specific fields. The flow panel edits name, key, goal, owner and flow inputs and shows readiness counters.
- **Every canvas action is one minimal text edit** made by the extension host with a byte-preserving YAML engine: comments, quoting and formatting outside the edited lines never change, and one Ctrl+Z undoes one action.
- **Validation:** JSON Schema (`schema/flow.schema.json`) plus semantic checks (IDs, keys, ports, edges, references, decisions, subflow boundary, status) go to the Problems panel; open fail ports also show in the canvas banner.
- **Layout** lives in one `layout:` block of the flow file. Flows without positions are auto-laid out (ELK) in memory and only written on the first move or _Tidy up_.
- **`flow.version`** is bumped once per commit on save when the semantic content changed (compared with Git HEAD), never for layout-only changes.

## Install

From a VSIX (Marketplace and Open VSX publishing follows later):

```bash
just package
```

```bash
code --install-extension out/ansible-flow-designer-0.1.0.vsix
```

Requires VS Code 1.140 or later. M1 needs no Ansible installation; from M3 on, an Ansible environment (Docker/Podman EE image, VS Code Remote, or a local venv with ansible-core 2.19+) is used.

## Usage

- **New flow:** Command Palette → _Ansible Flow: New Flow…_ creates `flows/<key>/<key>.flow.yaml` in the workspace with a start and an end node.
- **Open:** click any `*.flow.yaml` file. _Ansible Flow: Validate Design_, _Tidy Up Layout_ and _Open as Text_ are in the Command Palette and the top bar.

A minimal flow document (all values fictional):

```yaml
schema_version: 1
flow:
  id: 01JC5Z8V2B3N4M5P6Q7R8S9T0V
  key: ntp-baseline
  name: NTP baseline
  version: 1
  inputs:
    devices:
      type: host_list
      required: true
      targets: true
nodes:
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0W
    key: start
    type: start
    title: Start
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0X
    key: push-ntp
    type: task
    title: Push NTP servers
    status: draft
    intent: Configure ntp1.example.net and ntp2.example.net
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0Y
    key: done
    type: end
    title: Done
    outcome: success
edges:
  - id: 01JC5Z8V2B3N4M5P6Q7R8S9T0Z
    from: { node: 01JC5Z8V2B3N4M5P6Q7R8S9T0W, port: ok_hosts }
    to: { node: 01JC5Z8V2B3N4M5P6Q7R8S9T0X, port: in }
```

Opened in the designer, `push-ntp` shows an amber `failed_hosts` port and the banner says _1 open fail port_ until that port is wired to a handler or marked open on purpose. More complete examples: `examples/edge-baseline.flow.yaml`, `examples/os-upgrade.flow.yaml`.

Port catalog per node type (ADR-0004):

| Type          | Default ports                    | Optional                                                             |
| ------------- | -------------------------------- | -------------------------------------------------------------------- |
| start         | `ok_hosts`                       | none                                                                 |
| end           | `in`                             | none                                                                 |
| task, subflow | `in`, `ok_hosts`, `failed_hosts` | `unreachable`, `unchanged`, `always`, `cancelled`, `timeout`, `undo` |
| decision      | `in`, `true`, `false`            | none                                                                 |
| approval      | `in`, `approved`, `rejected`     | `timeout`                                                            |
| parallel      | `in`, `branch_1..n`              | none                                                                 |
| join          | `in`, `ok_hosts`                 | `failed_hosts`                                                       |

## Repository

| Path                             | What                                                                                                     |
| -------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `ansible-flow-designer-handoff/` | Design bundle (product docs 01–08, mockups, original schema and examples). Reference only, never edited. |
| `schema/flow.schema.json`        | Canonical flow document schema (v1 plus additive fields, ADR-0004).                                      |
| `examples/`                      | Example flows, byte-identical copies of the handoff examples.                                            |
| `src/core/`                      | Pure TypeScript: YAML edit engine, flow model, validation, commands, host⇄webview protocol.              |
| `src/extension/`                 | Extension host: custom editor, sessions, diagnostics, version bump, auto-layout, test API.               |
| `src/webview/`                   | React + React Flow canvas and panels; `harness/` is a dev-only page with a fake host.                    |
| `test/`                          | Vitest unit/component tests, VS Code integration and perf tests, fixtures.                               |
| `docs/adr/`                      | Architecture decisions.                                                                                  |

## Development

Requires Node 24+, npm, Git and [just](https://github.com/casey/just).

```bash
just install
```

| Recipe                           | Does                                                                        |
| -------------------------------- | --------------------------------------------------------------------------- |
| `just build` / `just build-prod` | Build extension host (esbuild) and webview (Vite); production is minified   |
| `just watch`                     | Rebuild on change                                                           |
| `just check`                     | Type-check (TypeScript 7) and lint/format check (Biome)                     |
| `just fmt`                       | Apply Biome formatting and safe fixes                                       |
| `just test [args]`               | Unit and component tests (Vitest); `AFD_FUZZ_STEPS=3000` deepens the fuzzer |
| `just test-int [version]`        | Integration tests inside VS Code (`stable`, `insiders` or e.g. `1.140.0`)   |
| `just perf [version]`            | Performance suite on the production bundle                                  |
| `just harness`                   | Webview harness on http://localhost:5178/harness/index.html?flow=os-upgrade |
| `just package`                   | Build the VSIX into `out/`                                                  |

Press F5 in VS Code to start an Extension Development Host with `examples/` open. The harness runs the real webview against an in-page fake host (`?flow=edge-baseline|os-upgrade`, `&theme=light|dark|hc`) for visual checks without VS Code.

## License

MIT, see `LICENSE`. Bundled third-party packages and their licenses: `THIRD_PARTY_NOTICES.md`.

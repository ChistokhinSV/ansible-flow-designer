# Ansible Flow Designer

Design Ansible automation as a diagram in VS Code. You draw the steps and decide what happens when each one fails; the extension writes the playbook and runs it. The diagram is a YAML file (`*.flow.yaml`) in your repository, next to your playbooks, and every step can later run a module, a role or a playbook of your own.

![The Hello, Ansible sample in the designer](docs/guide/images/hello-light.png)

## Your first flow in three steps

1. Open a folder (an empty one is fine), click the **Ansible Flows** icon in the Activity Bar, then **New Flow**.
2. Click **Add a Step**, then press **N** for the next one. Save: each step is now a play in `generated/<key>.yml` (**Peek Code** shows it).
3. Answer the banner (_what should happen when this step fails?_), then **Run as Skeleton** on `localhost`.

The **Your first flow** checklist in the designer ticks off these steps, and **Ansible Flow: Get Started** opens the same walkthrough on VS Code's Welcome page. Or open the **Hello, Ansible** sample (**Open Sample Flow…**): three steps that already run.

## Learn

- **[Tutorial 1: your first flow](docs/guide/tutorials/01-first-flow.md)** (10 minutes), then [from design to production](docs/guide/tutorials/02-design-to-production.md), [AWX end to end](docs/guide/tutorials/03-awx-end-to-end.md), [with an AI assistant](docs/guide/tutorials/04-ai-assistant.md) and [bring existing playbooks into flows](docs/guide/tutorials/05-import-playbooks.md).
- **[How flows work](docs/guide/explanation/how-flows-work.md):** hosts travel along wires, a step is a play, how failures end.
- **[The user guide](docs/guide/README.md)**, also in VS Code (**Ansible Flow: Open User Guide**, or "?" in the designer): how-to pages, [commands](docs/guide/reference/commands.md), [settings](docs/guide/reference/settings.md), [glossary](docs/guide/reference/glossary.md), [troubleshooting](docs/guide/troubleshooting.md).

## What it does

- **Design top-down:** steps, decisions, approvals, parallel branches and subflows on a canvas, each failure handled where you draw it, with notes, sections and text that explain the flow.
- **Failures in one click:** rollback from backup, notify on-call and stop, exclude and report, retry, or keep a port open with a reason.
- **Playbooks from the diagram:** written on every save, one play per step; a skeleton run (`--check`) works before any step has code.
- **Bind steps** to modules, roles or playbooks from your environment's catalog, with their docs, and pass data between steps and across subflows; poll until a device is back.
- **Design and code side by side:** Code mode compares the flow with the code it runs and fixes drift either way.
- **Run** locally (check mode or for real, audited) or in AWX with approvals; Run mode shows where every host went.
- **Lenses** over the whole flow: inventory, data, code, access, timing, changes since a commit.
- **Bring what you have:** import playbooks and AWX workflows or job templates.
- **AI assistants** (Copilot, Claude Code and others) build and fix flows with flow tools, by key.
- **Share it:** export draw.io diagrams and images; scenario tests check where hosts end.

Everything, in one list: [features](docs/guide/reference/features.md).

## Install

From a VSIX (Marketplace and Open VSX publishing follows later). Build one from this repository with
`just package`, then install it (the file name carries the version):

```bash
code --install-extension out/ansible-flow-designer-0.50.0.vsix
```

Requires VS Code 1.140 or later. Designing needs no Ansible installation. Runs and syntax checks need an Ansible environment with ansible-core 2.19 or later, and **Set Up Ansible Environment…** helps you pick one:

- an execution environment image through Docker or Podman (the setup proposes the public `ghcr.io/ansible/community-ansible-dev-tools` image);
- on Windows, a WSL distribution with Ansible in it (WSL 1 or 2: `afd.environment.kind: wsl`, or pick it in the setup);
- or VS Code Remote (WSL, SSH, Dev Container), or a local venv.

`docker/afd-ee.Dockerfile` builds a minimal one (`just ee-build 2.19`).

### Settings

| Setting                            | Default | Meaning                                                                                                                                                  |
| ---------------------------------- | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `afd.codegen.onSave`               | `true`  | Write `generated/` whenever a flow without errors is saved                                                                                               |
| `afd.environment.kind`             | `auto`  | `container` when an image is set, else `local`                                                                                                           |
| `afd.environment.image`            | (empty) | EE image, e.g. `registry.example.net/ee/netops:2.19`; empty uses the Red Hat Ansible extension's `ansible.executionEnvironment.image` when it is enabled |
| `afd.environment.containerEngine`  | `auto`  | `docker` or `podman` (auto: the Red Hat Ansible setting, else docker)                                                                                    |
| `afd.environment.containerOptions` | `[]`    | Extra `docker run` arguments, e.g. `["-v", "/home/jane/.ssh:/home/ansible/.ssh:ro"]`                                                                     |
| `afd.environment.python`           | (empty) | Interpreter for local mode; empty uses `ansible.python.interpreterPath`, else `python3`                                                                  |
| `afd.run.inventory`                | (empty) | Inventory relative to the repository root; empty uses the `ansible.cfg` default                                                                          |
| `afd.run.askVaultPassword`         | `auto`  | `auto` asks when the inventory or repository vars contain vault data                                                                                     |
| `afd.awx.url`                      | (empty) | AWX address for _Launch in AWX_, e.g. `https://awx.example.net`; the token is kept in VS Code's secret storage (_Set AWX Token_), never in settings      |
| `afd.awx.verifyTls`                | `true`  | Verify AWX's TLS certificate; turn off only for a lab AWX with a self-signed certificate                                                                 |

Example `.vscode/settings.json` for a Windows machine with Docker Desktop:

```json
{
  "afd.environment.image": "afd-ee:2.19",
  "afd.run.inventory": "inventories/lab/hosts.yml"
}
```

## Repository

| Path                             | What                                                                                                                                                                        |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ansible-flow-designer-handoff/` | Design bundle (product docs 01–08, mockups, original schema and examples). Reference only, never edited.                                                                    |
| `schema/flow.schema.json`        | Canonical flow document schema (v1 plus additive fields, ADR-0004).                                                                                                         |
| `examples/`                      | Example flows, byte-identical copies of the handoff examples; `generated/` holds their golden generated code.                                                               |
| `src/core/`                      | Pure TypeScript: YAML edit engine, flow model, validation, commands, port menus, failure patterns, host⇄webview protocol.                                                   |
| `src/core/engine/`               | Option A code generation (ADR-0009), generated-file checksums, the code preview.                                                                                            |
| `src/core/run/`                  | Environment resolution, probe and run command lines, run-event summary.                                                                                                     |
| `src/core/drift/`                | Code sync and drift: scan types, `computeDrift` (D-29 kinds and actions), role stubs and argument specs (M6).                                                               |
| `src/core/awx/`                  | AWX API types, AWX job events → `afd_events` lines (M7); workflow and job template import sources and the mapping to a flow (M9, AFD-26).                                   |
| `src/core/import/`               | Playbook import (AFD-26): the Ansible source reader (playbooks, task files, roles, vault kept opaque), the as-is mapper, shared secret rules, the re-import merge (AFD-61). |
| `src/extension/import/`          | Import commands' shared helpers (key, workspace files, notes), _Import Ansible Playbooks…_ (AFD-26) and _Re-import from Source_ (AFD-61).                                   |
| `src/core/lens/`                 | The five lenses, semantic zoom summary rows, requirements specs, run history statistics (M8).                                                                               |
| `src/extension/lens/`            | Lens facts: the inventory through the probe, the catalog's view of each binding, requirements pins (M8).                                                                    |
| `src/extension/awx/`             | AWX client, token, Set Up AWX Template, Launch in AWX with event polling (M7), the AWX import (M9, AFD-26), approval workflows (AFD-11).                                    |
| `lab/`                           | GNS3 lab: Git server on ops1, Docker suites on the GNS3 VM, setup notes (`lab/README.md`, M7).                                                                              |
| `src/core/ai/`                   | AI tool core: key references, the op language, flow descriptions, tool specs and handlers, the generated reference (AFD-19).                                                |
| `src/mcp/`                       | The MCP server for terminal agents (`dist/mcp.js`) and its file-system IO (AFD-19).                                                                                         |
| `src/extension/ai/`              | Copilot tools, Complete IDs quick fix, Set Up / Remove AI Assistants (skill copies, MCP registrations, launcher) (AFD-19).                                                  |
| `skills/`, `instructions/`       | The `ansible-flow` skill (`references/` generated by `just gen-ai`) and Copilot instructions for `*.flow.yaml` (AFD-19).                                                    |
| `src/core/catalog/`              | Catalog types, search ranking, repository context, the binding draft (form, checklist, `@` choices) (M5).                                                                   |
| `src/extension/sync/`            | Re-sync (probe compile, roles, Git state, catalog returns) and the drift actions that write code (M6).                                                                      |
| `src/extension/catalog/`         | SQLite FTS5 catalog index, its build worker, the catalog service, catalog-backed binding checks (M5).                                                                       |
| `src/extension/`                 | Extension host: custom editor, sessions, diagnostics, version bump, auto-layout, codegen on save, probe client, runs, audit, test API.                                      |
| `probe/`                         | Python probe (`afd_probe`, stdlib only) and the `afd_events` callback; pytest contract tests (uv).                                                                          |
| `docker/afd-ee.Dockerfile`       | Minimal execution environment image for tests and runs; `afd-awx-ee.Dockerfile` adds ansible-runner for AWX (M7).                                                           |
| `src/webview/`                   | React + React Flow canvas and panels; `harness/` is a dev-only page with a fake host.                                                                                       |
| `test/`                          | Vitest unit/component tests, VS Code integration and perf tests, fixtures.                                                                                                  |
| `docs/adr/`, `docs/spikes/`      | Architecture decisions; the M3 Option A spike (playbooks and results).                                                                                                      |

## Development

Requires Node 24+, npm, Git and [just](https://github.com/casey/just).

```bash
just install
```

| Recipe                           | Does                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `just build` / `just build-prod` | Build extension host (esbuild) and webview (Vite); production is minified            |
| `just watch`                     | Rebuild on change                                                                    |
| `just check`                     | Type-check (TypeScript 7) and lint/format check (Biome)                              |
| `just fmt`                       | Apply Biome formatting and safe fixes                                                |
| `just test [args]`               | Unit and component tests (Vitest); `AFD_FUZZ_STEPS=3000` deepens the fuzzer          |
| `just test-int [version]`        | Integration tests inside VS Code (`stable`, `insiders` or e.g. `1.140.0`)            |
| `just perf [version]`            | Performance suite on the production bundle                                           |
| `just test-yaml [version]`       | With the Red Hat YAML extension installed: flows are validated by our schema (AFD-5) |
| `just test-engine [images]`      | Generated code runs with simulated outcomes in each Ansible image (Docker)           |
| `just probe-test [images]`       | Probe contract tests (pytest via uv) in each image                                   |
| `just test-catalog dir`          | Search quality and latency gates on a full catalog dump (`<cache>/<core-minor>`)     |
| `just ee-build [core]`           | Build `afd-ee:<core>` from `docker/afd-ee.Dockerfile`                                |
| `just awx-ee-build [core]`       | Build `afd-awx-ee:<core>` (adds ansible-runner) for AWX                              |
| `just awx-lab [--sync]`          | Create the lab AWX objects (EE, project, inventory); `--sync` updates the project    |
| `just awx-lab --fixtures`        | Also the M9 import fixture workflows; `--record-import f` records their API answers  |
| `just test-awx [version]`        | Run mode against the lab AWX (needs `AFD_AWX_URL`, `AFD_AWX_TOKEN`; see `lab/`)      |
| `just test-lens [version]`       | The lens suite inside VS Code (its inventory test needs `AFD_TEST_IMAGE`)            |
| `just test-extract [version]`    | Extract into Subflow inside VS Code (AFD-7)                                          |
| `just test-clipboard [version]`  | Copy and paste of nodes inside VS Code (AFD-17); restores your clipboard afterwards  |
| `just test-edit [version]`       | One undo step per selection edit inside VS Code (AFD-18)                             |
| `just test-ai [version]`         | AI assistants inside VS Code: Complete IDs, Copilot tools, setup (AFD-19)            |
| `just test-mcp`                  | The MCP server end to end over stdio on the production bundle (AFD-19)               |
| `just gen-ai`                    | Regenerate the skill references and the Copilot tool entries in `package.json`       |
| `just test-import [version]`     | AWX workflow import inside VS Code (skeleton run: `AFD_TEST_IMAGE`; API: lab AWX)    |
| `just test-docker-lab [suites]`  | Engine, probe and Docker integration suites in a container on the GNS3 VM            |
| `just codegen [--check] flows…`  | Generate (or check) `generated/` for flow files from the command line                |
| `just harness`                   | Webview harness on http://localhost:5178/harness/index.html?flow=os-upgrade          |
| `just package`                   | Build the VSIX into `out/`                                                           |

`AFD_TEST_IMAGE=afd-ee:2.19 just test-int` also runs the integration tests that need the image: real skeleton runs (M3), the real catalog dump (M5) and a real Re-sync (M6); they are skipped without it. The engine and probe suites default to the `ps-probe-env:2.19/2.20/2.21` stand-in images. Pass `afd-ee:<core>` images to use the ones built here.

Press F5 in VS Code to start an Extension Development Host with `examples/` open. _Run Extension (other extensions off)_ starts faster: only this extension runs. The debugger reads the host bundles' source maps only, so the first start under the debugger stays well within VS Code's 10-second limit (AFD-18 follow-up). The harness runs the real webview against an in-page fake host (`?flow=edge-baseline|os-upgrade`, `&theme=light|dark|hc`) for visual checks without VS Code.

## License

MIT, see `LICENSE`. Bundled third-party packages and their licenses: `THIRD_PARTY_NOTICES.md`.

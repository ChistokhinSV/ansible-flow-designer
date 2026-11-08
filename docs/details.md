# Ansible Flow Designer: details

The [README](../README.md) is the short version. This page covers:

- what the extension needs;
- how it is configured;
- how the repository is organised;
- how to build and test it from source.

## Requirements

- **VS Code** 1.94 or later. Two features need more:
  - the **module catalog** (search, docs and binding checks) needs Node.js 22.13 in the editor,
    which VS Code has since 1.101; in an older editor it is off and says why;
  - **Copilot's flow tools** need VS Code 1.95 or later. Other assistants use the MCP server
    (**Set Up AI Assistants…**).
- **Designing** a flow (canvas, validation, generated playbooks) needs nothing else.
- **Running** a flow, syntax checks, the module catalog, lenses and Re-sync need an Ansible
  environment with ansible-core 2.19 or later. **Set Up Ansible Environment…** helps you pick one
  of these:
  - an execution environment image through Docker or Podman (the setup proposes the public
    `ghcr.io/ansible/community-ansible-dev-tools` image);
  - on Windows, a WSL distribution with Ansible in it (WSL 1 or 2: `afd.environment.kind: wsl`);
  - VS Code Remote (WSL, SSH, Dev Container), or a local venv.
- `docker/afd-ee.Dockerfile` builds a minimal image: `just ee-build 2.19`.
- **AWX** runs need `afd.awx.url` and a token (_Set AWX Token_). The token is kept in VS Code's
  secret storage, never in settings.

Every setting is described in [the settings reference](guide/reference/settings.md), and common
setups in [settings for common setups](guide/how-to/settings.md). For example,
`.vscode/settings.json` on a Windows machine with Docker Desktop:

```json
{
  "afd.environment.image": "afd-ee:2.19",
  "afd.run.inventory": "inventories/lab/hosts.yml"
}
```

In a workspace you have not trusted (Restricted Mode), you can design flows and generate
playbooks. Runs and the probe wait until you trust the workspace.

## Documentation map

| Where                                                                   | What                                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [`docs/guide/`](guide/README.md)                                        | The user guide: tutorials, how-to pages, explanation and reference |
| [`docs/guide/reference/features.md`](guide/reference/features.md)       | Every feature in one list                                          |
| [`docs/guide/reference/flow-format.md`](guide/reference/flow-format.md) | The flow file format (generated from the schema)                   |
| [`docs/guide/reference/problems.md`](guide/reference/problems.md)       | Every problem code, what it means and how to fix it                |
| [`docs/adr/`](adr/)                                                     | Architecture decisions, one file each, with their amendments       |
| [`CHANGELOG.md`](../CHANGELOG.md)                                       | What each version changed                                          |

## Repository

| Path                                  | What                                                                                                                                 |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `schema/flow.schema.json`             | The flow document schema; editors validate `*.flow.yaml` with it                                                                     |
| `examples/`, `samples/`               | Example flows (with their golden generated code) and the samples **Open Sample Flow…** copies                                        |
| `src/core/`                           | Pure TypeScript: the byte-preserving YAML edit engine, flow model, validation, commands, failure patterns, the host⇄webview protocol |
| `src/core/engine/`                    | Code generation (ADR-0009) and generated-file checksums                                                                              |
| `src/core/run/`, `src/core/drift/`    | Environments, probe and run command lines, run summaries; code sync and drift                                                        |
| `src/core/awx/`, `src/core/import/`   | AWX API types and events; playbook, AWX workflow and job template import                                                             |
| `src/core/lens/`, `src/core/catalog/` | The lenses; catalog search, ranking and the binding draft                                                                            |
| `src/core/ai/`, `src/mcp/`            | The flow tools for AI assistants (ops, descriptions, reference) and the MCP server for terminal agents                               |
| `src/extension/`                      | Extension host: custom editor, sessions, diagnostics, codegen on save, probe client, runs, AWX, catalog index, AI setup              |
| `src/webview/`                        | React + React Flow canvas and panels; `harness/` is a dev-only page with a fake host                                                 |
| `probe/`                              | The Python probe (`afd_probe`, stdlib only) and the `afd_events` callback, with pytest contract tests                                |
| `skills/`, `instructions/`            | The `ansible-flow` skill (references generated by `just gen-ai`) and Copilot instructions for `*.flow.yaml`                          |
| `docker/`                             | `afd-ee` (a minimal execution environment for tests and runs) and `afd-awx-ee` (adds ansible-runner for AWX)                         |
| `test/`                               | Vitest unit and component tests, VS Code integration and perf tests, engine contract tests, fixtures                                 |

## Building from source

Requires Node 24+, npm, Git and [just](https://github.com/casey/just).

```bash
just install
```

```bash
just package
```

`just package` builds the VSIX into `out/`. Install it with
`code --install-extension out/ansible-flow-designer-<version>.vsix`.

| Recipe                           | Does                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------- |
| `just build` / `just build-prod` | Build the extension host (esbuild) and the webview (Vite); production is minified |
| `just watch`                     | Rebuild on change                                                                 |
| `just check`                     | Type-check (TypeScript 7) and lint/format check (Biome)                           |
| `just fmt`                       | Apply Biome formatting and safe fixes                                             |
| `just test [args]`               | Unit and component tests (Vitest); `AFD_FUZZ_STEPS=3000` deepens the fuzzer       |
| `just test-int [version]`        | Integration tests inside VS Code (`stable`, `insiders` or e.g. `1.94.2`)          |
| `just test-floor`                | The integration tests on the oldest supported VS Code (1.94.2, Node 20)           |
| `just test-editor path [label]`  | A test suite inside an installed editor built on VS Code, by its executable       |
| `just test-wsl distro [version]` | The integration tests with their runs in a WSL distribution (Windows)             |
| `just perf [version]`            | Performance suite on the production bundle                                        |
| `just test-yaml [version]`       | With the Red Hat YAML extension installed: flows are validated by this schema     |
| `just test-engine [images]`      | Generated code runs with simulated outcomes in each Ansible image (Docker)        |
| `just probe-test [images]`       | Probe contract tests (pytest via uv) in each image                                |
| `just test-catalog dir`          | Search quality and latency gates on a full catalog dump                           |
| `just test-mcp`                  | The MCP server end to end over stdio on the production bundle                     |
| `just test-awx [version]`        | Run mode against an AWX (needs `AFD_AWX_URL` and `AFD_AWX_TOKEN`)                 |
| `just ee-build [core]`           | Build `afd-ee:<core>` from `docker/afd-ee.Dockerfile`                             |
| `just awx-ee-build [core]`       | Build `afd-awx-ee:<core>` (adds ansible-runner) for AWX                           |
| `just gen-ai`                    | Regenerate the skill references and the Copilot tool entries in `package.json`    |
| `just codegen [--check] flows…`  | Generate (or check) `generated/` for flow files from the command line             |
| `just harness`                   | The webview harness on http://localhost:5178/harness/index.html?flow=os-upgrade   |
| `just docs-shots [names…]`       | The user guide's screenshots, taken from the harness in Edge                      |
| `just demo-gif [takes…]`         | The README's animated demos, recorded in VS Code with the VSIX (ffmpeg, WSL)      |
| `just package`                   | Build the VSIX into `out/`                                                        |

**Tests that need Docker.** `AFD_TEST_IMAGE=afd-ee:2.19 just test-int` also runs the integration
tests that need an image: real skeleton runs, the real catalog dump and a real Re-sync. Without
the variable they are skipped. The engine and probe suites take images as an argument, for example
`just test-engine afd-ee:2.19,afd-ee:2.21`.

**Debugging.** Press F5 to start an Extension Development Host with `examples/` open. _Run
Extension (other extensions off)_ starts faster.

**The harness.** It runs the real webview against an in-page fake host, for visual checks without
VS Code. Choose the flow with `?flow=edge-baseline|os-upgrade` and the theme with
`&theme=light|dark|hc`.

## License

MIT, see [`LICENSE`](../LICENSE). Bundled third-party packages and their licenses are listed in
[`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).

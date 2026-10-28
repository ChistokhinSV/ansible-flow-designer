# Ansible Flow Designer

A VS Code extension for designing Ansible automation top-down. You sketch a flow as a graph of typed nodes and ports, run it as a walking skeleton, and then bind each node to a module, role or playbook. The flow document (`*.flow.yaml`) stays the source of truth: Ansible code is generated from it, and drift is detected in both directions.

Status: **M1 in progress** (flow document, design canvas). Tracking: YouTrack project AFD (epic AFD-1), knowledge base AFD-A-1.

## Repository

| Path | What |
|---|---|
| `ansible-flow-designer-handoff/` | Design bundle (product docs 01–08, mockups, original schema and examples). Reference only, never edited. |
| `schema/flow.schema.json` | Canonical flow document schema (v1 plus additive fields, ADR-0004). |
| `examples/` | Example flows, byte-identical copies of the handoff examples. |
| `src/core/` | Pure TypeScript: YAML edit engine, flow model, validation, commands, host⇄webview protocol. |
| `src/extension/` | Extension host: custom editor, diagnostics, version bump, auto-layout. |
| `src/webview/` | React + React Flow canvas and panels; `harness/` is a dev-only page with a fake host. |
| `test/` | Vitest unit/component tests, VS Code integration tests, fixtures. |
| `docs/adr/` | Architecture decisions. |

## Development

Requires Node 24+, npm and [just](https://github.com/casey/just).

```bash
just install
```

```bash
just build
```

| Recipe | Does |
|---|---|
| `just build` / `just build-prod` | Build extension host (esbuild) and webview (Vite); production is minified |
| `just watch` | Rebuild on change |
| `just check` | Type-check (TypeScript 7) and lint/format check (Biome) |
| `just fmt` | Apply Biome formatting and safe fixes |
| `just test [args]` | Unit and component tests (Vitest) |
| `just test-int [version]` | Integration tests inside VS Code (`stable`, `insiders` or e.g. `1.140.0`) |
| `just perf [version]` | Performance suite on the production bundle |
| `just harness` | Webview harness dev server on http://localhost:5178 |
| `just package` | Build the VSIX into `out/` |

Press F5 in VS Code to start an Extension Development Host with `examples/` open.

## License

MIT, see [LICENSE](LICENSE).

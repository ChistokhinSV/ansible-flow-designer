# ADR-0005 · Environments, probe and catalog storage

Status: Accepted · 2026-10-28 · AFD-1

## Decision

- **Environments in v1:** Docker/Podman EE image (primary on Windows), VS Code Remote (WSL, SSH, Dev Container) and a local venv. Remote and venv share the plain "local" probe mode. No raw-SSH repo sync mode. `extensionKind: ["workspace"]`.
- **Minimum versions:** ansible-core 2.19 (Origin tags and the trust model make sources and previews reliable); VS Code 1.140.
- **Probe:** a new stdlib-only Python package (`afd_probe`, Python 3.11+, the floor of ansible-core 2.19) that runs inside the environment and answers with Ansible's own APIs over a JSON-lines session. Quirks carried over as knowledge, not code: set `ANSIBLE_CONFIG` before importing ansible (Docker Desktop mounts are world-writable), the protocol owns stdout, `init_plugin_loader()`, detect inventory scripts by shebang, mount directories rather than single files.
- **redhat.ansible:** soft relationship. When our settings are unset, read its `ansible.python.interpreterPath`, `ansible.executionEnvironment.{enabled,image,containerEngine,containerOptions,volumeMounts,pull.policy}` and `ansible.config.path`. No `extensionDependencies`.
- **Catalog (M5):** SQLite FTS5 through `node:sqlite` in the extension host, index in `globalStorage`. Verified on VS Code 1.143.1 (Electron 43.7.7, Node 24.21.0, SQLite 3.53.4). The probe only dumps (`ansible-doc --metadata-dump --no-fail-on-errors` per collection, in parallel) and normalizes. An M5 spike re-checks VS Code 1.140 and the Remote server runtime; the fallback is an in-memory MiniSearch index. No native Node modules; `sql.js` lacks FTS5 in its default build.

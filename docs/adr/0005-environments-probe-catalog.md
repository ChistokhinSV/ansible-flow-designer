# ADR-0005 · Environments, probe and catalog storage

Status: Accepted · 2026-10-28 · AFD-1

## Decision

- **Environments in v1:** Docker/Podman EE image (primary on Windows), VS Code Remote (WSL, SSH, Dev Container) and a local venv. Remote and venv share the plain "local" probe mode. No raw-SSH repo sync mode. `extensionKind: ["workspace"]`.
- **Minimum versions:** ansible-core 2.19 (Origin tags and the trust model make sources and previews reliable); VS Code 1.140.
- **Probe:** a new stdlib-only Python package (`afd_probe`, Python 3.11+, the floor of ansible-core 2.19) that runs inside the environment and answers with Ansible's own APIs over a JSON-lines session. Quirks carried over as knowledge, not code: set `ANSIBLE_CONFIG` before importing ansible (Docker Desktop mounts are world-writable), the protocol owns stdout, `init_plugin_loader()`, detect inventory scripts by shebang, mount directories rather than single files.
- **redhat.ansible:** soft relationship. When our settings are unset, read its `ansible.python.interpreterPath`, `ansible.executionEnvironment.{enabled,image,containerEngine,containerOptions,volumeMounts,pull.policy}` and `ansible.config.path`. No `extensionDependencies`.
- **Catalog (M5):** SQLite FTS5 through `node:sqlite` in the extension host, index in `globalStorage`. Verified on VS Code 1.143.1 (Electron 43.7.7, Node 24.21.0, SQLite 3.53.4). The probe only dumps (`ansible-doc --metadata-dump --no-fail-on-errors` per collection, in parallel) and normalizes. An M5 spike re-checks VS Code 1.140 and the Remote server runtime; the fallback is an in-memory MiniSearch index. No native Node modules; `sql.js` lacks FTS5 in its default build.

## Amendment: probe calls, catalog process, version floor, log (AFD-32, 2026-10-31)

Found in the improvement review (KB AFD-A-17): the probe serves one request at a time, but `ProbeClient` sent calls at once and started each timeout on send; any timeout disposed the probe and rejected every pending call, so a slow lens or compile call queued behind a 15-minute catalog dump could kill the dump. The ready line's versions were not checked, probe stderr was only an error-report buffer, and an environment change kept the old catalog index.

- **Queue in the client:** calls go out one at a time; the timeout starts when a call is sent. A timeout rejects that call only and restarts the process; queued calls run on the new one. A process that exits fails only the running call. `dispose()` fails all.
- **Purposes:** `ProbeManager.forFolder(folder, 'catalog')` is a separate process for dumps, released when the load ends; lenses, Re-sync, runs and the syntax check use `'main'`. (A liveness ping before disposing, as first planned, cannot work with a serial probe: it would queue behind the stuck call.)
- **Floor enforced:** a ready line with ansible-core below 2.19 (`coreSupported`) stops the process and fails the call with the version found.
- **Log:** the _Ansible Flow_ `LogOutputChannel` (`extension/log.ts`) gets the probe lifecycle at Info and stderr lines at Debug.
- **Catalog:** `CatalogService.environmentChanged()` marks loaded indexes stale when `afd.environment.*` or `ansible.*` change; validation keeps the last index until the next search reloads.
- **AWX client (same resilience pass):** a GET failing with ECONNRESET, EPIPE or ECONNABORTED (a kept-alive socket closed while idle) is retried once; seen as intermittent lab failures through the SSH tunnel.

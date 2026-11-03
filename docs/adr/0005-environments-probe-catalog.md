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

## Amendment: Set Up Ansible Environment… (AFD-71, 2026-11-03)

Wave 7 (learnability): a newcomer on native Windows met a bare error on the first Run as Skeleton and had to find the right setting by name.

- **Error codes:** `resolveEnvironment` says why it failed (`no-image`, `windows-native`). The Windows message names what is needed (Docker or Podman with an image, or WSL) instead of a setting.
- **Setup command** `afd.environment.setup` (`extension/env/setupEnvironment.ts`, choices from the pure `core/run/setup.ts`): Docker and Podman found on the PATH become choices; on Windows the WSL extension adds Reopen the Folder in WSL, opened through the Command Palette by its title (the extension's command ID is not public API). With none, it points at the guide.
- **Proposed image:** `ghcr.io/ansible/community-ansible-dev-tools:latest`, the last ansible-dev-tools release, which its project documents as usable as an execution environment. Checked 2026-11-03: ansible-core 2.21.5, runs as root, 1.37 GB. The user can replace it before it is saved. The setup writes `afd.environment.image` and `containerEngine` at user level and never pulls: the first run does, as before.
- **One message:** a run with no environment shows its error once, with Set Up Ansible Environment… and Open Settings (Manage Workspace Trust when untrusted); after a setup it offers the run again. The run carries `errorCode: 'environment'` so the command does not repeat it.

## Amendment: WSL from Windows (AFD-75, 2026-11-03)

The product owner asked for WSL next to the Docker EE. Before this, WSL worked only through VS Code's WSL extension, with the whole extension host inside WSL (local mode).

- **A third kind:** `afd.environment.kind: wsl`, with `afd.environment.wslDistro` (empty: WSL's default distribution). It is chosen only when set, by hand or by the setup; `auto` never picks it. On another platform it fails with `wsl-not-windows`. `afd.environment.python` is the interpreter inside the distribution.
- **Command lines** (`core/run/command.ts`):
  - the probe is `wsl.exe [-d <distro>] --cd <root> -- env PYTHONPATH=… python3 -m afd_probe serve --root <root>`;
  - runs are the same `sh -c` script as local and container runs, behind `wsl.exe … -- env <the run's variables>`.
- **Paths:** `wslPath` turns `C:\x` into `/mnt/c/x` and `\\wsl$\<distro>\x` (or `wsl.localhost`) into `/x`. `insidePaths(env, …)` gives the repository, probe, run and cache folders as each kind sees them (the container's fixed mounts, WSL's `/mnt`, or as they are). It serves the probe's path mapping back to the host (`ProbeClient` gets the inside root), the catalog cache, and the scenario runner.
- **Secrets:** a vault password and secret inputs stay environment variables only. `WSLENV` lists just those names (`AFD_VAULT_PASSWORD/u`, `AFD_SECRET_VARS/u`), joined to a `WSLENV` already set. No value is ever an argument.
- **`ansible.cfg`:** DrvFs makes Windows drives world-writable inside WSL, and Ansible would ignore the file there; `ANSIBLE_CONFIG` names it, as for Docker Desktop mounts.
- **Setup:** Set Up Ansible Environment… reads `wsl.exe -l -q` (UTF-16, `parseWslList`), lists each distribution except Docker Desktop's own, and on a pick writes the kind and the distribution at user level. Installing Ansible stays the user's (`pipx install ansible-core`); the probe's version floor (2.19) says when it is missing or too old.

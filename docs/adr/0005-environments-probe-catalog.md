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

- **A third kind:** `afd.environment.kind: wsl`, with `afd.environment.wslDistro` (empty: WSL's default distribution). It is chosen only when set, by hand or by the setup; `auto` never picks it. On another platform it fails with `wsl-not-windows`. `afd.environment.python`, when set, is the interpreter inside the distribution.
- **Command lines** (`core/run/command.ts`):
  - the probe is `wsl.exe [-d <distro>] --cd <root> -e sh -c '<profile>; <python>; exec env PYTHONPATH=… $p -m afd_probe serve --root <root>'`;
  - runs are the same `sh -c` script as local and container runs, after `<profile>`, behind `wsl.exe … -e env <the run's variables>`;
  - `-e`, not `--`: after `--`, wsl.exe hands the words to the default shell, which parses them again (`$vp` in the vault script expanded too early, quotes in secret JSON lost; found on the first real run, 2026-11-03);
  - `<profile>` sources `/etc/profile` and `~/.profile` with their output discarded: the login PATH (pipx's `~/.local/bin`) without text on the probe's protocol channel;
  - `<python>` reads the interpreter from `ansible-playbook`'s `#!` line (else `python3`): pipx keeps ansible-core in its own venv, where plain `python3` cannot import it. `afd.environment.python` replaces it.
- **Paths:** `wslPath` turns `C:\x` into `/mnt/c/x` and `\\wsl$\<distro>\x` (or `wsl.localhost`) into `/x`. `insidePaths(env, …)` gives the repository, probe, run and cache folders as each kind sees them (the container's fixed mounts, WSL's `/mnt`, or as they are). It serves the probe's path mapping back to the host (`ProbeClient` gets the inside root), the catalog cache, and the scenario runner.
- **Secrets:** a vault password and secret inputs stay environment variables only. `WSLENV` lists just those names (`AFD_VAULT_PASSWORD/u`, `AFD_SECRET_VARS/u`), joined to a `WSLENV` already set. No value is ever an argument.
- **`ansible.cfg`:** DrvFs makes Windows drives world-writable inside WSL, and Ansible would ignore the file there; `ANSIBLE_CONFIG` names it, as for Docker Desktop mounts.
- **Setup:** Set Up Ansible Environment… reads `wsl.exe -l -q` (UTF-16, `parseWslList`), lists each distribution except Docker Desktop's own, and on a pick writes the kind and the distribution at user level. Installing Ansible stays the user's (`pipx install ansible-core`); the probe's version floor (2.19) says when it is missing or too old.

## Amendment: engine floor 1.94 for VS Code forks (AFD-171, 2026-11-08)

Epic AFD-170 gives the agents built into VS Code forks (Cursor, Windsurf / Devin Desktop, Antigravity IDE, Kiro) the flow tools and the skill. The forks install from Open VSX and run older VS Code bases: Cursor 3 declares API 1.105, Antigravity IDE 1.107, Kiro 0.1 1.94 (Node 20), Windsurf's is unknown. `engines.vscode: ^1.140.0` was a scaffold value and kept the extension out of all of them.

- **Floor:** `engines.vscode` and `@types/vscode` are 1.94. Type-checking against 1.94 found only the language-model tools API (1.95) newer than that; 1.101 and 1.105 had no errors.
- **Newer APIs at run time:** `src/extension/compat.ts` holds the types of the APIs above the floor (copied from @types/vscode 1.140) and looks them up when used. `registerFlowTools` registers nothing, with one log line, where `vscode.lm.registerTool` is missing or throws (VS Code before 1.95, Cursor), so activation goes on.
- **Catalog without SQLite:** `node:sqlite` needs Node 22.13 (VS Code 1.101). `catalogIndex.ts` imports its types only and loads it on first use with `process.getBuiltinModule` (works bundled and under Vitest; Node before 20.16 has neither). Without it, `CatalogService` reports the catalog as off with the Node version found and starts no probe; validation goes on without catalog facts.
- **Bundles:** the host bundles target `node20`, the oldest runtime the floor allows (Electron 30). `mcp.js` runs on Node 20 or later, as the launcher already required.
- **Test:** `just test-floor` runs the integration suite on VS Code 1.94.2; the Copilot tools test and the catalog suite skip there.
- **Checked in a fork:** `just test-editor <executable> [label]` runs a suite inside an installed editor built on VS Code (`useInstallation.fromPath`). In Antigravity IDE (VS Code 1.107) it found one difference: the editor keeps a flow's document loaded after its designer closes, so the flow session outlived the designer. A change on disk meanwhile was reloaded only as the designer opened and was marked as a live outside edit, and marks from before the close came back. `FlowSession` now drops the marks when its last panel closes, compares with the file on disk when the designer opens again, and counts the late reload as part of the closed-time marks (the AFD-92 rule in ADR-0001, unchanged in VS Code).

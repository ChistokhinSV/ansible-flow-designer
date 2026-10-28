# ADR-0007 · Repository, tooling and distribution

Status: Accepted · 2026-10-28 · AFD-1

## Decision

- **Flow files** live inside each automation repo as `flows/<key>/<key>.flow.yaml`; generated code goes to `flows/<key>/generated/`. The editor registers one unambiguous glob, `*.flow.yaml`. Multi-root workspaces are scanned folder by folder.
- **No code from the predecessor** (Playbook Studio, folder 122). Its ideas and quirks are used, and so are its non-code assets: the local images `ps-probe-env:2.19/2.20/2.21` and `ps-probe-sshd` as stand-in EEs (their Dockerfile is rewritten here), `examples/netops-demo` and the 20 intent queries as test data.
- **Toolchain:** TypeScript 7 for type-checking, esbuild (extension host) and Vite (webview, library mode) to transpile, Biome for lint and format. typescript-eslint caps TypeScript below 6.1. Vitest (projects `core` and `webview`), `@vscode/test-cli` for integration tests. One npm package, no workspaces; the VSIX ships bundled `dist/` only.
- **just** is the single entry point for every build, test, run and dev-server task.
- **Distribution:** Marketplace and Open VSX, MIT license. Publisher id placeholder `afd-dev` until the real id is chosen before the first publish. Display name "Ansible Flow Designer"; the name is checked against Red Hat's trademark guidance before going public.

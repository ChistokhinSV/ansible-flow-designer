# ADR-0036: Packages for other hosts: four npm packages built from this repository

- Status: accepted (2026-11-13, AFD-266, epic AFD-265). Amends ADR-0007 and ADR-0023.
- Context: Ansible Flow Server (a separate repository, YouTrack project AFS) runs flows for a team
  and must use the same model, generator, run pipeline and designer as the extension, in this
  version and in later ones

## Context

The layers of ADR-0023 already keep `vscode` out of `src/core`, `src/node` and `src/webview`, and
the MCP server and the browser harness run that code outside VS Code. What is missing is a way for
another repository to depend on it: the package is private, and the VSIX ships bundles only.

Product-owner decisions (2026-11-13):

- the server lives in its own repository and takes this code as npm packages;
- the packages are versioned with the extension;
- the scope is `@ansible-flow` (`@afd` is taken on npm, and the name pairs the designer with the
  server).

## Decision

**Four packages.**

| Package                  | Built from                             | For                                                                             | Runtime dependencies                                  |
| ------------------------ | -------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `@ansible-flow/core`     | `src/core`                             | any JavaScript host, browser included: model, commands, validation, codegen     | `yaml`, `ajv`, `ulid`, `@xyflow/system`               |
| `@ansible-flow/node`     | `src/node`                             | Node 22.13 or later: layout, runs, probe client, AWX client, catalog, SSH       | `@ansible-flow/core`, `elkjs`, `jsonc-parser`, `yaml` |
| `@ansible-flow/designer` | `src/webview`                          | a web page: the designer bundle, its stylesheet and a `mount` entry             | none (React and the canvas are inside)                |
| `@ansible-flow/assets`   | `probe/`, `schema/`, contract fixtures | files a host passes by path: the Python probe, the events callback, the schemas | none                                                  |

`src/extension`, `src/mcp` and `src/cli` are not packaged. A host that wants the flow tools builds
on `core/ai` (`TOOL_SPECS`, `runTool`) with its own `FlowIO`, as the MCP server does.

**The repository stays one npm package, with no workspaces** (ADR-0007 holds). The sources do not
move, so the relative imports, the Biome layer rules, the tsconfigs, the Vitest projects, the VSIX
build and the bundle budgets are untouched. A build script (`scripts/packages.mjs`, `just packages`)
stages each package in `dist/packages/<name>/` and writes its manifest:

- the version is the root `package.json` version;
- each dependency's version is copied from the root `package.json`;
- `license`, `repository` and `engines` come from one table in the script.

So there is one place for versions, and a package cannot be released with a dependency version the
extension was not tested with.

**One instance of the core.** `modelOf` caches a model per document in a `WeakMap`, and other
modules compare objects by identity. Two copies of a core module in one process would break both.
So the packages are not bundled per entry point:

- every source file of a layer that is not a test is an entry, and the output mirrors the source
  tree (`src/core/flow/document.ts` becomes `@ansible-flow/core/flow/document`), with code shared
  between files split into chunks (esbuild `bundle`, `splitting`, `format: 'esm'`,
  `packages: 'external'`);
- in the `node` package, an import that resolves into `src/core` is kept external and rewritten to
  `@ansible-flow/core/<path>`;
- each manifest exports `"./*": "./dist/*.js"` with its types.

A trial build on 2026-11-13 (0.84.0 sources) gave 1,200 KB for `core` and 34 KB for `node`, and a
plain Node script parsed a flow, built its model and loaded the layout from the two packages.

**Format.** ES modules only, target ES2023. `core` has no `node:` imports and is checked as browser
code by `tsconfig.webview.json` already. Types come from `tsc --emitDeclarationOnly` with a
build tsconfig the script writes, in the same tree as the code. The flow schema JSON that three core files
import from `schema/` is inlined by the build and also shipped as a file in `assets`.

**The designer** is the bundle the VSIX ships (`index.js` and `index.css` from the Vite library
build), so a web host shows the code that the extension's tests cover. The `mount` entry and the
transport that replaces `acquireVsCodeApi` are AFD-269. The harness is left out: it imports
`src/node` and test fixtures.

**What is stable.** Before 1.0, nothing is promised. The server pins exact versions and moves to
each release with a pull request that its contract tests gate.

- Documented entry points are listed in `docs/packages.md` (written with AFD-267): the flow
  document and model, commands, validation, the engine, runs, the protocol, scenarios, AWX, the AI
  tools. A breaking change to one of them, or to `core/protocol.ts`, gets a line under "Packages"
  in the changelog.
- Every other path can be imported, and is internal: it changes without notice.
- Contract fixtures in `assets` are replayed by this repository (a mock server) and by the server
  repository (the real server), so a protocol change that breaks either fails a test (AFD-277).

**Versions and publishing.** All four packages carry the extension's version and are published at
every release, changed or not. `publish.yml` has a job `npm` beside the VSIX's publish job, in the
same `release` environment: `npm publish --provenance --access public` with npm Trusted Publishing
(OIDC), as the Marketplace job does. The build job makes the tarballs with no secret and no token;
the `npm` job installs nothing and publishes them. A manual run with `dry_run` builds, checks and
uploads the tarballs only. The two publish jobs do not depend on each other, and a version already
on npm is skipped, so the job can be re-run.

Before the first publish, the npm organisation `ansible-flow` must exist and belong to the
publisher (an account step for the product owner). Until then the job is off: it runs only when the
repository variable `NPM_PUBLISH` is `true`. A package's first publish uses a token (`NPM_TOKEN`),
because npm sets a trusted publisher on a package that exists; the steps are in
[packages.md](../packages.md#publishing) (AFD-268).

**Checks.**

- The package build fails when a file under `src/core` or `src/node` imports from outside its
  layer, other than `schema/` and, for `node`, `src/core`.
- CI stages the packages, runs `npm pack --dry-run` for each, and imports the staged `core` and
  `node` from a plain Node script.
- The packages have no size budget. The VSIX budgets of ADR-0023 stay.

**Licence.** MIT, as the extension. Each package carries `LICENSE` and a `THIRD_PARTY_NOTICES.md`
for what it contains (`scripts/notices.mjs`): for the designer, React, the canvas and the icons it
bundles.

## Alternatives considered

- **npm workspaces with a manifest per package** (the first plan). Five manifests to keep in step,
  a changed lockfile and install layout, and symlinks in `node_modules`, for no gain while the
  sources stay in `src/`.
- **Moving the sources into `packages/*`.** Every relative import, the Biome rules, three tsconfigs
  and the Vitest projects change, and the history of 300 files is cut.
- **One bundle per documented entry point.** Smaller packages, but shared modules are copied into
  each bundle, which breaks the one-instance rule above.
- **A git submodule in the server.** No publishing, but the server builds this repository's
  sources with its own tool versions, and pins a commit instead of a release.

## Consequences

- Renaming or moving a file in `src/core` or `src/node` changes an import path the server may use.
  The server's contract tests and its version pull request catch it; the changelog names it when
  the path is a documented entry point.
- A release has one more job and needs the npm registry. The VSIX does not wait for it.
- The server runs on Node 22.13 or later, because the catalog index uses `node:sqlite`.
- Work that follows: AFD-267 (`core`), AFD-268 (`node`, `assets`, the publish job), AFD-269 (the
  designer outside VS Code).

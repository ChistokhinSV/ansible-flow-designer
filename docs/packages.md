# npm packages for other hosts

The code that is not tied to VS Code is also built as npm packages, so another program can read,
check, change and run flows the way the extension does. The first user is Ansible Flow Server.
The decision and its reasons are in [ADR-0036](adr/0036-packages-for-other-hosts.md).

| Package                  | Contents                                                             | State                         |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------- |
| `@ansible-flow/core`     | The flow model, commands, validation, code generation, run summaries | Built and checked; not on npm |
| `@ansible-flow/assets`   | The Python probe, the events callback, the schemas                   | Built and checked; not on npm |
| `@ansible-flow/node`     | Layout, runs, the probe client, the AWX client, the catalog, SSH     | Built and checked; not on npm |
| `@ansible-flow/designer` | The designer for a web page                                          | Planned (AFD-269)             |

Nothing is published yet: the release's npm job is switched off until the npm organisation exists
(see [Publishing](#publishing)). Once it is on, every release of the extension publishes all
packages with the extension's version.

## Build them

```sh
just packages
```

stages each package in `dist/packages/<name>/` and checks it: a dry-run `npm pack`, an import of
every module from a plain Node script, a flow parsed, validated and generated through the package,
and a TypeScript file that imports it. CI runs the same. `node scripts/packages.mjs --pack` also
writes the tarballs a release publishes to `out/npm/`; they can be installed in another project
with `npm install <file>.tgz` to try a change before it is released.

The manifests are written by `scripts/packages.mjs`. The version and the version of each
dependency come from the root `package.json`; there is no second place to edit.

## Use a package

- **ES modules only.** `import`, not `require`.
- **A module is imported by its path in the source tree:** `src/core/flow/document.ts` is
  `@ansible-flow/core/flow/document`. There is no single entry file. A folder's `index.ts` is
  `<folder>/index`.
- **TypeScript:** set `"moduleResolution": "bundler"`. The type files import each other without
  file extensions.
- **Pin the exact version.** Before 1.0 a release may change any module.

```ts
import { engineFor } from '@ansible-flow/core/engine/engines';
import { parseFlow } from '@ansible-flow/core/flow/document';
import { createSchemaValidator } from '@ansible-flow/core/flow/schema';
import { validateFlow } from '@ansible-flow/core/flow/validate';

const parsed = parseFlow(text);
if (parsed.doc) {
  const findings = validateFlow(parsed.doc, createSchemaValidator()(parsed.file)).findings;
  const code = engineFor(parsed.doc).generate(parsed.doc, { source: 'os-upgrade.flow.yaml' });
}
```

**One copy of the core.** A flow's model is cached per document (`modelOf`), and objects are
compared by identity. Install one version of `@ansible-flow/core`, and do not copy its modules
into a bundle that also imports the package.

## `@ansible-flow/assets`

Files a host hands to Python or to a schema tool by path. The package says where they are:

```ts
import { probeDir, schemaDir } from '@ansible-flow/assets';
```

- `probeDir` holds `afd_probe/` (the probe: `python -m afd_probe serve`) and
  `callback_plugins/afd_events.py` (the callback that writes a run's events). It is the `probe`
  path that `runProcess` and `probeProcess` of the core take.
- `schemaDir` holds `flow.schema.json` and `scenarios.schema.json`.

## `@ansible-flow/node`

For Node 22.13 or later. It depends on `@ansible-flow/core` at exactly its own version and imports
it by name, so a host that uses both has one copy of the core.

| Module                               | Main exports                                                  |
| ------------------------------------ | ------------------------------------------------------------- |
| `autoLayout`                         | `layoutLevel`, `layoutAll`, `autoPositions`, `shownPositions` |
| `env/probeClient`                    | `ProbeClient`                                                 |
| `scenario/runner`                    | `runScenarios`                                                |
| `run/storage`, `run/tail`            | `pruneRuns`, `dropVars`; `tailFile`                           |
| `awx/client`, `awx/awxWorkflow`      | `AwxClient`; the workflow follower                            |
| `catalog/catalogIndex`               | the module catalog index (`node:sqlite`)                      |
| `ssh/remote`, `ssh/sync`, `ssh/exec` | runs and the probe on a remote Linux host                     |

Two modules are programs, not libraries: they do their work when loaded. `catalog/catalogWorker`
is started as a worker thread and `ssh/sshRun` as a process; find their files with
`import.meta.resolve('@ansible-flow/node/catalog/catalogWorker')`.

The run pipeline the extension uses (`runFlow`) moves into this package with AFD-271.

## Documented entry points of `@ansible-flow/core`

A breaking change to one of these gets a line under "Packages" in the changelog. Every other module
can be imported and is internal: it changes without notice.

| Module                                                   | Main exports                                                               |
| -------------------------------------------------------- | -------------------------------------------------------------------------- |
| `flow/document`                                          | `parseFlow`, `ParsedFlow`                                                  |
| `flow/types`                                             | `FlowDocument`, `FlowNode`, `ImplBinding`, `Ulid` and the other file types |
| `flow/model`                                             | `modelOf`, `buildModel`, `FlowModel`                                       |
| `flow/schema`                                            | `createSchemaValidator`                                                    |
| `flow/validate`                                          | `validateFlow`, `Finding`                                                  |
| `flow/commands`, `yaml/edits`                            | `FlowCommand`, `planCommand`; `applyEdits`, `TextEdit`                     |
| `flow/save`                                              | `planSave`                                                                 |
| `flow/segments`                                          | `planSegments` (approval gates split a flow into segments)                 |
| `engine/engines`, `engine/types`                         | `engineFor`; `GenerateOptions`, `GenerateResult`, `Route`, `SegmentFile`   |
| `engine/writePlan`, `engine/partial`                     | `planGenerated`; `partialFlow`                                             |
| `run/environment`, `run/command`                         | `resolveEnvironment`, `settingsFromJson`; `runProcess`, `probeProcess`     |
| `run/events`, `run/view`                                 | `createSummarizer`, `summarizeRun`, `hostOutput`; `runStates`, `runPassed` |
| `run/launch`, `run/redact`                               | `launchFields`, `parseInput`, `LaunchPlan`; `redactLine`, `secretValues`   |
| `protocol`                                               | `HostMessage`, `WebviewMessage`, `Snapshot`, `RunView`                     |
| `scenario/scenarios`, `scenario/simulate`                | `parseScenarios`, `checkScenarios`; `simulateScenario`                     |
| `awx/events`, `awx/workflow`, `awx/import`, `awx/survey` | `awxEventsToLines`; `workflowFromApi`; `importWorkflow`; `surveyFor`       |
| `ai/specs`, `ai/handlers`                                | `TOOL_SPECS`; `FlowIO`, `runTool`                                          |
| `inventory/files`, `inventory/edit`                      | `readInventory`, `InventoryFs`; `editInventory`, `InventoryOp`             |
| `export/drawio`, `export/svg`                            | `toDrawio`; `toSvg`                                                        |

## Publishing

The `npm` job of `.github/workflows/publish.yml` publishes the tarballs the build job made, a
package after the ones it depends on, with provenance. It installs nothing. A version that is
already on npm is skipped, so the job can be run again after a failure. It does not block the
VSIX, and the VSIX does not block it.

To switch it on (once, by the owner of the npm account):

1. Create the npm organisation `ansible-flow`.
2. Add a granular access token for that scope as the secret `NPM_TOKEN` of the `release`
   environment. A package's first publish needs it: a trusted publisher can only be set on a
   package that exists.
3. Set the repository variable `NPM_PUBLISH` to `true` and release.
4. On npmjs.com, add a trusted publisher to each package: this repository, the workflow
   `publish.yml`, the environment `release`. Then delete the `NPM_TOKEN` secret; later releases
   publish with Trusted Publishing (npm 11.5.1 or later).

A manual run with `dry_run` builds and checks the packages and uploads the tarballs as the
artifact `npm`; it publishes nothing.

## Rules for this repository

- A file under `src/core` may import only from `src/core`, from `schema/` and from packages listed
  under `dependencies` in `package.json`. It may not import a Node built-in: the core also runs in a
  browser. `just packages` fails otherwise.
- A file under `src/node` may import only from `src/node`, from `src/core`, Node built-ins and
  packages listed under `dependencies`.
- A module of `src/node` that runs when loaded is listed under `programs` in
  `scripts/packages.mjs`, so the check does not import it.
- Import a file of a package without an `exports` map with its extension
  (`ajv/dist/2020.js`), or Node cannot load the built module.
- Moving or renaming a file under `src/core` or `src/node` changes an import path of a package. For a
  documented entry point, say so in the changelog.

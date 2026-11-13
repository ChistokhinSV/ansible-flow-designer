# npm packages for other hosts

The code that is not tied to VS Code is also built as npm packages, so another program can read,
check, change and run flows the way the extension does. The first user is Ansible Flow Server.
The decision and its reasons are in [ADR-0036](adr/0036-packages-for-other-hosts.md).

| Package                  | Contents                                                              | State                         |
| ------------------------ | --------------------------------------------------------------------- | ----------------------------- |
| `@ansible-flow/core`     | The flow model, commands, validation, code generation, run summaries  | Built and checked; not on npm |
| `@ansible-flow/node`     | Layout, runs, the probe client, the AWX client, the catalog, SSH      | Planned (AFD-268)             |
| `@ansible-flow/designer` | The designer for a web page                                           | Planned (AFD-269)             |
| `@ansible-flow/assets`   | The Python probe, the events callback, the schemas, contract fixtures | Planned (AFD-268)             |

Nothing is published yet. Publishing starts with AFD-268; from then on every release of the
extension publishes all packages with the extension's version.

## Build them

```sh
just packages
```

stages each package in `dist/packages/<name>/` and checks it: a dry-run `npm pack`, an import of
every module from a plain Node script, a flow parsed, validated and generated through the package,
and a TypeScript file that imports it. CI runs the same.

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

## Rules for this repository

- A file under `src/core` may import only from `src/core`, from `schema/` and from packages listed
  under `dependencies` in `package.json`. It may not import a Node built-in: the core also runs in a
  browser. `just packages` fails otherwise.
- Import a file of a package without an `exports` map with its extension
  (`ajv/dist/2020.js`), or Node cannot load the built module.
- Moving or renaming a file under `src/core` changes an import path of the package. For a
  documented entry point, say so in the changelog.

# npm packages for other hosts

The code that is not tied to VS Code is also built as npm packages, so another program can read,
check, change and run flows the way the extension does. The first user is Ansible Flow Server.
The decision and its reasons are in [ADR-0036](adr/0036-packages-for-other-hosts.md).

| Package                  | Contents                                                             | State                         |
| ------------------------ | -------------------------------------------------------------------- | ----------------------------- |
| `@ansible-flow/core`     | The flow model, commands, validation, code generation, run summaries | Built and checked; not on npm |
| `@ansible-flow/assets`   | The Python probe, the events callback, the schemas                   | Built and checked; not on npm |
| `@ansible-flow/node`     | Layout, runs, the probe client, the AWX client, the catalog, SSH     | Built and checked; not on npm |
| `@ansible-flow/designer` | The designer for a web page                                          | Built and checked; not on npm |

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

## `@ansible-flow/designer`

The designer for a web page: one script, one stylesheet. React, the canvas and the icon font are
inside; the page needs nothing else.

```html
<link rel="stylesheet" href="/designer/index.css" />
<div id="root"></div>
<script type="module">
  import { mount } from '/designer/index.js';

  const socket = new WebSocket('wss://flows.example.net/designer/os-upgrade');
  const designer = mount(document.getElementById('root'), {
    theme: 'auto',
    transport: {
      hostName: 'The server',
      post: (message) => socket.send(JSON.stringify(message)),
      subscribe(listener) {
        const onMessage = (event) => listener(JSON.parse(event.data));
        socket.addEventListener('message', onMessage);
        return () => socket.removeEventListener('message', onMessage);
      },
      getState: () => JSON.parse(localStorage.getItem('designer') ?? 'null') ?? undefined,
      setState: (state) => localStorage.setItem('designer', JSON.stringify(state)),
    },
  });
</script>
```

With a bundler: `import { mount } from '@ansible-flow/designer'` and
`import '@ansible-flow/designer/index.css'`.

- **The transport** (`DesignerTransport`) is the designer's only way to its host: `post` sends a
  `WebviewMessage`, `subscribe` delivers each `HostMessage` (both in
  `@ansible-flow/core/protocol`), `getState` and `setState` keep the viewport and panel widths.
  `hostName` is named when a request goes unanswered.
- **The host does what the extension does:** it answers `ready` with `config`, `catalogStatus` and
  a `snapshot`, and answers every message that has a `reqId` with an `ack` (or its own reply). The
  designer never computes file text: the host applies each command with `planCommand` and sends
  the next snapshot.
- **The designer is the whole page.** As in a VS Code webview, its stylesheet styles `<body>`, its
  keys are handled on the window and its menus open on `<body>`. Give it a page or an iframe of its
  own.
- **Theme:** `light`, `dark`, `hc-dark`, `hc-light` or `auto` (light or dark as the browser
  prefers). `mount` returns `{ setTheme, unmount }`.
- **Open the socket first or queue:** the designer posts `ready` as soon as it is mounted.
- The bundle carries its own copy of the core's code. Messages are plain data, so that copy never
  meets the one a server runs.

### A viewer: show and run, change nothing

A host that only shows flows and runs them asks for a viewer: `viewer: true` in its `config`
message, or in `mount(element, { transport, viewer: true })`. Once on, it stays on.

- The designer stays in Run mode, where the canvas and a step's Details only read. The mode switch,
  the palette, lenses, scenarios, Generate Code, the canvas menu, exports and the links into the
  editor (text, guide, feedback) are not shown. Run as Skeleton, Run for Real, Stop, earlier runs
  and a run's output stay.
- Only these messages leave the page (`VIEWER_MESSAGES` in `@ansible-flow/core/viewer`):
  `ready`; `run`, `launchCheck`, `launchRun`, `launchCancel`, `stopRun`, `showRun`, `runOutput`,
  `showRunOutput`; `catalog`, `copyText`, `openLink`; `inspectResult`, `pngRendered`,
  `cspViolation`, `perf`. Anything else is dropped in the page, and a request is answered there
  with "This view only shows and runs the flow".
- **The host must refuse the rest as well**, with `viewerAllows(message.type)` from the same
  module: a page can be changed by whoever opens it.

What a viewer host answers:

| The designer sends          | The host answers                                                                                     |
| --------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ready`                     | `config` (with `viewer: true`), `catalogStatus`, `snapshot`, and `runs` when there are earlier runs  |
| `run` (`check` or `real`)   | `launch` with a `LaunchPlan` (the dialog), or a `run` at once                                        |
| `launchCheck`               | `launchFacts` for the hosts typed so far                                                             |
| `launchRun`                 | `run` with a `RunView`, again as the run goes on (about twice a second), and a last one when it ends |
| `launchCancel`              | nothing                                                                                              |
| `stopRun`                   | the last `run`                                                                                       |
| `showRun`                   | `run` with `past: true`                                                                              |
| `runOutput` (has a `reqId`) | `runOutputReply`                                                                                     |
| `showRunOutput`             | the host's own page for the run's log, if it has one                                                 |
| `catalog` (has a `reqId`)   | `catalogReply`, `ok: false` when it has no catalog                                                   |

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
| `viewer`                                                 | `VIEWER_MESSAGES`, `viewerAllows`                                          |
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

It publishes by npm Trusted Publishing only: the job proves to npm that it is this repository's
`publish.yml` in the `release` environment, and npm lets it publish. There is no token to store,
leak or renew, and npm attaches provenance by itself. npm's granular tokens that bypass two-factor
authentication are being withdrawn, so the job reads none.

npm sets a trusted publisher on a package that exists, so each package's first version is
published by hand. Once, by the owner of the npm account:

1. Create the npm organisation `ansible-flow`.
2. On the release's tag, run `just packages-publish` in a terminal where `npm login` is done. It
   builds and checks the packages and publishes those whose version is not on npm yet; npm asks
   for the second factor. Nothing is stored.
3. On npmjs.com, in each package's settings, add a trusted publisher: GitHub Actions, this
   repository, the workflow `publish.yml`, the environment `release`. Then choose "Require
   two-factor authentication and disallow tokens".
4. Set the repository variable `NPM_PUBLISH` to `true`.

A new trusted publisher must publish successfully within 2 days or npm expires it, so do steps 3
and 4 at most 2 days before the next release. An expired one is deleted and added again.

A package added later (a fifth one) is first published the same way: `just packages-publish`
leaves the versions that are on npm as they are.

The job needs npm 11.5.1 or later (Node 24 has it) and fails with a message on an older one.

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
- `src/webview/bus.ts` reaches the host only through its transport. Nothing else in `src/webview`
  may call `acquireVsCodeApi` or listen for host messages on the window.
- Moving or renaming a file under `src/core` or `src/node` changes an import path of a package. For a
  documented entry point, say so in the changelog.

# ADR-0019 · User documentation: guides in the VSIX, walkthroughs, scripted screenshots

Status: Accepted · 2026-10-31 · AFD-22

## Context

The product is feature complete for v1, but users had only the README (a feature reference) and the developer knowledge base. The product owner asked for end-to-end tutorials, how-to pages per feature, and walkthroughs on VS Code's Welcome page as other extensions have.

Decisions (product owner, 2026-10-31):
1. The guides live in the repository (`docs/guide/`), ship in the VSIX and open in VS Code's Markdown preview; the README links them.
2. English only.
3. Scripted screenshots of the webview harness, light and dark.
4. Three walkthroughs: first flow, AI assistant, AWX.
5. Four end-to-end tutorials; how-to pages for every feature.
6. A command that copies bundled sample flows.
7. An extension icon.

## Decision

**Guides:** Markdown in `docs/guide/`:
- `README.md` (index), `tutorials/`, `how-to/`, `reference/`, `troubleshooting.md`, `images/`;
- `.vscodeignore` ships them with `samples/`, `media/icon.png` and `media/walkthrough/`;
- `afd.openGuide [page]` opens a page with `markdown.showPreview`. The page argument is a relative `.md` path; anything else (absolute, `..`) opens the index;
- the guides name commands in text: command links are left to the walkthroughs, where VS Code runs them.

**Generated reference:** `guideReferenceFiles()` (`core/ai/reference.ts`) writes `reference/problems.md` and `reference/flow-format.md` from `FINDING_CODES` and the schema through `just gen-ai`, like the skill's references. Biome leaves them alone, and a test fails while they are stale.

**Walkthroughs** (`contributes.walkthroughs`):
- `afd.firstFlow` (featured for `**/*.flow.yaml`), `afd.aiAssistants`, `afd.awx`;
- step media are the screenshots as `{light, dark, hc, hcLight}` (high contrast reuses dark and light), or Markdown in `media/walkthrough/`;
- completion events are our commands, `onSettingChanged`, or `onContext:afd.tour.*`. `extension/tour.ts` sets those keys after successful designer commands: a node added, a failure handled (pattern, decision, a wired fail port), a subflow;
- `afd.openWalkthrough` opens the first one with `workbench.action.openWalkthrough`.

**Samples:** `samples/firewall-upgrade.flow.yaml` (new: vendor-neutral, draft steps so a skeleton run works anywhere, 0 problems) and `samples/edge-baseline.flow.yaml` (a copy of the example, with its three open fail ports for the "handle failures" exercise). `afd.openSample [key]` copies one to `flows/<key>/` and never overwrites a copy already there.

**Screenshots:** `scripts/docs-shots.mjs` (`just docs-shots [names]`):
- starts or reuses the webview harness and drives the installed Edge through `playwright-core` (no browser download);
- the harness gained `?shots=1` (no theme bar) and the `firewall-upgrade`, `new` and `hand-written` flows;
- each shot names a flow, the walkthrough flag (light and dark) and actions through the DOM and the `afdUi` store;
- the clock is fixed; the icon is rendered from `media/icon.svg`.

**Fix found while verifying the tutorials:** React Flow sets `pointer-events: none` on handles without `connectionindicator`, that is, handles that cannot start a wire (wired outputs, `in` ports). Their port menus were unreachable by click. `.react-flow__handle.afd-port` now has `pointer-events: all`; `isConnectableStart` still stops a second wire.

## Consequences

- Users learn in VS Code: the Welcome page, the Command Palette and the designer menu reach the same pages.
- The guides are checked by tests: links, images (none unused), command links and completion events, every command and setting documented, generated pages current, samples valid.
- Screenshots drift as the UI changes: one command regenerates them. The PNGs add about 3 MB to the VSIX.
- The README stays the complete feature reference; the guides are task-oriented and link back to it where useful.

## Amendment: import documentation (AFD-28, 2026-10-31)

Decisions (product owner, 2026-10-31):
1. A new Tutorial 5 for import: as is, then with an AI assistant. Tutorials 3 and 4 get short import sections.
2. Bundled sample playbooks, so every reader imports the same thing.
3. Scripted screenshots.
4. Import steps in the first-flow and AI walkthroughs.

Design:
- **Sample:** `samples/playbooks/edge-baseline/` holds the playbooks at its top level, so its roles resolve next to the playbook as well as through its own `ansible.cfg`. A prompt stands in for the vault value, and the read-only commands use `check_mode: false`, so the skeleton run goes through.
- **Copying:** _Open Sample Flow…_ lists playbook samples under a separator (`afd.openSample playbooks/<name> [folder]`).
  - It copies the top-level entries only when none of them exists in the target folder; otherwise it warns and offers _Open Folder…_.
  - It opens `site.yml` and offers _Import Ansible Playbooks…_.
- **Screenshots:** the harness loads the sample's import as `playbook-import`, the golden `test/fixtures/import/sample-site.flow.yaml`, which the docs test keeps current. The new shots are `playbook-import` (light and dark, used by the walkthrough) and `task-keywords`.
- **Walkthroughs:**
  - `afd.firstFlow` step `import` (media: the screenshot), `afd.aiAssistants` step `import` (media: `media/walkthrough/ai-import.md`);
  - both complete on `onCommand:afd.importPlaybooks`;
  - the first step's import link moved to its own step.
- **The tutorial was followed for real:**
  - the sample import is checked in unit and integration tests (20 steps, the notes, the levels the tutorial names);
  - the engine suite runs the sample and its import for real side by side (the same files), and the import as a skeleton (every host through, the canary by the rescue);
  - a real Claude Code ran step 7's prompt.

## Amendment: UX baseline (AFD-33, 2026-10-31)

The improvement program (KB AFD-A-17) measures the UI before and after its redesign. `scripts/ux-baseline.mjs` (`just ux-baseline [label]`) reuses the screenshot harness (`scripts/harness-lib.mjs`, shared with `docs-shots`): screenshots of four flows in four views at two sizes, and per-level canvas metrics measured in the page (React Flow zoom × the node title's font size, wire label count, overlapping boxes) plus `modelStats.builds` (a counter in `core/flow/model.ts`) for one snapshot. Output goes to `docs/ux/<label>/`, which is not packaged; `docs/ux/baseline` is the reference. The eight-task table and the accessibility checklist are written by hand and get a column per wave.

## Amendment: vocabulary, command ids, keybindings (AFD-41, 2026-11-01)

Improvement program wave 3. The designer, the Command Palette and the guide used several words for one action ("Open as text", "Show as text", "Show in text"), "Implementation" for both a mode and a tab, and two commands to check a flow.

- **Glossary** (`docs/guide/reference/glossary.md`) is the source of truth: one word per thing, and a **Not** column of the words we do not use. Actions (commands, menu items, buttons) are in Title Case as in VS Code's menus; messages and tooltips are sentences. `test/unit/core/vocabulary.test.ts` reads the Not column and fails when a source string, `package.json`, a guide page, the walkthrough or the README uses one of those words, or when a milestone or decision code ("(M5)", "decision 3") reaches the UI. Comments do not count: Biome keeps them on their own lines or after code (TypeScript 7 has no parser API to read string literals).
- **Renamed:** Implementation mode → **Code** mode (internal id `code`); its Details tab → **Binding** (id `binding`); Properties → **Details**; Leave open on purpose…, Mark expected and Ignore… → **Accept with Reason…** (the dialog submits **Accept**); Stop ignoring → **Reopen**; Generate Playbook → **Generate Code**; Import from AWX… → **Import AWX Workflow or Job Template…**. The how-to page is `how-to/code-mode.md`.
- **Check Flow** folds Validate Design and Check Generated Code: it checks the design, shows the Problems panel when there are problems, and checks the generated code in the environment (cancellable) only when the design has no errors. It is in the top bar's "…" menu in every mode.
- **Command ids** follow `afd.<area>.<verb>` (`src/extension/commands/ids.ts`: `CMD`). The ids before 0.25 are registered as hidden aliases (`ALIASES`, not contributed, so not in the Command Palette) until 0.27; an alias runs the new command with its arguments and returns its result. The extension starts `onStartupFinished`, so aliases need no activation events. The Complete IDs code action kind stays `source.afd.completeIds`.
- **Keybindings** (`contributes.keybindings`, `when: activeCustomEditorId == afd.flowEditor`), after VS Code's own: Ctrl+F5 Run as Skeleton (Run Without Debugging), Shift+F5 Stop Run (Stop), Ctrl+Shift+B Generate Code (Run Build Task), Shift+Alt+F Tidy Up (Format Document), F7 Check Flow. The `?` sheet lists them under **Flow**.

## Amendment (0.28.0, 2026-11-01): aliases removed

The hidden aliases for the ids before 0.25 (`ALIASES`, `registerAliases`) were removed in 0.28, as
decided: two minor versions (0.25 to 0.27) of overlap. The commands reference lists the old ids
with their new ones.

## Amendment: a first hour (AFD-74, 2026-11-03)

Wave 7 (ADR-0029, ADR-0030):
- **Tutorials show the result first.** Tutorial 1 gets to a playbook after two steps, then the failures and a skeleton run, with about 12 concepts before the first output (about 45 before). Subflows open Tutorial 2.
- **An explanation page,** `docs/guide/explanation/how-flows-work.md`, is linked from the index ("Understand") and the end of Tutorial 1. It explains the model: hosts on wires, a step is a play, the outcome, levels, skeleton runs.
- **The smallest sample first:** `samples/hello.flow.yaml`, bound to builtin modules with no problems, sorts first in Open Sample Flow…. An integration test runs it as a skeleton on `localhost` in the Docker image. It was also checked in the public dev tools image (rc 0).
- **One word list:** the glossary. The guide index links it, and the vocabulary test keeps ticket and milestone codes out of the guide, the walkthrough and the README's newcomer part.
- **The README is the first page a newcomer reads** (and the Marketplace page). It covers what the extension is, a first flow in three steps, links and ten plain features; the complete list is `docs/guide/reference/features.md`.

## Amendment: images in the guide and on the extension's page (AFD-79, 2026-11-04)

Round 1 of the wave 8 usability test found broken images in both places a newcomer reads.

- **Markdown preview.** The guide opens from the installed extension, outside the workspace. For
  such a file VS Code's preview loads resources only from the file's own folder, plus the folder
  of every extension that contributes a preview style or script. A page under `how-to/` could not
  load `../images/`. The extension contributes `markdown.previewStyles` with an empty
  `media/guide-preview.css`, so its folder is a preview root.
  - The cost: one empty stylesheet in every Markdown preview.
  - Rejected: a webview of our own for the guide (a second renderer to keep) and moving the
    pages beside their images (it breaks the guide's structure).
- **The extension's page in the Extensions view.** It shows only `https:` images and opens no
  relative link (VS Code's README sanitizer and its `img-src https: data:` policy). Until the
  repository has a public address for `--baseImagesUrl`, the VSIX carries a README made by
  `scripts/vsix-readme.ts`: relative images are left out, the first leaves a note on where the
  guide opens, and relative links become their text. `just package` passes it with
  `--readme-path`. The repository's README is unchanged.

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

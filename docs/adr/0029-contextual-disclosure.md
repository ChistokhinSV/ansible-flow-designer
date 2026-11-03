# ADR-0029: Contextual disclosure

- Status: accepted (2026-11-03, AFD-72)
- Context: wave 7, a gentler first hour (KB AFD-A-19)

## Context

The product owner found that the designer frightens new users. A new flow showed 46 controls, with nothing folded (`docs/ux/wave7-start`):
- 10 in the top bar (three of them about runs, export and lenses with nothing to act on);
- 17 in the palette (eight node types, four failure patterns with no step that can fail, three annotations);
- 10 in the flow panel (a ULID, the version, the runtime and the maintenance window before the goal).

The first step raised a warning in jargon at once.

Two ways were weighed: a "simple view" setting that hides features until switched off, and disclosure by context. The product owner chose context, with no mode switch: nobody has to find a setting, and nothing is hidden from someone who is looking for it.

## Decision

- **A control shows when it can act here.**
  - Failure patterns appear once the level has a step with a fail port.
  - The Lens dropdown appears once the flow has a step, or while a lens is on.
  - Readiness appears once there is a step to count.
  - Stop is the Run button while a run goes, instead of a greyed button the rest of the time.
- **Rare fields go into a fold whose summary says what is inside:**
  - "More details: ntp-baseline · version 1" (key, ID, version, owner, runtime, imported from, maintenance window);
  - "More node types" (Parallel, Join, Start, End);
  - Quick Add's "Extra ports (optional)";
  - each Execution group ("Timing · 2 set");
  - a node's ID.
  - `webview/panels/Fold.tsx`: a native `<details>`.
- **A fold opens by itself** while a field inside has a value or a problem (an invalid key, a set setting, the branching types on a level that has them). Otherwise it stays as this viewer left it (webview state `folds`).
- **Nothing is removed.**
  - Export moves into "…" (Export as draw.io Diagram…, Export as Image…).
  - Every folded field is one click away.
  - Keyboard shortcuts, menus and commands are unchanged.
- **Words before names.**
  - Port names stay as in the file (`ok_hosts`, `failed_hosts`, …), because the file and the generated code use them.
  - One sentence per port explains it (`core/view/portHints.ts`). It shows in the port tooltip, the port menu, the Ports tab, Quick Add, the Legend and the Wire panel.
  - A `from:` reads as where the value comes from ("this step's result", "flow input devices", `"Check NTP" · peers`), with the raw reference in its tooltip (`core/view/fromText.ts`).
- **The open-fail-port warning stays a warning.**
  - The banner asks one question, _What should happen when "Check NTP" fails?_, with the port's first two patterns and Accept with Reason… as buttons, Other Choices (the port menu) and Next. The verb follows the port: fails, cannot reach a host, runs out of time, is rejected.
  - The finding says what happens to the hosts: "has nowhere to go, so its hosts fail the run".
- **A selected wire** shows what it does, "Hosts that leave X by `port` go to Y", with the wired port's menu (Insert, Rewire, Disconnect).
- **The minimap never covers a node.** It sits bottom left or top left, whichever is free (`minimapCorner`). When neither is, a Mini Map button in the zoom controls shows it on demand.

## Consequences

- The wave 7 metric counts the controls in view per region (`just ux-baseline`); the report compares them with `docs/ux/wave7-start`.
- The Stop and Export buttons no longer sit in fixed places on the bar (an ADR-0024 amendment). Shift+F5 and the commands still stop a run and export.
- Tests and scripts that drive the UI open a fold before clicking inside it. Integration tests read `data-*` hooks only, so they are unaffected.
- New panels and folds must say what they hold in their summary, and must open when something inside needs attention.

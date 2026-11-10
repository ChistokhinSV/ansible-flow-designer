# ADR-0033: Feedback without telemetry

- Status: accepted (2026-11-10, AFD-200)
- Context: the product owner wants to hear from people after some use, and above all from people
  who remove the extension

## Context

The extension had no telemetry, no usage counters and no way to send feedback. Feedback only came
through GitHub issues, which needs an account and a reason to look for the repository.

VS Code shows nothing when an extension is uninstalled. The only hook is the `vscode:uninstall`
script in `package.json`. It is plain Node.js, with no `vscode` API, and runs once in its own
process at the next full restart of VS Code after the removal. It no longer runs on updates
(microsoft/vscode#72375).

Product-owner decisions (2026-11-10):

- One notice after a week of real use, plus a **Send Feedback…** command that is always there.
- After uninstall: a "why did you leave?" page opens once in the browser.
- A short form for the survey and the uninstall page; GitHub issue forms for problems.
- A stable form page on GitHub Pages; behind it a Cloudflare Worker (free plan, Turnstile) that
  files each answer as an issue in a YouTrack project and sends the author a Telegram message.
- An optional email, kept in the YouTrack issue only, never in Telegram.
- GitHub Actions deploys the page and the Worker.

## Decision

- **The extension sends nothing.** It counts days of use in `globalState` and opens links with
  `vscode.env.openExternal`. Everything sent is typed and sent by the person, from the browser.
- **When to ask** (`src/core/feedback/feedback.ts`, pure): a day of use is a day the designer
  showed a flow with steps. The notice comes after 3 such days and 7 days since the first.
  **Not Now** waits 30 days and 3 more days of use; there are 2 notices at most. **Rate It**,
  **Tell Us More** and **Don't Ask Again** end the asking.
- **One notice per start.** The notice is last in the start-up chain: the editor-agent offer, the
  AI setup offer and the stale-setup repair come first. The feedback notice shows only when none
  of them asked.
- **The uninstall page** (`src/uninstall/`, bundled to `dist/uninstall.js`, 2 KB) reads its
  version from the extension's `package.json` and the editor from its install path. It opens
  `…/feedback/?source=uninstall&version=&editor=` with `rundll32`, `open` or `xdg-open`,
  detached, ignoring errors.
- **Respecting "no".** The script cannot read VS Code state. At each activation, and when the
  setting changes, the extension writes or removes `<extension folder>/.no-feedback` to match
  **Don't Ask Again** and `afd.feedback.prompt`. Updates install a new folder; the next activation
  writes the marker again. The script also skips in CI, on a remote server (`.vscode-server` and
  the like), and on Linux without a display.
- **The form and the Worker** live in `feedback/site/` and `feedback/worker/`. The URL carries only
  the occasion, the version and the editor. The Worker checks the origin, the size, the fields
  and the Turnstile token before it files anything.

## Consequences

- No usage data reaches the author unless someone fills in the form.
- The uninstall page opens only after a full restart of VS Code, which may be days later, and
  never for someone who removed the extension from a remote window.
- A read-only install (a system folder) cannot hold the marker: there the page opens even after
  **Don't Ask Again**.
- The form page and the Worker can change without a release; the extension only knows the page's
  address.

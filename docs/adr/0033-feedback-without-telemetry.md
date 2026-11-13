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
  never for someone who removed the extension from a remote window. VS Code runs the script when
  its shared process deletes the folder of an extension marked for removal, at start-up (seen on
  1.145.2). An uninstall from the command line (`code --uninstall-extension`) only takes the
  extension out of the profile, so the first start marks the folder and the second runs the
  script.
- A read-only install (a system folder) cannot hold the marker: there the page opens even after
  **Don't Ask Again**.
- The form page and the Worker can change without a release; the extension only knows the page's
  address.

## Amendment: the page counts its opens (AFD-215, 2026-11-11)

The product owner wants to know whether the page is visited even when nobody writes anything.
Turnstile analytics count every load of the page, but only as a total over a short lookback, with
no split between the uninstall page and the in-use form.

- **The page, not the extension:** on load the page posts `{source, version, editor}` to the
  Worker's `/visit` once per tab and occasion (sessionStorage guards reloads), with
  `navigator.sendBeacon`. The extension still sends nothing.
- **Kept:** one KV key per open and per saved answer: time, kind, occasion, editor, version and a
  random end; 400-day expiry. No IP (it only keys the rate limit), no cookie, no answer text.
- **Read back:** a daily cron trigger sends one Telegram message about the day before; the KV
  keys are readable in the dashboard and with `wrangler kv key list`.
- **Said where it matters:** the page's note and the README's "Feedback and privacy" section.
- **Why KV:** the Worker reads it back for the summary with no extra secret; Analytics Engine
  would need an API token to query, and D1 a database and a schema for a handful of rows a day.
  One key per event avoids read-modify-write counters.

## Amendment: no page opens by itself (AFD-263, 2026-11-13)

The product owner: a feedback page must not open on its own. Ask politely in a notification, and
open the page only when its button is clicked.

- **What opened by itself:** the uninstall page. The `vscode:uninstall` script has no editor UI, so
  it could only open the browser. The notice after a week of use already was a notification with
  buttons, and the two commands are the person's own action.
- **Decision:** the script is removed (`src/uninstall/`, `dist/uninstall.js`, the `.no-feedback`
  marker). Instead the running extension notices its own uninstall and asks in the window:
  "Ansible Flow Designer was uninstalled. Sorry it did not fit. …" with **Tell Us Why** and
  **No, Thanks**. Only **Tell Us Why** opens the form (`source=uninstall`).
- **How it notices:** the editor takes an uninstalled extension off `extensions.json` (the list
  beside the folder extensions are installed in) at once, and leaves the extension running until
  the next restart (seen on VS Code 1.146: the list becomes `[]`, the folder stays). The extension
  watches that file. An update keeps the extension on the list with the new version, so it asks
  nothing; a short wait before asking covers a list rewritten in two steps.
- **Not asked:** after **Don't Ask Again**; with `afd.feedback.prompt` off; when the list did not
  name the extension to begin with (a development host, a profile that keeps its own list in the
  user data folder); when no window with the extension active is open at the time (an uninstall
  from the command line, or from a window where no flow was opened).
- **Consequence:** fewer people are asked than the script reached, and none of them is surprised
  by a browser tab. The statement "VS Code shows nothing when an extension is uninstalled" above
  still holds for VS Code itself; the notice is the extension's own, while it is still running.

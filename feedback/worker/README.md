# afd-feedback Worker

A Cloudflare Worker (free plan) behind the Ansible Flow Designer feedback form. The extension sends
no telemetry: it only opens the static form page at
`https://chistokhinsv.github.io/ansible-flow-designer/feedback/`. The page posts each answer here,
and the Worker:

1. checks the origin, the size and the fields, and verifies the Cloudflare Turnstile token;
2. files the answer as an issue in the private YouTrack project AF, tagged `feedback` or
   `uninstall` and with the editor;
3. sends the product owner a Telegram message with the summary, the start of the text and the
   issue link. The email address never goes to Telegram.

Nothing is stored in the Worker. Secrets are set with `wrangler secret put` and are never in a
file of this repository.

## Files

| File             | What                                                                       |
| ---------------- | -------------------------------------------------------------------------- |
| `wrangler.toml`  | Name, entry, compatibility date, the non-secret vars, the rate limit, logs |
| `src/index.ts`   | The fetch export: binds the runtime and calls the handler                  |
| `src/handler.ts` | Routing, checks, Turnstile, YouTrack, tags, Telegram, the log line         |
| `src/answer.ts`  | Parsing and validation of the body                                         |
| `src/format.ts`  | The issue summary and description, the Telegram texts                      |

Tests: `test/unit/feedback/worker.test.ts` in the repository root (Vitest, mocked fetch).

## API

Every response carries the CORS headers for `ALLOWED_ORIGIN` only:
`Access-Control-Allow-Origin: <ALLOWED_ORIGIN>`, `Access-Control-Allow-Methods: POST`,
`Access-Control-Allow-Headers: Content-Type`, `Access-Control-Max-Age: 86400`, `Vary: Origin`.
Bodies are JSON: `{"ok":true,"id":"AF-12"}` or `{"ok":false,"error":"..."}`.

### `OPTIONS /feedback`

`204` with the CORS headers above.

### `POST /feedback`

`Content-Type: application/json`, at most 16 KB (16384 bytes; 4,000 characters of non-Latin text fit):

```json
{
  "source": "prompt",
  "version": "0.77.0",
  "editor": "vscode",
  "rating": 4,
  "uses": ["design", "ai"],
  "text": "Wiring the rescue path was quick.",
  "email": "pat.doe@example.com",
  "turnstile": "<token from the Turnstile widget>"
}
```

| Field       | Rule                                                                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `source`    | Required: `prompt`, `command` or `uninstall`                                                                                             |
| `version`   | Optional (empty or missing: unknown); at most 20 characters, `^[0-9][0-9A-Za-z.+-]*$`                                                    |
| `editor`    | Required: `vscode`, `cursor`, `kiro`, `antigravity`, `windsurf`, `vscodium` or `other`                                                   |
| `rating`    | Optional, integer 1 to 5. Used for `prompt` and `command`, ignored for `uninstall`                                                       |
| `uses`      | Optional array of `design`, `import`, `ai`, `awx`, `runs`, `other`. Duplicates dropped. Ignored for `uninstall`                          |
| `reason`    | Optional: `not-needed`, `hard-to-use`, `missing-feature`, `bug`, `slow`, `other-tool`, `just-trying`, `other`. Used for `uninstall` only |
| `text`      | Optional string. Trimmed; cut to 4000 characters (not refused); control characters other than newline and tab removed                    |
| `email`     | Optional, at most 200 characters, a simple `name@host.tld` shape. An empty string counts as not given                                    |
| `turnstile` | Required, 1 to 2048 characters                                                                                                           |

`null` counts as not given for the optional fields. Unknown fields are ignored. An answer with no
text, no rating, no uses and no reason is refused as `empty`.

Checks, in this order:

| Check                                                            | Status | `error`                                  |
| ---------------------------------------------------------------- | ------ | ---------------------------------------- |
| Path is not `/feedback`                                          | 404    | `not found`                              |
| Method is not `POST` or `OPTIONS`                                | 405    | `method`                                 |
| `Origin` is not `ALLOWED_ORIGIN`                                 | 403    | `origin`                                 |
| More than 10 requests a minute from this IP (`CF-Connecting-IP`) | 429    | `rate limited` (with `Retry-After: 60`)  |
| `YOUTRACK_*` or `TURNSTILE_SECRET` not set                       | 503    | `not configured`                         |
| Body over 16 KB                                                  | 413    | `too large`                              |
| `Content-Type` is not `application/json`                         | 415    | `content type`                           |
| Body is not a JSON object                                        | 400    | `invalid json`                           |
| A field breaks its rule                                          | 400    | `invalid <field>`, like `invalid rating` |
| Nothing answered                                                 | 400    | `empty`                                  |
| Turnstile says no (siteverify with secret, token and `remoteip`) | 403    | `captcha`                                |
| YouTrack does not create the issue                               | 502    | `not saved`                              |
| Saved                                                            | 200    | `{"ok":true,"id":"AF-12"}`               |

### What YouTrack gets

`POST {YOUTRACK_URL}/api/issues?fields=idReadable` with `Authorization: Bearer YOUTRACK_TOKEN` and
`{"project":{"id":YOUTRACK_PROJECT_ID},"summary":...,"description":...}`.

- Summary: `Feedback 4/5 · vscode · 0.77.0`, `Feedback · cursor · 0.77.0` without a rating,
  `Uninstalled: missing feature · kiro · 0.77.0`, or `Uninstalled · kiro · 0.77.0` without a reason.
- Description (Markdown): a list of the source, editor, version, rating, uses, reason, email (when
  given) and the UTC time received, then the text as a quote. Markdown characters in the text are
  escaped, so it cannot load an image, add a link or HTML, or mention anyone.
- Tags: `feedback` (or `uninstall`) and the editor. The tag API takes only a tag's ID, so the Worker
  looks the tag up by name (`GET /api/tags?query=`), creates it when missing (`POST /api/tags`),
  then adds it (`POST /api/issues/{id}/tags`). A tag the Worker creates belongs to the token's
  user and is visible to that user only; share it in YouTrack if others need it. When tagging
  fails, the issue is kept and the answer is still `200`.

### What Telegram gets

`POST https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage` with `chat_id`, `text` and
`disable_web_page_preview: true`. The text is the summary, at most 300 characters of the answer
text, and `{YOUTRACK_URL}/issue/AF-12`. When YouTrack fails, the message says the answer was lost
and carries the summary and the start of the text. Never the email. A Telegram failure does not
fail the request. With `TELEGRAM_BOT_TOKEN` or `TELEGRAM_CHAT_ID` empty, no message is sent.

### Logs

One JSON line per request, in Workers Logs (dashboard: Workers > afd-feedback > Logs):

```json
{
  "msg": "feedback",
  "method": "POST",
  "path": "/feedback",
  "source": "prompt",
  "editor": "vscode",
  "version": "0.77.0",
  "id": "AF-12",
  "tags": "ok",
  "telegram": "ok",
  "outcome": "saved",
  "status": 200,
  "ms": 840
}
```

No answer text, email, IP address or token is logged.

## One-time setup

You need a Cloudflare account (the free plan is enough), the YouTrack Cloud instance and a Telegram
account. Run the commands in this folder, with Node.js 22.12 or later.

```bash
npm ci
npx wrangler login
```

### 1. YouTrack project and token

1. Create the project AF (Projects > New project) and keep it private.
2. Create a permanent token for the user that files the issues: Profile > Account Security >
   Tokens > New token, scope YouTrack. That user needs to create issues in AF.
3. Find the project's database ID (the `id`, not the short name):

   ```bash
   read -rs YOUTRACK_TOKEN && export YOUTRACK_TOKEN
   curl -s -H "Authorization: Bearer $YOUTRACK_TOKEN" \
     "https://chistokhin.youtrack.cloud/api/admin/projects?fields=id,shortName"
   ```

   The answer looks like `[{"shortName":"AF","id":"0-12","$type":"Project"}]`. The `id` is
   `YOUTRACK_PROJECT_ID` (see "Where the two vars go" below).

### 2. Telegram bot and chat

1. Talk to `@BotFather`, send `/newbot` and keep the token it gives.
2. Send any message to your new bot from the account that should get the notices.
3. Find the chat ID:

   ```bash
   read -rs TELEGRAM_BOT_TOKEN && export TELEGRAM_BOT_TOKEN
   curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getUpdates"
   ```

   Look for `"chat":{"id":123456789,...}` in `result[].message`: that number is
   `TELEGRAM_CHAT_ID`.

### Where the two vars go

`wrangler.toml` leaves `YOUTRACK_PROJECT_ID` and `TELEGRAM_CHAT_ID` empty. The chat ID is not a
credential, but it identifies the Telegram account, so keep it out of this public repository:

- deploying from GitHub (`.github/workflows/feedback.yml`): set the repository variable
  `FEEDBACK_YOUTRACK_PROJECT_ID` and the repository secret `FEEDBACK_TELEGRAM_CHAT_ID`; the
  workflow passes them to `wrangler deploy --var`. The chat ID is a secret because
  `wrangler deploy` prints every var's value and the repository's workflow logs are public;
  GitHub masks secrets in them;
- deploying by hand: pass them the same way,
  `npx wrangler deploy --var YOUTRACK_PROJECT_ID:0-12 --var TELEGRAM_CHAT_ID:123456789`.

A plain `npx wrangler deploy` without them sets both back to empty.

### 3. Turnstile widget

In the Cloudflare dashboard: Turnstile > Add widget, hostname `chistokhinsv.github.io`, mode
Managed. The site key goes into the form page; the secret key goes to the Worker below.

### 4. Secrets

Each command asks for the value; nothing lands in a file or the shell history.

```bash
npx wrangler secret put YOUTRACK_TOKEN
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TURNSTILE_SECRET
```

### 5. Deploy

By the Feedback workflow on a push to `main` (or Run workflow), or by hand with the two vars:

```bash
npx wrangler deploy --var YOUTRACK_PROJECT_ID:0-12 --var TELEGRAM_CHAT_ID:123456789
```

The Worker answers at `https://afd-feedback.<your-subdomain>.workers.dev/feedback`; that URL goes
into the form page. Check it:

```bash
curl -i -X OPTIONS https://afd-feedback.<your-subdomain>.workers.dev/feedback
```

`204` with `Access-Control-Allow-Origin: https://chistokhinsv.github.io` means it is up. Then send
one answer from the form page and look for the issue and the Telegram message.

Before `YOUTRACK_PROJECT_ID` and the secrets are set, `POST /feedback` answers `503 not configured`.

## Rate limit

The `[[ratelimits]]` binding in `wrangler.toml` allows 10 POST requests a minute per client IP
(`CF-Connecting-IP`), after the origin check. Cloudflare counts per location and approximately, so
it is a brake, not a hard limit; Turnstile is the real guard. The Workers docs set no plan
restriction on it (generally available since September 2025). If a deploy refuses it, delete the
block: the Worker then runs without the limit.

## Development

```bash
npm ci
npm run check        # tsc with the Workers types
npx wrangler dev     # local run on http://localhost:8787
```

For `wrangler dev`, put local values in `.dev.vars` (ignored by git), for example
`TURNSTILE_SECRET=1x0000000000000000000000000000000AA`, Cloudflare's test secret that accepts any
token. The tests run from the repository root:

```bash
npx vitest run --project feedback
```

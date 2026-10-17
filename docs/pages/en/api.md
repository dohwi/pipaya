The server is **API-only**. It serves no HTML or API documentation page and runs independently of the app (client). This page lists every route, transcribed from the registration code in `server/src`.

## Authentication and common rules

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -H "Authorization: Bearer $TOKEN" http://<server address>:8787/configuration
```

| Item | Rule |
|---|---|
| Header | `Authorization: Bearer <token>` — admin token or device token |
| Public routes | `GET /health`, `POST /pairing/redeem` |
| `?token=` allowed | Only `/ws`, `/events`, `/sessions/:id/events`, `/terminals/:id/ws` (for browser streams) |
| Admin only | `POST`/`DELETE /pairing`, `GET /devices/tokens`, `DELETE /devices/tokens/:id`, `POST /server-extensions/reload`, `GET`/`POST /server/update` |
| Compatibility | `X-Pipaya-Protocol` header (`?protocol=` for streams). Lower than the server's `minClientProtocol` gives `426 client_too_old` |
| CORS | Loopback, Tailscale, private network and Tauri origins are always allowed; others via `PIPAYA_CORS_ORIGINS` |
| Request size | 2MB by default, 192MB for `POST /sessions/:id/messages`, 16MiB for client settings |

### Error format

```json
{ "error": { "code": "invalid_request", "message": "..." } }
```

Request schemas (TypeBox) provide validation and handler types. API messages and `GET /tools` descriptions are in English; UI translation is done by the client.

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `invalid_request` | The request is invalid |
| 400 | `update_unavailable` | This server cannot update itself |
| 401 | `unauthorized` | The token is missing or wrong |
| 403 | `admin_only` | An admin-only route was called with a device token |
| 403 | `invalid_pairing_code` | The connection code is not valid |
| 403 | `terminals_disabled` | The server has `PIPAYA_TERMINAL=0` |
| 404 | `not_found` | The target does not exist |
| 409 | `conflict` | The state does not allow it (running, compacting, closed session, etc.) |
| 409 | `sessions_running` | Update refused because chats are running |
| 409 | `too_many_terminals` | The 16-terminal limit |
| 409 | `up_to_date` / `update_in_progress` | Update related |
| 413 | `payload_too_large`, `too_large` | The request or file is too large |
| 426 | `client_too_old` | The app is too old |
| 429 | `pairing_throttled`, `notification_limit` | Too many attempts or notifications |
| 500 | `internal_error` | Server error |
| 501 | `compaction_not_supported` | This server does not support compaction |
| 502 | `upstream_error`, `update_failed` | Model call failed / update installation failed |

## Status and updates

| Method | Path | Description |
|---|---|---|
| GET | `/health` | Public. `ok`, `version`, `protocol`, `minClientProtocol`. With a token, also `uptimeMs`, `runningSessions`, `subscribers` |
| GET | `/server/update` | **Admin.** Whether there is a new commit and whether it can restart itself (`managed`, `reason`) |
| POST | `/server/update` | **Admin.** `{force?}` Move to the new commit → install dependencies → exit the process (the service manager restarts it). `409 sessions_running` if chats are running |
| GET | `/tools` | Tool list and defaults |
| GET | `/workspace` | Default working directory (`root`), home, and active and closed session counts per folder |
| GET | `/activity` | Per-session running and waiting-for-approval state |

## Sessions

| Method | Path | Description |
|---|---|---|
| POST | `/sessions` | Create. `{title?, cwd?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, approval?}` |
| GET | `/sessions` | List. `?limit=1..200(50)&before=&closed=` → `{sessions, nextBefore}` |
| POST | `/sessions/delete` | Bulk delete `{ids: 1..500}` → `{deleted, skipped}` (running or waiting ones are skipped) |
| GET / PUT | `/sessions/retention` | Automatic deletion policy `{enabled, days: 1..3650, onlyClosed}`, last run, count due for deletion now |
| GET | `/sessions/:id` | Get |
| PATCH | `/sessions/:id` | Update `{title?, purpose?, provider?, model?, thinkingLevel?, systemPrompt?*, tools?*, approval?, closed?}` (*only before the first message) |
| DELETE | `/sessions/:id` | Delete (204) |
| GET | `/sessions/:id/status` | Run state, partial message being streamed, queue, pending approvals and questions |
| GET | `/sessions/:id/usage` | Token and cost totals |
| GET | `/sessions/:id/context` | Context snapshot (AGENTS.md, skills, system prompt, files read) |
| POST | `/sessions/:id/messages` | Send `{text, mode?, images?, files?}` → `202`. Body limit 192MB |
| GET | `/sessions/:id/messages` | Stored history. `?after=&limit=1..5000(1000)` |
| POST | `/sessions/:id/abort` | Abort → `{aborted}` |
| POST | `/sessions/:id/queue/cancel` | Cancel a queued message `{mode: "steer"\|"follow_up", text}` → `{cancelled}` |
| POST | `/sessions/:id/retry` | Retry → `202` |
| POST | `/sessions/:id/fork` | Fork `{atSeq?, title?}` → `201` |
| POST | `/sessions/:id/compact` | Compact `{customInstructions?}` (up to 2,000 characters) |
| GET | `/sessions/:id/files` | Download a file from the working folder. `?path=` (up to 50MB, headers that prevent running as a web page) |
| GET | `/sessions/:id/extension-entries` | Entries left by server extensions. `?extension=&type=` |

Body for sending a message:

```json
{
  "text": "…",
  "mode": "prompt",
  "images": [{ "type": "image", "data": "<base64>", "mimeType": "image/png" }],
  "files":  [{ "name": "report.pdf", "data": "<base64>" }]
}
```

`mode` is `prompt` (only when idle), `steer` or `follow_up`. `images` allows up to 8 and `files` up to 8 (50MB each, 100MB total).

## Approvals and questions

| Method | Path | Description |
|---|---|---|
| GET | `/approvals` | Pending approvals. `?sessionId=` |
| POST | `/sessions/:id/approvals/:toolCallId` | Decide `{approved, reason?(≤2000 characters)}` |
| GET | `/questions` | Pending `ask_user` questions |
| POST | `/sessions/:id/questions/:toolCallId` | Answer `{answer}` or, for multiple questions, `{answers: […]}` (each ≤10,000 characters) |

## Models and providers

| Method | Path | Description |
|---|---|---|
| GET | `/models` | Catalog. `?provider=&configured=true` |
| GET | `/providers` | Availability and sign-in methods (key values are not returned) |
| POST | `/providers/:id/login` | Start sign-in `{type: "api_key"\|"oauth"}` |
| GET | `/logins/:id` | Progress (link to open, device code, pending question) |
| POST | `/logins/:id/answer` | Answer a question `{promptId, value}` |
| POST | `/logins/:id/cancel` | Cancel |
| PUT | `/providers/:id/credential` | Save a key `{key}` |
| DELETE | `/providers/:id/credential` | Delete a key |
| GET | `/configuration` | Custom providers and defaults (secrets excluded) |
| GET | `/configuration/catalog` | Bundled catalog for model ID autocomplete |
| POST | `/configuration/discover` | Fetch an endpoint's model list |
| PUT | `/configuration/providers/:id` | Create or update a custom endpoint |
| POST | `/configuration/providers/:id/refresh` | Synchronize the model list with the upstream |
| DELETE | `/configuration/providers/:id` | Delete the endpoint and stored key |
| PUT | `/configuration/defaults` | Default model `{provider, model}` (`null` to revert) |
| PUT | `/configuration/workdir` | Default working folder `{path}` (`null` to revert) |
| PUT | `/configuration/approval` | Default approval policy `{approval}` |
| PUT | `/configuration/ask-user` | Allow `ask_user` `{enabled}` |
| POST | `/configuration/test` | Connection test `{provider, model}` → `{ok, durationMs, text?, error?}` (may incur charges) |
| GET / PUT | `/compaction` | `{auto, model}` automatic compaction and the summary model |
| GET / PUT | `/subagents` | Sub-agents (PUT **replaces everything**) |
| GET / PUT | `/system-model` | Model that writes session titles and purposes (`null` turns it off) |
| GET / PUT | `/model-roles` | Model per role (PUT **replaces everything**) |
| POST | `/llm/complete` | One-off completion without a session `{role \| provider+model, system?, input, maxTokens?}` |

## Folders and files

| Method | Path | Description |
|---|---|---|
| GET | `/fs/dirs` | Browse folders (folders only). `?path=&hidden=` → up to 500 |
| POST | `/fs/dirs` | Create a folder `{parent, name}` |
| GET | `/fs/files` | Search file and folder names for `#` mentions. `?cwd=&q=&limit=1..100(50)` |

## Groups and terminals

| Method | Path | Description |
|---|---|---|
| GET / POST | `/groups` | List groups / create `{name?, layout}` |
| PATCH / DELETE | `/groups/:id` | Update name or layout / delete |
| GET | `/terminals/info` | Terminal support, platform, shell list, maximum count |
| GET / POST | `/terminals` | List / create `{cwd?, shell?, title?, cols?, rows?}` |
| PATCH / DELETE | `/terminals/:id` | Rename / close |
| WS | `/terminals/:id/ws` | Input/output socket |

## Skills, templates, extensions and languages

| Method | Path | Description |
|---|---|---|
| GET | `/skills` | Skill list and on/off. `?cwd=&sessionId=` |
| PUT | `/skills/:id` | `{scope: "global"\|"project"\|"session", enabled: bool\|null, cwd?, sessionId?}` |
| GET | `/templates` | Prompt templates. `?cwd=` |
| GET | `/server-extensions` | Loaded server extensions and commands |
| POST | `/server-extensions/reload` | **Admin.** Reload |
| GET | `/server-extensions/errors` | Error log (last 100) |
| POST | `/server-extensions/:extension/methods/:method` | Call an extension method. `?sessionId=` |
| GET | `/extensions/settings` | All client extension settings |
| PUT | `/extensions/:id/settings` | `{settings}` JSON object (≤16,000 characters) |
| DELETE | `/extensions/:id` | Delete extension settings |
| GET | `/locales` | Language pack list |
| GET / PUT / DELETE | `/locales/:tag` | Get a pack / save `{name, messages, owner?}` / delete (`?owner=`). `ko` and `en` are reserved |
| GET | `/client-settings` | All client settings tied to the server |
| GET / PUT | `/client-settings/:key` | `favModels` · `extensions` · `notificationPolicy` |

## Devices and notifications

| Method | Path | Description |
|---|---|---|
| POST | `/pairing` | **Admin.** Connection code → `{code, expiresAt}` |
| DELETE | `/pairing` | **Admin.** Cancel all issued codes |
| POST | `/pairing/redeem` | **Public.** `{code, name?}` → `{token}` (device token) |
| GET | `/devices/tokens` | **Admin.** Device token list (`id`, `name`, `createdAt`, `lastUsedAt`) |
| DELETE | `/devices/tokens/:id` | **Admin.** Revoke |
| GET | `/notifications/status` | `{pushConfigured, providers}` |
| GET | `/notifications/devices` | Notification-receiving device list |
| PUT | `/notifications/devices/:id` | Device state report (heartbeat) |
| POST | `/notifications/devices/:id/test` | Test notification |
| DELETE | `/notifications/devices/:id` | Delete a device's notification registration |
| POST | `/notifications/:id/received` | Confirm that a device displayed the notification |
| POST | `/notifications` | Send a notification `{source, notification}` |
| PUT | `/notifications/rules/:owner/:id` | Register a notification rule |
| DELETE | `/notifications/rules/:owner[/:id]` | Delete rules |

## Events and streams

| Method | Path | Description |
|---|---|---|
| GET | `/events` | SSE (all) |
| GET | `/sessions/:id/events` | SSE (one session) |
| GET | `/events/history` | Stored events and the latest cursor. `?sessionId=&after=&limit=1..1000(200)` |
| GET | `/events/types` | Event payload schemas |
| WS | `/ws` | Bidirectional WebSocket |

The detailed protocol is in [[events]].

## Example: create a chat and send a message

```bash
TOKEN="$(< ~/.pipaya/token)"; URL=http://<server address>:8787

# 1. Start subscribing first (in another terminal)
curl -N -H "Authorization: Bearer $TOKEN" "$URL/events?types=message_end,run_finished"

# 2. Create a session
ID=$(curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"cwd":"."}' "$URL/sessions" | jq -r .id)

# 3. Send a message (202)
curl -s -X POST -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"text":"Explain the structure of this folder"}' "$URL/sessions/$ID/messages"
```

> [!WARNING]
> Streaming chunks (`message_update`) are not stored, so **subscribe before you send the prompt**. For anything you missed, read the completed messages with `GET /sessions/:id/messages` to fill in.

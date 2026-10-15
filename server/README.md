# pipaya server

**English** · [한국어](README.ko.md) · [Project README](../README.md)

API-only harness: `pi-agent-core` + Bun + Fastify + SQLite. REST for commands and configuration; SSE/WebSocket for progress.
The server does not serve HTML, frontend assets or API documentation pages, and runs independently of `client/`.

```bash
cd server && bun install
bun run dev                     # starts with an empty model catalog
bun run typecheck && bun test
bun run start
```

For a one-command install with a service, see the [project README](../README.md#quick-install). To run the server in a container, see the [Docker sandbox](../README.md#server-in-docker-sandbox).

## Authentication

Token: `$HARNESS_TOKEN`, or generated at `~/.pipaya/token`.
Send `Authorization: Bearer <token>` on all API calls except `GET /health`.
Browser EventSource/WebSocket may use `?token=` **only** on `/events`, `/sessions/:id/events`, and `/ws`.
CORS preflight is public to allow clients on a separate origin.
The token grants administrator access; use Tailscale or HTTPS and do not share it with untrusted clients.

```bash
TOKEN="$(< "$HOME/.pipaya/token")"
curl -H "Authorization: Bearer $TOKEN" http://<server-ip>:8787/configuration
```

Errors are JSON: `{ "error": { "code": "invalid_request", "message": "..." } }`. API messages and the `GET /tools` descriptions are English; translating the UI is the client's job.
Request schemas in `src/schemas.ts` and `src/configuration.ts` provide TypeBox validation and handler types.
Tests additionally validate response contracts; production avoids per-response validation overhead.

## Runtime configuration

Bun loads `.env` in the server working directory. See `.env.example`.

| Variable | Default | Purpose |
|---|---|---|
| `HARNESS_HOST` / `HARNESS_PORT` | `0.0.0.0` / `8787` | Listen address |
| `HARNESS_DATA_DIR` | `~/.pipaya` | Database, token, default workspace |
| `HARNESS_DB` | `<data>/harness.db` | SQLite path |
| `HARNESS_WORKSPACE` | `<data>/workspace` | Startup default working directory. Change it at runtime with `PUT /configuration/workdir` (saved in SQLite, overrides this) |
| `HARNESS_PROVIDER` / `HARNESS_MODEL` | First configured model | Startup default; must name a registered custom provider/model; saved default takes priority |
| `HARNESS_APPROVAL` | `ask` | `auto`, `ask`, or `readonly` |
| `HARNESS_APPROVAL_TIMEOUT_MS` | `600000` | Auto-deny delay; `0` = no timeout |
| `HARNESS_LOG_LEVEL` | `info` | Fastify log level (`silent` disables logging). Tokens passed as `?token=` are redacted from request logs |
| `HARNESS_PUSH_FCM` | _(on when credentials exist)_ | `0` disables. Otherwise sends Android push through Firebase Cloud Messaging with Google Application Default Credentials; see [client/docs/notifications.md](../client/docs/notifications.md) |
| `HARNESS_CORS_ORIGINS` | _(empty)_ | Extra allowed browser origins, comma separated (exact match; `*` = any). Loopback, Tailscale `100.64.0.0/10`, RFC1918 LAN, `*.ts.net` and Tauri origins are always allowed |

A fresh server has an empty catalog: there are no built-in providers and no environment-based authentication.
Saved custom providers and models are restored from SQLite on restart.
Register endpoints and models through `/configuration/providers/:id` (or the client's Settings → Models), then set keys with `/providers/:id/credential`.

## REST API

| Method | Path | Input / result |
|---|---|---|
| GET | `/health` | Public liveness and stats |
| GET | `/tools` | Tool list and defaults |
| GET | `/models?provider=&configured=true` | Model catalog |
| GET | `/providers` | Provider availability, no keys |
| PUT | `/providers/:id/credential` | `{key}` |
| DELETE | `/providers/:id/credential` | Remove stored key |
| GET | `/workspace` | Default working directory (`root`) and the directories sessions use |
| PUT | `/configuration/workdir` | `{path}`: absolute existing directory, or `null` to restore the startup default |
| GET | `/fs/dirs?path=&hidden=` | Sub-directories of an absolute path (folders only) for pickers |
| POST | `/fs/dirs` | `{parent,name}`: create a folder |
| POST | `/sessions` | Optional `{title,cwd,provider,model,thinkingLevel,systemPrompt,tools,approval}`. `cwd` is an absolute existing directory anywhere on the server, or relative to the default working directory (created if missing) |
| POST | `/sessions/:id/compact` | Optional `{customInstructions}`. Summarizes older messages; the model then sees the summary instead of them (the stored transcript is unchanged). 409 while running or too short, 502 if the summary model fails |
| GET/PUT | `/compaction` | `{auto, model}`. `model` is `{provider, model, thinkingLevel?}` or `null` = use the session's own model for the summary |
| GET/PUT | `/subagents` | `{settings: {enabled, agents: [{name, description, enabled, model, tools, maxTurns, prompt}]}, toolChoices}`. `model` is `{provider, model, thinkingLevel?}` or `null` = the calling session's model (strength left out = `minimal`). Each agent is a read-only helper (`tools` from `read`, `grep`, `ls`; up to 10, unique `name`) behind the `delegate` tool, which takes an optional `agent` name (default: the first enabled one). `prompt` is appended to the built-in research prompt |
| GET | `/sessions?limit=&before=&closed=` | Sessions and `nextBefore` cursor |
| GET/PATCH/DELETE | `/sessions/:id` | Read/update/delete a session; PATCH also accepts `closed` |
| POST | `/sessions/:id/messages` | `{text,mode?,images?}`; async `202` |
| GET | `/sessions/:id/messages?after=&limit=` | Persisted transcript, ordered by `seq` |
| GET | `/sessions/:id/status` | Includes the streaming partial message for late joiners |
| GET | `/sessions/:id/usage` | Token/cost totals |
| POST | `/sessions/:id/abort` | `{aborted}` |
| POST | `/sessions/:id/queue/cancel` | Body `{mode: steer|follow_up, text}`; removes one undelivered queued message → `{cancelled}` |
| POST | `/sessions/:id/retry` | Retry after failure/abort; `202` |
| POST | `/sessions/:id/fork` | Optional `{atSeq,title}` |
| GET | `/skills?cwd=` | Skills visible from `cwd` (default: server default directory) with global/project on-off state |
| PUT | `/skills/:name` | `{scope:"global"\|"project",enabled,cwd?}`; project scope accepts `enabled:null` to drop the override |
| GET | `/locales` | UI language packs: `[{tag,name,owner?,messages,updatedAt}]` (built-in `ko`/`en` are not listed) |
| GET | `/locales/:tag` | One pack: `{tag,name,owner?,messages,updatedAt}` where `messages` maps the Korean source string to its translation |
| PUT | `/locales/:tag` | `{name,messages,owner?}`; `ko` and `en` are reserved. Max 20 packs, 3000 messages each. A pack owned by one extension is `409` for another. Saving identical content is a no-op (no event, same `updatedAt`). Emits `locales_updated` |
| DELETE | `/locales/:tag?owner=` | Remove a pack (idempotent); with `owner`, only if that extension published it |
| GET | `/sessions/:id/context` | Context snapshot (AGENTS.md files, enabled skills, effective system prompt) |
| GET | `/activity` | Per-session running/pending-approval state for sidebar indicators |
| GET/POST | `/groups` | Session groups (named split-pane layouts, 2-8 sessions). Without `name` the server uses `Group N`; clients normally send a localized name |
| PATCH/DELETE | `/groups/:id` | Rename or re-layout a group; delete it. A group left with fewer than two sessions (closed or deleted sessions leave their group) is removed by the server and emits `group_deleted` |
| GET | `/extensions/settings` | All client-extension settings, keyed by extension id |
| PUT | `/extensions/:id/settings` | `{settings}`: a JSON object owned by the extension (max 16,000 chars) |
| DELETE | `/extensions/:id` | Remove an extension's stored settings |
| GET | `/notifications/status` | `{pushConfigured,providers}` |
| GET | `/notifications/devices` | Devices that have connected with this token (`id`, `platform`, `name`, `os`, `app`, `live`, `push`, `lastSeen`); push tokens are never returned |
| PUT/DELETE | `/notifications/devices/:id` | Device presence heartbeat (`platform`, `focused`, `enabled`, `visibleSessionIds`, optional `name`, optional mobile `push` token) / remove the device (it is told through a `device_revoked` event and stops reporting) |
| POST | `/notifications/:id/received` | A device confirms it showed a notification, so delayed mobile push is skipped |
| POST | `/notifications` | `{source,notification:{title,body?,kind?,sessionId?,key?}}`. Rate limited to 5 per 10 s per source; `source: "harness"` is reserved for built-in notices |
| PUT/DELETE | `/notifications/rules/:owner/:id` | Per-extension rule that replaces the default notice for `run_finished` / `approval_requested` (max 5 per owner); `DELETE /notifications/rules/:owner` removes all |
| GET | `/approvals?sessionId=` | Pending approvals |
| POST | `/sessions/:id/approvals/:toolCallId` | `{approved,reason?}` |
| GET | `/events/history?sessionId=&after=&limit=` | Persisted events and latest cursor |
| GET | `/events/types` | Machine-readable event payload schemas |

Message modes: `prompt` starts an idle session; `steer` injects into an active run; `follow_up` queues for after it.
Invalid state returns `409`. `systemPrompt` and `tools` are frozen after the first message.
Thinking levels: `minimal`, `low`, `medium` (default), `high`, `xhigh`, `max`.
Disabling reasoning with `off` is not supported; existing `off` sessions migrate to `medium`.
Models without reasoning support ignore the selected strength.

## Skills

Skills follow the [Agent Skills](https://agentskills.io/specification) layout (`<name>/SKILL.md` with `name` + `description` frontmatter).

| Source | Location |
|---|---|
| Global | `~/.agents/skills/` of the server user |
| Project | `.pi/skills/` and `.agents/skills/` from the session directory up to the git root (or `/` without a repository) |
| Built-in | `server/builtin-skills/` (scope `builtin`), on in every project, lowest priority, can be switched off like any skill |

Nearer directories win name collisions, project skills beat global ones, and both beat built-in ones (replacing a built-in skill by name is silent). Invalid files are skipped with a warning (`GET /skills` → `warnings`).
Skills with `disable-model-invocation: true` are listed but never offered to the model.

On/off state is stored in SQLite (`settings.skills`), not in the skill folders: a **global** default, plus optional **per-project** overrides
keyed by the git root. Effective state = project override, else global default. Everything is enabled by default.

Enabled skills are added to the system prompt as an `<available_skills>` block (name, description, path); the model loads a skill by reading its `SKILL.md`.
Unlike `AGENTS.md` (frozen in the first-run **context snapshot**), skills always follow the *current* settings: toggling applies to running sessions
from their next message (`GET /sessions/:id/context` → `skills` / `effectiveSystemPrompt` show the live set). The leading system message is only rewritten
when the enabled set really changed, so the provider prompt cache stays warm otherwise. Without the `read` tool nothing is advertised. The `read` tool
may open files inside the currently enabled skill folders even though they are outside the working directory; nothing else outside it is readable. Changes emit `skills_updated`.

## Model configuration API

All changes are server-side and shared by clients connected to that server.

| Method | Path | Purpose |
|---|---|---|
| GET | `/configuration` | Custom providers, saved/effective defaults; never returns secrets |
| PUT | `/configuration/providers/:id` | Create/update a custom endpoint |
| DELETE | `/configuration/providers/:id` | Remove endpoint and stored key |
| PUT | `/configuration/defaults` | `{provider,model}`; JSON `null` resets to the startup default (`HARNESS_PROVIDER`/`HARNESS_MODEL`) or the first configured model |
| POST | `/configuration/test` | `{provider,model}`; `{ok,durationMs,text?,error?}` |
| GET | `/model-roles` | `{roles: {name: {provider,model}}}`. Named model slots such as `light` or `summary`; names are free-form (`^[a-z][a-z0-9-]{0,39}$`, max 20) |
| PUT | `/model-roles` | `{roles}` replaces the whole table; every model must exist, `{roles:{}}` clears it. Emits `configuration_updated` with `scope: "model-roles"` |
| POST | `/llm/complete` | One-shot completion, no session or tools. `{input, role? \| provider+model, system?, maxTokens?}` → `{text, provider, model, role, stopReason, usage}`. A role without a mapping uses the default model. Only the text you send is used; 502 if the provider fails |

Custom provider body:

```json
{
  "name": "Local Ollama",
  "baseUrl": "http://model-host:11434/v1",
  "api": "openai-completions",
  "authRequired": false,
  "models": [
    {
      "id": "qwen3:8b",
      "name": "Qwen 3 8B",
      "contextWindow": 32768,
      "maxTokens": 4096,
      "reasoning": false,
      "vision": false
    }
  ]
}
```

- API formats: `openai-completions`, `openai-responses`, `anthropic-messages`.
- Provider IDs: lowercase letter followed by lowercase letters/digits/`_`/`-`, max 64 chars.
- Model IDs are manual. Context window: 128–10,000,000; output limit: 1–context window.
- Custom endpoint URLs must be HTTP(S), without embedded credentials, query or fragment.
- Connection tests send real model requests: up to 32 output tokens, 30s timeout; charges may apply.
- Endpoint edits apply on the next request. Default changes affect new sessions only.
- Deleting providers/models referenced by defaults or sessions returns `409`.
- Custom pricing is not configured, so their recorded cost is zero, not necessarily free.

## Events

SSE: `GET /events` or `GET /sessions/:id/events`. Filter with `?types=a,b`.
Replay with `Last-Event-ID` or `?after=<id>`, then continue live; no cursor means live-only subscription.

Envelope: `{id,sessionId,type,ts,data}`. Persisted events use a global cursor; `id: 0` events are ephemeral.
Use `GET /events/types` for payload schemas. Event logs expire after seven days; transcripts are retained separately.

| Types | Persisted |
|---|---|
| `session_created`, `session_updated`, `session_deleted`, `session_forked` | Yes |
| `run_started`, `run_finished` | Yes |
| `agent_start`, `agent_end`, `turn_start`, `turn_end` | Yes |
| `message_start`, `message_end` | Yes |
| `message_update` | No; assistant deltas |
| `tool_execution_start`, `tool_execution_end` | Yes |
| `tool_execution_update` | No; partial tool output |
| `approval_requested`, `approval_resolved`, `message_queued`, `message_dequeued` | Yes |
| `provider_updated`, `configuration_updated`, `locales_updated`, `extension_settings_updated`, `group_*` | Yes |
| `notification` | No; addressed to one device, not replayed |

`message_end` contains `{seq,message}`. `run_finished` contains `{status,error,durationMs,usage}` and signals idle.
Subscribe before sending a prompt; replay does not recover ephemeral deltas.

WebSocket `/ws`: send `{id?,op,...args}`; receive `{type:"ack",id,ok,result|error}` and `{type:"event",event}`.
Operations: `subscribe {sessionId?,after?,types?}`, `unsubscribe {sessionId?}`, `prompt {sessionId,text,mode?,images?}`,
`abort {sessionId}`, `approve {sessionId,toolCallId,approved,reason?}`, `ping`.

## Storage and safety

```text
~/.pipaya/
├── harness.db       # sessions, messages, events, model settings, defaults, credentials
├── harness.db-wal   # SQLite managed
├── harness.db-shm
├── token            # 0600
└── workspace/
```

SQLite provides indexed queries and transactional configuration updates. API keys are **unencrypted**;
the default directory is created with `0700`, and new databases with `0600`.
Use a SQLite-aware backup or stop/checkpoint before copying; do not copy only the database while it is running.
Existing `server/data` is not auto-imported; set `HARNESS_DATA_DIR=./data` to keep using it.

The auth token and the data directory (`0600` / `0700`) are never printed to logs; `?token=` is redacted. `bash` child processes do not inherit any `HARNESS_*` variable.

Custom URLs intentionally allow LAN/Tailscale server-side requests; configure only trusted endpoints.
`bash` is **not sandboxed** and runs as the server user. Keep approval policy `ask` or isolate the server in a container/VM.
Mutating tools (`write`, `edit`, `bash`) follow the approval policy.

### Built-in skills

`harness-client-extensions` documents the client's extension system for agents that change the client. Its `references/` are copies of `client/docs/extension*.md`; after editing those, run `bun scripts/sync-builtin-skills.ts` (a test fails when they drift). Add another built-in skill by creating `builtin-skills/<name>/SKILL.md`.

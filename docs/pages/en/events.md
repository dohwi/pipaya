The server reports progress as **events**. Clients subscribe over SSE or WebSocket.

## Envelope

Every event has the same shape.

```json
{ "id": 1042, "sessionId": "…", "type": "message_end", "ts": 1760000000000, "data": { … } }
```

| Field | Description |
|---|---|
| `id` | **Global cursor.** For stored events, a monotonically increasing integer; for unstored (transient) events, `0` |
| `sessionId` | The session the event belongs to. `null` for global events |
| `type` | The kind of event |
| `ts` | Time of occurrence (Unix ms) |
| `data` | A payload that differs per `type`. The schema is at `GET /events/types` |

The event log expires after **7 days** (cleaned every 6 hours). The chat history (messages) is kept separately and is not affected.

## Event types

### Sessions and runs

| Type | Stored | Description |
|---|---|---|
| `session_created` `session_updated` | Yes | Session created or settings changed (the payload is the session record) |
| `session_deleted` | Yes | Session deleted (`sessionId: null`, `data.id`) |
| `session_forked` | Yes | Emitted for the new session once copying is done |
| `run_started` | Yes | The agent started working (`data.mode`) |
| `run_finished` | Yes | **The run ended.** A safe point at which to treat this session as idle. `{status, error, durationMs, usage}` |
| `agent_start` `agent_end` | Yes | Agent loop lifecycle |
| `turn_start` `turn_end` | Yes | One model call + one batch of tool executions |

### Messages

| Type | Stored | Description |
|---|---|---|
| `message_start` | Yes | A message started (user, assistant or tool result) |
| `message_update` | **No** | An assistant streaming chunk (delta) |
| `message_end` | Yes | Message completed and stored. `{seq, message}`. `seq` matches `GET /sessions/:id/messages` |
| `message_queued` | Yes | A `steer`/`follow_up` message was accepted during a run |
| `message_dequeued` | Yes | A pending message was cancelled before delivery |

### Tools and approvals

| Type | Stored | Description |
|---|---|---|
| `tool_execution_start` | Yes | A tool started (after approval, if it was needed). `{toolCallId, toolName, args}` |
| `tool_execution_update` | **No** | Intermediate tool output (for example, streaming bash output) |
| `tool_execution_end` | Yes | A tool ended or was blocked |
| `approval_requested` | Yes | A tool call is waiting for `POST /sessions/:id/approvals/:toolCallId` |
| `approval_resolved` | Yes | Approval decided, timed out or aborted (`source`: `user` / `timeout` / `abort`) |
| `question_requested` | Yes | The agent asked a question with `ask_user` |
| `question_resolved` | Yes | The question was answered or the run was aborted |

### Context

| Type | Stored | Description |
|---|---|---|
| `context_updated` | Yes | The size of what the model sees changed |
| `compaction_started` | Yes | Compaction began writing the summary (`reason`: `manual` / `threshold`) |
| `compaction_finished` | Yes | Summary stored. The model now sees the summary |
| `compaction_failed` | Yes | Compaction failed or was cancelled. **The context stays as it was** |

### Settings and configuration (global, `sessionId: null`)

| Type | Stored | Description |
|---|---|---|
| `configuration_updated` | Yes | Custom providers, defaults, compaction, cleanup policy and so on changed. Read `GET /configuration` again |
| `provider_updated` | Yes | A provider credential was set or deleted |
| `skills_updated` | Yes | Skills were turned on or off, or skill, template or AGENTS.md files changed |
| `extension_settings_updated` | Yes | Extension settings were saved or deleted |
| `client_settings_updated` | Yes | Client settings tied to the server changed. `origin` is the device that wrote it, so it can skip its own echo |
| `locales_updated` | Yes | A language pack was saved or deleted |
| `group_created` `group_updated` `group_deleted` | Yes | Split-screen group changes |

### Terminals and extensions (transient)

| Type | Stored | Description |
|---|---|---|
| `terminal_created` `terminal_updated` `terminal_closed` | No | Terminal opened, renamed or closed |
| `extensions_updated` | No | Server extensions were (re)loaded |
| `extension_error` | No | A server extension threw an exception in a hook, command or method |
| `extension_event` | Yes (No if `ephemeral`) | A custom event an extension emitted to clients |
| `extension_entry` | Yes | An extension left an entry in the session |

### Devices

| Type | Stored | Description |
|---|---|---|
| `notification` | No | An OS notification for a single device. **Not replayed** |
| `device_revoked` | No | A device was removed from the list. That device should stop reporting |

## SSE

`GET /events` (all) or `GET /sessions/:id/events` (one session).

| Item | Description |
|---|---|
| Filter | `?types=a,b` comma-separated |
| Replay | The `Last-Event-ID` header (sent automatically by a browser EventSource) or `?after=<id>`. **Stored** events after that cursor are replayed first, then it continues live |
| No cursor | Starts a live subscription only |
| Duplicates / gaps | It subscribes before replaying and filters duplicates by `id`, so there are no gaps or duplicates |
| Authentication | `Authorization` header or `?token=` |
| Heartbeat | A `: ping` comment every 15 seconds |
| Reconnection | `retry: 2000` (2 seconds) |
| Frame | `id: <n>` · `event: <type>` · `data: <envelope JSON>` |

Unstored events (`id: 0`) have no `id:` line, so the cursor does not advance.

```bash
curl -N -H "Authorization: Bearer $TOKEN" "http://<server address>:8787/events?after=1000&types=run_finished"
```

## WebSocket (`/ws`)

A bidirectional alternative to REST + SSE. It uses JSON text frames.

### Client → server

```json
{ "id": "1", "op": "subscribe", "sessionId": "…", "after": 1000, "types": ["run_finished"] }
```

| `op` | Arguments | Description |
|---|---|---|
| `subscribe` | `sessionId?`, `after?`, `types?` | Subscribe. Omit `sessionId` for all. A previous subscription to the same target is replaced |
| `unsubscribe` | `sessionId?` | Unsubscribe |
| `prompt` | `sessionId`, `text`, `mode?`, `images?` | Send a message |
| `abort` | `sessionId` | Abort → `{aborted}` |
| `approve` | `sessionId`, `toolCallId`, `approved`, `reason?` | Decide an approval |
| `ping` | | `{pong: <ms>}` |

`id` is optional and comes back as is in the response.

### Server → client

| Frame | Description |
|---|---|
| `{type: "hello", subscriptions, version, protocol, minClientProtocol}` | Once right after connecting. For judging compatibility |
| `{type: "ack", id, ok: true, result}` | Success |
| `{type: "ack", id, ok: false, error: {code, message}}` | Failure. `invalid_request` (the frame is not an object), `unknown_op` (unknown `op`) and so on |
| `{type: "event", event}` | A subscribed event |

The result of `subscribe` is `{subscribed, latestId}`. If you give `after`, stored events after it are replayed in chunks of 500, then it switches to live.

### Connection management

| Item | Value |
|---|---|
| Max frame | 25MB |
| Server ping | A protocol ping every 30 seconds. A socket that did not answer the previous ping is cut off (browsers answer automatically) |
| Slow client | Closed with `1013` if more than 8MB behind. Reconnect and replay with `after` in `subscribe` |
| Authentication | `?token=` allowed |
| Compatibility | `?protocol=` |

## How to subscribe correctly

1. **Subscribe before you send the prompt.** Streaming chunks are not replayed.
2. If disconnected, subscribe again with the last `id` you received as `after` to catch up on stored events.
3. If you need the chunks, fill the missed span with `GET /sessions/:id/messages` or `GET /sessions/:id/status` (which includes the partial message being streamed).
4. When `run_finished` arrives, that session is idle. If a queued message starts next, `run_started` follows immediately.
5. Global configuration events (`configuration_updated`, `skills_updated` and so on) are **a signal to "read again", not a statement of what changed**. Call the relevant `GET` again.

## Looking up past events

`GET /events/history?sessionId=&after=&limit=` → `{events, latestId}`. `limit` is 1–1,000 (default 200). Use it to fetch, all at once, the changes that happened while the app was off.

## Event schema

`GET /events/types` returns `{type, persisted, description, data}` (JSON Schema) for each event. It is the reference for clients and extensions to check payload formats.

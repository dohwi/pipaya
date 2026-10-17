The structure of pipaya and what happens to a single message. Read this to know where to look when something goes wrong.

## Process and storage

The server is a single Bun process. All persistent data lives in `~/.pipaya/pipaya.db` (SQLite).

| Table | Contents |
|---|---|
| `sessions` | Session records (title, working folder, model, approval policy, closed flag, and so on) |
| `messages` | Conversation history per session, ordered by `seq` |
| `events` | The event log. Expires after **7 days** |
| `credentials` | Provider API keys and OAuth credentials (**not encrypted**) |
| `custom_providers` | Model endpoints you registered |
| `settings` | Key-value store: default model, default folder, default approval, compaction, sub-agents, system model, cleanup policy, skill on/off, roles, and more |
| `groups` | Split-view groups |
| `session_contexts` | The AGENTS.md snapshot frozen at a session's first run |
| `session_compactions` | Compaction summaries |
| `session_skills` | Per-session skill overrides |
| `extension_entries` | Records server extensions leave on a session |
| `device_tokens` | Tokens of devices connected by QR (hashes only) |
| `notification_*` | Notification devices, rules, de-duplication, delayed pushes |
| `client_settings` | Client settings tied to the server |

Kept only in memory: running agent loops, partial messages being streamed, **terminals**, connection codes (QR), and the state of connected devices.

> [!NOTE]
> If you restart the server, work in progress is interrupted and does not resume automatically. Conversation history and settings stay in the database. All terminals end.

## The journey of one message

::: steps
### Request

The client sends `{text, mode?, images?, files?}` to `POST /sessions/:id/messages`. The server answers `202` right away and continues in the background. If the session is running and `mode` is `prompt`, the answer is `409`.

### Message assembly

When the server builds the user message it adds:

- For a prompt template (`/prompt:name`), the expanded body and a marker for display
- For `/subagent:name`, `@session` or `/skill:name`, a **hidden hint** (`<pipaya-hint>`) that only the model sees
- Attached images, and for files, a saved copy in `.pipaya/uploads/` plus a path note (`<pipaya-files>`)

### Auto-compaction check

If auto-compaction is on and the context reached the threshold, older history is summarized before the prompt runs. → [[context]]

### Agent loop

The model is called; if it asks for tools, they run and the results go back to the model (a turn). This repeats. Before each tool call, the **approval policy check** runs. → [[tools]]

### Done

When the model answers without a tool call, the run ends and `run_finished` is emitted. A queued follow-up message (`follow_up`) is handled next, if any.
:::

## Telling clients with events

Everything that happens (messages, tool runs, approval requests, state changes) is published as an event and delivered to subscribers over SSE and WebSocket. Persisted events carry a global cursor (`id`) and are kept for 7 days, so a client that dropped and reconnected can replay what it missed. Streaming fragments (`message_update`, `tool_execution_update`) are not stored, so **subscribe before you send the prompt**. → [[events]]

## Runaway protection

| Guard | Value |
|---|---|
| Model calls per run | 200 (change with `PIPAYA_MAX_RUN_TURNS`) |
| Repeated tool calls | Stops after 6 identical calls (same name and arguments) in a row |
| Forced stop after an abort request | If it does not stop within 8 seconds, the run is cut and ends as `aborted` |
| Approval wait | Denied automatically after 10 minutes by default |

When a run stops at one of these limits, it ends with a note telling you to send a message to continue.

## Memory management

A session left unused for 30 minutes is unloaded from memory and loaded back from the database the next time it is used. Nothing in the history is lost.

## System prompt composition

A session's system prompt is assembled in this order:

1. The base prompt (or the `systemPrompt` given when the session was created)
2. **AGENTS.md**, the full text frozen at the session's first run
3. `<available_skills>`, the name, description and path of each enabled skill
4. `# Sub-agents`, only in a session that has the `delegate` tool and at least one enabled sub-agent

Block 2 never changes during the session; blocks 3 and 4 follow settings from the next message on. Details are in [[context]].

## What the client does

The client reads state over REST, receives live updates over SSE, and merges them on screen. What the server stores (sessions, model settings, groups, sub-agents, and so on) is kept separate from what stays on the device (theme, shortcuts, notification sound, server list and tokens). → [[settings]]

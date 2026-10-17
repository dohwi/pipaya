A session is one conversation. Each session has its own model, working folder, approval policy and history.

## Session record

| Field | Description |
|---|---|
| `id` | Session ID |
| `title` | Title. Up to 200 characters. Starts as `New session` |
| `name` | The call name used with `@` (for example, Mina). Assigned automatically → [[orchestration]] |
| `purpose` | One line on what this session is for, written by the system model. Up to 200 characters |
| `cwd` | Working directory |
| `provider` / `model` | The model in use |
| `thinkingLevel` | Reasoning strength: `minimal` `low` `medium` (default) `high` `xhigh` `max` |
| `systemPrompt` | Replaces the default prompt. Can be set **only before the first message** (`409` afterwards). Up to 100,000 characters |
| `tools` | List of tools to use. Can be set **only before the first message** |
| `approval` | `ask` `auto` `readonly`. A new session follows the server's default policy |
| `parentId` | The session this one was forked from |
| `closed` | Whether it is closed |

`systemPrompt` and `tools` are fixed after the first message.

## Creating

`POST /sessions`, or **New chat** in the app ({{Alt+N}}, `/new`). In the app, a session is created on the server as soon as you start a new chat, and it appears in the sidebar.

- `cwd` is either an absolute path that exists on the server, or a path relative to the default working directory (created if missing).
- If you start the server with `PIPAYA_RESTRICT_WORKSPACE=1`, sessions, the folder picker and the default folder are all limited to the workspace. Any other `cwd` is rejected.

## Automatic title and purpose

- **Without a system model**: the first message is whitespace-normalized and cut to its first 60 characters. The purpose (`purpose`) stays empty.
- **With a system model**: it is given the first message (up to 4,000 characters) and recent messages (up to 2,000 characters) and asked for a title (2–6 words, within 40 characters) and a purpose (within 80 characters) as JSON. It writes in the same language as the user's messages.

Set the system model in [[models]]. If you rename a session yourself with `/rename`, your title takes priority.

## Send modes

| Mode | Behavior | Condition |
|---|---|---|
| `prompt` | Starts a new run | Only when the session is **idle**. `409` if it is running |
| `steer` | Inserts an instruction into the next step of the running work | While running |
| `follow_up` | Queues the message to be handled after the current run ends | While running |

While a run is active, {{Enter}} in the input box steers and {{Alt+Enter}} queues → [[composer]]. Pending messages can be cancelled one by one from the list above the input box (`/cancel`, {{Alt+Q}}, `POST /sessions/:id/queue/cancel`).

Other cases that return `409`: sending to a session that is compacting, and sending to a closed session.

## Stop and retry

| Action | Description |
|---|---|
| Stop (`/stop`, {{Escape}}) | Asks the agent to stop. If it has not stopped within 8 seconds, the run is cut off and finishes as `aborted` |
| Retry (`/retry`) | When the last response ended as `error` or `aborted`, discards it and runs again. In any other state: `409` |

## Fork

`/fork` creates a **new session** with a copy of the history up to the current point and leaves the original untouched. `/fork last` branches from just before the last response. In the API, call `POST /sessions/:id/fork` with `atSeq` (copy up to that `seq`; omit for everything) and `title`. Use `/tree` to see and navigate the branch structure. Forked sessions are shown grouped under their original in the sidebar.

## Close and reopen

| Action | Description |
|---|---|
| Close (`/close`, {{Alt+W}}) | Stops it if running and removes it from the active list. **The history is kept** |
| Reopen (`/resume`, {{Alt+O}}) | Pick from a list that includes closed chats and open it |
| Delete (`/delete`) | Permanent. Cannot be undone. Messages and events are deleted too |

A closed session drops out of `@` mentions, and its name can be used again. If the session belonged to a group, it leaves the group when closed or deleted, and a group left with fewer than 2 sessions is dissolved.

## Listing

`GET /sessions?limit=&before=&closed=`

| Parameter | Description |
|---|---|
| `limit` | 1–200, default 50 |
| `before` | The `nextBefore` cursor from the previous page |
| `closed` | `true`: closed only, `false`: active only, omitted: both |

## Bulk delete and automatic cleanup

In Settings → Server → **Chats** you can select chats per folder and delete them. Up to 500 at a time, and **sessions that are running or waiting for approval or an answer are skipped** (`skipped` in the response).

The server's automatic cleanup deletes chats that have not been used for a while.

| Setting | Value |
|---|---|
| `enabled` | Off by default |
| `days` | How many days after last use a chat is deleted. 1–3650, default 30 |
| `onlyClosed` | When on, only closed chats are deleted. Off by default |

It runs once 30 seconds after the server starts, then every hour. The screen shows the last run time, the number deleted, and how many chats are due for deletion now. Chats that are running or waiting for an answer are never deleted, regardless of age. The API is `GET`/`PUT /sessions/retention`.

## Viewing status

| Item | Where |
|---|---|
| Running / waiting for approval / waiting for an answer | Sidebar status indicator, `GET /activity` |
| Partial message being streamed | `GET /sessions/:id/status` (for clients that connect late) |
| Token and cost totals | `GET /sessions/:id/usage` — `input` `output` `cacheRead` `cacheWrite` `totalTokens` `cost` (USD) `turns` |
| Applied AGENTS.md, skills and system prompt | Session context in the chat header → [[context]] |

> [!NOTE]
> No price is set for custom connections, so the recorded cost is 0. That does not mean it is free.

## Design notes

- If the server restarts, runs in progress are stopped and are not resumed automatically.
- A session unused for 30 minutes is unloaded from memory and reloaded from the database on next use.
- Two runs never go at once in the same session.

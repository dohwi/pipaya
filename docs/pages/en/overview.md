pipaya is an **AI agent chat tool that runs on your own server**. The server calls models and runs tools; the app (client) connects to the same server from any device. Sessions, settings and API keys are stored only in your server's SQLite database.

::: cards
[Quick start](/en/w/quick-start)

[Installation](/en/w/installation)

[How it works](/en/w/how-it-works)

[Tools and approval](/en/w/tools)
:::

## Architecture

| Part | Technology | Role |
|---|---|---|
| Server | Bun, Fastify, SQLite | Runs the agent and stores sessions and settings. **API only, no UI** |
| Client | Svelte 5, Vite, Tauri 2 | Web, Windows, macOS, Android and iOS apps |
| Transport | REST, SSE, WebSocket | Commands over REST, live progress over SSE/WebSocket |
| Agent loop | `pi-agent-core` | Alternates model calls and tool execution |
| Isolation | Docker (optional) | Confines the agent's file and command work to a container |

The server and client run independently. One server can serve several devices at once, and every device sees the same sessions and settings.

```text
[ Client ]  ──REST / SSE / WebSocket──▶  [ pipaya server ]  ──▶  [ Model API ]
 web · desktop · mobile                   sessions · tools · SQLite   OpenAI · Anthropic · local
```

## What it can do

Give the agent a goal and a working folder, and it reads and edits files, runs commands and works through multi-step tasks. Use it for software development, but also for organizing notes, research and data files.

| Feature | Description | Page |
|---|---|---|
| 10 built-in tools | `read` `write` `edit` `ls` `grep` `bash` `ask_user` `delegate` `peer_send` `peer_read` | [[tools]] |
| Approval policies | `ask` `auto` `readonly`. You control what changes things | [[tools]] |
| Any model | Built-in providers, local servers, your own endpoints. Split models by purpose | [[models]] |
| Conversation tools | Steer and queue, fork, retry, compaction, close and resume | [[sessions]] |
| Input box | `/` commands, `#` files, `@` sessions, pasted images, file uploads | [[composer]] |
| Session teamwork | Hand work to other sessions with `@name` and read the results | [[orchestration]] |
| Split view | Up to 8 conversations on one screen, with integrated server shells | [[panes]] |
| Many devices | One-time QR codes, per-device tokens, notifications and mobile push | [[notifications]] |
| Extensions | AGENTS.md, skills, templates, sub-agents, server and client extensions | [[agents-md]] |

## Highlights

### Data stays on your server
Conversations, keys and tokens all live on your server. No cloud account is needed, and model connections are configured in that one place. A new server has no model connected at all.

### You control what changes things
`write`, `edit` and `bash` follow the approval policy. The default `ask` confirms only actions that reach outside the project folder. An approval request is denied automatically if you do not answer within 10 minutes.

> [!WARNING]
> The read tools (`read`, `ls`, `grep`) need no approval and **can read files outside the working folder.** Assume anything the server's user can read can be read by the agent. See [[security]].

### Pick up on any device
If the connection drops, stored events (7 days) let the client catch up. You get a notification when work finishes or needs approval, and a device you are already looking at is not notified twice.

### Extend it yourself
Server extensions add tools and `/commands` and hook into the agent. Client extensions add panels, themes and language packs inside a sandbox.

## Supported environments

| Item | Details |
|---|---|
| Server | Linux and macOS (install script). On a Windows server, terminals run over pipes |
| Client | Windows x64, macOS Apple Silicon, Android arm64, iOS (unsigned IPA), web |
| Languages | Korean and English UI. More through language-pack extensions |
| License | AGPL-3.0 |

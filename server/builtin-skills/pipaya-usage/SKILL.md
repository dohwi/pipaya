---
name: pipaya-usage
description: Read this when the user asks to configure, inspect, or change pipaya itself (the server and client they are chatting through) — global/project AGENTS.md, skills, subagent roles, prompt templates, MCP servers, default/helper/fallback/image/role models, toggleable tools, compaction, execution guard, retention, voice input, or server extensions. Not for changing pipaya source code, and not for writing client/server extensions (use pipaya-client-extensions or pipaya-server-extensions).
---

# Using and configuring pipaya

Facts about the user's own pipaya. Everything here was checked against the server source; if the running server behaves differently, trust the live server (and session context in the chat header) over this file.

| Topic | Read |
|---|---|
| `AGENTS.md`, skills, subagent roles (`subagents/`), prompt templates (`templates/`) | `references/agents-md.md` |
| MCP servers: adding, updating, removing, troubleshooting stdio/http | `references/mcp.md` |
| Server settings & HTTP API: models, tools, delegate policy, compaction, guard, retention, extensions | `references/server-settings.md` |
| Voice input (dictation): file and realtime modes, `/voice` API, microphone button and shortcut | `references/voice-input.md` |

## Rules

1. **Pick the lightest channel that fits.**
   - **Plain files**: `AGENTS.md`, `skills/<name>/SKILL.md`, `subagents/<name>.md`, and `templates/<name>.md` live on disk — read and edit them directly (no token or port needed).
   - **Built-in tools**: use `mcp` for MCP servers, `schedule` for scheduled tasks, and `goal` for session goals.
   - **Server settings**: use the HTTP API (`references/server-settings.md`) when the user asks you to inspect or update settings directly; prefer the Settings UI whenever secrets (API keys, OAuth logins) are involved.
2. **Never print, log, or paste secrets.** Load `~/.pipaya/token` into a shell variable inside the same command (`TOKEN="$(< "${PIPAYA_DATA_DIR:-$HOME/.pipaya}/token")"`). Never `cat` or `echo` tokens or `.env` files. Do not pass real API keys in tool arguments (they are stored in the chat transcript) — ask the user to enter them in Settings.
3. **Never edit `pipaya.db` directly.** Always go through the built-in tools or HTTP API so validation, hot-reload, and client sync events run.
4. **Say when changes take effect.** File edits (`AGENTS.md`, skills, subagents, templates) and settings API changes apply immediately or from the next message/turn; only `PIPAYA_*` startup environment variables require a server restart.
5. **Edit the server's own home.** `~/.agents/` and `~/.pipaya/` belong to the user the *server* runs as (which may be a different machine or container from where a tool runs); confirm before editing.

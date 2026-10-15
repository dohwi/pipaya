---
name: harness-usage
description: Read this when the user asks how to configure or change the pipaya itself (the server and client they are chatting through) - adding, editing, enabling or removing sub-agents (the `delegate` helpers, their agent files in `.agents/subagents/*.md`, `$name` mentions), writing or locating the global ~/.agents/AGENTS.md and project AGENTS.md, or turning skills on and off. Not for changing the harness source code, and not for client extensions (use harness-client-extensions).
---

# Using and configuring the harness

Facts about the user's own harness. Everything here was checked against the server source; if the user's server behaves differently, trust the running server (`GET /subagents`, session context in the chat header) over this file.

| Topic | Read |
|---|---|
| Sub-agents: add, edit, enable, remove, models, tools, agent files, `$name` | `references/subagents.md` |
| Global and project `AGENTS.md`, when edits take effect, size limits | `references/agents-md.md` |
| Skills: where they load from, on/off | `references/agents-md.md` section "Skills" |

## Rules

1. **Settings live on the server, not in files.** Sub-agents and skill on/off are in the server database and are changed through the API or the client's settings screens. Sub-agents can *additionally* be defined as files (`references/subagents.md`, "Agent files"). `AGENTS.md` and `SKILL.md` are the opposite: plain files you can write.
2. **Prefer the client UI when the user can use it** (sub-agents: the sub-agent screen in settings; skills: the book icon under the input). Use the API only when asked or when you have no other way.
3. **`PUT /subagents` replaces everything.** Always `GET` first, change the one entry, and send the whole `settings` object back. A partial body would delete the other helpers.
4. **Never print or log the token.** Read it into a shell variable (`TOKEN="$(< ~/.pipaya/token)"`, or `HARNESS_TOKEN`) and use it in the same command. Never `cat` it. Do not touch `.env` files.
5. **Say when it applies.** AGENTS.md is frozen at a session's first run, so edits reach new sessions only. Sub-agent and skill changes apply to the next call or message.
6. **Give `write`/`edit`/`bash` to a helper only on request.** Those helpers act under the session's approval policy; default to `read`, `grep`, `ls`. A fresh server has no helpers, and with no helpers or skills the matching prompt blocks are not injected.
7. **Edit the right AGENTS.md.** The global file is `~/.agents/AGENTS.md` of the *server's* user. The server may be a different machine or a container from where you are running; check before editing.

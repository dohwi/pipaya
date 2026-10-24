---
name: pipaya-usage
description: Read this when the user asks how to configure or change the pipaya itself (the server and client they are chatting through) - writing or locating the global ~/.agents/AGENTS.md and project AGENTS.md, or turning skills on and off. Not for changing the pipaya source code, and not for client extensions (use pipaya-client-extensions).
---

# Using and configuring the pipaya

Facts about the user's own pipaya. Everything here was checked against the server source; if the user's server behaves differently, trust the running server (session context in the chat header) over this file.

| Topic | Read |
|---|---|
| Global and project `AGENTS.md`, when edits take effect, size limits | `references/agents-md.md` |
| Skills: where they load from, on/off | `references/agents-md.md` section "Skills" |

## Rules

1. **`AGENTS.md` and `SKILL.md` are plain files you write.** Only the skills on/off switches are stored in the server database and changed through the API or the client's settings screens.
2. **Prefer the client UI when the user can use it** (skills: the book icon under the input). Use the API only when asked or when you have no other way.
3. **Never print or log the token.** Read it into a shell variable (`TOKEN="$(< ~/.pipaya/token)"`, or `PIPAYA_TOKEN`) and use it in the same command. Never `cat` it. Do not touch `.env` files.
4. **Say when it applies.** AGENTS.md and skill changes both apply from the session's next message.
5. **Edit the right AGENTS.md.** The global file is `~/.agents/AGENTS.md` of the *server's* user. The server may be a different machine or a container from where you are running; check before editing.

# Sub-agents (`delegate`)

The main agent can hand a task (usually a search) to a **helper**. The helper works in its own transcript and returns one short report, so the main conversation does not fill up with file contents.

**A fresh server has no helpers (no files).** Nothing is built in. Until at least one helper exists (as a file), the `# Sub-agents` block is not added to the system prompt and `/subagent:name` adds no hint. The same holds for skills: with no skill available, no `<available_skills>` block is added.

## What a helper can and cannot do

- Tools: any of `read`, `grep`, `ls` (read-only) and `write`, `edit`, `bash` (change files / run commands). It cannot ask the user or call `delegate`.
- A helper that holds `write`, `edit` or `bash` is gated like those tools: the session's approval policy applies to the `delegate` call (ask / readonly refuses / auto runs). Helpers with only `read`, `grep`, `ls` run in every session.
- It **does not see the conversation**. The main agent must put all context in `task` (max 4,000 chars).
- Result: a report of at most ~300 words with `path:line` citations, cut at 6,000 chars. Output per call is limited to 2,048 tokens. Treat it as a lead and read the cited lines before changing code.
- Default thinking strength is `minimal` unless the helper's model entry sets one.

## What is stored on the server

Helpers are **files only**. The server stores just two switches, in the `settings` table (key `subagents`): the master switch and the names of helpers switched off in the settings screen. Older saves that held the helpers themselves are ignored.

API (admin or device token, `Authorization: Bearer`):

| Call | Effect |
|---|---|
| `GET /subagents?cwd=` | `{enabled, agents, warnings, toolChoices}`: every helper file visible from `cwd` (global + project), with `enabled` (effective), `fileEnabled`, `scope`, `path`, `model`, `tools`, `maxTurns`, `prompt`; broken files come back in `warnings` |
| `PUT /subagents {enabled}` | Master switch for the whole `delegate` tool |
| `PUT /subagents/:name {enabled}` | Switch one helper off/on. A helper whose file says `enabled: false` stays off. Unknown name: 404 |

Limits (checked when a file is read; a bad file is skipped with a warning): `name` `^[a-z][a-z0-9-]{0,39}$`, `description` 1-200 chars, `tools` 1-6 unique items from `read`, `grep`, `ls`, `write`, `edit`, `bash`, `maxTurns` 2-30 (default 12), `prompt` up to 2,000 chars appended to the built-in helper prompt (read-only research prompt without `write`/`edit`/`bash`, a general worker prompt otherwise). Default thinking is `minimal`.

## Agent files (no API needed)

A helper can also be a Markdown file. Files are read on every turn, so edits apply to the next message.

| Where | Scope |
|---|---|
| `~/.agents/subagents/<name>.md` | Global (the *server* user's home) |
| `<dir>/.agents/subagents/<name>.md` for every directory from `/` down to the session's working directory | Project. The nearest directory wins |

A file with the same `name` replaces a helper of that name saved on the server, and a nearer file replaces a farther one. Only `*.md` files up to 32 KB are read. A bad file is skipped with a warning (it never breaks other helpers).

```markdown
---
name: fixer                 # optional; default = file name without .md. Same rules as `name` above
description: Fixes a small, well-described bug and runs the tests   # required, 1-200 chars; say WHEN to use it
model: openai/gpt-5-mini    # optional; "provider/model", or omit / "inherit" = the caller's model
thinking: low               # optional; minimal | low | medium | high | xhigh | max (needs `model`; default minimal)
tools: [read, grep, ls, edit, bash]   # optional list or "read, grep"; default = read, grep, ls
maxTurns: 20                # optional; 2-30, default 12
enabled: true               # optional; default true
---
Everything below the frontmatter is the extra prompt (max 2,000 chars).
Run the project's tests after every edit and list the files you changed.
```

Create one with the `write` tool (or a shell):

```bash
mkdir -p ~/.agents/subagents
printf '%s\n' '---' 'description: Reads a diff area and lists risky spots with path:line. Read-only.' 'tools: [read, grep, ls]' '---' 'Focus on error handling and missing tests.' > ~/.agents/subagents/reviewer.md
```

An unknown `model` is not checked when written; if it does not exist when the helper runs, the helper falls back to the caller's model. The settings screen lists the files read-only and only switches helpers on or off.

## Recipes

Turn the whole feature off, or one helper off (keep the token out of output):

```bash
TOKEN="$(< ~/.pipaya/token)"; URL=http://localhost:8787
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"enabled":false}' $URL/subagents
curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"enabled":false}' $URL/subagents/explore
```

Add, edit or remove a helper by writing, editing or deleting its `.md` file. Port and data dir may differ (`PIPAYA_PORT`, `PIPAYA_DATA_DIR`; the token file is `<data dir>/token`).

## Picking a helper by hand: `/subagent:name`

In the message input the user can write `/subagent:name` (preceded by start or whitespace, followed by end, whitespace or `. , ; : ! ? )`). Only names of **currently available** (enabled) helpers count; unknown names, or a switched-off feature, are ignored. The server then adds a hidden `<pipaya-hint>` note (clients hide it) telling the model to call `delegate` with that agent. It is a strong hint, not a guarantee. The `/` menu lists helpers (tagged "Sub-agents") and the input tints the token. In the input, `#path` mentions a file, `#imageN` an attached image, and `@name` another session of the same group.

## Good helper design

- One job per helper, named for the job (`explore`, `tests-finder`, `api-routes`).
- Put the trigger in `description`: "Use when the user asks where X is defined or how Y flows".
- Cheap model + `minimal` thinking for search. Raise the model only if reports are shallow.
- Use `prompt` for house rules (output format, directories to skip). Permissions come from `tools`; give `write`/`edit`/`bash` only to a helper that needs them.

## Source map (when you must read code)

`server/src/subagent-settings.ts` (limits, switches, model resolution), `subagent-files.ts` (agent file parsing and lookup), `subagent.ts` (run loop, report cut, `/subagent:name` parsing/hint), `subagent-routes.ts` (API), `tools.ts` (the `delegate` tool), `sessions.ts` (wiring), client `src/components/SubAgents.svelte` (settings screen).

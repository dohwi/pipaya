# Sub-agents (`delegate`)

The main agent can hand a task (usually a search) to a **helper**. The helper works in its own transcript and returns one short report, so the main conversation does not fill up with file contents.

**A fresh server has no helpers.** Nothing is built in. Until at least one helper exists (saved on the server, or as a file), the `# Sub-agents` block is not added to the system prompt and `$name` adds no hint. The same holds for skills: with no skill available, no `<available_skills>` block is added.

## What a helper can and cannot do

- Tools: any of `read`, `grep`, `ls` (read-only) and `write`, `edit`, `bash` (change files / run commands). It cannot ask the user or call `delegate`.
- A helper that holds `write`, `edit` or `bash` is gated like those tools: the session's approval policy applies to the `delegate` call (ask / readonly refuses / auto runs). Helpers with only `read`, `grep`, `ls` run in every session.
- It **does not see the conversation**. The main agent must put all context in `task` (max 4,000 chars).
- Result: a report of at most ~300 words with `path:line` citations, cut at 6,000 chars. Output per call is limited to 2,048 tokens. Treat it as a lead and read the cited lines before changing code.
- Default thinking strength is `minimal` unless the helper's model entry sets one.

## Settings shape

Stored on the server (`settings` table, key `subagents`). API: `GET /subagents`, `PUT /subagents` (admin or device token, `Authorization: Bearer`).

```json
{
  "settings": {
    "enabled": true,
    "agents": [
      {
        "name": "explore",
        "description": "Searches and reads the codebase and reports back with path:line citations",
        "enabled": true,
        "model": null,
        "tools": ["read", "grep", "ls"],
        "maxTurns": 12,
        "prompt": ""
      }
    ]
  }
}
```

`GET` also returns `defaults` (the factory setup: no helpers) and `toolChoices`.

| Field | Rule |
|---|---|
| `settings.enabled` | Master switch for the whole `delegate` tool |
| `agents` | At most 10; names unique |
| `name` | `^[a-z][a-z0-9-]{0,39}$` (lowercase, digits, `-`; starts with a letter). This is what the main agent passes as `agent` and what the user types as `$name` |
| `description` | 1-200 chars. Shown to the main agent; it decides when to pick this helper, so say *when to use it* |
| `enabled` | A disabled helper is not offered |
| `model` | `null` = the model of the conversation that called it. Otherwise `{provider, model, thinkingLevel?}`; the model must be registered or the save is rejected (`400`). If it is deleted later, the helper silently falls back to the caller's model |
| `tools` | 1-6 unique items from `read`, `grep`, `ls`, `write`, `edit`, `bash` |
| `maxTurns` | Integer 2-30 (default 12): model calls before it is stopped; the report then says it may be incomplete |
| `prompt` | Up to 2,000 chars, **appended** to the built-in helper prompt (a read-only research prompt when the helper has no `write`/`edit`/`bash`, a general worker prompt otherwise) |

Unknown keys are rejected (`additionalProperties: false`). A bad save changes nothing.

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

Unlike the API, an unknown `model` in a file is not checked when written; if it does not exist when the helper runs, the helper falls back to the caller's model. File helpers appear in the model's sub-agent list and the `delegate` description, not (yet) in the settings screen.

## Recipes

Add or change a helper through the API (keep the token out of output):

```bash
TOKEN="$(< ~/.pipaya/token)"; URL=http://localhost:8787
curl -s -H "Authorization: Bearer $TOKEN" $URL/subagents \
 | jq '.settings | .agents += [{name:"reviewer",description:"Reads a diff area and lists risky spots with path:line",enabled:true,model:null,tools:["read","grep"],maxTurns:12,prompt:"Focus on error handling and missing tests."}] | {settings:.}' \
 | curl -s -X PUT -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @- $URL/subagents
```

Edit one field: `jq '.settings | (.agents[] | select(.name=="explore") | .maxTurns) = 20 | {settings:.}'`. Remove: `.agents |= map(select(.name!="reviewer"))`. Turn all off: `.enabled = false`.

Port and data dir may differ (`HARNESS_PORT`, `HARNESS_DATA_DIR`; the token file is `<data dir>/token`). Re-`GET` afterwards to confirm.

## Picking a helper by hand: `$name`

In the message input the user can write `$name` (preceded by start or whitespace, followed by end, whitespace or `. , ; : ! ? )`). Only names of **currently available** (enabled) helpers count; unknown names, or a switched-off feature, are ignored. The server then adds a hidden `<harness-hint>` note (clients hide it) telling the model to call `delegate` with that agent. It is a strong hint, not a guarantee. The input has a menu and tints the token.

## Good helper design

- One job per helper, named for the job (`explore`, `tests-finder`, `api-routes`).
- Put the trigger in `description`: "Use when the user asks where X is defined or how Y flows".
- Cheap model + `minimal` thinking for search. Raise the model only if reports are shallow.
- Use `prompt` for house rules (output format, directories to skip). Permissions come from `tools`; give `write`/`edit`/`bash` only to a helper that needs them.

## Source map (when you must read code)

`server/src/subagent-settings.ts` (schema, limits, model resolution, merging files), `subagent-files.ts` (agent file parsing and lookup), `subagent.ts` (run loop, report cut, `$name` parsing/hint), `subagent-routes.ts` (API), `tools.ts` (the `delegate` tool), `sessions.ts` (wiring), client `src/components/SubAgents.svelte` (settings screen). Docs: repo `docs/agent-loop.md`.

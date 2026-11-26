# AGENTS.md, skills, subagents, and templates

Four file-based ways to shape how pipaya works:

|  | `AGENTS.md` | Skill | Subagent role | Prompt template |
|---|---|---|---|---|
| Location | `~/.agents/AGENTS.md`, ancestor & cwd `AGENTS.md` | `~/.agents/skills/<name>/SKILL.md`, `.agents/skills/` | `~/.agents/subagents/<name>.md`, `<cwd>/.agents/subagents/` | `~/.agents/templates/<name>.md`, `.agents/templates/` |
| Model sees | **Full text** in system prompt | Name, description, path (opened with `read` on demand) | Used when `delegate(role=...)` runs | Expanded into the user's message via `/prompt:<name>` |
| Changes apply | From the **next message** | From the **next message** | Next `delegate` call (auto-reloaded) | Next `/prompt:<name>` run (uncached) |

## AGENTS.md

Discovery order (later files appear after earlier ones in the system prompt):

1. **Global**: `~/.agents/AGENTS.md` — the home of the user the **server** runs as.
2. **Ancestors**: `AGENTS.md` in each directory from the filesystem root down to (not including) the working directory.
3. **Working directory**: its own `AGENTS.md`.

Rules: the same real file (symlinks resolved) is included once; empty/whitespace-only files are skipped; **subdirectories are never searched**; non-regular files are skipped with a warning. Limits: **64 KiB per file, 256 KiB total**; a file over the limit is skipped whole (with a warning), not truncated.

Behaviour to tell the user:

- Before a session's first message the client shows a **preview**. At the first run the base prompt, tools and cwd are stored; `AGENTS.md` files are re-read from disk on every run, so an edit applies from the **next message** (the prompt cache is only reset when the files really changed).
- To verify: open the chat header's **session context** (file icon). It lists the applied files, scope, byte sizes, warnings, the full system prompt, active tools and files already read.

Writing the global file:

1. Confirm whose home it is (`echo ~`, and whether the server runs here or in Docker; in a container the home is the container user's, not the host's).
2. `mkdir -p ~/.agents`, then read the existing file first and **edit, do not overwrite**; it may hold the user's environment rules.
3. Keep it short and imperative: environment facts, hard rules, commands. No secrets.
4. Tell the user it applies from the next message.

Project rules go in `<repo>/AGENTS.md`; a monorepo subfolder rule goes in that subfolder's file and only applies when the session's working directory is that subfolder (or the rule is placed in a parent).

## Skills

Follows the [Agent Skills](https://agentskills.io/specification) layout: `<name>/SKILL.md` with `name` and `description` frontmatter (`name`: lowercase letters, digits, single hyphens, max 64 chars; `description`: max 1024 chars).

| Kind | Location |
|---|---|
| Global | `~/.agents/skills/` of the server's user |
| Project | `.pi/skills/` and `.agents/skills/` from the working directory up to the git root (up to `/` without a repo) |
| Built-in | `server/builtin-skills/` (shipped with the server; on by default; currently `pipaya-client-extensions`, `pipaya-server-extensions`, `pipaya-usage`) |

- Name clash: nearer folder > project > global > built-in. Shadowing a built-in with the same name gives no warning.
- Unreadable skills are skipped and listed in `GET /skills` `warnings` (also shown on top of the skills window).
- `disable-model-invocation: true` = listed but manual-only; cannot be toggled.
- **On/off is stored on the server**, not in the folder: global default, per-project override (project = git root), and per-session override. Effective = session > project > global (default on). All clients on the server share it.
  - Toggle API: `PUT /skills/:id` with `{ scope: "global" | "project" | "session", enabled: boolean | null, cwd?, sessionId? }` (`enabled: null` clears a project or session override; `global` requires a boolean).
  - Source API: `GET /skills/:name/source?cwd=`, `PUT /skills/:name/source` (`{ description, manualOnly, body, cwd? }`), `DELETE /skills/:name?cwd=` (built-ins return `409`).
- Turning a skill off removes it from the list **and blocks reading its folder**. Content already read stays in the history.
- **Manual call**: writing `/skill:name` in a message (shown in the `/` menu with a Skill tag) makes the server attach that skill's full `SKILL.md` as a hidden hint to the message. Works for enabled skills, including manual-only ones; unknown or switched-off names stay plain text.
- Sessions without the `read` tool are not told about skills.
- The system message is rewritten only when the enabled set really changed, so the provider's prompt cache survives other edits.

Adding a skill: create `~/.agents/skills/<name>/SKILL.md` (global) or `<repo>/.agents/skills/<name>/SKILL.md` (project); `name` must match the folder. The description is what makes the model open it, so state *when* to read it. A **built-in** skill lives in `server/builtin-skills/<name>/SKILL.md` in the pipaya repo; the Docker image copies that folder.

## Subagent roles

Subagents invoked through `delegate(role=...)` can be defined as Markdown files:

- **Global**: `~/.agents/subagents/<name>.md`
- **Project**: `<cwd>/.agents/subagents/<name>.md` (non-recursive; project wins over global on the same `name`)

File format (filename stem = role name, `/^[A-Za-z0-9][\w.-]*$/`, ≤40 chars via API):

```markdown
---
description: Fast read-only codebase search
model: provider/model-id
thinking: low
tools: [read, grep, glob, ls]
maxTurns: 12
---
Role instructions go here.
```

- `model` and `thinking` are optional (omitting `model` inherits the parent session's model).
- `tools` accepts an array or comma/whitespace-separated string; defaults to `["read", "grep", "glob", "ls"]`. Forbidden tools (`delegate`, `ask_user`, `peer`, `peer_*`, `schedule`, `goal`, `mcp`, `workdir`, `generate_image`) and any server-disabled tools are stripped automatically.
- `maxTurns` defaults to `12` (clamped `1..30` in frontmatter; server policy caps concurrency/calls/turns via `PUT /configuration/delegate`).
- Disk edits are detected automatically (`mtime`/`size`/`ino` fingerprint); disabling a project role via `PUT /configuration/subagents/:name/enabled` (`{ scope, enabled, cwd? }`) lets a global role of the same name show again.
- API: `GET /configuration/subagents?cwd=`, `POST /configuration/subagents?cwd=`, `PUT /configuration/subagents/:name?cwd=`, `PUT /configuration/subagents/:name/enabled`, `DELETE /configuration/subagents/:name?scope=&cwd=`.

## Prompt templates

Reusable user prompts invoked in chat as `/prompt:<name> [args]`:

- **Project**: `.agents/templates/<name>.md` walking from `cwd` up to the git root (nearer folder wins).
- **Global**: `~/.agents/templates/<name>.md` (project wins over global).

Format: optional YAML frontmatter (`name` defaults to filename stem, lowercase kebab-case max 64 chars; `description` defaults to the first non-empty body line, max 1024 chars). Limits: 128 KiB per file, 200 templates max, 60,000 chars expanded.

- If the template body contains `$ARGUMENTS`, it is replaced with the arguments after `/prompt:<name>`; otherwise arguments are appended after a blank line.
- Templates are read from disk on every run (no restart or cache flush needed).
- API: `GET /templates?cwd=`, `POST /templates`, `PUT /templates/:name`, `DELETE /templates/:name`.

## Source map

`server/src/context.ts` (`AGENTS.md` discovery, limits, snapshot), `server/src/skills.ts`, `server/src/routes/skills-routes.ts`, `server/src/subagents.ts`, `server/src/templates.ts`, `server/src/routes/templates-routes.ts`, `server/src/agents-watch.ts`.

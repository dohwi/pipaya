# AGENTS.md and skills

Two ways to tell the agent how to work:

|  | AGENTS.md | Skill |
|---|---|---|
| What | Rules that always apply | A folder with `SKILL.md`, read on demand |
| Model sees | The **full text** in the system prompt | Only name, description, path; it opens the file with `read` when needed |
| Changes apply | From the **next message** | From the **next message** |

## AGENTS.md

Discovery order (the later ones come after the earlier ones in the prompt):

1. **Global**: `~/.agents/AGENTS.md` - the home of the user the **server** runs as.
2. **Ancestors**: `AGENTS.md` in each directory from the filesystem root down to (not including) the working directory.
3. **Working directory**: its own `AGENTS.md`.

Rules: the same real file (symlinks resolved) is included once; empty/whitespace-only files are skipped; **subdirectories are never searched**; non-regular files are skipped with a warning. Limits: **64 KiB per file, 256 KiB total**; a file over the limit is skipped whole (with a warning), not truncated.

Behaviour to tell the user:

- Before a session's first message the client shows a **preview**. At the first run the base prompt, tools and cwd are stored and never change; AGENTS.md files are re-read from disk, so an edit applies from the **next message** (the prompt cache is only reset when the files really changed).
- To verify: open the chat header's **session context** (file icon). It lists the applied files, scope, byte sizes, warnings, the full system prompt, active tools and files already read.

Writing the global file:

1. Confirm whose home it is (`echo ~`, and whether the server runs here or in Docker; in the container image the home is the container user's, not the host's).
2. `mkdir -p ~/.agents`, then read the existing file first and **edit, do not overwrite**; it may hold the user's environment rules.
3. Keep it short and imperative: environment facts, hard rules, commands. No secrets.
4. Tell the user it applies to new sessions only.

Project rules go in `<repo>/AGENTS.md`; a monorepo subfolder rule goes in that subfolder's file and only applies when the session's working directory is that subfolder (or the rule is placed in a parent).

## Skills

Follows the [Agent Skills](https://agentskills.io/specification) layout: `<name>/SKILL.md` with `name` and `description` frontmatter.

| Kind | Location |
|---|---|
| Global | `~/.agents/skills/` of the server's user |
| Project | `.pi/skills/` and `.agents/skills/` from the working directory up to the git root (up to `/` without a repo) |
| Built-in | `server/builtin-skills/` (shipped with the server; on by default; currently `pipaya-client-extensions`, `pipaya-server-extensions`, `pipaya-usage`) |

- Name clash: nearer folder > project > global > built-in. Shadowing a built-in with the same name gives no warning.
- Unreadable skills are skipped and listed in `GET /skills` `warnings` (also on top of the skills window).
- `disable-model-invocation: true` = listed but manual-only; cannot be toggled.
- **On/off is stored on the server**, not in the folder: a global default plus per-project overrides (project = git root). Effective = project value if set, else global. Default is on. `PUT /skills/:name` sets it; `enabled: null` clears a project override. All clients on the server share it.
- Turning a skill off removes it from the list **and blocks reading its folder**. Content already read stays in the history.
- **Manual call**: writing `/skill:name` in a message (shown in the `/` menu with a Skill tag) makes the server attach that skill's full `SKILL.md` as a hidden hint to the message. Works for enabled skills, including manual-only ones; unknown or switched-off names are plain text.
- Sessions without the `read` tool are not told about skills.
- The system message is rewritten only when the enabled set really changed, so the provider's prompt cache survives other edits.

Adding a skill: create `~/.agents/skills/<name>/SKILL.md` (global) or `<repo>/.agents/skills/<name>/SKILL.md` (project); `name` must match the folder. The description is what makes the model open it, so state *when* to read it. A **built-in** skill is `server/builtin-skills/<name>/SKILL.md` in the pipaya repo; the Docker image copies that folder.

## Source map

`server/src/context.ts` (discovery, limits, snapshot), `skills.ts` (discovery, priority, built-in dir), `skills-routes.ts` (API).

Skills are **knowledge and procedures that are read only when needed**. They follow the [Agent Skills](https://agentskills.io/specification) format (`<name>/SKILL.md`).

## How it works

With [[agents-md]] the full text always goes into the system prompt, but a skill puts only its **name, description and path** into an `<available_skills>` block. When the model decides one fits what it is doing, it opens `SKILL.md` with `read` and follows it. That saves context while still allowing long procedures.

> [!TIP]
> **The description is the trigger.** Whether a skill gets used depends on its `description`, so state specifically "when it should be read".

## Creating

```markdown
---
name: release-notes
description: Read this when writing release notes or updating the CHANGELOG. Contains the procedure and format for summarizing the commit log.
---

# Writing release notes

1. Collect changes with `git log --oneline <previous tag>..HEAD`.
2. Pick only user-visible changes and sort them into "Added / Changed / Fixed".
3. ...
```

| Rule | Value |
|---|---|
| File | `<skill folder>/SKILL.md` |
| `name` | Lowercase letters, digits and single hyphens (`my-skill`), up to 64 characters. If empty, the folder name |
| `description` | Up to 1,024 characters. Longer is truncated with a warning |
| Folder name | Recommended to match `name` (Agent Skills spec) |
| Count | Up to 200 skills are discovered |
| Search depth | Up to 4 levels inside a skill folder |

A file with a wrong name or format is skipped with a warning and the rest are handled normally. Warnings appear in `warnings` of `GET /skills` and at the top of the skills window.

## Location and priority

| Source | Location |
|---|---|
| Project | `.pi/skills/` and `.agents/skills/` from the working directory up to the git root (`/` if there is no repository) |
| Global | The server user's `~/.agents/skills/` |
| Built-in | The server's `builtin-skills/`. On in every project, and can be turned off like any other skill |

When names collide, the order of precedence is **closer folder > project > global > built-in**. Overriding a built-in skill with the same name gives no notice.

Built-in skills:

| Name | Purpose |
|---|---|
| `pipaya-usage` | Lets the agent handle pipaya's own settings (sub-agents, AGENTS.md, turning skills on and off) |
| `pipaya-client-extensions` | Explanation of the client extension system and reference for writing one |
| `pipaya-server-extensions` | Reference for writing server extensions |

To add a built-in skill, create `server/builtin-skills/<name>/SKILL.md` in the repository (the Docker image copies this folder).

## Turning on and off

Open the skills window with the book icon under the input box, or with the *Open skills* shortcut.

| Scope | Description |
|---|---|
| **Global** | The default for all projects |
| **Project** | An override per git root. Reverting it to match the global default makes it follow the default again (`enabled: null`) |

The actual state = **the project value if present, otherwise the global value**. Everything is on by default. The state is stored not in the skill folder but in the server database (`settings.skills`), so all devices on the same server share it.

- Turning one off removes it from the list and **also blocks reading that folder.** Content already read stays in the history.
- A change applies **from the next message**. The system message at the top is rewritten only when the enabled list actually changes, so the prompt cache stays valid.
- Sessions without the `read` tool are not told about skills.
- Changes are announced to open apps with the `skills_updated` event.

API: `GET /skills?cwd=&sessionId=`, `PUT /skills/:name` `{scope: "global" | "project" | "session", enabled: true | false | null, cwd?, sessionId?}`. The `session` scope requires `sessionId`. Each skill in the response includes `globalEnabled`, `override` (project), `sessionOverride` and the final `enabled`.

## Manual invocation

Writing `/skill:name` in a message makes the server send that skill's full `SKILL.md` along as a hidden note. Use it when you want to **make sure it is used now**, rather than wait for the model to read it on its own. It appears in the `/` menu with a **Skill** tag.

```text
/skill:release-notes write the notes for this version
```

- Only enabled skills can be invoked. A missing or disabled name is plain text.
- Before the name there must be the start of a line or a space, and after it the end, a space, or one of `. , ; : ! ? )`.

### Manual-only skills

Putting `disable-model-invocation: true` in the front matter keeps the skill **out** of the model's `<available_skills>` list and shows it as "Manual only" in the skills window. It can be used only with `/skill:name`, and cannot be switched on or off.

## What a skill can read

The `read` tool normally works relative to the working folder, but **files inside an enabled skill folder** are allowed to be read even if they are outside the working directory (files whose symlinks point outside the folder are rejected). Put reference material in the skill folder (`references/`) and point to it from `SKILL.md`.

## Skills vs other means

| When | Use |
|---|---|
| Short rules that must always hold | [[agents-md]] |
| Long procedures and reference material for a specific task | **Skill** |
| Repeating the same request often | [[templates]] |
| Research that reads many files | [[subagents]] |
| A new tool or `/command` | [[server-extensions]] |

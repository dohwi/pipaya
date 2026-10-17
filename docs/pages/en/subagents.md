When the main agent hands work such as searching to a **helper**, the helper works in a separate history and returns **just one short report**. File contents do not pile up in the main chat, which saves context.

> [!NOTE]
> A new server has **no helpers at all.** Until you create one, `delegate` is not used and the `# Sub-agents` block is not added to the system prompt.

## When to use

- **Research** that finds where something is defined or how it flows in a codebase
- Work that needs many file reads but only a few lines of result
- Exploration that a cheap model can handle

If the main agent does it directly, every file read stays in the chat. A helper keeps that process in its own history and returns only a summary.

## What a helper can and cannot do

| | |
|---|---|
| Tools | A choice from `read` `grep` `ls` (read-only) and `write` `edit` `bash` (modifying) |
| Cannot do | Ask the user (`ask_user`), call other helpers (`delegate`) |
| Conversation | **Cannot see it.** Knows only what is in the request text (`task`, up to 4,000 characters) |
| Result | A report of about 300 words with `path:line` citations. Cut at 6,000 characters |
| Output per call | Up to 2,048 tokens per model call |
| Reasoning strength | `minimal` by default (unless set on the model entry) |

If the report is cut for length, `[report cut at the length limit]` is added; if it stops at the step limit, `[stopped at the N-step limit; this report may be incomplete]` is added. Treat the report as a **lead**, and check the cited lines yourself before fixing anything.

A helper with write tools (`write`, `edit`, `bash`) runs with the general helper prompt ("do only the task and list every file you changed"), and **the approval policy applies as is** before tool calls → [[tools]]. Server extension `tool_call` hooks also run through helpers, so a policy extension cannot be bypassed.

## Settings

Create them in Settings → Server → **Agents**.

| Field | Rule |
|---|---|
| Enable all | Master switch for the whole `delegate` tool |
| Count | Up to **10**. Names are unique |
| `name` | Starts with a lowercase letter; lowercase letters, digits and `-`; up to 40 characters. The main agent passes it as `agent`, and the user calls it with `/subagent:name` |
| `description` | 1–200 characters. It is what the main agent uses to decide **when to pick this helper**, so write "when to use it" |
| Enabled | A disabled helper is not suggested |
| Model | If empty, the **calling chat's model**. If set, `{provider, model, thinkingLevel?}`. An unregistered model is rejected on save (`400`). If the model is deleted later, it quietly falls back to the calling chat's model |
| `tools` | 1–6, no duplicates |
| Max steps (`maxTurns`) | 2–30, default **12**. After this many model calls it stops and gives the report so far |
| `prompt` | Up to 2,000 characters. **Appended after** the default instructions |

Settings are stored on the server (DB key `subagents`) and shared by every device. An invalid save changes nothing, and unknown keys are rejected. The note on the settings screen: "After this many model calls, the sub-agent is stopped and you receive the report so far."

> [!WARNING]
> `PUT /subagents` **replaces everything**. `GET` it first, edit one entry and send the whole thing back. If you send only part of it, the other helpers are deleted.

### Reducing cost

- For exploration, a **light, cheap model + `minimal` reasoning** is usually enough. If reports are shallow, move up a model.
- If the model's connection has no key, the helper fails, so a warning appears on the settings screen.
- A model that does not support reasoning ignores the strength setting.

## Defining with files

You can also make helpers as Markdown files. The files are **read every turn**, so edits apply from the next message.

| Location | Scope |
|---|---|
| `~/.agents/subagents/<name>.md` | Global (the home of the user running the server) |
| `.agents/subagents/<name>.md` in each folder from the root to the working directory | Project. The closer folder wins |

```markdown
---
name: fixer
description: Fixes small, clear bugs and runs the tests
model: openai/gpt-5-mini
thinking: low
tools: [read, grep, ls, edit, bash]
maxTurns: 20
enabled: true
---
Run the project tests after every fix and list every file you changed.
```

| Field | Description |
|---|---|
| `name` | Optional. Defaults to the file name (without `.md`). Same rules as above |
| `description` | **Required**, 1–200 characters |
| `model` | `provider/model` form, or omitted / `inherit` (= the calling chat's model) |
| `thinking` | `minimal` to `max`. Only meaningful with `model`. Default `minimal` |
| `tools` | A list, or a `read, grep` string. Default `read, grep, ls` |
| `maxTurns` | 2–30, default 12 |
| `enabled` | Default `true` |
| Body | Extra instructions (up to 2,000 characters) |

- Only `*.md` files of **32KB or less** are read. An invalid file is skipped with a warning.
- With **the same name**, a file replaces a helper stored on the server, and a closer file replaces a farther one.
- The model named in a file is not checked when used. If it does not exist, the helper runs with the calling chat's model.
- File helpers appear in the main agent's helper list and in the `delegate` description, but for now they do not appear on the settings screen.

## How to call

| Method | Behavior |
|---|---|
| Automatic | The main agent looks at the helpers' descriptions and calls `delegate` when needed. If `agent` is omitted, the first enabled helper |
| Manual | `/subagent:name` in the input box. A **hidden hint** to use that helper is attached (a strong suggestion, not a guarantee) |

Write `/subagent:name` at the start of a line or after a space, and only names of **currently enabled** helpers are accepted. It appears in the `/` menu with a **Sub-agent** tag.

## Designing good helpers

- One helper, **one job**. Name it to match the job (`explore`, `tests-finder`, `api-routes`).
- Put the call condition in `description`: "Use when finding where something is defined or how it flows."
- Put **house rules** such as the output format and folders to skip in `prompt`.
- Permissions are set by `tools`. Give `write`, `edit` and `bash` only to helpers that really need them.

## Difference from session collaboration

A temporary helper returns one report and is done. To collaborate with another chat that works independently for a long time, see [[orchestration]].

## Leave it to the agent

The built-in skill `pipaya-usage` lets you say something like "add a sub-agent that investigates the repository structure", and the agent creates it through the API or a file. The default is read-only tools (`read`, `grep`, `ls`), and modifying tools are given only when you ask.

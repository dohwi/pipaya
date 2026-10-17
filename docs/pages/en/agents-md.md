`AGENTS.md` is a file for **rules the agent should always follow**. Its **full text goes into the system prompt.**

## Difference from skills and templates

| | AGENTS.md | [[skills]] | [[templates]] |
|---|---|---|---|
| What the model sees | **Full text** (always) | Name, description and path only. Opened with `read` when needed | The expanded body, only when invoked |
| When changes apply | **Fixed at the session's first run** | **From the next message** | Immediately |
| Use for | Rules that must always hold, facts about the environment | Procedures and knowledge for specific situations | Long requests you use often |

## Reading order

They are appended to the system prompt in this order.

1. **Global** — `~/.agents/AGENTS.md` (the home of the user running the server)
2. **Parent folders** — the `AGENTS.md` in each folder from the filesystem root down to **just above** the working directory
3. **Working directory** — that folder's `AGENTS.md`

## Rules

| Item | Value |
|---|---|
| Subfolders | **Not searched** |
| Same real file | Symlinks are resolved and it is included only once |
| Empty file | Skipped |
| Not a regular file | Skipped with a warning |
| Per-file limit | **64KiB** |
| Total limit | **256KiB** |
| Over the limit | Not truncated: **the whole file is excluded** (with a warning) |

## When it is fixed

At a session's **first run**, a snapshot is stored in the database (`session_contexts`) and never changes afterwards. Editing the file does not affect sessions that are already open, so check it in a **new chat**. Before you send the first message, the client shows a **preview** of the list that will apply.

## Checking what applied

In the chat header's **Session context** (file icon) you can see the files that applied, their scope (`global` / `ancestor` / `cwd`), byte counts, warnings and the actual system prompt. Clicking `N AGENTS.md` in the status line opens the same screen → [[context]].

## Sub-agents and AGENTS.md

Sub-agents do **not** receive AGENTS.md. A sub-agent's prompt is the default research instructions plus that helper's `prompt` field → [[subagents]].

## How to write one

```markdown
# Rules

## Environment
- Ubuntu 24.04. Install packages with `mise`.

## Code
- After changes, run `bun run typecheck && bun test`.
- Never read or print secrets (`.env`, tokens).
```

- Keep it short and imperative, with only **environment facts, rules that must be kept, and frequently used commands**.
- Do not put secrets in it.
- Put rules for a monorepo subfolder in that subfolder's file. They apply only when the session's working directory is that folder (or write them in the parent).
- Before creating a global file, **read the existing content and edit it in place.** Overwriting can wipe out environment rules.
- If the server runs inside Docker, "home" is the **container user's home**, not the host's `~/.agents`.

## Change detection

The server watches `~/.agents` and the `.agents` and `.pi` folders from each known working directory up to the repository root. When a file changes, it sends a `skills_updated` event, and open apps re-read the skill, template and status-line counts **without a refresh**. The list of folders to watch is recomputed every 15 seconds, so folders created later are picked up too. AGENTS.md itself, however, does not reach existing sessions, for the reason above.

## Leave it to the agent

The built-in skill `pipaya-usage` lets you say "add this rule to the global AGENTS.md" in a chat, and the agent handles it following the rules above. It first checks the home of the user running the server, and reads an existing file before editing it.

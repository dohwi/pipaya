This page explains how the context the model actually sees is built, how to inspect it, and how it is shortened when it grows long.

## What the model sees

A session's context has two main parts.

| Part | Content | When it changes |
|---|---|---|
| System prompt | Base prompt + AGENTS.md + skill list + sub-agent list | See the table below |
| Conversation history | User, assistant and tool-result messages (once compacted: a summary + the recent part) | Every turn |

### System prompt layout

| Order | Block | Content | When it takes effect |
|---|---|---|---|
| 1 | Base prompt | A coding assistant that works in small, verified steps with tools inside a sandboxed working folder. Uses relative paths and reports attachments and result files as markdown links inside the working folder | Can be replaced with `systemPrompt` at session creation (fixed after the first message) |
| 2 | AGENTS.md | Full text of the rules from global, parent folders and the working folder | **Fixed at the session's first run** |
| 3 | `<available_skills>` | Name, description and path of enabled skills | From the next message. The system message at the top is rewritten only when the enabled list changes |
| 4 | `# Sub-agents` | Name and description of enabled sub-agents | From the next message. Only when the `delegate` tool exists and at least one helper is enabled |

If there is nothing for block 3 or 4, the block is left out entirely. The skill list is not shown to sessions without the `read` tool.

The system message is rewritten only when the enabled list actually changes, so other setting changes do not break the provider's **prompt cache**.

### Hidden hints

A user message can have hint blocks added that are not shown on screen. All start with `<pipaya-hint>` and are passed only to the model.

| Trigger | What is added |
|---|---|
| `/subagent:name` | A hint to use that helper |
| `@session-name` | A hint to handle the mentioned session with `peer_send`/`peer_read` |
| `/skill:name` | The full `SKILL.md` of that skill |

For a prompt template (`/prompt:name`), the expanded body becomes the user message itself and the short call is shown as a note under the bubble. Attached files get a note with the saved path, type and size (`<pipaya-files>`).

## Checking the context

Check it in the chat header's **Session context** (or `GET /sessions/:id/context`).

| Item | Description |
|---|---|
| Applied AGENTS.md | File path, scope (`global` / `ancestor` / `cwd`), byte count, warnings |
| Active skills | The skills visible to this session right now |
| System prompt | The actual full text (`effectiveSystemPrompt`) |
| `skillsPrompt`, `agentsPrompt` | The exact text of blocks 3 and 4 |
| Tools | The list of active tools |
| Files already read | Files read in this session |

If you wonder why the agent behaves a certain way, look here first.

The status line summarizes this: the number of applied AGENTS.md files, the number of available skills and templates (click to see the list), and the current context usage.

## Context usage display

| Display | Meaning |
|---|---|
| Context `used / window` | Based on the **last model call**. New input and tool results are not included |
| `~` prefix | An estimate from an older server version |
| `—` | Just compacted, not measured yet |
| Cache hit rate | Share of prompt tokens read from the cache |
| Output speed | Tokens per second (tps) of the last response |
| Running cost | This chat's cost and number of model calls |

The **current context** and **cumulative billed tokens** differ. The cumulative figure adds the input again on every call, so it grows far larger than the context. Usage is totaled as `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` (USD) and `turns`.

## Compaction

This summarizes old history so that the model **sees the summary instead**. The stored original history is left as is.

### How to run it

| Method | Description |
|---|---|
| Manual | `/compact [instructions]` or `POST /sessions/:id/compact`. Instructions up to 2,000 characters |
| Automatic | **Auto compaction** under Settings → Model connections → Compaction. When on, it checks **before** sending a prompt |

### Automatic compaction condition

It runs when the context tokens reach this threshold.

```text
threshold = max( context window × 0.5 , context window − 16,384 )
```

That is, the **larger** of half the window and "the window minus 16,384 tokens". For a big window the second value applies; for a small one, half.

### What is summarized and what is kept

- About the last **20,000 tokens** are kept verbatim. The cut is always placed before a user message.
- Everything earlier is summarized. The summary condenses, factually, the user's goals and constraints, decisions and reasons, file paths read or changed, commands and results, errors and fixes, and remaining work; greetings and repetition are dropped.
- Tool output going into the summary is cut to 2,000 characters per message.
- The summary is stored in the `session_compactions` table, and the later context is rebuilt as `[summary message, …kept messages]`. The model sees the summary as a synthetic user message.

### Summary model

If a **compaction model** is set and usable, it is used; otherwise the session's model. A light, cheap model is recommended. If the compaction model's connection has no key, compaction fails.

### Failures and error codes

| Code | Cause |
|---|---|
| `409` | Closed session / already compacting / running (manual compaction) / waiting for approval or an answer / history too short to compact / cancelled by an extension / aborted |
| `501` | This server has no compaction feature (`compaction_not_supported`) |
| `502` | The summary model call failed (`upstream_error`) |

On failure or abort, a `compaction_failed` event is sent and the **context stays as it was**. While compacting, sending messages and changing models are blocked, and the stop button can request cancellation.

> [!NOTE]
> Compaction costs a summary-model call, and details can be lost in the summarizing.

The events are `compaction_started` → `compaction_finished` or `compaction_failed`. A server extension can cancel compaction or supply the summary itself with the `session_before_compact` hook → [[server-extensions]].

## Ways to save context

| Method | Effect |
|---|---|
| `/compact` | Replaces old history with a summary |
| [[subagents]] | Hand off research that reads files many times and receive only a short report — what was read does not pile up in the main chat |
| Give only the path with `#` | Instead of pasting a whole file, let the agent `read` only the parts it needs |
| [[skills]] | Long procedures are read only when needed (AGENTS.md is always included) |
| `/fork` | Copy what you have so far and try a new direction |

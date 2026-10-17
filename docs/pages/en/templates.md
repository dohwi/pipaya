Templates let you save a long request you use often as a file and call it with `/prompt:name [content]`.

## Creating

One `<name>.md` file is one template.

```markdown
---
description: Review the changes as code review
---
Please review the current changes for correctness, security and tests.
Pay special attention to: $ARGUMENTS
```

```text
/prompt:review login error handling
```

## Location

| Scope | Location |
|---|---|
| Project | `.agents/templates/<name>.md` from the working directory up to the repository root |
| Global | `~/.agents/templates/<name>.md` (the home of the user running the server) |

When names collide, the closer folder wins (a warning is shown), and the project wins over global. A global folder that happens to be a parent folder is never mistaken for a project folder.

## File rules

| Item | Value |
|---|---|
| Name | The file name (without `.md`) or `name` in the front matter. Lowercase letters, digits and single hyphens, up to 64 characters |
| `description` | The description shown in the menu. If empty, the **first line of the body** (heading marks removed, up to 120 characters) |
| File size | Up to 128KB. Larger files are skipped |
| Count | Up to 200 |
| Front matter | Optional. If the YAML is invalid, the front matter is treated as absent and the whole file is used as the body |

Invalid files are skipped with a warning (`warnings` in `GET /templates`).

## Arguments

| Situation | Result |
|---|---|
| The body contains `$ARGUMENTS` | Every `$ARGUMENTS` is **replaced** by what you wrote after the call |
| No `$ARGUMENTS` | What you wrote after the call is **appended** to the end of the body (after one blank line) |
| Called without arguments | The body as is |

Numbered arguments (`$1`) and other placeholders such as `$@` are not supported.

## Calling rules

- `/prompt:name` must be at the **very start** of the message. In the middle of a sentence it is not recognized as a template.
- Names are lowercase letters, digits and hyphens. An unknown name is sent as plain text.
- The expanded body becomes the **user message** sent to the model. The chat shows the short call as a note under the bubble.
- The expansion is capped at **60,000 characters**; anything longer is cut and `[cut]` is appended.
- If the session has no title yet, the template name becomes its title.

## Checking and refreshing

- Pressing `/` in the input box shows them with a **Template** tag. Clicking `N templates` in the status line opens the list window (search, refresh, project/global distinction).
- When you add or edit a file, the server notices (`skills_updated`) and the list updates **without a refresh**.

## Templates vs skills

| | Template | [[skills]] |
|---|---|---|
| Who calls it | Only the user (`/prompt:`) | The model on its own judgment, or the user (`/skill:`) |
| Where the content goes | Directly into the user message | The model reads it if needed |
| Use for | Repeating the same **request** | **Methods and knowledge** for a task |

Client extensions can also add template-style `/commands` with `commands` (the `{{args}}` placeholder) → [[client-extensions]].

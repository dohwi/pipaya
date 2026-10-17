Typing `/` in the input box opens the command menu. Most commands are run by the **app, not the server**, so commands handled locally also work offline.

## Built-in commands

| Command | Argument | Description | Needs an open chat |
|---|---|---|---|
| `/new` | | Start a new chat | No |
| `/resume` | | Reopen a closed chat (pick from a list that includes closed chats) | No |
| `/rename` | `<title>` | Rename the chat. Without a title it just shows help | Yes |
| `/close` | | Close the chat. **The history is kept** | Yes |
| `/cd` | `[path]` | Change the working directory. Without a path, opens the folder picker (or the server default / folders in use) | No |
| `/compact` | `[instructions]` | Compact the context. Costs a summarizing call. Instructions up to 2,000 characters | Yes |
| `/retry` | | Retry the last response | Yes |
| `/stop` | | Stop the work in progress | Yes |
| `/cancel` | | Open the window to cancel queued and steer messages | Yes |
| `/fork` | `[last]` | Branch the chat. `last` branches from just before the last response | Yes |
| `/tree` | | Chat branch tree (only that family if a chat is open, otherwise everything by folder) | No |
| `/copy` | | Copy the last answer's text to the clipboard | Yes |
| `/delete` | | **Permanently delete** the chat. A confirmation window appears once more | Yes |

- Every built-in command has exactly **one English name** in the form `/name`. There are no Korean or duplicate aliases.
- Toggling the sidebar, model, reasoning and help are not commands; use the UI and shortcuts.
- Using a command that needs an open chat from the new-chat screen does nothing.

## How commands behave

- Write a command at the **very start** of the input box as `/name [argument]`.
- Commands such as `/stop` and `/cancel` run immediately even while work is running ({{Enter}} during work steers, but commands are intercepted and executed).
- If you send a command that is **not** in the list (`/xxx`), it is not passed to the model; only the notice "Unknown command. Type / to see the list" appears. Your input stays so you can fix it.
- For commands that require an argument (`/rename`), {{Tab}} only completes the input; for commands where the argument is optional (`/compact`, `/cd`, `/fork`), selecting runs them right away.
- For commands whose argument is a fixed set of choices, an argument menu opens next.

## Prefix calls

After the built-in commands, the `/` menu shows the items below with a **tag**.

| Form | Meaning | Docs |
|---|---|---|
| `/subagent:name` | Pick the sub-agent to use for this request | [[subagents]] |
| `/skill:name` | Pass the skill's full text along with this request | [[skills]] |
| `/prompt:name [arguments]` | Expand a saved prompt template. Only at the **very start** of the message | [[templates]] |
| `/extension-command` | Commands registered by server and client extensions | [[server-extensions]], [[client-extensions]] |

Commands registered by a server extension also appear in the app's `/` menu. Choosing one **sends `/name arguments` to the server as a message**, and the server runs the extension command instead of the model. If the extension returns a string, it is passed to the model as the user message. Names must be lowercase letters, digits and hyphens to appear in the menu, and **if a name collides with a built-in app command or a client extension command, the server extension's entry is dropped from the menu.**

## Symbols

Other symbols used in the input box besides `/` → [[composer]].

| Symbol | Meaning |
|---|---|
| `#path` | A file or folder in the working folder |
| `#image1` | An attached image |
| `@name` | Another session → [[orchestration]] |

## The same actions as shortcuts

| Command | Shortcut action |
|---|---|
| `/new` | New chat ({{Alt+N}}) |
| `/close` | Close the current chat ({{Alt+W}}) |
| `/resume` | Open a chat ({{Alt+O}}) |
| `/stop` | Stop the work ({{Escape}}) |
| `/cancel` | Cancel queue ({{Alt+Q}}) |
| `/fork`, `/retry`, `/compact`, `/copy` | Shortcut of the same name (none by default) |
| `/cd` | Change the working folder (none by default) |

The full list is in [[shortcuts]].

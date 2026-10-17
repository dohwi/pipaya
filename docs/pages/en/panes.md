How to split several chats and server terminals across one screen.

## Groups

A **group** is a layout that arranges 2 to 8 chats (or terminals) on one screen.

| Item | Value |
|---|---|
| Members | **2 to 8**. More than 8 is rejected (`a group holds at most 8 sessions`), and fewer than 2 is rejected |
| Name | 1–100 characters. If empty, the server adds `Group N` (the app usually sends a localized name) |
| Split ratio | 0.1 to 0.9 (other values are clamped into the range) |
| Nesting depth | Up to 8 |
| Storage | On the **server**. The same group is visible on every device |

When a group drops below 2 (by closing or deleting chats, or removing them from the group), the server deletes the group and sends a `group_deleted` event. The chats themselves stay.

## Layout structure

A layout is a binary split tree.

```json
{
  "type": "split", "dir": "row", "ratio": 0.5,
  "a": { "type": "pane", "sessionId": "…" },
  "b": { "type": "pane", "sessionId": "…" }
}
```

`dir: "row"` puts `a` on the left and `b` on the right; `dir: "col"` puts `a` on top and `b` below. Use `POST /groups`, `PATCH /groups/:id` (name, layout) and `DELETE /groups/:id`.

## Creating and changing

| Method | Behavior |
|---|---|
| Drag a chat in the sidebar onto another chat | Groups the two chats |
| Drag a chat onto another **pane** | Splits to the left, right, top or bottom depending on where you drop |
| Row menu → **Group with another chat** | For touch devices where dragging does not work. Pick the chat to group from a list |
| Shortcuts | Split right {{Mod+\}}, split down {{Mod+Shift+\}}. Split left and split up have no default |
| Ungroup | The sidebar group row menu, or the *Remove current pane from group* shortcut |

While dragging over a pane, the drop zone (left, right, top, bottom) is highlighted. You cannot drop onto yourself. If a group already has 8 panes you cannot add more, and the notice "A group can hold up to 8 chats" appears.

## Adjusting dividers

Drag a divider to resize.

| Action | Behavior |
|---|---|
| Drag | Moves only this divider |
| {{Shift}} + drag | Moves dividers lined up on the same line together |
| {{Ctrl}} (Mac: {{Cmd}}) + drag | Snaps to another divider's guide |
| Double-click | Resets to half and half (50%). With {{Shift}}, the whole connected line |

## Panes and focus

![A group of two chats. (1) the group row in the sidebar (2) the focused pane (orange border) (3) the other pane (blue border)](/assets/img/ui/en/group.png)

- The **pane title bar** shows the chat name (`@mina`) and title, and a long title scrolls in the selected pane. Drag the title bar to move it to another cell.
- Only the selected (focused) pane takes input, file drops and shortcuts.
- Moving between panes: the *Focus the pane to the left / right / above / below* and *Focus the next pane* shortcuts (no default → [[shortcuts]]).
- Buttons in the pane title bar: **Enlarge**, **Remove from group**, and for a terminal, **Close terminal**.

### Enlarge and full mode

| Action | Description |
|---|---|
| Double-click the pane title bar / **Enlarge** button | **Temporarily** enlarges the selected pane. Return with {{Escape}} or **Shrink** |
| The group's **full mode** | Puts the whole group in enlarged view and turns the other panes into a one-line strip. This state is saved on the device |

## Display in the sidebar

The sidebar groups chats by folder, and groups appear as a separate block with a divider. When you collapse the sidebar, active chats and groups remain as icons in a vertical rail.

| Feature | Description |
|---|---|
| Search | Find by chat title or name |
| Collapse / expand | Folder blocks can be collapsed (the collapsed state is saved on the device; always expanded while searching) |
| Reordering | Drag single chats in the same folder to reorder them, and drag folder and group headers to reorder (saved on the device) |
| Double-click | Rename the chat on the current server |
| Row menu | Group with another chat / rename / close (reopen with `/resume`) / for a terminal, close terminal |
| Fork marker | Forked chats get a fork icon |
| Status | Per-chat running, waiting for approval and finished marks, and per-server connection state (not connected, token rejected, app update needed) |
| `New chat` / `New terminal` | Start from each folder header, based on that folder |

From a folder header's menu you can create a **new chat** or **new terminal** for that folder directly. Collapse the sidebar with {{Mod+B}}.

## Terminals

Opens a shell on the server machine as a pane of the app. You can put it side by side with chats or in a group.

| Item | Details |
|---|---|
| Opening | **New terminal** on a sidebar folder header, {{Mod+Shift+`}} (in the current working folder), {{Mod+Alt+`}} (opens below the selected pane and groups them) |
| Shell | On Linux and macOS `$SHELL` (if absent, tries bash → zsh → fish → sh); on Windows PowerShell first |
| Implementation | On Linux and macOS a **real pseudo-terminal (PTY)**. Windows has no PTY, so it works over **pipes** and the client echoes input itself |
| Start folder | The given `cwd` (otherwise relative to the default working directory) |
| Count | Up to **16** per server |
| Scrollback | Keeps the last **512KB** of output per terminal. It is restored when you reconnect |
| Multiple connections | Several clients can attach to one terminal at the same time |
| Size | 2–1000 columns, 1–500 rows. It follows when you resize the pane |
| Exit | Closing sends `SIGHUP` to the shell and, if it has not ended shortly after, `SIGKILL`. When the shell exits, "The shell exited (code N)" is shown |
| Lifetime | **Only in memory**. Restarting the server removes them all |
| Environment | The server environment without `PIPAYA_*`, plus `TERM=xterm-256color`, `COLORTERM=truecolor`, `TERM_PROGRAM=pipaya` |

> [!WARNING]
> A terminal is a **full shell that ignores the approval policy**. A device with the token can run any command with the server user's permissions. To not use it, start the server with `PIPAYA_TERMINAL=0`. If the server has `PIPAYA_RESTRICT_WORKSPACE=1`, a terminal's start folder is also restricted to the workspace.

Communication is over the `GET /terminals/:id/ws` WebSocket: the server sends output as binary frames, and the client sends `{type:"input", data}` and `{type:"resize", cols, rows}`. A slow client (4MB or more behind) is disconnected and receives the scrollback when it reconnects. REST is `GET /terminals/info` (support and shell list), `GET`/`POST /terminals`, and `PATCH`/`DELETE /terminals/:id`.

## Status line

The information shown under each chat's input box → [[context]].

| Item | Meaning |
|---|---|
| N AGENTS.md | Number of applied instruction files (click to view with the system prompt) |
| N skills | Number of skills this chat uses (click to turn on or off) |
| N templates | Prompt templates you can use (click for the list) |
| Context | Current context usage / window |
| Cache hit rate | Share of prompt tokens read from the cache |
| Output speed | tps of the last response |
| Running cost | This chat's cost and number of model calls |

## Command palette

The app's picker window (the palette) opens when a command such as `/resume`, `/tree` or `/cd` shows a list. Typing in the search box filters by title and subtitle, {{↑}} {{↓}} moves, {{Enter}} selects and {{Escape}} closes. When nothing matches, "No matching items" appears. `/delete` receives its "Really delete? This cannot be undone" confirmation in this window.

Every shortcut in the app and the rules for changing them. `Mod` is {{Ctrl}} on Windows and Linux and {{Cmd}} on macOS. In Settings → Shortcuts you can **change or remove all of them.**

## Default shortcuts

### General

| Action | Default | Description |
|---|---|---|
| Collapse / expand sidebar | {{Mod+B}} | On a narrow screen, opens and closes the sidebar drawer |
| New chat | {{Alt+N}} | Goes to a blank screen. Inside a group, only the selected pane becomes a new chat |
| Close current chat | {{Alt+W}} | The history stays and you can reopen it with `Open chat`. Inside a group, focus moves to the next pane |
| Go to a finished chat | {{Alt+U}} | Jumps to a chat that finished but has not been seen yet (including failures). Press again for the next one |
| Open chat | {{Alt+O}} | Pick from a list that includes closed chats and open it |
| Open settings | {{Mod+Comma}} | |
| Toggle full screen | {{F11}} | Makes the window full screen or restores it |

### Chat

| Action | Default | Description |
|---|---|---|
| Stop work | {{Escape}} | **Fixed key** — cannot be changed |
| Cancel queue / steer | {{Alt+Q}} | |

### Model · reasoning

| Action | Default | Description |
|---|---|---|
| Open the model picker | {{Alt+M}} | The window for choosing model and reasoning strength |
| Cycle favorite models | {{Alt+Shift+M}} | Only starred models, in order |
| Change reasoning level | {{Alt+T}} | `minimal → … → max`, wrapping from the end to the start |

### Split screen · terminal

| Action | Default | Description |
|---|---|---|
| Split to the right (side by side) | {{Mod+\}} | |
| Split downward (stacked) | {{Mod+Shift+\}} | |
| New terminal | {{Mod+Shift+`}} | Opens the server's shell in the current working folder |
| Open terminal below | {{Mod+Alt+`}} | Opens a terminal below the selected pane and groups them |

## Shortcuts with no default

The following have **no default**. To use them, assign one in Settings → Shortcuts.

| Category | Actions |
|---|---|
| Chat navigation | Go to previous chat / go to next chat / return to the chat you were just viewing / search chats |
| Chat | Fork chat / retry response / compact context / copy last answer |
| Scroll | Jump to top of chat / jump to bottom of chat (bottom turns auto-follow back on) |
| Approval | Change approval mode (confirm outside the project only ↔ auto) / approve tool run / deny tool run |
| Split | Split to the left / split upward |
| Pane navigation | Focus the pane to the left, right, above or below / focus the next pane |
| Group | Remove the current pane from its group |
| Tools | Change working folder / open skills / switch to the next server |
| Other | Turn notification sound on or off / switch light and dark |

> [!WARNING]
> **Change approval mode** toggles between `ask` and `auto`. Auto runs without asking, so be careful to pick a shortcut you will not press by accident. This value is saved on the server and new chats follow it.

## Key combination format

Combinations are stored as strings such as `Mod+B`, `Alt+Shift+M` and `Mod+B+V`.

- Modifier keys are written in the order **`Mod`, `Alt`, `Shift`**, followed by **up to 3** regular keys in the order they were pressed.
- Keys are based on `KeyboardEvent.code`, so they **do not depend on the keyboard layout**, and macOS {{Alt}} changing the typed character has no effect.
- The display adapts to the platform: ⌘ ⌥ ⇧ on macOS, Ctrl Alt Shift elsewhere.

## How to change

In Settings → Shortcuts, click an item to **record** a new one.

1. Click the item to start recording.
2. Press the combination you want. The keys you press pile up on screen.
3. Press the **check button** to save.

| Key | During recording |
|---|---|
| {{Backspace}} | Undo the last key. If there is no key to undo, **clears the shortcut** |
| {{Escape}} | Cancel recording (nothing is saved) |

- If the combination is already used by another action, **you take it from that action.** ("Took this shortcut from ○○")
- You cannot have more than 3 regular keys.
- Only values changed from the default are saved (`pipaya.keys`). Returning to the default removes it from storage.
- You can filter by name, description or key in the search box.
- Backups contain only the shortcuts you changed → [[settings]].

## When they do not work

- While you are typing in the input box or a form, or **composing** text such as Korean, shortcuts do not intercept.
- Inside dialogs and popups, that window's own key behavior takes priority.
- Combinations the browser already uses (`Ctrl+W`, `Ctrl+T`, etc.) cannot be used in the web app. That is why the defaults use {{Alt}} combinations.
- Keys that an extension adds with the `shortcuts` permission must include {{Mod}} or {{Alt}} and **cannot change the app's default shortcuts** → [[client-extensions]].

## Shortcuts on this docs site

They also work on this documentation site.

| Key | Action |
|---|---|
| {{Mod+K}} or {{/}} | Open search |
| {{←}} {{→}} | Previous / next page |
| {{Escape}} | Close search / menu |

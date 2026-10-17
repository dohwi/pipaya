Everything the message input box does. Besides plain text, it handles `/` commands, `#` files and images, `@` session mentions and attachments on a single line.

## At a glance

| Input | Meaning | Example |
|---|---|---|
| `/name` | Command, sub-agent, skill or template | `/compact`, `/skill:review` |
| `#path` | Point to a file or folder in the working folder | `Fix #src/app.ts` |
| `#image1` | Point to an attached image by order | `Compare #image1 and #image2` |
| `@name` | Mention another session (agent) | `Talk to @mina and proceed` |
| Paste, drag and drop, clip button | Attach images and files | Screenshot {{Mod+V}} |

Each symbol opens its menu only when it is at the **start of a word** (start of a line or after a space). Symbols in the middle of a word, like `a#b` or `mail@address`, are ordinary characters.

## Sending and line breaks

| Situation | Key | Behavior |
|---|---|---|
| Desktop, idle | {{Enter}} | Send |
| Desktop | {{Shift+Enter}} | New line |
| Desktop, working | {{Enter}} | **Steer** — add an instruction to the work in progress |
| Desktop, working | {{Alt+Enter}} / {{Ctrl+Enter}} / {{Cmd+Enter}} | **Queue** — runs after the current work ends |
| Phone / tablet (touch) | {{Enter}} | New line. Send with the button |
| While composing Korean | {{Enter}} | Only confirms the composition, does not send |

- Nothing is sent while offline. `/` commands handled locally still run.
- While the context is being compacted, you cannot send ordinary messages; only `/` commands work.
- Messages sent during work can also carry images and files.
- Cancel queued messages one by one from the list above the input box (`/cancel`, {{Alt+Q}}).

## Suggestion menu

Typing `/`, `#` or `@` opens a menu above the input box.

![After typing `/`. (1) the input box (2) the suggestion menu opened upward, with commands and skills in groups](/assets/img/ui/en/slash.png)

| Key | Behavior |
|---|---|
| {{↑}} {{↓}} | Move between items (wraps from the end to the start) |
| {{Enter}} | Select (on touch devices, tap an item) |
| {{Tab}} | Select but **do not run — only complete the input** |
| {{Escape}} | Close the menu. Typing more opens it again |

## Recalling earlier input

In the input box, {{↑}} / {{↓}} walk back through messages you already sent in this chat.

- It works only when the cursor is on the first line ({{↑}}) or last line ({{↓}}) and no text is selected.
- If you edit a recalled message, browsing restarts from the most recent message.
- What you were typing before you began browsing is restored when you press {{↓}} all the way down.
- Consecutive identical messages appear only once.

When the input box is empty, the most recent message is shown in faded text (it glows softly while work is running).

## Keeping a draft

Even if you switch chats and come back, your **text, attached images and attached files** are kept per chat. The new-chat screen is a store of its own too.

> [!NOTE]
> The draft is kept only in app memory. Refreshing or quitting the app clears it.

## # File and folder mentions

Pick a file in the working directory with `#` to write its path into the message.

![After typing `#app`, (2) files whose names match appear as a list](/assets/img/ui/en/hash.png)

```text
Explain the connection logic in #src/lib/store.svelte.ts
```

### How it works

- When you select one, the `#path` text goes into the input box, and the selected path is highlighted in mint. A path you only typed by hand is not highlighted.
- **The file content is not attached automatically.** The path text is passed as is, and the agent opens it with `read` when needed. The server has no special handling for `#`.
- Picking a file adds a space after it; **picking a folder keeps the menu open** so you can continue into its contents.
- The base folder is **that session's working directory** (the server's default directory for a new chat).

### Search rules

On each keystroke (80ms delay) the server is queried for **names only**; file contents are not read. Order of results:

1. Exact path match
2. Path starts with the input
3. File name starts with the input
4. File name contains the input
5. Path contains the input
6. Loose match where only the letter order fits (`cmps` → `Composer.svelte`)

When the input is empty, shallower paths come first and folders come before files. Shows 50 by default (up to 100).

### What is excluded from search

- Folders: `node_modules` `.git` `.svn` `.hg` `dist` `build` `target` `__pycache__` `.venv` `.next` `.svelte-kit` `.cache`
- Symbolic links are not followed
- At most **20,000** entries are indexed at a time (filled from shallow levels first). In a very large repository, deep files may not show up
- The index is cached for 5 seconds. A file you just created appears a few seconds later

### Paths outside the working folder

If the input starts with one of the following, it lists **one folder at a time** instead of using the index.

| Input | Meaning |
|---|---|
| `#~`, `#~/work/` | Home directory |
| `#/etc/` | Absolute path |
| `#../` | Parent folder |

Hidden items (starting with `.`) appear only when the input starts with `.`. If the server is restricted to the workspace (`PIPAYA_RESTRICT_WORKSPACE=1`), paths outside it are rejected. This only tells the agent a path; whether it can actually be opened follows the tool permissions and approval policy.

## #image1 image mentions

When you attach an image, `#image1`, `#image2`… are **inserted automatically** into the input box. They tell apart which image you mean when there are several.

```text
#image1 is before the change, #image2 is after. Explain the difference
```

- Numbers follow the attachment order (from 1). When you type `#`, images appear above files.
- Only tokens within the current number of attachments are highlighted in purple; out-of-range numbers are ordinary text.
- If you remove an image, its token is deleted from the text and **the following numbers shift down by one** (`#image3` → `#image2`).
- If you type a token all the way through by hand, the menu does not reopen, so {{Enter}} sends right away.

## @ session mentions

Call another session with `@name` to hand off work or ask about its status. How it works and its limits are in [[orchestration]].

![After typing `@`, (2) the sessions on this server appear with their names](/assets/img/ui/en/at.png)

```text
@mina is building the API. When she finishes, read the result and wire up the frontend
```

- Typing `@` lists **every active session except yourself and closed ones**. They do not need to belong to a split group.
- Search by name (prefix match) or by window title (contains match).
- Each item also shows the window title, folder and current state (working, waiting for approval, etc.), and the selected name is highlighted in sky blue.
- Particles attached to the name, as in Korean `@미나랑` or `@미나가`, are still recognized. A Latin or numeric name is not recognized as part of a longer word (`mina` inside `@mina2`).
- A name that does not exist is not highlighted and is passed on as plain text.

## / commands, skills and templates

The menu lists **commands → sub-agents → skills → templates**, each with a tag.

| Input | Meaning |
|---|---|
| `/new`, `/compact`, etc. | Built-in commands → [[slash-commands]] |
| `/subagent:name` | Pick the sub-agent to use for this request → [[subagents]] |
| `/skill:name` | Pass the skill's full text with this request → [[skills]] |
| `/prompt:name arguments` | Expand a saved prompt template → [[templates]] |

- If you send a `/xxx` that is not in the list, it is **not sent to the model** and an "Unknown command" notice appears. Your input stays so you can fix it.
- Only enabled skills and sub-agents appear. If you change the server settings, they are read again when you open the menu.
- The `/` menu does not open while an image is attached.
- Existing `/skill:`, `/prompt:` and `/subagent:` tokens are highlighted; names that do not exist are ordinary text.

## Ways to attach

| Method | Description |
|---|---|
| Clip button | Pick several files |
| Paste | Images and files from the clipboard (screenshots, etc.) |
| Drag and drop | Drop anywhere in the window to attach to the **selected pane** ("Drop files to attach" is shown) |

- If the clipboard contains a file, only that file is attached and **any text that came with it is not pasted.** Pasting only text is unaffected.
- In split view, files attach only to the pane that has focus.
- A pasted image without a name is called `image`, and an ordinary file is called `file`.

## How images and files are handled differently

Attachments are handled by one of two paths.

| | **Sent as an image** | **Sent as a file** |
|---|---|---|
| Condition | An image format, and the selected model **can see images** (vision). SVG excluded | Everything else: documents, code, archives, images with a model that cannot see them, SVG |
| What the model receives | The image itself | A note with the saved **path, type and size** |
| Storage | Included in the chat history | `.pipaya/uploads/` in the working folder |
| Original | Downscaled and re-encoded | **Exactly as is** |

### Image conversion

- If the long side exceeds **1568px**, it is scaled down keeping the aspect ratio.
- A **PNG under 600KB** stays PNG (so screenshots remain sharp); anything else is converted to **JPEG (quality 0.85)**.
- So a large PNG loses its transparent background, and an animated GIF keeps only its first frame. If you need the original, switch to a model that cannot see images, or compress it and upload it so that it is sent as a file.

### File storage rules

- Location: `.pipaya/uploads/<6 random characters>-<file name>` in the session's working directory
- The file name is cleaned up. Characters other than letters, digits, `.`, `_` and `-` (including spaces) become `_`, a leading dot becomes `_`, and only the last 120 characters are kept.
- The agent learns the location from the note attached to the message (path, MIME type, byte count) and opens it with `read` and the like.
- We found no code in which the server deletes uploaded files automatically. Clean them up yourself if needed, and in a Git repository we recommend adding `.pipaya/` to `.gitignore`.

## Attachment limits

The client blocks first (showing a notice) and the server checks again with the same values.

| Item | Limit | When exceeded |
|---|---|---|
| Images | **8 per message** | Notice "Up to 8 images", extras ignored |
| Files | **8 per message** | Notice "Up to 8 files", further selection stops |
| One file | **50MB** | Only that file is excluded |
| Files total | **100MB** | Only that file is excluded |
| Message characters | 1,000,000 | Rejected by the server |
| Message request size | 192MB (allowing for base64 growing about 1.34×) | Rejected by the server |
| Other API requests | 2MB | Rejected by the server |

- If the server rejects it, the response is `413 too_large`.
- The 8 images and 8 files are **separate limits** and do not count against each other. The 50MB and 100MB limits apply only to files.
- Files are loaded into browser memory as base64 before sending, so larger ones can be slow or run out of memory on mobile.
- If a file cannot be read, a "Could not read ○○" notice appears and only that file is excluded.

## Attachment cards and previews

- They appear as cards above the input box. Images show a thumbnail; others show an extension badge, name and size (B/KB/MB).
- Remove one with the card's **×**. For images, the `#imageN` numbers are tidied automatically.
- Clicking a file card in a sent message opens a preview.

| Type | Preview |
|---|---|
| Image (png jpg gif webp bmp avif svg) | Image viewer (zoom) |
| PDF | PDF viewer |
| Audio (mp3 wav ogg m4a aac flac opus) | Playback |
| Video (mp4 m4v webm ogv mov) | Playback |
| Markdown | Rendered |
| CSV / TSV | Table (**first 1,000 rows**) |
| Text and code | Text (**first 400,000 characters**; if longer, "Showing only the beginning") |
| Anything else | No preview |

The server lookup for previews (`GET /sessions/:id/files?path=`) serves files so that they **cannot run as a web page** (`nosniff`, CSP `sandbox`). Even HTML files appear only as text. Files over 50MB return `413`.

> [!WARNING]
> This lookup does not block paths outside the working directory either. The earlier path restriction was removed in commit `cb26464`, and the current `safePath` returns the path as is. A client with a token can fetch through this route any file the server user can read. → [[security]]

Clicking a **link in an agent answer that is relative to the working folder** (such as `src/a.ts`) opens the same preview. Absolute paths (`/…`), paths containing `..` and addresses like `http:` do not count.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| A pasted screenshot went in as a file, not an image | The selected model cannot see images (no vision). Change the model → [[models]] |
| The 9th image is not attached | The limit is 8 images per message. Send them in separate messages |
| A file I just created is missing from the `#` menu | The index cache is 5 seconds. Type again shortly |
| The `#` menu shows no files at all | You are inside an excluded folder, or a deep path past the 20,000 index limit. Type the folder path step by step |
| The `@` menu is empty | There is no other active session with a name. Open one more new chat |
| A large PNG's background turned black | PNGs of 600KB or more are converted to JPEG. Use a model that cannot see images, or compress it before uploading |
| `/xxx` is not sent | A nonexistent command is not sent to the model. Type `/` to see the list |
| I do not know where an uploaded file is | `.pipaya/uploads/` in the working folder |

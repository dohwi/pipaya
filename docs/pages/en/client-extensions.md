A client extension is **code that runs in an isolated Worker inside the app**. It adds screen panels, status items, settings forms, themes, language packs and `/commands`. An extension can send **only validated data**, and the app draws the screen itself.

## Difference from server extensions

| | Client extension | [[server-extensions]] |
|---|---|---|
| Where it runs | An **isolated Worker** in the app | The server process (full permissions) |
| What it does | Screens, themes, language packs, the input box, notifications | Tools, hooks, server commands, providers |
| Permissions | **Only the permissions the package declares** | Everything |
| Installation | Import a JSON package in the app's **Settings → Extensions** | A file in the server's `extensions/` folder |
| Linking | Calls server extension methods with the `server` permission | Exposed with `pi.emit` and `registerMethod` |

## Isolation

Extension code is **never run in the app's own environment.**

- A frame with no origin (opaque origin) owns the Worker, and the code runs only inside that Worker.
- The frame's CSP **blocks network, images, styles, frames and form submission entirely.** (`connect-src 'none'`, `default-src 'none'`)
- The Worker and the app talk over **one dedicated MessagePort only**, and the app **checks permissions** on every request before handling it.
- In a WebView where the CSP is not applied, the sandbox check fails and **the extension does not start** (fail closed).
- An SDK request fails if there is no response within 5 seconds, and at most 100 requests can be pending at once.
- **HTML, CSS, URLs, functions and event attributes sent by an extension are not accepted.** The screen is expressed only as data of fixed node types.

> [!WARNING]
> Extension code runs in an isolated environment, but **its safety is not guaranteed.** Limits on resource use such as CPU and memory are not guaranteed, so install only extensions you trust.

## Installation and management

Do it on the **Settings → Extensions** screen.

| Action | Description |
|---|---|
| Add an extension | Import a JSON package file. **Up to 256KB** |
| Review permissions | Before importing, the requested permissions are listed, and you must approve to install |
| Turn on / off | Even when installed, it does not run until turned on |
| Replace / update | Importing a package with the same `id` replaces it (permissions are reviewed again if they grew) |
| Export | Only the package. Personal settings and the extension's stored data are excluded |
| Delete | Erases the extension and its stored data |
| Settings | The settings form the extension declares. Or edit directly as a JSON object (up to 16KB) |

### Where things are stored

- The package is installed on **this device** (localStorage) and is also synchronized as the server-tied client setting `extensions` (up to 13,500,000 characters).
- An extension's settings are stored on this device (`local`) or on the server (`server`) depending on `settingsScope`. Server settings are a `PUT /extensions/:id/settings` JSON object (up to 16,000 characters).
- An extension's own storage (`sdk.storage`) is **32KB per extension**.
- Secret values in settings and storage (`secret` fields) are left out of exports.

### Recovery safeguards

- **Safe mode**: add `?extensions=off` to the app address, or turn on safe mode in Settings → Extensions, and **all extensions stop running**. After turning it off, you must turn each extension back on yourself.
- If the app detects the trace of an extension that was interrupted while starting (a booting marker), it does not turn that extension on automatically.
- Unreadable entries are shown as a separate card so they can be deleted.
- Even if one extension fails or is replaced, **the others are left alone.**
- The app shows **who provides it** on every extension screen.

## Package format

A package is a JSON object. Unknown fields are rejected and the maximum size is 256KB. **At least one** of `theme`, `commands`, `locales` and `code` must be present.

```json
{
  "manifest": {
    "id": "example.focus",
    "name": "Focus · theme and review draft",
    "version": "1.0.0",
    "sdkVersion": 1,
    "description": "A calm blue theme and a /review prompt draft.",
    "permissions": ["commands", "composer"]
  },
  "theme": {
    "dark":  { "--accent": "#93c5fd", "--accent-fg": "#172033", "--radius": "8px" },
    "light": { "--accent": "#2563eb", "--accent-fg": "#ffffff", "--radius": "8px" }
  },
  "commands": [
    { "name": "review", "description": "Insert a code review draft", "template": "Please review the current changes.\nPay special attention to: {{args}}" }
  ]
}
```

### manifest

| Field | Rule |
|---|---|
| `id` | Required. Starts with a lowercase letter; lowercase letters, digits and `.` `-` separators; up to 80 characters (`example.focus`) |
| `name` | Required. 1–80 characters |
| `version` | Required. Numeric SemVer `x.y.z` (+ optional prerelease), up to 80 characters |
| `sdkVersion` | Required. Currently `1` |
| `description` | Optional. Up to 2,000 characters |
| `permissions` | Required. From the 23 below, without duplicates |
| `settingsScope` | Optional. `"local"` or `"server"` |
| `settings` | Optional. Up to 20 setting fields |

### Setting fields (`settings`)

| Property | Rule |
|---|---|
| `key` | Required. `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`. Unique within the extension |
| `type` | `string` `number` `boolean` `select` |
| `label` | Required. 1–60 characters |
| `description` / `placeholder` | Optional. 200 / 80 characters |
| `required` | Optional |
| `secret` | Strings only. Cannot have a default. Excluded from exports |
| `format` | Strings only. `"origin"` = must be a valid http/https origin |
| `min` / `max` | Numbers only. `min <= max` |
| `options` | Required for `select`. 2–20 of `{value, label}` |
| `default` | A string (up to 2,000 characters), number, boolean, or an option value for select |

### theme

For each of `dark` / `light`, only the allowed tokens can be changed (23 in all). Colors must be hexadecimal `#rgb` `#rgba` `#rrggbb` `#rrggbbaa`, and sizes must be integer `px`.

| Token | Range |
|---|---|
| `--content-w` | 480–1200px |
| `--radius*` | 0–32px |
| Color tokens | Hex colors |

### commands

| Field | Rule |
|---|---|
| `name` | `^[a-z][a-z0-9-]{0,39}$` |
| `description` | Up to 500 characters |
| `template` | Up to 16,000 characters. The argument you type goes into `{{args}}` |
| Count | Up to 20 |
| Required permissions | `commands`, `composer` |

A template command **only fills the input box and does not send.** The user checks it and then sends.

### locales

| Field | Rule |
|---|---|
| Count | Up to 5 packs |
| `tag` | A language tag (`ja`, `pt-br`, etc.). Up to 35 characters. `ko` and `en` are reserved |
| `name` | Up to 60 characters |
| `messages` | Up to 3,000. Keys within 1,000 characters, values within 2,000. **Korean source → translation** |
| Required permission | `locales` |

A language pack is uploaded to the server (`PUT /locales/:tag`) so other devices on the same server can use it too. If another extension overwrites a pack owned by one extension, the result is `409`. A sentence without a translation appears as the Korean original.

### code

`code` is the **body of an async function** (up to 128KB) that receives `sdk` as its argument. It talks to the app through the SDK below.

```js
await sdk.commands.register({ name: "hello", description: "Greeting" }, async () => {
  await sdk.composer.setText("Hello!");
});
await sdk.status.set("hello", "Ready");
```

## Permissions

You need the declared permission to use the matching SDK, and the app checks it on every call. **It never widens permissions quietly.**

| Permission | What it allows |
|---|---|
| `commands` | Add slash commands (`sdk.commands.register`) |
| `composer` | Fill text into the input box, add input box buttons |
| `status` | Show status items (`sdk.status`) |
| `context` | Read the session ID, model, provider, and run and connection state |
| `storage` | The extension's own storage (32KB per extension) |
| `notifications` | Show in-app notifications (toasts) |
| `events` | Subscribe to chat and work state events (`run_started` `run_finished` `session_*` `compaction_finished` `approval_*` `turn_end` `tool_execution_end`) |
| `ui` | Show panels, forms and input box widgets, and receive input values |
| `navbar` | Show read-only items (gauge, icon, text) at the top, **3** per extension |
| `http` | **GET** JSON from a server address the extension sets (no credentials sent) |
| `http-write` | **POST, PUT, DELETE** to `httpOrigin`, optionally using `httpToken` as a Bearer |
| `configuration` | Export and import settings after app approval. Imported code is not run automatically |
| `configuration-background` | After first approval, repeatedly read non-sensitive settings and apply them automatically. A code change needs additional approval |
| `system-notifications` | Send OS and mobile push notifications, and register event notification rules even when the app is closed. **The wording is passed to the OS and push providers** |
| `locales` | Register language packs |
| `server` | Call server extension methods, and read the entries and events that extension left |
| `shortcuts` | Add shortcuts that include `Ctrl/⌘` or `Alt`. **Cannot change the app's default shortcuts**, 10 per extension, rejected if they clash with another extension |
| `dialogs` | Ask the user with confirm, select and input windows |
| `session` | Send messages to the open chat and stop runs. Limited to **5 per 10 seconds**. Messages sent are run by the agent |
| `tools` | Show a tool call result with a screen made by the extension instead. Reads the result content |
| `messages` | Show entries left by a server extension as cards in the middle of the chat. Reads the entries |
| `slots` | Show read-only items below the header (`header`) and above the input box (`footer`), **2** per extension |
| `composer-filter` | Read and change messages, or block sending, before they are sent. Must respond within **2 seconds**. The input content is passed to the extension code |

> [!NOTE]
> For the notification SDK (`sdk.notifications.send`, `status`, `register`, `remove`) and the behavior of notification rules, see [[notifications]]. `system-notifications` can raise notifications without the user being aware, so the approval screen shows a separate warning.

## SDK at a glance

Wait for every call with `await`. The host validates the arguments and rejects invalid values.

| Area | Methods |
|---|---|
| `sdk.commands` | `register(spec, handler)` |
| `sdk.composer` | `setText(text)`, `registerAction(spec, handler)` |
| `sdk.ui` | `registerPanel(spec, handler)`, `update(id, view, {tone?})`, `open(id)`, `close(id)`, `remove(id)` |
| `sdk.navbar` | `set(id, {label, view})`, `remove(id)` |
| `sdk.slots` | `set(slot, id, spec)`, `remove(slot, id)` |
| `sdk.status` | `set(id, text)`, `remove(id)` |
| `sdk.context` | `get()` → `{sessionId, model, provider, running, online}` |
| `sdk.storage` | `get(key)`, `set(key, value)` |
| `sdk.settings` | `get()` — the extension's own settings |
| `sdk.notifications` | `show(text)`, `send(spec)`, `status()`, `register(id, rule)`, `remove(id)` |
| `sdk.events` | `on(listener)` → unsubscribe function |
| `sdk.http` | `getJson(path)`, `requestJson(request)` |
| `sdk.configuration` | Export, import and restore settings |
| `sdk.server` | `call(extension, method, params?, sessionId?)`, `entries(options?)`, `list()`, `on(listener)` |
| `sdk.shortcuts` | `register(spec, handler)`, `remove(id)` |
| `sdk.dialog` | `confirm(spec)`, `select(spec)`, `input(spec)` |
| `sdk.session` | `send(text, mode?)`, `abort()` |
| `sdk.tools` | `registerRenderer(toolName, fn)`, `removeRenderer(toolName)` |
| `sdk.messages` | `registerRenderer(entryType, fn)`, `removeRenderer(entryType)` |
| `sdk.composerFilter` | `set(fn)`, `clear()` |
| `sdk.log(...)` | Logging |

## Building screens (declarative UI)

An extension describes a screen as a **JSON node tree**. The app draws each node with its own components, so HTML, CSS and URLs cannot be used. Node types:

| Category | Nodes |
|---|---|
| Layout | `stack` (vertical or horizontal, spacing), `grid` (1–3 columns), `card`, `tabs` (up to 8), `divider` |
| Display | `text` (tone, size), `badge`, `alert`, `code`, `stat`, `progress`, `gauge`, `icon`, `table`, `list` |
| Input | `form`, `input` (text, email, number), `textarea`, `select`, `checkbox`, `button` (primary, secondary, danger) |

Tones are `neutral` `info` `success` `warning` `danger`. Input values reach the handler as an event when the user submits the form.

Main length limits (code constants): label 120 characters, title 80, description 500, text 8,000, code 16,000, table cell 2,000, input value 16,000, select value 200, list 100 items.

### Top items (navbar) and slots

| Item | Limit |
|---|---|
| navbar items | 3 per extension, label 40 characters, 60 nodes, depth 4, size 32KB |
| Nodes allowed in navbar | Read-only only: `stack` `grid` `text` `badge` `divider` `progress` `stat` `gauge` `icon` (buttons, forms, tables, lists, code and alerts are rejected) |
| Slots | `header` (below the header), `footer` (above the input box). 2 per extension |
| Input box widget | `placement: "composer"` on a panel |

### Gauge

`gauge` is a ring gauge for showing usage. Up to 3 rings, display text of 16 characters, and up to 12 detail rows that open on hover or focus (label 48 characters, description 80, group 40). `value: null` means **unknown** and is not drawn as 0; the last update time is shown as "Updated N seconds ago".

## Examples

They are in `client/examples/extensions/` in the repository.

| File | Content | Permissions |
|---|---|---|
| `focus.json` | Blue theme + `/review` prompt draft | `commands` `composer` |
| `lang-ja.json` | Japanese language pack | `locales` |
| `session-tools.json` | A set of chat tools | `commands` `composer` `status` `context` `storage` `events` `notifications` |
| `todo-view.json` | The screen for the server extension `todo` | `server` `messages` `slots` `composer-filter` `events` `context` |
| `ui-workbench.*` | A collection of UI nodes | |

Installing the server extension `todo.ts` together with `todo-view.json` shows how a server extension and a client extension connect.

## Leave it to the agent

The built-in skill `pipaya-client-extensions` contains detailed documentation of the extension system (architecture, extension UI, screen design principles, notifications). When you ask the agent to build an extension or fix the app's extension system, it reads this documentation first.

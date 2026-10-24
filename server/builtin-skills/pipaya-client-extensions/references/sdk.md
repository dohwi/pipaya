# Client extensions: packages and SDK v1

Themes, prompt commands, composer actions, status items and declarative UI ([ui.md](ui.md)) without rebuilding the app. Same on web and Tauri. Separate from server extensions (agent tools, hooks, providers; see the `pipaya-server-extensions` skill); the `server` permission connects the two.

## Using

1. Settings > **Extensions**: import a `.json` package (or install from the marketplace).
2. Review its info and permissions. Imported packages start **disabled**.
3. Enable it. Commands run like built-ins (`/review`).
4. Disabling removes its commands, actions, statuses, navbar items, subscriptions and theme, and cancels its `http` requests.

Other extensions are never disabled automatically. Re-importing the same ID stops the running copy and does not auto-run the new code (see same-ID replace below). A name clash with another extension or a built-in command makes enable fail.

Packages live in this client's `localStorage` (per install / browser origin). Settings are owned by the server (see [Settings storage](#settings-storage-and-sync)). Exported packages contain neither settings nor storage data.

## Package format

Examples: `examples/extensions/focus.json` (declarative), `session-tools.json` (code).

```json
{
  "manifest": {
    "id": "my.review",
    "name": "Review helper",
    "version": "1.0.0",
    "sdkVersion": 1,
    "description": "Adds a review draft to the composer",
    "permissions": ["commands", "composer"]
  },
  "commands": [
    { "name": "review", "description": "Code review draft", "template": "Please review this change.\n{{args}}" }
  ]
}
```

- `id`: lowercase (`sync`, `my.review`, `team-session-tools`), ≤80 chars.
- `version`: semver (`1.0.0`, `1.0.0-beta.1`). No remote auto-update.
- `sdkVersion`: exactly `1`.
- `permissions`: only those listed below. Declarative commands also need `commands` and `composer`.
- Command names: lowercase letter first, then `[a-z0-9-]`, ≤40 chars.
- Package ≤256 KiB, code ≤128 KiB (UTF-8), ≤50 extensions.
- Unknown fields, duplicate permissions/commands and wrong types are rejected. Types: `src/lib/extensions/schema.ts`, public SDK: `src/lib/extensions/sdk.ts`.
- `code` is the body of an async function with `sdk` injected. No imports, no npm.
- `settingsScope`: `"server"` (default) or `"local"` (this device only; recommended for credentials).

### Settings schema (`manifest.settings`)

Up to 20 fields; the settings page renders a form and validates. Without it, the page shows a raw JSON editor.

```json
"settings": [
  { "key": "httpOrigin", "type": "string", "label": "Server", "format": "origin", "required": true, "placeholder": "http://localhost:8317" },
  { "key": "interval", "type": "number", "label": "Refresh (s)", "min": 10, "max": 600, "default": 60 },
  { "key": "compact", "type": "boolean", "label": "Compact", "default": false },
  { "key": "mode", "type": "select", "label": "Display", "default": "ring",
    "options": [{ "value": "ring", "label": "Ring" }, { "value": "text", "label": "Text" }] }
]
```

| Field | Rule |
|---|---|
| `key` | `^[a-zA-Z][a-zA-Z0-9_]{0,39}$`, unique |
| `type` | `string`, `number`, `boolean`, `select` |
| `label` | required, ≤60 |
| `description` / `placeholder` | ≤200 / ≤80 |
| `default` | must match `type` (an option for `select`, within `min`/`max` for `number`) |
| `required` | missing or empty is an error |
| `secret` | strings only; password input, excluded from configuration export, no default |
| `format` | strings only, `"origin"`: http(s) origin without path, query or credentials |
| `min` / `max` | numbers only |
| `options` | `select` only, 2–20 of `{value ≤60, label ≤60}` |

`resolveSettings(fields, raw)` → `{values, errors, ok}` is strict: fills defaults, drops undeclared keys, never coerces (`"5"` is not a number).

Behaviour:

- **Same-ID replace** keeps settings. If the old copy was running, the new one asks for no new permissions and safe mode is off, the button becomes "replace and run" and it restarts. Otherwise it is replaced disabled.
- **`configured` gate**: a fresh install with a schema cannot be enabled until the user saves settings once (defaults are prefilled, saving unchanged is enough). Already `true` when the server or a kept copy has settings for the ID, for older entries without the field, and on same-ID replace.
- **Enable is refused** while required settings are missing or invalid; same at startup.
- `sdk.settings.get()` returns validated values (declared keys only) with a schema, the stored object without one. `httpOrigin` is read from the same result.

## Settings storage and sync

Server-scope settings are stored on the connected server (`<dataDir>/extensions/<id>/settings.json`); `localStorage` is a cache.

| Request | Use |
|---|---|
| `GET /extensions/settings` → `{settings:{[id]:object}}` | read all at start |
| `PUT /extensions/:id/settings` `{settings}` | save |
| `DELETE /extensions/:id` | delete (local delete proceeds on failure) |

- **Start**: before enabling anything, `GET` with a 3 s timeout; server values win and refresh the cache. On failure, start from the cache and show a non-blocking notice.
- **Save**: update locally, then `PUT`; on failure say it was saved on this browser only and retry on the next save.
- **Migration**: no server value but a non-empty local one → `PUT` once.
- **Delete** asks: keep settings / delete settings / cancel. Both remove the package and `pipaya.extension.storage.<id>`. "Delete settings" sends `DELETE`; "keep" stores a copy in `pipaya.extensions.kept` (≤50) restored on reinstall (server value first).
- Importing a configuration switches to shared local settings and stops server mirroring.

### Unreadable entries

A stored package that no longer validates (e.g. a removed permission) is kept raw in `unreadable` and written back unchanged. It shows as an "unreadable" card with export-raw and delete. Importing the same ID replaces it and inherits its settings. Counts toward the 50 limit. A fully corrupt list is backed up once to `pipaya.extensions.v1.corrupt`.

## Themes

```json
{
  "manifest": { "id": "my.blue", "name": "Blue", "version": "1.0.0", "sdkVersion": 1, "permissions": [] },
  "theme": {
    "dark": { "--accent": "#60a5fa", "--accent-fg": "#101820", "--radius": "8px" },
    "light": { "--accent": "#2563eb", "--accent-fg": "#ffffff" }
  }
}
```

Reapplied on light/dark switch; later extensions in the list win on the same token. Colors: hex only. Radius: integer 0–32 px. `--content-w`: integer 480–1200 px. No other CSS, `url()`, fonts or selectors. Allowed tokens:

```
--bg --bg-side --bg-elev --bg-hover --bg-active --bg-code
--border --border-strong --text --text-dim --text-faint --user-bg
--accent --accent-hover --accent-fg --accent-soft --ok --warn --danger
--radius --radius-panel --radius-sm --content-w
```

## Language packs

`locales` adds languages to Settings > General > Language. Needs the `locales` permission; no code required. Example: `examples/extensions/lang-ja.json`.

```json
"locales": [{ "tag": "ja", "name": "日本語", "messages": { "설정": "設定", "모델 {n}개": "{n}個のモデル" } }]
```

- `tag`: lowercase BCP 47 (`ja`, `pt-br`). `ko` and `en` are built in.
- `messages`: **Korean source string → translation**. Keys match `src/lib/locales/en.ts`; keep placeholders (`{n}`) and plurals (`{n#one|other}`) as in the source. A key with a context suffix (`"선택\u0004optional"`) wins. Missing strings fall back to English, then Korean.
- Limits: 5 languages per extension, 3000 strings each, key ≤1000, translation ≤2000, name ≤60.
- Enabling uploads it with `PUT /locales/:tag` (`owner` = extension ID) so other devices on the server see it; offline it still works locally. Disabling removes it from this device only; deleting also removes the server copy it uploaded.
- Active extension packs beat server copies; among extensions, later in the list wins.

Server: `GET /locales`, `GET/PUT /locales/:tag`, `DELETE /locales/:tag?owner=`, event `locales_updated`. The client caches packs in `localStorage` (`pipaya.locales`).

## Permissions and SDK

Every SDK method returns a Promise. `await` registrations in startup code; a failed start cleans everything up.

| Permission | Methods | Scope |
|---|---|---|
| `commands` | `sdk.commands.register(spec, handler)` | ≤20 per extension |
| `composer` | `sdk.composer.setText(text)`, `registerAction(spec, handler)` | replace the draft; ≤10 buttons |
| `ui` | `sdk.ui.registerPanel(spec, handler)`, `update(id, view, {tone}?)`, `open`, `close`, `remove` | own panels and composer widgets ([ui.md](ui.md)) |
| `status` | `sdk.status.set(id, text)`, `remove(id)` | ≤10 status items |
| `navbar` | `sdk.navbar.set(id, {label, view})`, `remove(id)` | ≤3 read-only header items |
| `http` | `sdk.http.getJson(path)` | GET JSON from the user's `httpOrigin`, no credentials |
| `http-write` | `sdk.http.requestJson(request)` | JSON read/write to `httpOrigin`, optional Bearer from own `httpToken` |
| `configuration` | `sdk.configuration.export()`, `apply(doc)`, `restore()`, `status()` | user-approved config export/import |
| `configuration-background` | `sdk.configuration.authorize/revoke/access/read/applyBackground` | ongoing access after one approval |
| `context` | `sdk.context.get()` | session ID, model, provider, running/online |
| `events` | `sdk.events.on(handler)` | event metadata only |
| `storage` | `sdk.storage.get(key)`, `set(key, value)` | per-extension JSON, ≤32,000 chars serialized |
| `notifications` | `sdk.notifications.show(text)` | in-app toast, ≤300 chars |
| `locales` | none | ship language packs |
| `system-notifications` | `sdk.notifications.send(spec)`, `status()`, `register(id, rule)`, `remove(id)` | OS / push ([notifications.md](notifications.md)) |
| `server` | `sdk.server.call(extension, method, params?, sessionId?)`, `entries({sessionId?, extension?, type?})`, `list()`, `on(handler)` | server extension methods, entries, events; 15 s per call |
| `shortcuts` | `sdk.shortcuts.register({id, label, combo}, handler)`, `remove(id)` | ≤10; `Mod` (Ctrl/⌘) or `Alt` + one key (`Mod+Shift+K`); app shortcuts win, no combo shared between extensions |
| `dialogs` | `sdk.dialog.confirm/select/input(spec)` | modal question showing the extension name; cancel → `false` / `null`; queued one at a time |
| `session` | `sdk.session.send(text, mode?)`, `abort()` | message or stop the open chat; 5 per 10 s |
| `tools` | `sdk.tools.registerRenderer(toolName, render)`, `removeRenderer(toolName)` | render finished tool calls (read-only nodes, 80 nodes, depth 5, 24 KiB); `null`/error → default; last registration wins; ≤20 |
| `messages` | `sdk.messages.registerRenderer(entryType, render)`, `removeRenderer`, `setHeader(pattern)`, `clearHeader()` | show server-extension entries (`ctx.appendEntry`) as cards in time order (navbar nodes, 80 nodes, depth 5, 24 KiB, ≤20); no renderer → hidden. `setHeader`: if a user message's first line matches the RegExp source (≤400), group 1 becomes a header above the bubble (1 per extension) |
| `session-labels` | `sdk.sessionLabels.set({[sessionId]: {text, title?}})` | short label (≤40) before chat titles; replaces all of this extension's labels; ≤1000 |
| `composer-mentions` | `sdk.mentions.set([{insert, desc?, group?, keywords?, except?}])` | `@` completion; replaces the list; ≤500 |
| `slots` | `sdk.slots.set('header'\|'footer', id, {label, view})`, `remove(slot, id)` | read-only area under the header / above the composer; navbar rules, 2 per extension |
| `composer-filter` | `sdk.composerFilter.set(fn)`, `clear()` | rewrite or block text before send (`string`, `{text}`, `{cancel: reason}`, `null` = unchanged); 2 s; on error/timeout the original is sent; slash commands skip it |
| `panes` | `sdk.panes.list()`, `group()`, `read(id,{limit?})`, `focus`, `send(id,text,mode?)`, `abort`, `split(id,edge,{kind?,focus?})`, `move(id,target,edge)`, `swap(a,b)`, `resize(id,ratio)`, `leave`, `close`, `zoom(id?)`, `models()`, `configure(id,{title?,provider?,model?,thinkingLevel?})`, `compact(id,instructions?)` | read (text only) and drive the open group's chats and terminals by ID; `split` keeps focus unless `focus: true`; 30 changes per 10 s; `configure` changes only that chat (model needs `provider`, thinking level must be supported) |
| none | `sdk.settings.get()`, `sdk.log(text)` | own settings, extension log |

Messages sent with `session`/`panes` are run by the agent, and `panes.close` ends terminal jobs; the consent text must say so.

```js
const settings = await sdk.settings.get();
await sdk.commands.register({ name: 'review', description: 'Add a review draft', args: '[target]' },
  async (arg) => { await sdk.composer.setText(`${settings.prefix || 'Please review.'}\n${arg}`); });
await sdk.composer.registerAction({ id: 'review-button', label: 'Review draft' },
  async () => { await sdk.composer.setText('Please review the current changes.'); });
await sdk.status.set('mode', 'Review helper');
await sdk.events.on(async (e) => { if (e.type === 'run_finished') await sdk.status.set('mode', e.status || 'done'); });
```

- Command spec `{name, description, args?}`, handler gets the argument string. Action spec `{id, label}`, handler gets nothing. Running a command never sends; `setText` replaces the draft and never touches attachments.
- `context.get()` → `{sessionId: string|null, model, provider, running, online, language}`.
- Events: `{type, sessionId?, at, status?, toolName?, isError?, groupId?}`. Types: `run_started`, `run_finished`, `session_created`, `session_updated`, `session_deleted`, `compaction_finished`, `question_requested`, `question_resolved`, `group_created`, `group_updated`, `group_deleted`, `extensions_updated`, `language_changed`, `turn_end`, `tool_execution_end`. `status` only on `run_finished`, `toolName`/`isError` only on `tool_execution_end`; never tool args or results. Events may repeat after reconnects; do not rely on exactly-once.
- Storage: missing key → `null`; `__proto__`, `constructor`, `prototype` are refused; deleted with the extension. `console` goes to the extension log (last 100 lines).

### Navbar

```js
await sdk.navbar.set('usage', { label: 'Usage', view: {
  type: 'stack', id: 'root', direction: 'horizontal', children: [
    { type: 'gauge', id: 'main', label: 'Usage', rings: [{ value: 42 }], display: '42%', size: 'small' }] } });
```

ID: like panel IDs (`[a-z][a-z0-9-]`, ≤40); `label` ≤40 is the accessible name; ≤3 per extension, same ID replaces. Only read-only nodes: `stack`, `grid`, `text`, `badge`, `divider`, `progress`, `stat`, `gauge`, `icon`; 60 nodes, depth 4, 32 KiB. The slot is capped at `min(40%, 160px)` (narrow: `min(36%, 132px)`) so the title wins, and scrolls sideways.

### `gauge` and `icon`

```js
const icon = { viewBox: '0 0 24 24', paths: [{ d: 'M12 2 L22 22 H2 Z', fill: 'currentColor', fillRule: 'evenodd' }] };
{ type: 'icon', id: 'logo', icon, size: 'medium', label: 'Logo' }
{ type: 'gauge', id: 'g', label: 'Usage', hint: '5h window', size: 'small', display: '42%', icon,
  rings: [{ value: 42, color: 'accent' }, { value: null, max: 200, color: '#10a37f', label: 'Secondary' }] }
```

- **IconSpec** `{viewBox, paths}`: `viewBox` is four finite numbers, w and h 1–512. 1–8 paths `{d ≤8192 chars of SVG path syntax, fill?: '#rrggbb'|'currentColor', fillRule?: 'nonzero'|'evenodd'}`. The host builds the `<svg>`; no raw SVG, URLs, gradients or CSS.
- **icon**: `{icon, size?: small|medium|large, label?}`; without `label` it is `aria-hidden`.
- **gauge**: `{label, rings, display?, icon?, hint?, stale?, size?, details?}`.
  - `rings`: 1–3, outermost first, `{value: number|null, max? >0 (100), color?: '#rrggbb'|'accent'|'ok'|'warn'|'danger', label?}`. `null` means unknown (dashed track, `—`), **never 0**.
  - `display` ≤16, `hint` ≤500 (tooltip and description), `stale` dims it, `size` `small` (~26 px) or `medium` (48 px).
  - `details?: {title? ≤40, rows: 1–12 of {label ≤48, value: number|null, max?, color?, caption? ≤80, group? ≤40}, updatedAt?: epoch ms}`: popover on hover, focus or tap (fixed position, clamped to the viewport, closes on Esc/scroll/resize, one at a time, attached inside an open `<dialog>`). Consecutive rows with the same `group` share a heading. `updatedAt` shows "updated N s ago" (live) instead of the stale line. With `details` there is no native `title`; the summary goes to `aria-description`.
  - Each ring is a `progressbar`, with `aria-valuenow` only when known.

### HTTP

```js
// settings: {"httpOrigin":"http://localhost:8317"}
const data = await sdk.http.getJson('/some/path?x=1');
const res = await sdk.http.requestJson({ path: '/resource', method: 'PUT', body: { data: 1 }, headers: { 'If-Match': '"3"' } });
// { status, body: JSON | null }; non-2xx is returned, not thrown
```

- No default origin: `httpOrigin` is required and must be a bare http(s) origin. `path` starts with a single `/`; `//`, backslashes, control chars, spaces, `.`/`..` segments, fragments and schemes are refused; query is allowed.
- `getJson`: GET only, `credentials: 'omit'`, `redirect: 'error'`, no-store, no referrer. 3.5 s timeout, 2 MiB body, depth 32. Errors never include the URL. In-flight requests to the same path merge; the same path again within 2 s is refused as too frequent; ≤4 concurrent.
- `requestJson` (`http-write`): `GET|PUT|POST|DELETE`, only extra header `If-Match`, optional Bearer from the extension's own `httpToken`, 4 MiB, depth 32, 3.5 s, one request at a time per extension.
- CORS is the target server's job; there is no proxy. Requests are cancelled on disable, reload and safe mode.

### Configuration export/import

`configuration` handles `{schemaVersion:1, servers:[{name,baseUrl}], extensions:[{package,enabled,settings}], preferences:{theme?,sound?,volume?}}`. Server tokens, chats, extension storage, the calling extension itself, `secret` fields and credential-like keys are excluded (secrets hard-coded in package code cannot be removed).

`export()`, `apply(doc)`, `restore()` return `{id}` at once and open an approval dialog naming the extension; poll `status()` → `{id, state: pending|done|cancelled|error, document?, error?}`. Import: 4 MiB, validated, local backup first, servers merged (tokens kept), extensions restored disabled and unconfigured. Disabling invalidates pending approvals.

`configuration-background`: `authorize()` binds a grant to the SHA-256 of the full package and its settings; any change to code, manifest, settings, servers or tokens needs a new grant. `access()` → `{authorized}`, `read()` → `{document, fingerprint}`, `applyBackground(doc, expectedFingerprint)` refuses on fingerprint mismatch and applies only settings of existing extensions with the same package and enabled state, app preferences and the server list (replaced, keeping IDs and tokens of known URLs; secrets kept). New extensions, code or enabled-state changes need a manual `apply()`. Sync protocol, timers and conflict policy are the extension's; it only runs while the app is open.

## Isolation and limits

- Code runs in a Worker inside an opaque-origin `<iframe sandbox="allow-scripts">` (no `allow-same-origin`), talking over a dedicated `MessagePort`. Forged messages gain nothing: the host checks every call.
- Sandbox CSP blocks everything but scripts and Workers: no direct network, external scripts, images, frames or forms. A canary checks this before start; WebViews that ignore the CSP do not run code.
- Never exposed: server token, API keys, app localStorage, DOM, Tauri invoke, transcripts, tool args/results, files, shell.
- Limits: start 5 s, command 10 s, SDK reply 5 s; heartbeat every 4 s, stopped after 5 s without a reply; 200 messages/s, 100 pending SDK requests, 20 concurrent commands; requests ≤70,000 bytes (4 MiB for configuration apply and `requestJson`).
- Start, Worker or timeout errors disable the extension; JS and permission errors are logged.
- A browser sandbox is not OS process isolation and guarantees no memory/CPU quota. Only run reviewed extensions. There is no fallback that runs code in the app realm.

## Recovery

- Settings > Extensions > **Safe mode** stops all extensions.
- IDs being started are recorded in `pipaya.extensions.booting`; if the page reloads mid-start (HMR included), only those are disabled next time ("start did not finish"), the rest start normally.
- If the app cannot boot: add `?extensions=off` to the web URL, or set `localStorage.setItem('pipaya.extensions.safe', '1')` in the desktop WebView devtools.

## Verification

```sh
bun run check && bun run test && bun run build
```

Browser QA (isolation, management, composer, heartbeat) against the dev server; Playwright is installed outside the app:

```sh
npm install --prefix /tmp/pipaya-browser-qa playwright
/tmp/pipaya-browser-qa/node_modules/.bin/playwright install chromium
NODE_PATH=/tmp/pipaya-browser-qa/node_modules node scripts/check-extensions.cjs
NODE_PATH=/tmp/pipaya-browser-qa/node_modules node scripts/check-extension-ui.cjs
```

Default URL `http://localhost:1420`, override with `EXTENSION_TEST_URL`. This does not replace QA in a native Tauri WebView.

## Not supported

Signing and publisher verification, npm packages, arbitrary HTML/CSS/components, file/shell/arbitrary network APIs, transcript access. Add any of these only behind a new explicit permission.

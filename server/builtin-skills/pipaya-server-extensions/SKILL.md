---
name: pipaya-server-extensions
description: Read this when the user wants to write, install, debug or change a pipaya SERVER extension - code that runs inside the server process to add or replace agent tools, hook the agent loop (tool_call, tool_result, context, before_agent_start, input, compaction), add `/commands`, register model providers, expose methods or events to the client, or keep per-session data. Not for client (browser or Tauri) extensions, which are covered by pipaya-client-extensions.
---

# Pipaya server extensions

A server extension is a `.ts`/`.js` file (or a folder with `index.ts`, or a `package.json` with `"pipaya": { "extensions": ["./a.ts"] }`) that default-exports `(pi) => { ... }`. It runs **inside the server process with the server's full privileges**: it can read any file the server can, run commands and see every credential. Only install code you trust. That is why `POST /server-extensions/reload` needs the admin token, and why a paired phone can call extension methods but never reload or install anything.

A folder extension can describe itself in `package.json` so Settings shows a page like a client extension's: `version`, `description`, and under `"pipaya"`: `title`, `descriptions` (`{ "en": "...", "ko": "..." }`) and `settings`, a list of fields (`key`, `type` string/number/boolean/select, `label`, `description`, `default`, `required`, `secret`, `options`, `readonly`, `component` (a `ui-components` component of the companion client extension that draws this one field), `when` (show a field only for some values of an earlier one, e.g. `{ "key": "role", "equals": "follower" }`), max 20; same shape as a client manifest's `settings`). The form edits the object behind `pi.settings`.

Korean and English are both required for anything a person reads (rule book: `docs/i18n.md` in the app repository):
write `title`, `description` and the form in one language, then add `pipaya.descriptions` (`{ "en": "...", "ko": "..." }`)
and `pipaya.translations` (`{ "ko": { "<text as written>": "<translation>" } }`) for the title, every `label`,
`description`, `placeholder` and option `label`. A `readonly` status the extension writes is `{ "ko": "...", "en": "..." }`.
Text for the agent (tool descriptions and results, command templates) stays English.

A server extension that needs a client half names it with `pipaya.companion` (its client id) and can carry the built package itself with `pipaya.client` (a path to the package JSON inside the folder, e.g. `"dist/my-ui.json"`). Settings then installs the client half from the server (`GET /server-extensions/:extension/client`), the same version as the server half and without the marketplace; it falls back to the catalog otherwise.

Where they are read from (each entry is a file or a folder; names starting with `.` and `node_modules` are skipped):

- `<dataDir>/extensions/` (default `~/.pipaya/extensions/`)
- `~/.agents/extensions/`

The server ships no extensions of its own: install them from the marketplace (`pipaya-marketplace`; the default ones are folders of `pipaya-extensions`). `ask_user` and `peer` are built in, so the old `ask-user` and `peer-tools` extensions are not loaded. `examples/extensions/todo.ts` is a small one to copy from.

Reload without a restart: `POST /server-extensions/reload`. Loaded extensions, their tools, commands, methods and load errors: `GET /server-extensions`, `GET /server-extensions/errors[?extension=name]`. A file that throws while loading is switched off alone; the others keep working.

## Showing live state on the extension's page (`pi.ui`)

A `readonly` field in `pipaya.settings` is for a value that really is a setting. A status ("connected 3 min ago", a last error, a button that runs something now) does not belong in the settings object: every write would fire `onChange` and a form save would write it back. Give the page its own tree instead. It is held by the host (not stored), served as `panel` in `GET /server-extensions`, shown in Settings → Extensions above "확장 설정", and pushed to open clients at once.

```ts
export default (pi) => {
  if (typeof pi.ui?.setPanel !== "function") return fallbackToReadonlyField(pi);   // an older app: no pi.ui
  const show = (s) => pi.ui.setPanel({
    type: "card", id: "status", title: { ko: "동기화", en: "Sync" }, children: [
      { type: "badge", id: "state", text: s.ok ? { ko: "연결됨", en: "Connected" } : { ko: "끊김", en: "Offline" }, tone: s.ok ? "success" : "danger" },
      { type: "stat", id: "items", label: { ko: "가져온 항목", en: "Items" }, value: String(s.items) },
      ...(s.error ? [{ type: "alert", id: "err", tone: "danger", text: s.error }] : []),
      { type: "button", id: "sync", label: { ko: "지금 동기화", en: "Sync now" }, disabled: s.busy },
    ],
  });
  pi.ui.onEvent(async (e) => { if (e.type === "action" && e.id === "sync") await runSync(); });
  show(initial);                     // call setPanel again whenever the state changes; `null` removes the page
};
```

| Member | What it does |
|---|---|
| `pi.ui` | absent on a server older than this feature. **Detect it with `typeof pi.ui?.setPanel === "function"`** and fall back to the old way |
| `pi.ui.setPanel(node \| null)` | sets the page (one tree, replacing the last), `null` removes it. Throws on a bad tree. An identical tree is not pushed again. A reload clears it: set it again when the extension starts |
| `pi.ui.onEvent(handler)` | one handler for what the user does: `{type:"action", id}` (a button), `{type:"change", id, value}` (a field), `{type:"submit", id, values}` (a form). The server checks it against the current page first (the node must exist, be of the right kind and not disabled). A throwing handler shows as an error on the page |

The tree is the client's declarative UI (`pipaya-client-extensions`, `references/ui.md`): `stack grid card tabs form text badge divider code alert progress stat table list button input textarea select checkbox`; `icon` too. Limits are the client's: 200 nodes, 8 levels, 60 KB of JSON, ids `[a-z][a-z0-9-]{0,39}` unique in the tree. The server checks the shape and size when you call `setPanel`; the client validates every node again and shows nothing when it refuses one (for example a node type from a newer server). Every text (`text`, `title`, `label`, `description`, table cells, list titles, ...) is a string or `{ "ko": "...", "en": "..." }`; a plain string is also looked up in `pipaya.translations`. Values of fields and options are data and are not translated. No HTML, URLs or styles: it is data only and needs no consent.

Live: `GET /server-extensions` has `panel`; a change is the live-only event `extension_panel_updated` (`{extension, panel}`, `panel` null when removed); the client posts events to `POST /server-extensions/:extension/panel/event` `{event}`. A page that must draw more than the nodes can (a slider, an editor) uses the client half, below.

### A richer page: Svelte without a client half (`pipaya.components`)

A pure server extension can carry Svelte for its own settings page, no client companion needed. In `package.json`:

```json
"pipaya": {
  "settings": [{ "key": "interval", "type": "number", "label": "Interval", "min": 1, "max": 60, "component": "Slider" }],
  "components": { "Slider": "ui/Slider.svelte", "Banner": "ui/Banner.svelte" },
  "mounts": [{ "slot": "extension.page.top", "component": "Banner" }],
  "replaces": { "extension.settings": "Section" }
}
```

`components` maps a PascalCase name to a `.svelte` file inside the folder (≤20, ≤64 KB each; a missing or oversized file is left out). The server lists the names and mounts as `ui` in `GET /server-extensions` and serves the sources at `GET /server-extensions/:extension/ui`. The reach is the extension's own page only: `mounts` accepts just the slot `extension.page.top`, `replaces` just the part `extension.settings`, and a settings field names a component with `"component"`; anything else is dropped by the server and refused by the client. Components are written like those of a client `ui-components` package (the `pipaya` kit, props `{ id, extension, serverId, settings, fields, panel, disabled, save(partial), call(method, params), fallback }`; a field component gets `{ field, value, onchange, disabled, settings, error, fallback }`; see `pipaya-client-extensions`, `references/trusted-ui.md`). `call` and `save` go to the server the page is shown for, also when it is not the open one. A runnable example is `examples/extensions/page-demo/`.

It runs in the app itself with full access, so **nothing runs until the user allows it on that device**, for exactly this code (the agreement is the SHA-256 of the components, mounts and part; changed code asks again; one agreement per server and extension; "허용 취소" takes it back; safe mode runs none of it). Until then, and when a component throws, the declarative page and the generic form are shown, so keep the essentials there. An older app ignores `pipaya.components` (the keys are unknown to it): detect nothing, just keep the declarative fallback.

### A richer page: Svelte from the client half

A server extension with `pipaya.companion` (and the client package, `pipaya.client`) can draw its own page with Svelte, using the client extension's `ui-components` (the user consents to that when installing it). Only the extension that owns the page can: the client extension named in `pipaya.companion`, never another one. The page then gets `extension.settings` (the whole settings section, with the generic form as `fallback`), `extension.page.top` (a block above the sections), and any settings field can name `"component": "Slider"` in `pipaya.settings` to draw just that one field. Props, `save(partial)` and `call(method, params)` are in `pipaya-client-extensions`, `references/trusted-ui.md`. It runs only when the client half is installed and on, and only on the server that is open in the app; elsewhere (and in safe mode, or on an older app, or if a component throws) the declarative page and the generic form are shown, so keep the essentials there.

### What a settings form saves

The form edits the declared fields that are not `readonly` and sends only those keys (`PUT /extensions/:id/settings` with `keys`): **the server replaces those keys and keeps everything else in the stored object**. A key you keep in your own settings that is not a form field, and a `readonly` value you wrote, survive any save; the form never writes a `readonly` field's value back. A write without `keys` (a client extension's own, `pi.settings.set`) still replaces the whole object. Your own `pi.settings.set` does not count as a person's edit, so it never makes a form save stale.

## A complete example

```ts
// ~/.pipaya/extensions/guard.ts
export default (pi) => {
  const T = pi.Type;

  // 1. a tool the model can call
  pi.registerTool({
    name: "todo_add",
    description: "Add an item to the session's todo list",
    parameters: T.Object({ text: T.String() }),
    execute: async (_id, p, ctx) => {
      ctx.appendEntry("todo", { text: p.text });   // saved on the session, not sent to the model
      return { content: [{ type: "text", text: `added: ${p.text}` }] };
    },
  });

  // 2. a policy: block commands before they run
  pi.on("tool_call", (e) =>
    e.toolName === "bash" && /rm\s+-rf\s+\//.test(String(e.args.command))
      ? { block: true, reason: "refused by guard" }
      : undefined);

  // 3. a /command handled by the server (returning a string sends it to the model as the user's message)
  pi.registerCommand("todos", {
    description: "List todos",
    handler: async (_args, ctx) => `Summarize these todos: ${JSON.stringify(ctx.entries("todo").map((e) => e.data))}`,
  });

  // 4. a method the client can call, and an event it can listen for
  pi.registerMethod("count", (_p, ctx) => ctx?.entries("todo").length ?? 0);
  pi.emit(null, "ready", { at: Date.now() }, { ephemeral: true });
};
```

## `pi` (ExtensionAPI)

| Member | What it does |
|---|---|
| `pi.Type` | typebox, for tool parameter schemas |
| `pi.on(event, handler)` | hooks, see below. Handlers run in load order. A throwing handler is logged and skipped, it never breaks the run |
| `pi.registerTool(tool)` | `{name, description, parameters, defaultActive?, alwaysActive?, switchable?, label?, execute(toolCallId, params, ctx, signal, onUpdate)}`. A built-in name (`read`, `bash`, ...) **replaces** that tool; `pi.builtinTool(name, cwd)` returns the original so you can wrap it |
| `pi.registerCommand(name, {description?, args?, handler(args, ctx)})` | user types `/name args`; return a string or `{prompt, note?, title?}` to send it to the model, nothing to just handle it. Runs before the model sees the message. The app's built-in names (`new`, `resume`, `rename`, `close`, `cd`, `compact`, `retry`, `stop`, `cancel`, `fork`, `tree`, `copy`, `delete`) are refused: built-in commands cannot be overridden |
| `pi.registerCommands(prefix, {label?, list(cwd), run(name, args, ctx)})` | a family `/prefix:name args` found at run time (e.g. files in a folder). `list(cwd)` returns `[{name, description?, args?}]` for the menu (`GET /server-extensions/commands?cwd=`); `run` returns like a command. A `note` (`{text, collapse?, data?}`) is shown on the user's message and never sent to the model |
| `pi.registerMethod(name, (params, ctx\|null) => result)` | called by clients: `POST /server-extensions/:extension/methods/:name[?sessionId=]`. Name: letters, digits, `_`, `-` (max 80). A call that has not answered in 20 s fails |
| `pi.registerRoute({method?, path, public?, handler(req, ctx)})` | an HTTP endpoint on the pipaya server at `/x/<extension><path>` (webhook, small web page, REST API for another program). `method`: `GET` (default), `POST`, `PUT`, `PATCH`, `DELETE`, a list, or `"*"`. `path` segments: literal, `:name`, or a final `*` (rest of the path). `handler` gets a web `Request` (raw body, any content type, ≤16 MiB) and `ctx = {params, query, device, authenticated}`; return a `Response` (any status, headers, stream) or a value to send as JSON. A token (admin or paired device) is required unless `public: true`; a public route is open to anyone who can reach the server, so check your own secret (a webhook signature). Max 50 per extension, removed on reload, listed in `GET /server-extensions` (`routes`). A throw is a 500 and an entry in the extension's errors |
| `pi.registerProvider(provider)` / `unregisterProvider(id)` | a pi-ai `Provider` (custom endpoint, proxy, OAuth). Removed when the extension unloads |
| `pi.registerFlag(name, {type?, default?, description?})`, `pi.getFlag(name)` | value from environment `PIPAYA_FLAG_<NAME>` |
| `pi.emit(sessionId\|null, type, data?, {ephemeral?})` | publishes `extension_event` to clients (client extensions with the `server` permission receive it) |
| `pi.events.on/emit(channel, ...)` | in-process bus between extensions |
| `pi.sessions` | every session: `list({closed?, limit?, before?})`, `get(id)`, `messages(id, count?, {after?})`, `send(id, text, mode?)`, `create({title?, cwd?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, parentId?})`, `update(id, {title?, purpose?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, closed?})`, `fork(id, {atSeq?, title?})`, `abort(id)`, `compact(id, instructions?)`, `questions(id)`, `answer(id, toolCallId, answer)`, `delete(id)` (false for an unknown or busy one). Each `SessionInfo` has model, tools, `running` and `busy` |
| `pi.sessions.data` | this extension's own values on sessions (a name, a label, a marker): `get(sessionId, key)`, `set(sessionId, key, value)` (JSON, 4000 characters at most, unknown session throws), `delete(sessionId, key)`, `list(key)` → `{ [sessionId]: value }`. Kept with the session, removed with it, invisible to other extensions |
| `pi.groups` | split-window groups: `list()`, `get(id)`, `create({name?, layout})`, `update(id, {name?, layout?})`, `delete(id)`. `{id, name, sessionIds, terminalIds, layout, ...}`. A layout pane may hold a session or a terminal id |
| `pi.terminals` | the server's shells: `list()`, `get(id)`, `create({cwd?, shell?, title?, cols?, rows?})`, `rename(id, title)`, `write(id, data)` (types into it, `"ls\r"` runs `ls`; ≤64 KB), `resize(id, cols, rows)`, `close(id)` (false when unknown). Ids start with `term_`; put one in a group layout to show it as a pane |
| `pi.models` | `list({provider?})` the usable models; `complete({role? \| provider+model, system?, input, maxTokens?, signal?})` one-shot text completion (no session, no tools) |
| `pi.subscribe(handler, {sessionId?, types?})` | every server event (the `/events` stream) as it happens; returns the unsubscribe. Removed on reload |
| `pi.notify({title, body?, sessionId?, key?, kind?})` | OS / push notification to the user's devices, under this extension's name (5 per 10 s) |
| `pi.ui` | the extension's page in Settings: `setPanel(node \| null)`, `onEvent(handler)`; see "Showing live state". Absent on an older server |
| `pi.settings` | `get()`, `set(obj)`, `onChange(fn)`: the object behind `/extensions/:id/settings` for this extension's id, shared with a client extension that has the same id and `settingsScope: "server"` |
| `pi.home`, `pi.defaultCwd()` | the user's home and the server's default working directory |
| `pi.dataDir` | a folder for this extension's own files |
| `pi.log(...)` | server log |

`ctx` (ExtensionContext): `sessionId`, `cwd`, `appendEntry(type, data)`, `entries(type?)`, `sendUserMessage(text, mode?)`, `abort()`, `isRunning()`, `ask(toolCallId, {question, options?, recommended?, allowFreeText?, items?}, signal?)` (asks the user, resolves to the answer text). `appendEntry` data is stored in `extension_entries`, published as `extension_entry`, listed by `GET /sessions/:id/extension-entries[?extension=&type=&after=<id>&limit=<≤1000>]` (oldest first), and never reaches the model.

## Hooks

| Event | Payload | Return |
|---|---|---|
| `input` | `{sessionId, text, mode}` | `{text}` to rewrite, `{handled: true}` to swallow, `{parts}` to store extra text blocks for the model after it (blocks starting `<pipaya-` are hidden from the transcript), `{note}` to show a line on the message that the model never sees, `{title}` to cut the session title from something else |
| `before_agent_start` | `{sessionId, text}` | `{systemPrompt?, appendSystemPrompt?, message?}` for this run only |
| `context` | `{sessionId, messages}` | `{messages}`: what the model sees for this call (storage is untouched) |
| `tool_call` | `{sessionId, toolCallId, toolName, args}` | `{block: true, reason}`; `args` may be edited in place. |
| `tool_result` | `{..., content, details, isError}` | `{content?, details?, isError?}`; each extension sees the previous one's result |
| `session_before_compact` | `{sessionId, reason, messages, previousSummary, instructions?}` | `{cancel: true}` or `{summary}` (your own summary replaces the model call) |
| `extension_unload` | `{name}` | none. Runs (2 s limit) before reload or shutdown drops the extension: close timers and files here |
| observation only | `agent_start`, `agent_end`, `turn_start`, `turn_end`, `message_end`, `session_start`, `session_fork`, `session_compact`, `session_shutdown`, `extensions_loaded` | none |

`alwaysActive: true` gives a tool to every session, also ones created before the extension was installed (otherwise only new sessions get it, through the default tool set). `switchable: true` lets the user turn it off in the settings.

Tools run without asking the user; a `tool_call` hook is the place for a policy. To ask the user something, call `ctx.ask(...)`.

## Another server next to pipaya

Need more than routes (a WebSocket server, another port, a Python service)? The extension runs with the server's rights, so it can open one itself: `const srv = Bun.serve({ hostname, port, fetch })` or `Bun.spawn([...])`, and close it in `pi.on("extension_unload", () => srv.stop())` (otherwise a reload leaves the port taken). Prefer `registerRoute` when HTTP is enough: it shares the server's address, TLS and token check.

## Rules that are easy to break

1. **Never block the event loop.** Hooks run on the agent's path. Do slow work async and keep `context` fast; it runs before every model call.
2. **Return `undefined` when you have nothing to say** so the next extension still runs. In `tool_call`, return `{block: true}` only when you mean it: it stops the whole chain.
3. **Do not store secrets in `appendEntry` or `emit`**: both reach every connected client and `emit` with `ephemeral: false` is persisted in the event log.
4. **Replacing a built-in tool replaces its safety checks.** If you override `read`/`write`/`edit`/`bash`, call the original from `pi.builtinTool(name, ctx.cwd)` (which keeps its path checks) unless you deliberately reimplement them.
5. **Unload cleanly.** Providers and bus listeners you register are removed on reload; timers and file handles you open are yours to close in an `extension_unload` handler.
6. **Test with a real server.** `server/test/server-extensions.test.ts` shows how: write the extension to a temp dir, `buildApp(cfg, { extensionDirs: [dir] })`, drive it through the HTTP API with the echo upstream in `test/support/openai-upstream.ts`.

## Client side

A client extension reaches yours with the `server` permission: `sdk.server.call("guard", "count")`, `sdk.server.entries({type: "todo"})`, `sdk.server.on(e => ...)`. See `pipaya-client-extensions`.

---
name: pipaya-server-extensions
description: Read this when the user wants to write, install, debug or change a pipaya SERVER extension - code that runs inside the server process to add or replace agent tools, hook the agent loop (tool_call, tool_result, context, before_agent_start, input, compaction), add `/commands`, register model providers, expose methods or events to the client, or keep per-session data. Not for client (browser or Tauri) extensions, which are covered by pipaya-client-extensions.
---

# Pipaya server extensions

A server extension is a `.ts`/`.js` file (or a folder with `index.ts`, or a `package.json` with `"pipaya": { "extensions": ["./a.ts"] }`) that default-exports `(pi) => { ... }`. It runs **inside the server process with the server's full privileges**: it can read any file the server can, run commands and see every credential. Only install code you trust. That is why `POST /server-extensions/reload` needs the admin token, and why a paired phone can call extension methods but never reload or install anything.

A folder extension can describe itself in `package.json` so Settings shows a page like a client extension's: `version`, `description`, and under `"pipaya"`: `title`, `descriptions` (`{ "en": "...", "ko": "..." }`) and `settings`, a list of fields (`key`, `type` string/number/boolean/select, `label`, `description`, `default`, `required`, `secret`, `options`, max 20; same shape as a client manifest's `settings`). The form edits the object behind `pi.settings`.

A server extension that needs a client half names it with `pipaya.companion` (its client id) and can carry the built package itself with `pipaya.client` (a path to the package JSON inside the folder, e.g. `"dist/my-ui.json"`). Settings then installs the client half from the server (`GET /server-extensions/:extension/client`), the same version as the server half and without the marketplace; it falls back to the catalog otherwise.

Where they are read from (each entry is a file or a folder; names starting with `.` and `node_modules` are skipped):

- `<dataDir>/extensions/` (default `~/.pipaya/extensions/`)
- `~/.agents/extensions/`

The server ships no extensions of its own: install them from the marketplace (`pipaya-marketplace`; the default ones are folders of `pipaya-extensions`, e.g. `extensions/peer-tools`). `examples/extensions/todo.ts` is a small one to copy from.

Reload without a restart: `POST /server-extensions/reload`. Loaded extensions, their tools, commands, methods and load errors: `GET /server-extensions`, `GET /server-extensions/errors[?extension=name]`. A file that throws while loading is switched off alone; the others keep working.

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
| `pi.registerCommand(name, {description?, args?, handler(args, ctx)})` | user types `/name args`; return a string or `{prompt, note?, title?}` to send it to the model, nothing to just handle it. Runs before the model sees the message |
| `pi.registerCommands(prefix, {label?, list(cwd), run(name, args, ctx)})` | a family `/prefix:name args` found at run time (e.g. files in a folder). `list(cwd)` returns `[{name, description?, args?}]` for the menu (`GET /server-extensions/commands?cwd=`); `run` returns like a command. A `note` (`{text, collapse?, data?}`) is shown on the user's message and never sent to the model |
| `pi.registerMethod(name, (params, ctx\|null) => result)` | called by clients: `POST /server-extensions/:extension/methods/:name[?sessionId=]`. Name: letters, digits, `_`, `-` (max 80). A call that has not answered in 20 s fails |
| `pi.registerProvider(provider)` / `unregisterProvider(id)` | a pi-ai `Provider` (custom endpoint, proxy, OAuth). Removed when the extension unloads |
| `pi.registerFlag(name, {type?, default?, description?})`, `pi.getFlag(name)` | value from environment `PIPAYA_FLAG_<NAME>` |
| `pi.emit(sessionId\|null, type, data?, {ephemeral?})` | publishes `extension_event` to clients (client extensions with the `server` permission receive it) |
| `pi.events.on/emit(channel, ...)` | in-process bus between extensions |
| `pi.sessions` | every session: `list({closed?, limit?, before?})`, `get(id)`, `messages(id, count?, {after?})`, `send(id, text, mode?)`, `create({title?, cwd?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, parentId?})`, `update(id, {title?, purpose?, provider?, model?, thinkingLevel?, systemPrompt?, tools?, closed?})`, `fork(id, {atSeq?, title?})`, `abort(id)`, `compact(id, instructions?)`, `questions(id)`, `answer(id, toolCallId, answer)`, `delete(id)` (false for an unknown or busy one). Each `SessionInfo` has model, tools, `running` and `busy` |
| `pi.sessions.data` | this extension's own values on sessions (a name, a label, a marker): `get(sessionId, key)`, `set(sessionId, key, value)` (JSON, 4000 characters at most, unknown session throws), `delete(sessionId, key)`, `list(key)` → `{ [sessionId]: value }`. Kept with the session, removed with it, invisible to other extensions |
| `pi.groups` | split-window groups: `list()`, `get(id)`, `create({name?, layout})`, `update(id, {name?, layout?})`, `delete(id)`. `{id, name, sessionIds, layout, ...}` |
| `pi.models` | `list({provider?})` the usable models; `complete({role? \| provider+model, system?, input, maxTokens?, signal?})` one-shot text completion (no session, no tools) |
| `pi.subscribe(handler, {sessionId?, types?})` | every server event (the `/events` stream) as it happens; returns the unsubscribe. Removed on reload |
| `pi.notify({title, body?, sessionId?, key?, kind?})` | OS / push notification to the user's devices, under this extension's name (5 per 10 s) |
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

## Rules that are easy to break

1. **Never block the event loop.** Hooks run on the agent's path. Do slow work async and keep `context` fast; it runs before every model call.
2. **Return `undefined` when you have nothing to say** so the next extension still runs. In `tool_call`, return `{block: true}` only when you mean it: it stops the whole chain.
3. **Do not store secrets in `appendEntry` or `emit`**: both reach every connected client and `emit` with `ephemeral: false` is persisted in the event log.
4. **Replacing a built-in tool replaces its safety checks.** If you override `read`/`write`/`edit`/`bash`, call the original from `pi.builtinTool(name, ctx.cwd)` (which keeps its path checks) unless you deliberately reimplement them.
5. **Unload cleanly.** Providers and bus listeners you register are removed on reload; timers and file handles you open are yours to close in an `extension_unload` handler.
6. **Test with a real server.** `server/test/server-extensions.test.ts` shows how: write the extension to a temp dir, `buildApp(cfg, { extensionDirs: [dir] })`, drive it through the HTTP API with the echo upstream in `test/support/openai-upstream.ts`.

## Client side

A client extension reaches yours with the `server` permission: `sdk.server.call("guard", "count")`, `sdk.server.entries({type: "todo"})`, `sdk.server.on(e => ...)`. See `pipaya-client-extensions`.

A server extension is a **plugin that runs inside the server process**. It can add or replace tools, hook into the agent's behavior, create `/commands`, expose methods for clients to call, and register model providers.

> [!DANGER]
> A server extension **runs with all of the server's permissions.** There is no sandbox and no time limit (the only exception is the 2-second wait on the unload hook), and it can do as it pleases with files, the network and processes. Install only code you trust. That is why reloading extensions can be done only with the **admin token**.

## Location and loading

| Location | Description |
|---|---|
| `~/.pipaya/extensions/` | `extensions/` in the data directory (`PIPAYA_DATA_DIR`) |
| `~/.agents/extensions/` | The home of the server user |

Each entry is one of the following. Names starting with `.` and `node_modules` are skipped.

- A `.ts`, `.js` or `.mjs` file
- A folder containing `index.ts` / `index.js` / `index.mjs`
- A folder whose `package.json` lists files under `pipaya.extensions` (`{"pipaya": {"extensions": ["./a.ts", "./b.ts"]}}`)

To reload without restarting the server, call `POST /server-extensions/reload` (admin token). When reloading, the previous instances are taken down by sending each extension the `extension_unload` hook and waiting **up to 2 seconds**.

| Check | API |
|---|---|
| Loaded extensions, tools, commands, methods, errors | `GET /server-extensions` |
| Load and runtime errors | `GET /server-extensions/errors` (last 100) |

An extension that throws while loading is the only one turned off; the others keep working. Errors are also announced with the `extension_error` event (not stored).

## Basic shape

An extension is a module that **default-exports** a `(pi) => { … }` function.

```ts
// ~/.pipaya/extensions/guard.ts
export default (pi) => {
  const T = pi.Type;

  // 1. A tool the model can call
  pi.registerTool({
    name: "todo_add",
    description: "Add an item to this chat's to-do list",
    parameters: T.Object({ text: T.String({ minLength: 1, maxLength: 200 }) }),
    mutating: false,                      // default true = needs approval under the ask policy
    execute: async (_id, params, ctx) => {
      ctx.appendEntry("todo", { text: params.text });   // stored in the session, not sent to the model
      return { content: [{ type: "text", text: `Added: ${params.text}` }] };
    },
  });

  // 2. Policy: block dangerous commands before they run
  pi.on("tool_call", (e) =>
    e.toolName === "bash" && /\brm\s+-rf\s+\/(\s|$)/.test(String(e.args?.command))
      ? { block: true, reason: "denied by guard" }
      : undefined);

  // 3. A /command handled by the server (a returned string goes to the model as a user message)
  pi.registerCommand("todos", {
    description: "Ask for a summary of the to-do list",
    handler: async (_args, ctx) => {
      const items = ctx.entries("todo").map((e) => `- ${e.data.text}`);
      return items.length ? `Here are my to-dos. Suggest what to do first:\n${items.join("\n")}` : "I have no to-dos.";
    },
  });

  // 4. A method the client calls
  pi.registerMethod("count", (_params, ctx) => ctx?.entries("todo").length ?? 0);

  pi.on("extension_unload", () => pi.log("guard unloaded"));
};
```

`server/examples/extensions/todo.ts` in the repository is a complete example with the same structure.

## `pi` (ExtensionAPI)

| Member | Description |
|---|---|
| `pi.Type` | typebox. For tool parameter schemas (`pi.Type.Object({…})`) |
| `pi.name` | This extension's name (file or folder name) |
| `pi.on(event, handler)` | Register a hook. Handlers run in **load order**. If one throws, it is logged and skipped |
| `pi.registerTool(tool)` | Add a tool. If the name equals a built-in tool (`read`, `bash`…), it **replaces that tool**. Name rule `^[A-Za-z0-9_-]{1,64}$` |
| `pi.builtinTool(name, cwd)` | Returns the original built-in tool (for wrapping while replacing) |
| `pi.registerCommand(name, cmd)` | A server command called as `/name arguments`. Name rule `^[A-Za-z0-9_-]{1,40}$` |
| `pi.registerMethod(name, fn)` | Called by the client with `POST /server-extensions/:extension/methods/:name`. `fn(params, ctx \| null)` |
| `pi.registerProvider(p)` / `unregisterProvider(id)` | A model provider (custom endpoint, proxy, OAuth sign-in, etc.). Same shape as pi-ai's `Provider` |
| `pi.registerFlag(name, flag?)` / `getFlag(name)` | Flags. The value comes from the environment variable `PIPAYA_FLAG_<name>`, otherwise the default |
| `pi.emit(sessionId, type, data?, {ephemeral?})` | Emit an `extension_event` to clients. `sessionId: null` makes it global. `ephemeral` means not stored |
| `pi.events.on(channel, fn)` / `emit(channel, data)` | An **in-process** event bus between extensions. `on` returns an unsubscribe function |
| `pi.dataDir` | A folder where this extension can keep files (created on first use) |
| `pi.log(...)` | Logging |

If two extensions register the same name, the conflict is logged as an error.

## Tools

| Field | Description |
|---|---|
| `name` | Tool name |
| `label` | Display name (optional) |
| `description` | The description the model reads |
| `parameters` | A typebox schema |
| `mutating` | Default **true**. A modifying tool **always** asks for approval under `ask` and is blocked under `readonly`. Set `false` if it is read-only |
| `defaultActive` | Whether to include it in a new session's default tools. Default true |
| `execute(toolCallId, params, ctx, signal?, onUpdate?)` | Returns `{content: [{type:"text", text} \| {type:"image", data, mimeType}], details?}` |

> [!NOTE]
> The server cannot tell whether an extension tool reaches outside the project, so an extension tool with `mutating: true` (the default) asks for approval under the `ask` policy **even inside the project** → [[tools]].

## Hooks (events)

| Event | Payload | What a return value can do |
|---|---|---|
| `input` | `{sessionId, text, mode}` | **Rewrite** with `{text}`, or **swallow** with `{handled: true}` |
| `before_agent_start` | `{sessionId, text}` | `{systemPrompt?, appendSystemPrompt?, message?}` — add context for this run only |
| `context` | `{sessionId, messages}` | **Change the messages the model sees** with `{messages}` (not stored) |
| `tool_call` | `{sessionId, toolCallId, toolName, args}` | Edit `args` in place, or **block** with `{block: true, reason}`. Sub-agents' tool calls pass through it too |
| `tool_result` | `{…, content, details, isError}` | **Partly replace** the result with `{content?, details?, isError?}` |
| `session_before_compact` | `{sessionId, reason: "manual"\|"threshold", messages, previousSummary, instructions?}` | `{cancel: true}` or a `{summary}` you wrote yourself |
| `agent_start` `agent_end` `turn_start` `turn_end` `message_end` | Session ID and so on | For observation (no return) |
| `session_start` `session_shutdown` `session_fork` `session_compact` | Session ID and so on | For observation |
| `extension_unload` | `{name}` | Clean up timers and files. Must finish within 2 seconds |
| `extensions_loaded` | `{names}` | Once, after all extensions are loaded |

Every handler receives `(event, ctx)`.

## ctx (ExtensionContext)

| Member | Description |
|---|---|
| `sessionId`, `cwd` | The session and working directory |
| `appendEntry(type, data)` | **Store an entry** in the session. It survives restarts and is not sent to the model. Also emitted as an `extension_entry` event |
| `entries(type?)` | The entries this extension stored in this session (oldest first) |
| `sendUserMessage(text, mode?)` | Queue a user message. If idle, starts a new run (`prompt`); otherwise `steer`/`follow_up` |
| `abort()` | Abort the running agent |
| `isRunning()` | Whether work is in progress |

The `ctx` of a `registerMethod` handler is `null` if the request has no `?sessionId=`.

## `/commands`

When a user sends `/name arguments` from the input box, the server runs the extension command. If the handler **returns a string (or `{prompt}`), it is passed to the model as a user message**; if it returns nothing, it just handles it and ends. The loaded extension commands also appear in the app's `/` menu.

## Connecting to clients

| Direction | Method |
|---|---|
| Client → server | A client extension calls `sdk.server.call("extension", "method", params)` → `registerMethod` |
| Server → client | `pi.emit(...)`, `ctx.appendEntry(...)` → a client extension receives with `sdk.server.on(...)` |
| Reading stored entries | `GET /sessions/:id/extension-entries?extension=&type=`, `sdk.server.entries(...)` |

A server extension's methods can also be called by devices connected with QR (not `403`), but only the admin can reload. The screens are drawn by client extensions → [[client-extensions]].

## Building and debugging

::: steps
### Create the file

Put part of the example above in `~/.pipaya/extensions/hello.ts`.

### Reload

```bash
TOKEN="$(< ~/.pipaya/token)"
curl -X POST -H "Authorization: Bearer $TOKEN" http://<server address>:8787/server-extensions/reload
```

### Check

In `GET /server-extensions`, see whether the tools, commands and methods appear, and in `GET /server-extensions/errors` that there are no errors. If a load error occurred, the message says which stage (`where`) it was.
:::

- Changed tools and commands are reliably reflected in sessions created **after reloading**.
- The policy hook (`tool_call`) applies to every session and sub-agent, so it is good for blocking dangerous actions. But if the server extension fails to load, the policy is not applied either.

## Leave it to the agent

The built-in skill `pipaya-server-extensions` contains the above, so a request like "block `rm -rf /` with a server extension" is understood by the agent, which creates the file for you.

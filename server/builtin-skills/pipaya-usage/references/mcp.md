# MCP servers

MCP (Model Context Protocol) servers are configured on the pipaya server (`settings.mcp_servers` in SQLite) and shared across all sessions. Connected servers expose their tools as `mcp_<server>_<tool>` (capped at 200 per server and 128 total across all servers).

## Preferred way: the built-in `mcp` tool

Use the built-in `mcp` tool whenever it is enabled in the session — it works identically on Linux, macOS, Windows, Docker, and Tauri desktop without needing the server port or bearer token:

- `mcp(action="list")` — see configured servers, connection status (`ready` / `connecting` / `error` / `off`), env/header key names (never values), and exposed `mcp_<server>_<tool>` names.
- `mcp(action="add", name=..., transport="stdio"|"http", ...)` — register one server (defaults to `enabled: true`) and wait briefly for it to connect.
- `mcp(action="update", name=..., ...)` — patch one server without touching others. `env` and `headers` merge keys (`null` removes a key; omitted keys preserve stored secrets). `allowTools` / `denyTools` accept `null` to clear.
- `mcp(action="enable"|"disable", name=...)` — switch a server on or off.
- `mcp(action="remove", name=...)` — delete a server.
- `mcp(action="reload", name=?)` — reconnect one server (or all if `name` is omitted).

When `add`, `update`, `enable`, or `reload` succeeds, the server connects immediately and the new `mcp_<server>_<tool>` tools become available on the next turn.

### Common recipes

- **Python (`uvx`)**: `transport: "stdio"`, `command: "uvx"`, `args: ["mcp-for-blender"]`.
- **Node (`npx`)**: `transport: "stdio"`, `command: "npx"`, `args: ["-y", "@modelcontextprotocol/server-filesystem", "/path"]`. On Windows, if `npx` fails with `ENOENT` because it is a `.cmd` shim, use `command: "cmd"`, `args: ["/c", "npx", "-y", ...]`, or the full path to `npx.cmd`.
- **Custom binary paths (Windows/macOS/Linux)**: pass absolute paths directly in `command` or `env` (e.g. `env: { OPENSCAD_PATH: "C:\\Program Files\\OpenSCAD\\openscad.exe" }`).
- **Streamable HTTP**: `transport: "http"`, `url: "https://example.com/mcp"`, optional `headers`.
- **PATH caveats**: stdio commands run inside the **server process's** environment (filtered by default; set `inheritEnv: true` to pass host env excluding `PIPAYA_*`). In macOS GUI/Tauri builds or Docker containers, tools like `uvx` or `npx` may not be on the default PATH — check `which uvx` / `where uvx` or pass an absolute path.

### Secrets hygiene

- `GET /mcp` and the `mcp` tool never return `env` or `headers` values (`••••••••` masked on read, and matched values are redacted from connection errors).
- `args` and `url` are **not** masked — never put tokens or API keys in CLI flags (`--api-key=...`) or URL query strings (`?token=...`); pass them via `env` or `headers` instead.
- Tool call arguments **are** saved in the chat transcript. If an MCP server needs an API key or bearer token, either ask the user to fill it in **Settings → MCP servers**, or add the server with a placeholder (or `enabled: false`) and have the user paste the secret in Settings.

## HTTP API fallback

Only needed when the `mcp` tool is switched off in Settings → Tools, or when configuring from a script or server extension (`pi.api.request`). All mutating routes require the admin token (paired devices get `403`).

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/mcp` | List servers, status, tools (`env`/`headers` values masked as `••••••••`) |
| `POST` | `/mcp` | Add one server (`McpServerBody`; returns `201`, or `409` if name already exists) |
| `PATCH` | `/mcp/:name` | Update one server in place (`env`/`headers` merge keys; `null` deletes a key; returns `404` if unknown) |
| `DELETE` | `/mcp/:name` | Remove one server (`404` if unknown) |
| `PUT` | `/mcp` | Replace the entire `{ servers: [...] }` list (sending `••••••••` keeps the stored secret) |
| `POST` | `/mcp/reload` | `{ name? }` reconnect one server or all |

## Source map

`server/src/mcp.ts` (manager, validation, connection, secret masking), `server/src/mcp-tool.ts` (built-in `mcp` tool), `server/src/routes/mcp-routes.ts` (HTTP API).

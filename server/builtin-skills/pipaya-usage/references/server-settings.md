# Server settings and HTTP API

Use this reference when the user asks you to inspect or change pipaya server settings that do not live in plain files (`AGENTS.md`, `skills/`, `subagents/`, `templates/`) or have a dedicated built-in tool (`mcp`, `schedule`, `goal`).

## Calling the local server safely

- **Default base URL**: `http://127.0.0.1:${PIPAYA_PORT:-8787}` (check `PIPAYA_PORT` or running listeners if customised).
- **Token**: `${PIPAYA_DATA_DIR:-$HOME/.pipaya}/token` (or `$PIPAYA_TOKEN`).
- **Never print or log the token.** Load it inside the same shell command:

```sh
TOKEN="$(< "${PIPAYA_DATA_DIR:-$HOME/.pipaya}/token")"
curl -sS -H "Authorization: Bearer $TOKEN" "http://127.0.0.1:${PIPAYA_PORT:-8787}/configuration"
```

For writes, pass `-X PUT -H "Content-Type: application/json" -d '{...}'`. Always read the current value with `GET` first so you preserve existing fields when a `PUT` replaces an object.

- **Auth scope**: most settings routes accept any valid Bearer token (admin or paired device). **Admin-only** routes (`403` for paired devices) are `/pairing`, `/devices/tokens*`, `POST /server-extensions/install`, `POST /server-extensions/reload`, `DELETE /server-extensions/:extension`, mutating `/mcp*`, and `/server/update`.
- **Secrets hygiene**: never put real API keys or tokens in tool call arguments or chat messages (they are recorded in the transcript). When adding a provider or voice key, configure non-secret fields or guide the user to enter the key in Settings.

## Core configuration and models

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/configuration` | Snapshot of `providers`, `defaults`, `effectiveDefaults`, `workdir`, `tools` (including `delegate` policy) |
| `GET` | `/models` | Available models (`?provider=&configured=1`) |
| `GET` | `/tools` | Active tool definitions |
| `PUT` | `/configuration/defaults` | `{ provider, model, thinkingLevel?, serviceTier? }` or `null` to clear |
| `PUT` | `/configuration/workdir` | `{ path: string \| null }` — default working directory for new sessions (`null` resets to fallback) |
| `PUT` | `/configuration/tools` | `{ disabled: string[] }` — disable toggleable tools (`glob`, `ask_user`, `peer`, `delegate`, `schedule`, `goal`, `mcp`, plus switchable tools like `generate_image`). Locked tools (`read`, `write`, `edit`, `ls`, `grep`, `bash`, `workdir`) return `400`. |
| `PUT` | `/configuration/delegate` | `{ roles?: "defined" \| "any", policy: "defined" \| "allowlist" \| "any", models: string[], maxConcurrent: number, maxCalls: number, maxTurns: number }` (limits: `maxConcurrent` 1–8, `maxCalls` 1–50, `maxTurns` 1–50) |
| `GET` / `PUT` | `/system-model` | `{ model: { provider, model, thinkingLevel? } \| null }` — helper model for session titles, purpose, and group names |
| `GET` / `PUT` | `/fallback-model` | `{ model: { provider, model, thinkingLevel? } \| null }` — automatic fallback model |
| `GET` / `PUT` | `/image-model` | `{ model: { provider, model } \| null }` — enables/configures the `generate_image` tool |
| `GET` / `PUT` | `/model-roles` | `{ roles: Record<string, { provider, model }> }` — named LLM roles for one-shot completions |
| `POST` | `/configuration/test` | `{ provider, model }` — smoke-test a chat or image model |

## Custom providers

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/providers` | Built-in and custom providers with auth status and login methods |
| `POST` | `/configuration/discover` | `{ baseUrl, api, providerId?, apiKey? }` — query upstream `/models` (omit `apiKey` if stored on `providerId`) |
| `PUT` | `/configuration/providers/:id` | `{ name, baseUrl, api, authRequired, models: [{ id, name?, contextWindow, maxTokens, reasoning, vision, imageGeneration?, imageApi?, icon?, disabled?, fromUpstream?, thinkingLevels?, catalogId?, defaultThinkingLevel?, defaultServiceTier?, serviceTiers? }] }` |
| `POST` | `/configuration/providers/:id/refresh` | Refresh upstream model list for a custom provider |
| `DELETE` | `/configuration/providers/:id` | Delete an unreferenced custom provider |
| `DELETE` | `/providers/:id/credential` | Remove a stored provider credential (for adding keys or OAuth logins, direct the user to **Settings → Providers**) |

## Compaction, execution guard, and retention

| Method | Path | Body / notes |
|---|---|---|
| `GET` / `PUT` | `/compaction` | `{ auto: boolean, model: { provider, model, thinkingLevel? } \| null, thresholdPercent?: number }` |
| `GET` / `PUT` | `/guard` | Partial boolean flags: `{ wipe?, disk?, fork?, permissions?, remoteExec?, systemPower?, forcePush? }` |
| `GET` / `PUT` | `/retention` | `{ enabled: boolean, days: number, onlyClosed: boolean }` (`GET` also returns `lastRun`, `lastDeleted`, `due`) |
| `POST` | `/retention/run` | Run session retention cleanup now (`{ deleted }`) |
| `PUT` | `/schedules/settings` | Update retention days for finished one-time scheduled tasks |

## Server extensions and shared settings

| Method | Path | Body / notes |
|---|---|---|
| `GET` | `/server-extensions` | Loaded server extensions, tools, commands, routes |
| `GET` | `/server-extensions/errors` | Load and runtime errors (`?extension=name`) |
| `POST` | `/server-extensions/install` | Admin-only; install a server extension from Git and reload |
| `POST` | `/server-extensions/reload` | Admin-only; reload all server extensions without restarting the server |
| `DELETE` | `/server-extensions/:extension` | Admin-only; uninstall from `<dataDir>/extensions` and reload |
| `GET` / `PUT` | `/extensions/:id/settings` | Shared settings object for one extension (`GET /extensions/settings` lists all) |
| `GET` / `PUT` | `/client-settings/:key` | Shared client settings (`favModels`, `favDirs`, `extensions`, `extensionStates`, `notificationPolicy`, `sidebar`); `PUT` takes `{ value, at?, origin? }` |

## Startup-only environment variables

These are read once when the server process starts (changing them requires restarting the server):

`PIPAYA_HOST` (default `127.0.0.1`), `PIPAYA_PORT` (`8787`), `PIPAYA_DATA_DIR` (`~/.pipaya`), `PIPAYA_DB`, `PIPAYA_TOKEN`, `PIPAYA_WORKSPACE`, `PIPAYA_RESTRICT_WORKSPACE` (`1`), `PIPAYA_PROVIDER`, `PIPAYA_MODEL`, `PIPAYA_LOG_LEVEL`, `PIPAYA_CORS_ORIGINS`, `PIPAYA_PUSH_FCM` (`0` disables), `PIPAYA_TERMINAL` (`0` disables), `PIPAYA_MAX_SESSIONS`, `PIPAYA_DEVICE_TOKEN_IDLE_DAYS`.

## Source map

`server/src/config.ts`, `server/src/auth-policy.ts`, `server/src/routes/configuration-routes.ts`, `server/src/routes/compaction-routes.ts`, `server/src/routes/guard-routes.ts`, `server/src/routes/retention-routes.ts`, `server/src/routes/system-model-routes.ts`, `server/src/routes/fallback-model-routes.ts`, `server/src/routes/image-model-routes.ts`, `server/src/routes/llm-routes.ts`, `server/src/routes/client-settings-routes.ts`, `server/src/extensions/routes.ts`.

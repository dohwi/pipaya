Every environment variable the server reads, with defaults. The list was found directly in the source (`config.ts` and others), and there are no other `PIPAYA_*` variables.

## Where to set them

| Installation | Location |
|---|---|
| Install script | `~/.config/pipaya/server.env` (read by the service). Restart the service after changing |
| Manual run | `.env` in the server's working directory (read by Bun) |
| Docker | `.env` next to `compose.yaml` |
| Direct | Process environment variables |

## Server

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_HOST` | `0.0.0.0` | Listen address. The install script sets the Tailscale IPv4 (or `127.0.0.1` if none) |
| `PIPAYA_PORT` | `8787` | Listen port |
| `PIPAYA_TOKEN` | Auto-generated | Admin token. Must be **24 characters or more** (the server will not start if shorter). If absent, `<data>/token` is created and kept at 0600. Recommended: `openssl rand -base64url 32` |
| `PIPAYA_DATA_DIR` | `~/.pipaya` | Data directory (0700) |
| `PIPAYA_DB` | `<data>/pipaya.db` | SQLite path |
| `PIPAYA_LOG_LEVEL` | `info` | Fastify log level. `silent` turns it off. `?token=` is masked in logs |

## Working folder

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_WORKSPACE` | `<data>/workspace` | The default working directory at startup. While running, change it with Settings → Default folder (`PUT /configuration/workdir`); the stored value overrides this one |
| `PIPAYA_RESTRICT_WORKSPACE` | Off | At `1`, session `cwd`, the folder picker, the default folder and the terminal start folder are restricted to the workspace. **It does not block the agent tools' file access** → [[security]] |

## Models

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_PROVIDER` / `PIPAYA_MODEL` | The first configured model | Startup default model. Must be a registered provider and model, and **a stored default takes priority** |

## Agent and tools

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_APPROVAL` | `ask` | Default approval policy. `ask` / `auto` / `readonly`. Any other value stops the server from starting. `readonly` is not chosen in the app and is API-only |
| `PIPAYA_APPROVAL_TIMEOUT_MS` | `600000` | Approval auto-deny time (ms). `0` is unlimited |
| `PIPAYA_MAX_RUN_TURNS` | `200` | Maximum model calls per run. 200 if 0 or less, or not a number |
| `PIPAYA_BASH_ENV` | None | Comma-separated list of environment variable **names** to pass additionally to `bash` child processes. Names starting with `PIPAYA_` are ignored |
| `PIPAYA_TERMINAL` | On | At `0`, turns off the server terminal feature (`403 terminals_disabled`) |

`PIPAYA_*` variables are not passed to the child processes of `bash` and terminals.

## Network

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_CORS_ORIGINS` | None | Additional browser origins to allow (comma-separated, exact match, `*` for all). Loopback, Tailscale, private networks (RFC1918), `*.ts.net` and Tauri origins are always allowed |

## Notifications

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_PUSH_FCM` | On | At `0`, turns off mobile push. Even when on, it works only if Firebase credentials **exist** |
| `GOOGLE_APPLICATION_CREDENTIALS` | None | Path to the FCM service account file. If absent, `~/.secrets/pipaya/firebase-adminsdk.json` |

## Updates and extensions

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_SELF_UPDATE` | Auto-detected | `1` assumes a supervisor exists and forces it on, `0` turns it off. Auto-detection checks for systemd (`INVOCATION_ID`) or launchd (`XPC_SERVICE_NAME`) → [[updates]] |
| `PIPAYA_FLAG_<name>` | | A server extension's flag value. The extension reads it with `pi.getFlag("name")` → [[server-extensions]] |
| `PIPAYA_BUILTIN_SKILLS` | The server's `builtin-skills/` | Overrides the location of the built-in skills folder |

## Install script (`install.sh`)

Variables read by `install.sh`, not by the server process.

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_REPO` | `https://github.com/dohwi/pipaya.git` | Repository to download |
| `PIPAYA_RELEASE_URL` | `https://github.com/dohwi/pipaya/releases/download/latest` | Client release location |
| `PIPAYA_BUN_VERSION` | `1.3.14` | Bun version to install |
| `PIPAYA_APP_DIR` | `~/.local/share/pipaya` | Install location |
| `PIPAYA_DATA_DIR` | `~/.pipaya` | Data directory |

The options (`--host`, `--port`, `--approval`, `--ref`, `--dir`, `--no-service`, `-y`) are in [[installation]]. The config file `server.env` that `install.sh` uses records the values you chose, such as `PIPAYA_HOST`, `PIPAYA_PORT` and `PIPAYA_APPROVAL`.

## Docker (`compose.yaml`)

| Variable | Default | Description |
|---|---|---|
| `PIPAYA_BIND` | `127.0.0.1` | Address to open on the host |
| `PIPAYA_PORT` | `8787` | Host port (8787 inside the container) |
| `PIPAYA_WORKSPACE_DIR` | Docker volume | Host folder to give the agent |
| `PIPAYA_APPROVAL` | `ask` | Approval policy |
| `PIPAYA_TOKEN` | Empty (auto-generated) | Token |
| `PIPAYA_CORS_ORIGINS` | Empty | Additional origins |
| `PIPAYA_MEM_LIMIT` | `2g` | Memory limit |
| `PIPAYA_CPUS` | `2` | CPU limit |

Fixed values inside the image: `PIPAYA_HOST=0.0.0.0`, `PIPAYA_PORT=8787`, `PIPAYA_DATA_DIR=/data`, `PIPAYA_WORKSPACE=/workspace`.

## Client (development)

| Command | Description |
|---|---|
| `bun run dev` | Development server (default port 1420) |
| `?extensions=off` on the app address | Stops running all client extensions (safe mode) |

## Summary of how to read it

```ini
# example ~/.config/pipaya/server.env
PIPAYA_HOST=100.x.y.z
PIPAYA_PORT=8787
PIPAYA_APPROVAL=ask
PIPAYA_APPROVAL_TIMEOUT_MS=600000
PIPAYA_CORS_ORIGINS=https://my-client.example
PIPAYA_RESTRICT_WORKSPACE=1
PIPAYA_TERMINAL=0
```

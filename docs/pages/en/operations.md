This page covers management tasks after the server is running: service management, data locations, backup, cleanup and monitoring.

## Service management

### Linux (systemd user service)

`install.sh` creates `~/.config/systemd/user/pipaya.service`.

```bash
systemctl --user status pipaya
systemctl --user restart pipaya
systemctl --user stop pipaya        # if you stop it explicitly, it stays stopped
journalctl --user -u pipaya -f      # view logs
```

- `Restart=always`, `RestartSec=3`: if it dies or exits, it starts again after 3 seconds. Only `systemctl stop` keeps it stopped.
- The config file is `~/.config/pipaya/server.env`, which the service reads as `EnvironmentFile`. After changing values, run `systemctl --user restart pipaya`.
- By default a user service stops when you log out and does not start at boot. The script tries `loginctl enable-linger`, and if that fails it tells you to run `sudo loginctl enable-linger $USER`.

### macOS (launchd)

The service name is `app.pipaya.server`. Restart with `launchctl kickstart -k gui/$(id -u)/app.pipaya.server`.

### Common

```bash
install.sh status      # calls /health to check whether it is running
```

### Running directly

```bash
cd ~/.local/share/pipaya/server
set -a && . ~/.config/pipaya/server.env && set +a
bun src/index.ts
```

On `SIGINT`/`SIGTERM` the server cleans up and exits, and forces an exit if it does not finish within 10 seconds.

## What happens at startup

1. Prepares the data directory (`0700`) and the SQLite DB (`0600` if newly created) and applies migrations
2. Checks or creates the token file (`0600`)
3. Loads server extensions
4. Synchronizes each model connection's model list with the upstream in the background
5. Starts file watching (`~/.agents`, and `.agents` and `.pi` in each working directory)
6. Schedules automatic cleanup (once 30 seconds after start, then every hour) and event-log cleanup (every 6 hours, deleting entries older than 7 days)
7. If a system model is set, fills in titles and purposes in the background for existing sessions that lack them

## Data locations

```text
~/.pipaya/                      # PIPAYA_DATA_DIR (0700)
├── pipaya.db                   # sessions, messages, events, settings, credentials (0600 for a new DB)
├── pipaya.db-wal               # managed by SQLite
├── pipaya.db-shm
├── token                       # admin token (0600)
├── locales/                    # language packs (0700)
├── extensions/                 # server extensions
└── workspace/                  # default working folder (PIPAYA_WORKSPACE)
```

| Location | Content |
|---|---|
| `~/.agents/` | Global `AGENTS.md`, `skills/`, `templates/`, `subagents/`, `extensions/` (the home of the server user) |
| `<project>/.agents/`, `.pi/` | Project skills, templates and sub-agents |
| `<working folder>/.pipaya/uploads/` | Attachments uploaded by the user |
| `~/.config/pipaya/server.env` | Environment variable file made by the install script |
| `~/.local/share/pipaya/` | Installed server code (`install.sh`) |
| `~/.secrets/pipaya/firebase-adminsdk.json` | Firebase credentials for mobile push (optional) |

In Docker, `/data` (data) and `/workspace` (working folder) are volumes.

> [!NOTE]
> The old `server/data` folder is not imported automatically. To keep using it, set `PIPAYA_DATA_DIR=./data`.

## Backup and restore

| Target | Method |
|---|---|
| All data | The `~/.pipaya/` folder |
| Code | Not needed. Download again with the install script |
| Settings (`server.env`) | `~/.config/pipaya/server.env` |
| User instructions | `~/.agents/` |

> [!WARNING]
> **Do not copy only `pipaya.db` while it is running.** SQLite is in WAL mode, so the `-wal` and `-shm` files may hold content not yet applied. Copy after stopping the service, or use SQLite's backup feature. A backup **contains API keys and tokens**, so store it carefully.

```bash
systemctl --user stop pipaya
tar czf pipaya-backup-$(date +%F).tgz -C ~ .pipaya .agents
systemctl --user start pipaya
```

To restore, stop the service, put the files back and start it. The app-side backup (server connections, extensions, shortcuts) is the **Backup** tab in [[settings]].

## Cleaning up

| Target | Method |
|---|---|
| Old chats | **Automatic deletion** or bulk delete under Settings → Server → Chats → [[sessions]] |
| Event log | Automatic (7 days) |
| Uploaded files | Not deleted automatically. Clean up `.pipaya/uploads/` in the working folder yourself |
| Chat history | Deleting a session also deletes its messages, events and compaction records |

## Monitoring

| Check | Method |
|---|---|
| Is it alive | `GET /health` — `ok`, `version`, `protocol` and `minClientProtocol` even without a token |
| Load | `GET /health` with a token additionally returns uptime, running session count and subscriber count |
| Running work | `GET /activity` — per-session running and waiting for approval |
| Event stream | `GET /events` (SSE) → [[events]] |
| Extension errors | `GET /server-extensions/errors` |
| Log level | `PIPAYA_LOG_LEVEL` (`silent` turns it off). `?token=` is masked in logs |

The Docker container has a health check that calls `/health` every 30 seconds (15-second start grace, 3 retries).

## Environment variables

The full list is in [[env]]. The config file differs by installation method.

| Installation | Config location |
|---|---|
| Script | `~/.config/pipaya/server.env` |
| Manual run | `.env` in the server's working directory (read by Bun) |
| Docker | `.env` next to `compose.yaml` |

## Uninstall

```bash
install.sh uninstall     # remove the service and code (data is kept)
rm -rf ~/.pipaya         # to erase the data too. Cannot be undone
```

For Docker, `docker compose down`; to delete volumes too, `docker compose down -v`.

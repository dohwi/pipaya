Look up causes and fixes by symptom. Checking `GET /health` and the server log first narrows most problems.

## First checks

```bash
curl http://<server address>:8787/health                  # is the server up
TOKEN="$(< ~/.pipaya/token)"
curl -H "Authorization: Bearer $TOKEN" http://<server address>:8787/activity   # is the token right
journalctl --user -u pipaya -n 100                    # recent logs (Linux)
```

## Connection

| Symptom | Cause and fix |
|---|---|
| The app cannot connect to the server | Check the address and port. The script's default listen address is the Tailscale IP or `127.0.0.1`. To use it from other devices, give the Tailscale IP to `--host` |
| `Not connected` is shown | The server is off or there is a network problem. `install.sh status` or `/health` |
| `Token rejected` / `401` | The token is wrong. Check again with `cat ~/.pipaya/token`. If the device was revoked, connect again with QR |
| `App update needed` / `426 client_too_old` | The app is older than the server. Update the app → [[updates]] |
| `403 admin_only` | An admin-only path was called with a device token from a QR connection. Use the admin token |
| CORS error in the browser | Add the web client's address to `PIPAYA_CORS_ORIGINS` |
| Token exposure warning over the internet | It is an `http` address. Use a Tailscale address or `https` |
| QR scan says `expired or already used` | A code is valid for 2 minutes and one use. Create a **new QR** on the PC |
| Connected by QR but the phone cannot reach the server | The address is `localhost`. Change it to a Tailscale or LAN address and create it again |
| `429` (connection code) | Too many wrong codes tried. Try again in 1 minute |
| Port in use | Find a free port with `ss -ltn` and set `--port` or `PIPAYA_PORT` |

## Models

| Symptom | Cause and fix |
|---|---|
| Typing works but there is no model, and the "Connect a model" button shows | No model is connected → [[models]] |
| Cannot connect to a local model | `localhost` in the address means the **server machine**. In Docker, use `host.docker.internal` |
| The connection test gives `401`/`403` | The key is wrong or expired. Save the key again |
| Deleting a model/provider gives `409` | The default or a session is using it. Switch to another model, then delete |
| A model ID is `available: false` | It disappeared from the upstream model list. Refresh the connection or choose another model |
| Compaction model warning "connection has no key so compaction fails" | Put a key in that connection or choose another model |
| Sub-agent model warning | Same |
| Reasoning strength has no effect | That model does not support reasoning |
| The title stays "New session" | If the system model is off, it is the first 60 characters of the first message. Set it in [[models]] |

## Chats and tools

| Symptom | Cause and fix |
|---|---|
| A message gets `409 session is busy` | `prompt` was sent to a running session. Send as `steer` or `follow_up` (the input box does this automatically) |
| A message gets `409` while compacting | Wait until compaction ends. Cancel with the stop button |
| The agent says "Stopped after 200 model calls" | The per-run model call limit. Send a message to continue. The limit is `PIPAYA_MAX_RUN_TURNS` |
| It stopped after repeating the same action | 6 identical tool calls in a row were detected. Change the request and try again |
| No approval card appears and it is stuck | Approval may be waiting in another pane (split screen) or on another device. Check the waiting-for-approval marker in the sidebar |
| Approval was denied automatically | 10 minutes without response. Adjust `PIPAYA_APPROVAL_TIMEOUT_MS` |
| `"write" is disabled: this session is read-only` | The session policy is `readonly`. Change `approval` through the API |
| `ask_user is turned off in the settings` | **Allow questions** under Settings → General is off |
| Tool output is cut off midway | Output is capped at 50KB and `read` at 2,000 lines. Read in parts with `offset` and `limit` |
| `bash` timed out | 120 seconds by default (up to 1800). For long jobs raise `timeout` or run it in the background |
| An environment variable is not visible in `bash` | Variables outside the allow list are not passed. Allow with `PIPAYA_BASH_ENV=NAME` |
| `edit` says "oldText was not found" | Whitespace or line breaks differ. Retry with the exact text |
| `edit` says "matches more than once" | Include more surrounding lines to make it unique |

## Input box and attachments

| Symptom | Cause and fix |
|---|---|
| A screenshot went in as a file, not an image | The selected model cannot see images (no vision) → [[composer]] |
| The 9th image does not attach | 8 per message |
| An attachment gives `413 too_large` | Over 50MB per file, 100MB total, or 192MB request |
| No files in the `#` menu | Excluded folder, 5-second cache, 20,000-entry index limit |
| The `@` menu is empty | There is no other active session with a name |
| `/xxx` is not sent | Unknown commands are not sent to the model. Type `/` to see the list |
| A large PNG's background turned black | Files of 600KB or more are converted to JPEG |

## Context and compaction

| Symptom | Cause and fix |
|---|---|
| Compaction gives `409` | The chat is running, its history is short, or it is waiting for approval or an answer |
| Compaction gives `502` | The summary model call failed. Check the compaction model and key |
| Compaction gives `501` | This server does not support compaction. Update the server |
| The context display is `—` | Just compacted, not measured yet. Updates after the next response |
| An `AGENTS.md` edit did not take effect | It is fixed at the session's first run. Check in a **new chat** → [[agents-md]] |
| A skill is on but the model does not use it | The `description` is vague. Say specifically "when to use it" → [[skills]] |
| A skill does not show in the list | Name rule violation or `SKILL.md` format error. Check the warnings at the top of the skills window |

## Session collaboration

See the troubleshooting table in [[orchestration]]. The most common causes are the **10-call `peer_send` limit** and **editing the same folder at once**.

## Terminals

| Symptom | Cause and fix |
|---|---|
| Creating a terminal gives `403 terminals_disabled` | The server has `PIPAYA_TERMINAL=0` |
| `409` | The terminal count hit the limit of 16 per server |
| Terminals vanished after a server restart | Terminals live only in memory |
| Input looks odd on Windows | Windows uses pipes, not a PTY. The client echoes the input |

## Notifications

| Symptom | Cause and fix |
|---|---|
| No notification arrives | Nothing is sent while you are looking at the app window. Check **System notifications** under Settings → General and test each leg with **Test notification** |
| No push on the phone | The server has no FCM credentials, or the app could not register a push token → [[notifications]] |
| A notification went to the PC but also arrives on the phone | Intended: if it is not read on the PC, it escalates to the phone |

## Server operation

| Symptom | Cause and fix |
|---|---|
| Cannot update the server | Check `reason` in the response (`disabled`, `not_git`, `unmanaged`, `detached`, `fetch_failed`) → [[updates]] |
| Update gives `409 sessions_running` | A chat is running. Do it after it ends, or use `force` |
| Update gives `502 update_failed` | Dependency installation failed. It was restored to the previous version. Check the network |
| The service stops when I log out | `sudo loginctl enable-linger $USER` |
| A server extension does not work | `POST /server-extensions/reload`, then `GET /server-extensions/errors` |
| Suspected DB lock or corruption | Check whether the DB file was copied while running. Stop the service and restore from a backup |
| The disk fills quickly | Attachments in `.pipaya/uploads/` and old chats. Turn on automatic deletion and clean up the upload folder → [[operations]] |

## Extensions

| Symptom | Cause and fix |
|---|---|
| The app acts strangely right after starting | An extension may be the cause. Add `?extensions=off` to the app address, or use the safe mode under Settings → Extensions → [[client-extensions]] |
| Cannot turn an extension on | Safe mode is on or the package has a problem. Turn safe mode off and check |
| Import failed | The package is over 256KB or has an unknown field. Check `path: reason` in the error message |

If it is still unresolved, report it in the [repository issues](https://github.com/dohwi/pipaya/issues) with the server version (`version` from `/health`), the app type, and the steps to reproduce.

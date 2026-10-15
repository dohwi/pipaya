# Where a setting lives: the server or the device

A client is only a window onto the server it is connected to. Two rules decide where anything is stored:

- **Server scope**: it is part of *that server's* work. Every client connected to the server sees the same value, live. Switching from server A to server B shows B's value.
- **Device scope**: it is how *this device* looks and behaves. It never leaves the device and does not change when you switch server.

When you add a setting, decide its scope first and add it to the table.

| Setting | Scope | Stored in |
|---|---|---|
| Sessions, groups, working directories | server | server database (already) |
| Model connections, default model | server | server database (already) |
| Notification rules | server | server database (already) |
| **Unread-on-PC wait before the phone is pushed** | server (the server acts on it) | `client_settings.notificationPolicy` |
| Skills on/off | server | server (already) |
| Extension settings (`/extensions/:id/settings`) | server | server files (already) |
| **Installed extension packages** (server extensions) | server | `client_settings.extensions` |
| **Extensions installed on this device** (device extensions) | device | `localStorage` `pipaya.extensions.device.v1`; never sent to a server, kept when the open server changes |
| **Starred models** | server | `client_settings.favModels` |
| Which installed extensions are switched on, and the consent given to them | device | `localStorage` (consent must come from the person using that device) |
| Server list and access tokens | device | `localStorage` (a token is never sent to a server) |
| Theme, language | device | `localStorage` |
| Shortcuts | device | `localStorage` |
| Sound on/off and volume | device | `localStorage` |
| Sidebar width, collapsed state, folded folders | device | `localStorage` |
| Draft, last open session, working directory choice | device | `localStorage` |
| Notification on/off, device id, push token | device (the push token is registered with the server it belongs to) | `localStorage` |

## How server-scope settings sync

`GET /client-settings`, `GET|PUT /client-settings/:key`; only keys in `SERVER_SCOPED_KEYS` (`server/src/client-settings.ts`) are accepted, so a device preference cannot end up on the server by mistake.

- **Upload**: a client uploads ~0.4 s after an edit (debounced) with the time the user made it (`at`).
- **Live**: the server publishes `client_settings_updated` on the event stream, so other clients refetch at once. There is no polling. The event carries the writer's `origin` device id so that device ignores its own echo.
- **Conflicts**: last write wins per key, by `at`. A write older than what is stored is refused (`applied: false`) and the response carries the stored value, which the client adopts. A device clock in the future is capped to the server's time.
- **Offline**: an edit that could not be uploaded stays marked on the device, survives a restart, and is sent on the next connect unless someone else changed it later.
- **First contact**: when a server has no value yet, what the device already had becomes the server's value. Nothing is lost on upgrade: the old single list of starred models and installed extensions is moved to the first server opened after the update.
- **The settings file (Settings → Backup) is the device's.** It carries the server list (names and addresses, never tokens), the extensions installed on this device, app settings and the shortcuts changed from the default. Server extensions are not in it: the server has them, and a device that connects to it gets them there. Extensions from a file come back as device extensions, switched off (one that already exists keeps its place). Shortcuts are the user's own, so an extension asking for the settings through the SDK never receives them.
- **Two kinds of extension.** A *server extension* belongs to the open server: it is in that server's list, every device sees it, and switching server swaps the list. A *device extension* is installed only on this device and stays whichever server is open; the server list never adds, replaces or removes it. When importing you choose where it goes (a replacement stays where it is). The same id cannot be both: the device one wins and the server's copy is kept as an unreadable entry.
- **Extensions arrive switched off** on a device that did not install them. Activation is a decision for each device, because it runs code and grants permissions.

Client engine: `client/src/lib/server-settings.ts`.

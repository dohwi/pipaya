This page lists the items on the settings screen and **where each value is stored**. pipaya's settings are split into those that stay on the device and those stored on the server and shared by every device.

## Where things are stored

| Location | Nature | Examples |
|---|---|---|
| **Device** (localStorage) | Preferences of this device only | Theme, shortcuts, notification sounds, sidebar, server list and tokens, temporary drafts, favorite models |
| **Server** (SQLite) | Shared by every device connected to the server | Model connections and defaults, default folder, approval policy, compaction, sub-agents, skills on/off, groups, cleanup policy |
| **Client settings tied to a server** | Shared per server but managed by the client | Favorite models (`favModels`), installed extensions (`extensions`), notification policy (`notificationPolicy`) |

Client settings tied to a server are synchronized through `GET`/`PUT /client-settings/:key`. Only the latest value is applied (an older write returns `applied: false`), and each key has a size cap.

| Key | Cap |
|---|---|
| `favModels` | 100,000 characters |
| `extensions` | 13,500,000 characters (including extension code) |
| `notificationPolicy` | 1,000 characters |

## Settings screen layout

Settings are divided into two areas. The search box at the top searches settings and shortcuts together (`Search settings and shortcuts`).

![The settings screen. (1) pick a tab in the list on the left and (2) change values on the right. Below is a close-up of the **Tool approval** area](/assets/img/ui/en/settings.png)

### App settings (this device)

| Tab | Content |
|---|---|
| General | Language · theme · tool approval · questions · notification sounds · notifications · updates |
| Shortcuts | Assign and reset keys |
| Extensions | Client extensions installed on this device → [[client-extensions]] |
| Backup | Export and import settings |

### Server settings (the selected server)

| Tab | Content |
|---|---|
| Info | Edit server name, address and token, check the connection, server version |
| Default folder | Where new chats start on this server |
| Model connections | Add, edit and delete connections, defaults, compaction model → [[models]] |
| Agents | Sub-agents → [[subagents]] |
| Chats | Chat list, bulk delete, automatic deletion → [[sessions]] |
| Devices | Connected devices, QR connection → [[notifications]] |

You can register several servers; open settings with {{Mod+Comma}} and switch servers with the *Switch to next server* shortcut.

## General tab

| Item | Default | Stored | Description |
|---|---|---|---|
| Language | System | Device | Follow the system, or pick Korean or English (and any installed language packs) directly |
| Theme | System | Device | System / Light / Dark ({{Mod+Comma}} for settings; the light/dark switch shortcut has no default) |
| Tool approval | Confirm outside the project only | **Server** | `ask` ("Confirm only when modifying files outside the project folder or running commands that touch paths outside it") or `auto` ("Run everything without asking"). Applies to **new chats** started from now on |
| Allow questions | On | **Server** | When off, the agent proceeds on assumptions without `ask_user`. Applies to all chats |
| Notification sounds | On | Device | Play a sound on completion, confirmation needed and failure |
| Sound volume | 100 | Device | 0–200. It does not ring when the chat you are looking at finishes, and approval requests ring even if you are looking |
| System notifications | — | Device + server | → [[notifications]] |
| Check for new version at startup | — | Device | Check for updates when the app starts → [[updates]] |

> [!NOTE]
> **Tool approval** in settings is the server's default policy and does not change chats that already exist. To change it per session, use the *Change approval mode* shortcut or the session settings.

## Default folder

The working directory where new chats start. In the folder picker you can browse the server's folders and create new ones.

- A change is saved immediately and applies to new chats from then on.
- If the server has no stored value, it uses the setting from the first startup (`PIPAYA_WORKSPACE`). Clearing it with `null` restores that value.
- The input must be an **existing absolute path**.
- If the server has `PIPAYA_RESTRICT_WORKSPACE=1`, only paths inside the workspace are allowed.
- The picker shows only folders (hidden folders are an option) and lists at most 500 at a time.

You can also change the current chat's working directory with `/cd`.

## Shortcuts tab

![The Shortcuts tab](/assets/img/ui/en/settings-keys.png)

You can change or remove every shortcut. Defaults and rules are in [[shortcuts]].

- Assigning keys works by **recording**. The keys you press pile up on screen and you press the check button to save. {{Backspace}} undoes the last key, and when there is no key left to undo, it clears the shortcut. {{Escape}} cancels recording.
- After the modifier keys ({{Mod}} {{Alt}} {{Shift}}) you can add **up to 3 regular keys** (in the order pressed, like `Mod+B+V`). Going over shows a notice.
- If the combination is already used by another action, **you take it from that action** ("Took this shortcut from ○○").
- Only values changed from the default are saved (`pipaya.keys`).
- You can filter by name, description or key in the search box.

## Model connections tab

![The Model connections tab](/assets/img/ui/en/settings-models.png)

Handle adding, editing and deleting connections, the default, and the context compaction model in one place. Details are in [[models]], and compaction is in [[context]].

| Item | Description |
|---|---|
| Add connection | Built-in provider / local preset / manual entry |
| Default | The default model for new chats |
| Context compaction model | The model that writes the summary. If empty, "Use the session model as is" |
| Auto compaction | Compacts automatically when the context fills up |

If the compaction model's connection has no key, the warning "This model's connection has no key, so compaction will fail" appears.

## Agents tab

![The Agents tab](/assets/img/ui/en/settings-agent.png)

Add, edit, delete and enable or disable sub-agents. Up to 10, and you set name, description, model, reasoning strength, tools, max steps and extra instructions → [[subagents]].

## Chats tab

| Item | Description |
|---|---|
| Chat list | See all the server's chats by folder and select them (including closed ones). Refresh |
| Bulk delete | Select several and delete. Chats that are running or waiting for an answer are skipped |
| Automatic deletion | On/off, period (days), closed chats only. Shows how many are due for deletion now and the last cleanup record |

## Backup tab

![The Backup tab](/assets/img/ui/en/settings-backup.png)

Export and import settings as a single JSON file. Use it to move to another device or a freshly installed app.

### Export

| Item | Content |
|---|---|
| Server connections | **Name and address only.** Tokens are not included |
| Extensions on this device | Packages and non-sensitive settings of extensions installed only on this device. Extensions that live on the server are excluded |
| App settings | Theme, whether notification sounds are on, and volume |
| Shortcuts | Only those changed from the default |

Values that look like passwords or tokens are left out. However, secrets written directly into extension code or defaults cannot be filtered out, so check the file before sending it to anyone.

### Import

- The file can be **at most 4MiB** and must be JSON. Drag it in or click to pick it.
- Before importing it shows a **preview of what will change** (servers added, extensions installed, replaced or changed, none). If it matches current settings: "Nothing to change".
- An existing server is **found by address and only its name is matched**; the token is left as is.
- Extensions come in as extensions of this device, **all turned off**. Check their permissions and turn them on yourself.
- The state just before applying is backed up on this device, so you can cancel with **Undo**.

## Keys stored on the device

| localStorage key | Content |
|---|---|
| `pipaya.servers`, `pipaya.server`, `pipaya.conn` | Server list, selected server, connection info |
| `pipaya.active.<server>` | Chats that were open, per server |
| `pipaya.theme` | Theme |
| `pipaya.sound`, `pipaya.volume2` | Whether notification sounds are on, volume |
| `pipaya.keys` | Changed shortcuts |
| `pipaya.draft` | Text being written |
| `pipaya.sidebar`, `pipaya.sidebar.w` | Sidebar collapsed state, width |
| `pipaya.workdir.<server>` | Last working folder per server |
| `pipaya.fav.models.<server>` | Favorite models |
| `pipaya.folded`, `pipaya.dirOrder`, `pipaya.grouporder`, `pipaya.fullgroups` | Collapse, order, full mode |

> [!WARNING]
> The server token stays in plain text in this device's localStorage. Do not use it on a shared computer, and revoke devices you no longer use → [[notifications]].

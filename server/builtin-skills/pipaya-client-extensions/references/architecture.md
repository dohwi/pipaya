# Architecture and change guide

Where the client extension system (SDK v1) lives, how it runs, and what to touch when you change it. Paths are relative to the client root.

## Model

```
package JSON ─parsePackage─▶ ExtensionHost (host.svelte.ts, singleton `extensions`)
                                │ enable()
                                ▼
                     ExtensionRuntime (runtime.ts)
  app realm          ┌─────────────────────────────────────────┐
                     │ <iframe sandbox="allow-scripts"> (opaque)│
                     │   └ blob Worker: `sdk` injected, runs code│
                     └──────────────── MessagePort ─────────────┘
Worker ─rpc(method,args)─▶ runtime.receive ─▶ host.request()   (permission check here)
host ─execute(token,arg)─▶ Worker handler (command, action, panel event)
```

- Extension code never runs in the app realm: no network, DOM, token or Tauri API.
- An extension affects the screen only through validated data (manifest, theme, commands, view trees). Trusted host components render it.
- Every SDK call is permission-checked in `host.request()`, never in the Worker.

## Extension points

| Contribution | Made with | Where it shows | Limit | Source |
|---|---|---|---|---|
| Template command | package `commands[]` | `/` menu | 20 | `host.registerCommand`, `lib/commands.ts` |
| Code command | `sdk.commands.register` | `/` menu | 20 per extension | same |
| Composer action | `sdk.composer.registerAction` | button row under the composer | 10 | `Composer.svelte` |
| Panel | `sdk.ui.registerPanel` | launcher → modal `<dialog>` | 5 per extension | `extensions/ExtensionPanels.svelte` |
| Composer widget | panel with `placement:'composer'` | collapsible box above the composer | counts toward the 5 | `ExtensionPanels placement="composer"` |
| Navbar item | `sdk.navbar.set` | header right slot | 3, read-only nodes | `extensions/NavbarUsage.svelte`, `Header.svelte` |
| Status chip | `sdk.status.set` | `StatusLine` | 10, 120 chars | `StatusLine.svelte` |
| Theme | package `theme` | `:root` CSS variables | token whitelist | `host.applyThemes` |
| Toast | `sdk.notifications.show` | toast | 5 per 10 s, 300 chars | `HostAdapter.notify` |
| Server bridge | `sdk.server.*` | `Api.callServerExtension`, `store.emitServer` | `server` | `host.svelte.ts` `emitServer` |
| Entry card | `sdk.messages.*` | `EntryCard.svelte` in `MessageList` | `messages`, 20 | `messageRendererFor` |
| Header/footer slot | `sdk.slots.*` | `ExtensionSlot.svelte` (`Header`, `Pane`) | `slots`, 2 | `slots` |
| Pre-send filter | `sdk.composerFilter.*` | `Composer.svelte` submit | `composer-filter`, 2 s | `filterComposer` |
| Shortcut | `sdk.shortcuts.*` | `lib/actions.ts` `onShortcut` (after app shortcuts) | `shortcuts`, 10 | `shortcutFor` |
| Dialog | `sdk.dialog.*` | `ExtensionDialog.svelte` | `dialogs`, one at a time | `store.askExtension` |
| Session control | `sdk.session.*` | `HostAdapter.session` | `session`, 5 per 10 s | `limitSession` |
| Pane control | `sdk.panes.*` | `HostAdapter.panes` (`extensions/panes.ts`) | `panes`, 30 changes per 10 s | `limitPanes` |
| Tool renderer | `sdk.tools.registerRenderer` | `ToolCard.svelte` | `tools`, 20 | `rendererFor` |
| System notification | `sdk.notifications.send/status/register/remove` | OS, FCM | `system-notifications`, 5 server rules | [notifications.md](notifications.md) |
| Settings form | manifest `settings` | Settings > Extensions > detail page | 20 fields | `extensions/SettingsForm.svelte` |
| Approval | `sdk.configuration.*` | modal | one at a time | `extensions/ExtensionApproval.svelte`, `store.confirmExtension` |

Global limits: 50 extensions, 256 KiB package, 128 KiB code, 16,000-char settings JSON, 32,000-char storage, 100 log lines.

> Trusted UI (`ui-style`, `ui-components`) is the one place extension code runs in the app realm: `lib/extensions/{components,kit,style}.ts`, `extensions/ExtensionMount|ExtensionPart.svelte`, `host.installUi/mountsIn/replacementFor`. Details: [trusted-ui.md](trusted-ui.md). Cleanup by owner covers its styles, mounts, replacements and data.

## Code map

`src/lib/extensions/`

| File | Role |
|---|---|
| `schema.ts` | `parsePackage` (strict), `PERMISSIONS`, `THEME_TOKENS`, `resolveSettings`, `fillSettingDefaults` |
| `ui.ts` | node types, `UI_LIMITS`, `NODE_KEYS`, `parseView`, `parsePanelSpec`, `validateUIEvent` |
| `navbar.ts` | navbar item validation, `NAVBAR_NODE_TYPES` |
| `sdk.ts` | public types for extension authors (`ExtensionSDK`, ...) |
| `runtime.ts` | sandbox iframe + Worker source, heartbeat, message and time limits |
| `host.svelte.ts` | `ExtensionHost`: install, enable, cleanup, settings sync, `request()` dispatcher, panel/navbar/status state |
| `labels.ts` | `permissionLabels` (consent text per permission; the type forces one for each) |
| `http.ts` / `transport.ts` | `http` (GET JSON) / `http-write` |
| `configuration.ts` / `fingerprint.ts` | config export/import/backup/approval; canonical JSON + SHA-256 |
| `marketplace.ts` | catalog parsing and install (`DEFAULT_MARKETPLACE_URL`) |
| `panes.ts` | `paneAdapter` for `sdk.panes` |

`src/components/`: `Extensions.svelte` (Settings > Extensions tab) and `extensions/`: `ExtensionPanels` (launcher, panel modal, composer widgets), `ExtensionSurface` (draft values, event queue of 20), `ExtensionView` (recursive node renderer), `ExtensionGauge`, `ExtensionIcon`, `SettingsForm`, `PermissionList`, `ExtensionRow`, `ExtensionPage`, `InstalledDetail`, `ServerDetail`, `Marketplace`, `ImportDialogs`, `RemoveConfirm`, `UnreadableCard`, `ExtensionApproval`, `ExtensionDialog`, `EntryCard`, `ExtensionSlot`, `NavbarUsage`.

Wiring: `App.svelte` (`extensions.init(adapter)`), `Header.svelte`, `Composer.svelte`, `StatusLine.svelte`, `lib/commands.ts`, `lib/store.svelte.ts` (`extensions.emit`, `applyThemes`, `confirmExtension`), `Settings.svelte`, `Backup.svelte`, `lib/api.ts`.

Server: `server/src/extension-settings.ts`, `extension-settings-routes.ts`. The extension ID rule exists twice: client `schema.ts` `ID` and server `EXTENSION_ID_PATTERN`. Change both; a server test compares them.

Tests: `client/tests/extensions-*.test.ts`, `server/test/extension-settings.test.ts`.

## Lifecycle

1. `install(pkg, scope)`: `parsePackage`, add **disabled**. `scope` is `"server"` (default; the open server's list, synced) or `"device"` (this device only; untouched by server sync and `switchServer`). On an ID clash the device copy stays. With a settings schema, defaults are filled and a fresh install has `configured=false`.
2. `enable(id)`: check safe mode, `configRequired`, `settingsProblem` → `markBooting` → `start`.
3. `start(id)`: `cleanup` → bump generation → register template commands → `ExtensionRuntime.start` (5 s) → `state:'active'` → apply themes. Async steps check the generation (`current()`) so stale replies cannot reach a new instance.
4. On failure `failure()`: `enabled=false`, `state:'error'`, `cleanup`, toast.
5. `cleanup(id)` removes everything the owner registered: commands, actions, statuses, panels, navbar, subscriptions, HTTP, approvals. **A new contribution kind must be added here.** `disable`, `remove`, `setSafeMode` all go through it and never touch other extensions.
6. Durable notification rules are not removed by `cleanup` (they must outlive the app). They are revoked on disable, failure, safe mode, replace and delete; `notification-rules.ts` retries offline.

### localStorage keys

| Key | Holds |
|---|---|
| `pipaya.extensions.v1.<serverId>` | server-scope list (package, enabled, settings, configured) + raw unreadable entries |
| `pipaya.extensions.device.v1` (`.corrupt`) | device-scope list |
| `pipaya.extensions.safe`, `.booting`, `.kept`, `.v1.corrupt` | safe mode, IDs mid-start, settings kept on delete, corrupt backup |
| `pipaya.extension.storage.<id>` | `sdk.storage` |
| `pipaya.extensions.settings-source` | `local` stops mirroring server settings |
| `pipaya.extensions.configuration-backup(-at)`, `.background-grant.<id>` | import backup, background grant |

## Server API

| Request | Use |
|---|---|
| `GET /extensions/settings` | all settings `{settings:{[id]:object}}` |
| `PUT /extensions/:id/settings` | save (≤16,000 chars, ≤100 extensions) |
| `DELETE /extensions/:id` | delete settings |

Stored at `<dataDir>/extensions/<id>/settings.json`; saving emits SSE `extension_settings_updated`. The client reads with a 3 s timeout at start and falls back to its localStorage cache.

## Change checklists

Finish tests and docs in the same change.

**A. New SDK method**: `sdk.ts` type → `sdk` object in the `runtime.ts` Worker source → `case` in `host.request()` (first `this.require(id, permission)`, then validate arg count and types). If it registers something, release it in `cleanup()` and cap it with a constant. Large payloads: check the request size exceptions in `runtime.ts` (default 70,000 bytes). Test in `extensions-host.test.ts` (denied, bad args, cleanup); update the permission table in [sdk.md](sdk.md).

**B. New permission**: `PERMISSIONS` in `schema.ts` → `permissionLabels` in `labels.ts` → tests → [sdk.md](sdk.md). Never widen an existing permission. Old clients keep packages with unknown permissions as `unreadable` (not deleted); keep that.

**C. New UI node**: `ui.ts` (interface, `UINode` union, `NODE_KEYS`, `parseNode` case with length caps, `UI_LIMITS`) → `ExtensionView.svelte` (render + token-only styles; for interactive nodes extend `validateUIEvent`) → decide on `NAVBAR_NODE_TYPES` → `extensions-ui.test.ts` (valid, invalid, limits, duplicate IDs) → [ui.md](ui.md) tables.

**D. New contribution kind**: host state (`$state.raw`) + `cleanup()` + validator and limits + render component + placement in the app + permission + the table above.

**E. New manifest or package field**: allowed keys in `parsePackage` (unknown keys are rejected) → what `configuration.ts` exports → same-ID replace behaviour → [sdk.md](sdk.md).

**F. Settings screen**: safe mode and unreadable-entry cards are recovery paths; keep them reachable. Update the selectors in `scripts/check-extension*.cjs`.

## Invariants

1. Data only: no HTML, CSS, URLs, functions, class names or event attributes from an extension.
2. Validate on the host: reject unknown keys, cap lengths and counts, return fresh copies.
3. Check permissions on the host; consent text says exactly what becomes possible.
4. Never disable or touch other extensions. A reinstall starts disabled (exception: same-ID replace with no new permissions restarts at once).
5. Never hand credentials to an extension: server token, app localStorage, transcripts, tool args and results.
6. Keep recovery paths: safe mode, `?extensions=off`, boot-interruption detection, unreadable entries.
7. The app always shows the source (extension name) so an extension cannot pose as an app dialog. UI copy is Korean source strings through `t()`/`msg()` (`src/lib/i18n.ts`); add English to `src/lib/locales/en.ts` (`node scripts/extract-i18n.cjs` checks).

## Verify

```sh
cd client && bun run check && bun run test && bun run build
cd ../server && bun test test/extension-settings.test.ts
```

Browser QA: [sdk.md](sdk.md#verification). After a visible change, look at it on the dev server (`bun run dev`, `0.0.0.0:1420`) at 1280 and 390 px, dark and light.

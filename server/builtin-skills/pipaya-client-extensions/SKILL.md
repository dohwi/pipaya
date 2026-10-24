---
name: pipaya-client-extensions
description: Read before adding or changing anything in the pipaya client app (Svelte 5 + Tauri) that touches its extension system - SDK methods, permissions, manifest and package fields, declarative UI nodes (panels, forms, gauges, navbar items, composer widgets), the extension screens and their design, system notifications - or when writing a client extension package. Not for extensions that run inside the server (agent tools, hooks, model providers); use pipaya-server-extensions.
---

# Pipaya client extensions

Client extensions (SDK v1) run in a sandboxed Worker and can only send **validated data**; the host renders everything. The one exception is the opt-in **trusted UI** (`ui-style`, `ui-components`, see `references/trusted-ui.md`): CSS and Svelte components that run in the app itself, behind their own permissions and a danger notice. Server extensions are separate (`pipaya-server-extensions`); the `server` permission bridges the two.

The docs are in `references/` next to this file. Source paths in them (`src/lib/extensions/...`, `src/components/...`, `tests/...`, `examples/extensions/...`) are relative to the client root, the directory containing `src/lib/extensions/` (normally `<repo>/client`). If you cannot find it, ask the user instead of guessing.

| Task | Read |
|---|---|
| Any change to the app (always first) | `references/architecture.md` (code map, lifecycle, change checklists, invariants) |
| SDK method, permission, manifest or package field, settings, themes, language packs, HTTP | `references/sdk.md` |
| UI node, panel, form, event, or anything the user sees | `references/ui.md` |
| OS / mobile push, presence, durable notification rules | `references/notifications.md` |
| Styles, mounting components in the app, replacing built-in parts | `references/trusted-ui.md` |
| Writing a package only (no app change) | `references/sdk.md`, `references/ui.md`, and `examples/extensions/` |

## Rules that are easy to break

1. **Data only**, except the trusted UI. Without `ui-style` / `ui-components`, never accept HTML, CSS, URLs, class names, functions or event attributes from an extension. A new look is a new node or enum value.
2. **Validate on the host.** Strict parsers (`schema.ts`, `ui.ts`, `navbar.ts`): reject unknown keys, cap lengths and counts, return fresh copies. Check permissions first in `host.svelte.ts` `request()`, never in the Worker.
3. **Never widen a permission.** A new capability needs a new permission, a consent label in `labels.ts` `permissionLabels`, tests and docs.
4. **Clean up by owner** in `ExtensionHost.cleanup()`. Durable notification rules survive app teardown; revoke them on disable, replace, failure, safe mode and delete.
5. **Never touch other extensions** when one is imported, replaced or fails.
6. **Keep recovery paths**: safe mode, `?extensions=off`, boot-interruption detection, unreadable-entry cards.
7. **Show the source**: the app labels which extension a screen comes from.
8. **Design tokens only** (`src/app.css`). UI copy is Korean source strings through `t()`/`msg()` with English in `src/lib/locales/en.ts`.
9. **Modal `<dialog>` content is in the top layer**: popovers over it attach inside the open dialog, not `<body>`.

## Finish every change with

1. Tests next to the change: `tests/extensions-*.test.ts` (client), `test/extension-settings.test.ts` (server).
2. The matching table in `references/` updated in the same change; numbers come from code.
3. From the client root: `bun run check && bun run test && bun run build`.
4. Visible changes: `bun run dev` (`0.0.0.0:1420`), screenshots at 1280 and 390 px, dark and light. Say which surfaces you could not check.

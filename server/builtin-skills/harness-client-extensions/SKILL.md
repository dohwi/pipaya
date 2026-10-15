---
name: harness-client-extensions
description: Read this before adding or changing anything in the pipaya client app (Svelte 5 + Tauri) that touches its extension system - the extension SDK (permissions, sdk methods, manifest, packages), declarative UI nodes (panels, forms, gauges, navbar items, composer widgets), the extension screens (extension panel dialog, Settings > Extensions manager, import and approval modals) and their visual design - or when writing an extension package for the client. Not for the server's agent tools or model providers.
---

# Harness client extensions

The harness client has its own extension system (SDK v1). Extension code runs in a sandboxed Worker and can only send **validated data**; the host renders everything. It is separate from the server's agent tools and model providers.

The docs below are bundled with this skill, in `references/` next to this file. Read them with the `read` tool before you edit. Source paths inside them (`src/lib/extensions/...`, `src/components/...`, `tests/...`, `examples/extensions/...`) are relative to the client project root, the directory that contains `src/lib/extensions/` (normally `<repo>/client`). If you cannot find it from the working directory, ask the user where the client source is instead of guessing.

## Read first (always)

- `references/extension-architecture.md` - code map, lifecycle, extension points, **change checklists (section 6)**, invariants, known issues.

## Then what the task needs

| Task | Also read |
|---|---|
| OS/mobile push notifications, presence policy, durable event notification rules | `references/notifications.md` |
| New or changed SDK method, permission, manifest or package field | `references/extensions.md` |
| New or changed UI node, panel, form, event | `references/extension-ui.md` |
| Anything the user sees: extension panel, composer widget, navbar item, Settings > Extensions, import/approval modals | `references/extension-screen-design.md` (principles, tokens, per-node specs, screen recipes, checklist) |
| Writing an extension package only (no app change) | `references/extensions.md`, `references/extension-ui.md`, `references/extension-screen-design.md` section 7, and the client's `examples/extensions/` |

## Rules that are easy to break

1. **Data only.** Never accept HTML, CSS, URLs, class names, functions or event attributes from an extension. A new look means a new node or enum value, not a style hook.
2. **Validate on the host.** New fields go through the strict parsers (`schema.ts`, `ui.ts`, `navbar.ts`): reject unknown keys, cap lengths and counts, return fresh copies. Check permissions in `host.svelte.ts` `request()` first, never in the Worker.
3. **Never widen a permission silently.** A new capability needs a new permission, a user-facing label in `Extensions.svelte` `permissionLabels`, tests and docs.
4. **Clean up by owner.** Local registrations must be removed in `ExtensionHost.cleanup()`. Durable notification rules deliberately survive ordinary app teardown; revoke them on disable, replace, failure, safe mode and delete (see `references/notifications.md`).
5. **Never touch other extensions** when one is imported, replaced or fails.
6. **Keep recovery paths reachable:** safe mode, `?extensions=off`, boot-interruption detection, unreadable-entry cards.
7. **Show the source.** The app labels who provides an extension screen; keep that when polishing the UI.
8. **Use design tokens** from `src/app.css` (`--bg*`, `--text*`, `--radius*`, `--motion-*`, `--ease*`). No hard-coded colors, radii or durations. User-facing copy is Korean.
9. **Modal `<dialog>` content is in the top layer.** Anything that must float above it (popovers, tooltips) must be attached inside the open dialog, not `<body>`.

## Finish every change with

1. Tests next to the change: `tests/extensions-*.test.ts` (client) and `test/extension-settings.test.ts` (server) as relevant.
2. Docs updated in the same change: the matching table in the extension docs. Doc numbers come from code; if you change a limit, change the doc. In the harness repo the docs live in `client/docs/` - after editing them run `bun scripts/sync-builtin-skills.ts` in `server/` so this skill's copies follow.
3. From the client root: `bun run check`, `bun test tests`, `bun run build`.
4. For visible changes, look at it: `bun run dev` (binds `0.0.0.0:1420`), Playwright screenshots at 1280 and 390 px, dark and light. State which surfaces you could not check.

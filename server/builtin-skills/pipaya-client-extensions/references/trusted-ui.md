# Trusted UI: styles, mounted components, replaced parts

Two opt-in permissions let a package change the app itself. Both run **in the application realm**, not in the sandbox, so the consent dialog shows a danger notice for `ui-components` and the package only starts once the user enabled it on this device. Safe mode and `?extensions=off` turn all of it off.

| Permission | Package field | What it does |
|---|---|---|
| `ui-style` | `styles` (CSS, ≤64KB) | App-wide stylesheet. No `</style>`, no `@import`. |
| `ui-components` | `components` (name → Svelte 5 source, ≤20, ≤64KB each), `mounts`, `replaces` | Compiled by the app (`lib/extensions/components.ts`) and mounted like built-in components. |
| either | `assets` (file name → base64 `data:` URL, ≤40 files, ≤768KB total) | Design files: `image/png jpeg webp gif avif svg+xml`, `font/woff2 woff ttf otf`. |

A whole package is at most 1 MiB. A design pack is one package: `theme` for the tokens, `styles` for the rest, `assets` for its images and fonts, `components` for anything new.

## Styles
Target `[data-part="..."]` (`STYLE_PARTS` in `schema.ts`): `app, sidebar, sidebar.brand, sidebar.bottom, rail, header, header.title, tabbar, pane, messages, message.user, message.assistant, tool, welcome, sessions, composer, composer.box, composer.bar, statusline, toasts, palette, modal`. Internal class names are not a contract. The host raises each rule's specificity (`style.ts`), so a plain `[data-part="header"] { ... }` beats the app's scoped rules without `!important`. Override design tokens with `:root { --accent: ... }` (not raised). Files from `assets` are referenced as `asset("name")`, which becomes `url("data:...")`; naming a file the package does not carry is refused at install:

```css
@font-face { font-family: "Brand"; src: asset("brand.woff2") format("woff2"); }
:root { --font: "Brand", sans-serif; }
[data-part="sidebar.brand"] { background: asset("logo.svg") no-repeat left center / auto 20px; }
```

## Components
```json
{ "components": { "Chip": "<script>import { Icon, ext } from 'pipaya'; let { slot } = $props();</script><Icon name=\"bolt\" /> {ext.data?.text}" },
  "mounts": [{ "slot": "header.end", "component": "Chip", "order": 0 }],
  "replaces": { "composer.send": "Send" } }
```
- Imports allowed: `svelte`, `svelte/{transition,animate,easing,motion,store,reactivity,events,attachments}`, `./Name.svelte` (sibling component), and `pipaya`.
- `pipaya` exports (`kit.ts`): `ext` (`id`, `data`, `settings`, `language`, `dark`, `assets`; getters, read inside the component), `app`, `extensions`, `shortcuts` (with `register` and the reactive `currentShortcut(id)`), `t`, `tc`, `getPane`; components `Icon Button IconButton Badge Switch Pin StatusDot Modal ModalHeader Select Segmented Accordion Notice Markdown SearchField`; `ExtensionView` (draws declarative nodes); `motion` (`fadeIn fadeOut surfaceIn surfaceOut collapseIn collapseOut reduced`, the app's transitions).
- `shortcuts.register({id, label, combo?}, { down?, up? })` registers a keyboard shortcut and returns a function that removes it (released with the component when called during init or in an `$effect`). `up` makes it a hold. `combo` is optional: without it the shortcut starts unbound and the user gives it one in Settings > Shortcuts. Needs the `shortcuts` permission **in addition to** `ui-components`: a component could already listen to `window` keys, but only a registered shortcut is checked against the app's own (app wins), appears in Settings > Shortcuts with its owner, and stops on disable, safe mode, IME composition and shortcut recording. Handler argument, rules, the user's own combos and `up` reasons: [sdk.md](sdk.md#shortcuts-down-hold-up-and-the-users-own-combos). Do not listen to `window` keydown/keyup instead.
- `sdk.components.setData(json)` (≤256KB) from the extension's Worker code becomes `ext.data`. Keep fetching and secrets in the Worker (`code`); components draw.
- **Slots** (`UI_SLOTS`): `app.overlay header.start header.end header.below sidebar.top sidebar.bottom pane.top pane.bottom composer.top composer.toolbar composer.bottom message.user.after message.assistant.after extension.page.top`. Pane, message and composer slots receive `paneId` (messages also `item`, assistant `turn last live`).
- **Replaceable parts** (`UI_PARTS`): `header.title sidebar.brand pane.empty pane.welcome composer.send statusline message.user message.assistant extension.settings`. The component gets the part's props plus `fallback`, a snippet drawing the original (`{@render fallback()}`). The first installed extension wins.
- A component that throws is logged to the extension's log and dropped (mounts) or replaced by the original (parts); the app keeps running. It is not protection against hostile code.
- **Your own page**: `extension.settings` (part), `extension.page.top` (slot) and a settings field's `component` draw an extension's page in Settings. They are for the owner only; see "An extension's own page" below.

## An extension's own page (`extension.settings`, `extension.page.top`, a field's `component`)

Settings → Extensions shows one page per extension: a client extension's (`InstalledDetail`) and a server extension's (`ServerDetail`). An extension with `ui-components` can draw its own page, in three places that work for both kinds:

| Where | What it draws | Declared as |
|---|---|---|
| part `extension.settings` | the whole "확장 설정" section; `fallback` is the generic form | `replaces: { "extension.settings": "Page" }` |
| slot `extension.page.top` | a block above the page's sections (a live status card, a chart) | `mounts: [{ slot: "extension.page.top", component: "Top" }]` |
| a settings field's `component` | just that field instead of its default control | `settings: [{ "key": "level", "type": "number", "label": "Level", "component": "Slider" }]` |

**Only the owner may fill them.** The owner of a client extension's page is that extension; the owner of a server extension's page is the client extension it names in `pipaya.companion`. Another extension's `replaces`/`mounts` for these names are accepted by the package parser but never rendered (`OWNED_PAGE_NAMES` in `schema.ts`; `host.replacementFor(part, owners)`, `host.mountsIn(slot, owners)`, `host.fieldComponent(owners, name)` return nothing without the owner). They need the extension to be on, not in safe mode; otherwise, and when a component throws, the generic form is drawn. A server extension's page can be Svelte only on the server that is open in the app (the client half runs only there); another server's page gets the declarative panel and the generic form.

Props of `extension.settings` and `extension.page.top` (plus `fallback` for the part):

| Prop | |
|---|---|
| `id`, `extension` | the settings id, and the extension's name (a server extension) or id |
| `serverId` | the server the page belongs to (the settings window can show another than the open one); null for a client extension |
| `settings` | the stored settings, live (a value the extension writes appears without a reload) |
| `fields` | the declared fields, localized |
| `panel` | the validated declarative page of a server extension (`pi.ui.setPanel`), or null |
| `disabled` | a save or another task is running |
| `save(partial)` | changes only the named keys, through the form's own rules: declared fields only, never a `readonly` one, the result must validate. Resolves when stored, throws a user-facing error. The other stored keys stay as they are |
| `call(method, params)` | a server extension's registered method on `serverId` (`POST /server-extensions/:ext/methods/:name`); rejects for a method it did not register. For a client extension it rejects: use `sdk.server.call` in its code |

A field's component gets `{ field, value, onchange(next), disabled, settings, error, fallback }`: `onchange` edits the form draft (it is saved with the form's button, with the form's validation); `fallback` draws the default control. A `readonly` field's component gets `value` only. The package parser refuses a `component` that is not in `components`.

```json
{ "manifest": { "permissions": ["ui-components"], "settings": [{ "key": "level", "type": "number", "label": "Level", "min": 0, "max": 10, "component": "Slider" }] },
  "components": {
    "Slider": "<script>import { Icon } from 'pipaya'; let { field, value, onchange, disabled } = $props();</script><input type=\"range\" min={field.min} max={field.max} {value} {disabled} oninput={(e) => onchange(e.currentTarget.valueAsNumber)} /> {value}",
    "Status": "<script>let { settings, call, save } = $props();</script><button onclick={() => call('syncNow')}>Sync</button> {settings.lastRun}"
  },
  "mounts": [{ "slot": "extension.page.top", "component": "Status" }] }
```

### A server extension's own components (no companion)

A server extension may carry the same kind of components itself (`pipaya.components`, `pipaya.mounts`, `pipaya.replaces` in its package.json; see `pipaya-server-extensions`). They go through the same compiler and kit (`lib/extensions/own-ui.ts`, `own-ui.svelte.ts`) but with two differences: the reach is only `extension.page.top`, `extension.settings` and a field's `component` of that extension, and the consent is not a package install but a per-device agreement bound to the SHA-256 of the sources (`pipaya.extensions.own-ui`, `"<serverId>:<extension>"`). Changed sources ask again; safe mode runs none. They work on any saved server (the sources are read with that server's connection), unlike a companion, which runs only on the open one.

## Adding a slot or part
0. A name that must not be open to every extension (a place that belongs to one extension) also goes in `OWNED_PAGE_NAMES`, and its `ExtensionMount` / `ExtensionPart` gets an `owners` list.
1. Add the name to `UI_SLOTS` / `UI_PARTS` / `STYLE_PARTS` in `schema.ts` (`extensions-design.test.ts` checks that `STYLE_PARTS` and the app's `data-part` attributes match).
2. Place `<ExtensionMount slot="...">` or wrap the markup in `<ExtensionPart part="...">` (and a `data-part` attribute for CSS).
3. Document it here; names are a public contract, so never rename one.

## Tests
`tests/extensions-components.test.ts` (compiler, schema), `extensions-style.test.ts`, `extensions-host.test.ts` ("trusted UI"). Check in a browser: import a package through Settings → Extensions, enable it, confirm mounts, replacement, style and clean removal on disable.

## When to use which
- **Declarative nodes** (`ui.md`): the default. Sandboxed, validated, consistent. Use them for panels, forms and simple read-only items.
- **`ui-style`**: re-skin the existing app.
- **`ui-components`**: a look or behaviour the nodes cannot express (rings and popovers, a replaced send button, new toolbar controls). The cost is that it runs unsandboxed and needs the danger consent. A real example is `quota-monitor` 0.5: its worker polls with the sandboxed `http-write` and sends plain data through `sdk.components.setData`; `Gauge.svelte` and `Ring.svelte` only draw it.
- Keep secrets, polling and network in the Worker. Components should do no I/O, so one that only draws can be reviewed at a glance.

# Trusted UI: styles, mounted components, replaced parts

Two opt-in permissions let a package change the app itself. Both run **in the application realm**, not in the sandbox, so the consent dialog shows a danger notice for `ui-components` and the package only starts once the user enabled it on this device. Safe mode and `?extensions=off` turn all of it off.

| Permission | Package field | What it does |
|---|---|---|
| `ui-style` | `styles` (CSS, ≤64KB) | App-wide stylesheet. No `</style>`, no `@import`. |
| `ui-components` | `components` (name → Svelte 5 source, ≤20, ≤64KB each), `mounts`, `replaces` | Compiled by the app (`lib/extensions/components.ts`) and mounted like built-in components. |

## Styles
Target `[data-part="..."]` (`STYLE_PARTS` in `schema.ts`): `app, sidebar, sidebar.brand, sidebar.bottom, header, header.title, pane, messages, message.user, message.assistant, composer, composer.box, composer.bar, statusline`. Internal class names are not a contract. The host raises each rule's specificity (`style.ts`), so a plain `[data-part="header"] { ... }` beats the app's scoped rules without `!important`. Override design tokens with `:root { --accent: ... }` (not raised).

## Components
```json
{ "components": { "Chip": "<script>import { Icon, ext } from 'pipaya'; let { slot } = $props();</script><Icon name=\"bolt\" /> {ext.data?.text}" },
  "mounts": [{ "slot": "header.end", "component": "Chip", "order": 0 }],
  "replaces": { "composer.send": "Send" } }
```
- Imports allowed: `svelte`, `svelte/{transition,animate,easing,motion,store,reactivity,events,attachments}`, `./Name.svelte` (sibling component), and `pipaya`.
- `pipaya` exports (`kit.ts`): `ext` (`id`, `data`, `settings`, `language`, `dark`; getters, read inside the component), `app`, `extensions`, `t`, `tc`, `getPane`, and `Icon Button IconButton Badge Switch Pin StatusDot Gauge`.
- `sdk.components.setData(json)` (≤64KB) from the extension's Worker code becomes `ext.data`. Keep fetching and secrets in the Worker (`code`); components draw.
- **Slots** (`UI_SLOTS`): `app.overlay header.start header.end header.below sidebar.top sidebar.bottom pane.top pane.bottom composer.top composer.toolbar composer.bottom message.user.after message.assistant.after`. Pane, message and composer slots receive `paneId` (messages also `item`, assistant `turn last live`).
- **Replaceable parts** (`UI_PARTS`): `header.title sidebar.brand pane.empty pane.welcome composer.send statusline message.user message.assistant`. The component gets the part's props plus `fallback`, a snippet drawing the original (`{@render fallback()}`). The first installed extension wins.
- A component that throws is logged to the extension's log and dropped (mounts) or replaced by the original (parts); the app keeps running. It is not protection against hostile code.

## Adding a slot or part
1. Add the name to `UI_SLOTS` / `UI_PARTS` / `STYLE_PARTS` in `schema.ts`.
2. Place `<ExtensionMount slot="...">` or wrap the markup in `<ExtensionPart part="...">` (and a `data-part` attribute for CSS).
3. Document it here; names are a public contract, so never rename one.

## Tests
`tests/extensions-components.test.ts` (compiler, schema), `extensions-style.test.ts`, `extensions-host.test.ts` ("trusted UI"). Check in a browser: import a package through Settings → Extensions, enable it, confirm mounts, replacement, style and clean removal on disable.

## When to use which
- **Declarative nodes** (`ui.md`): the default. Sandboxed, validated, consistent. Use them for panels, forms and simple read-only items.
- **`ui-style`**: re-skin the existing app.
- **`ui-components`**: a look or behaviour the nodes cannot express (custom gauges, a replaced send button, new toolbar controls). The cost is that it runs unsandboxed and needs the danger consent. A real example is `quota-monitor` 0.5: its worker polls with the sandboxed `http-write` and sends plain data through `sdk.components.setData`; `Gauge.svelte` and `Ring.svelte` only draw it.
- Keep secrets, polling and network in the Worker. Components should do no I/O, so one that only draws can be reviewed at a glance.

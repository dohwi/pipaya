# Declarative UI and screen design

Extensions build screens by sending a JSON view tree; the host renders it with Svelte components, and the Worker keeps the state. Needs the `ui` permission. Types and validation: `src/lib/extensions/ui.ts`; public types: `src/lib/extensions/sdk.ts`.

## Surfaces

| Surface | Where | Container | Interactive | Component |
|---|---|---|---|---|
| Panel (`panel`) | launcher → modal | `<dialog>`, `min(size.width ?? 1000px,96vw)` × `min(size.height ?? 760px,90dvh)` | yes | `ExtensionPanels` |
| Composer widget (`composer`) | above the composer (hidden without a server) | `Accordion variant="box"`, max `min(40dvh,320px)` | yes | `ExtensionPanels placement="composer"` |
| Sidebar section (`sidebar`) | bottom of the sidebar | `Accordion variant="box"`, max `45vh` | yes | `ExtensionPanels placement="sidebar"` |
| Side dock (`side`) | right of the conversation area (narrow screens: over it) | `size.width ?? 360px`, user-resizable, tabs per panel | yes | `ExtensionDock` |
| Floating window (`floating`) | over the app, non-modal | `size` (default 380×320), `position` (corner, `center`, or `{x,y}`), draggable and resizable | yes | `ExtensionFloating` |
| Navbar item | header right slot | `min(40%,160px)` (≤600 px: `min(36%,132px)`) | no | `NavbarItems` |
| Status chip | under the composer | text | no | `StatusLine` |
| Composer action | under the composer | small button | click | `Composer` |
| Management | Settings > Extensions | list + detail page | yes | `Extensions.svelte`, `extensions/*` |
| Approval | app-wide | `<dialog>` | yes | `ExtensionApproval` |

The app always labels a panel with its extension's name (header; the owner line is skipped when it equals the panel title). This stops an extension from posing as an app dialog; keep it when polishing.

Limits per panel: 5 panels per extension, 200 nodes, depth 8, 60 KiB view, 50 children, 8 tabs, 50 options, table 100 rows × 8 columns, list 100 items. Every node has a unique `id` (`[a-z][a-z0-9-]`, ≤40); tab IDs are unique across the tree.

## Writing a panel

```js
let count = 0;
const view = () => ({
  type: 'stack', id: 'root', gap: 'medium', children: [
    { type: 'stat', id: 'count', label: 'Clicks', value: String(count) },
    { type: 'button', id: 'increment', label: 'Add', variant: 'primary' },
  ],
});

await sdk.ui.registerPanel({ id: 'counter', title: 'Counter', description: 'First UI extension', view: view() },
  async (event) => {
    if (event.type === 'action' && event.id === 'increment') { count++; await sdk.ui.update('counter', view()); }
  });
await sdk.ui.open('counter');
```

- Spec `{id, title, description?, placement?: 'panel'|'composer'|'sidebar'|'side'|'floating', size?: {width?, height?}, position?, view}`; a handler is required. `size` (px, width 200–2000, height 120–2000) is for `panel`, `side` (width only) and `floating`; `position` (`top-left`, `top-right`, `bottom-left`, `bottom-right`, `center`, or `{x, y}` px) only for `floating`. Sizes are clamped to the screen.
- `open`/`close` on a `side`/`floating` panel show and hide it (both start shown), on a `composer`/`sidebar` panel unfold and fold it (both start folded), on a `panel` open and close the modal.
- `place(id, {placement?, size?, position?})` moves a panel or changes its size and position at runtime. A new placement drops the old size/position unless given; a window the user dragged goes back to the asked place.
- `open` during start waits for activation and never steals the screen from another open extension panel.
- `update(id, view, {tone?})` replaces the whole view (no patches). `tone: 'danger'` turns the launcher badge red (`!`, extension name in the tooltip) and the panel tab red until the next update without it. Use it for errors instead of a status chip.
- `close(id)` closes but keeps the registration; `remove(id)` drops panel and handler. Other extensions' IDs are unreachable.

## Nodes

| Node | Main props | Use / avoid |
|---|---|---|
| `stack` | `children`, `direction?`, `gap?: small/medium/large` (6/12/20 px) | skeleton; horizontal wraps on small screens |
| `grid` | `children`, `columns?: 1/2/3` | same-kind cards; min column 9rem |
| `card` | `children`, `title?`, `description?` | a titled group; no cards in cards, no big tables inside |
| `tabs` | `items: {id,label,children}[]` | 2–8 peer views (keyboard ←/→/Home/End); not for ordered steps |
| `form` | `children`, `submitLabel`, `disabled?` | batch submit; label is a verb ("Insert draft"); no nesting |
| `text` | `text`, `size?: small/body/heading`, `tone?` | 1–2 headings per screen |
| `badge` | `text`, `tone?` | 1–2 words |
| `alert` | `text`, `title?`, `tone?` | results; `danger`/`warning` are `role=alert` |
| `stat` | `label`, `value`, `hint?` | key number, 3–4 per grid |
| `progress` | `label`, `value`, `max?` (100) | known-length work only |
| `code` | `text`, `language?` | escaped, no highlighting; ≤16,000 chars; scrolls |
| `divider` | none | sparingly |
| `icon` | `icon: {viewBox, paths}`, `size?`, `label?` | see [sdk.md](sdk.md#icon) |
| `table` | `columns: {id,label}[]`, `rows: {id,cells}[]`, `caption?` | comparison; ≤8 columns, short cells |
| `list` | `items: {id,title,description?,badge?}[]`, `emptyText?` | items are not clickable |
| `button` | `label`, `variant?: primary/secondary/danger`, `disabled?` | one `primary` per screen |
| `input` | `label`, `value?`, `inputType?: text/email/number`, `placeholder?` | label required |
| `textarea` | `label`, `value?`, `placeholder?`, `rows?` | |
| `select` | `label`, `value?`, `options: {value,label}[]` | |
| `checkbox` | `label`, `checked?` | |

Inputs also take `required?`, `disabled?`, `error?` (Worker-side validation message); input/textarea take `minLength?`, `maxLength?`. `tone`: `neutral/info/success/warning/danger`. No CSS props of any kind.

Navbar, slots, tool and entry renderers accept read-only nodes only: `stack`, `grid`, `text`, `badge`, `divider`, `progress`, `stat`, `icon`.

## Events

```ts
{ type: 'action', id: string }
{ type: 'change', id: string, value: string | boolean }
{ type: 'submit', id: string, values: Record<string, string | boolean> }
```

- `change` fires on commit, not per keystroke; select/checkbox fire at once.
- Form values are a local draft; `submit` sends all enabled fields. Switching tabs keeps the draft.
- Host and surface validate the target, type, options, length, required/email/number against the current view. No arbitrary IDs or extra fields.
- An update with the same ID, type and default keeps edits; a changed default resets that field. To force a reset use a new field ID or remove/register.
- During action/submit the surface locks its inputs and shows errors; `change` does not lock and is queued (≤20). Inputs survive failures.
- Closing a panel may drop the draft; persist with `storage` if needed. Disable, reinstall, safe mode and delete clean up UI and handlers; old callbacks cannot drive a re-registered panel.

## Design rules

The host owns the look: when an extension looks wrong, fix the renderer (`ExtensionView.svelte` etc.) once for all. A new look is a new node or enum value, never a CSS hook.

1. **Monochrome, contrast for emphasis.** `--accent` is near-white/black, not a hue. Color only means something (ok/warn/danger/info).
2. **One primary action per screen**; destructive ones are `danger` and confirmed, with focus on the safe choice.
3. **Design every state**: initial (what this screen does + first action), loading (`progress` or "loading…" text, buttons disabled), empty (`emptyText` saying how to fill it), success and failure (`alert`, inputs kept), disabled (reason as text nearby).
4. **Small screens first**: works at 320–390 px; sideways scrolling only for tables, code and the header slot.
5. **Motion only with meaning**: tokens `--motion-fast` 180 / `--motion-normal` 360 / `--motion-slow` 460 ms, eases `--ease`, `--ease-exit`, `--ease-std`; off under `prefers-reduced-motion`.
6. **No repetition**: show the source once, clearly.
7. **Tokens only** (`src/app.css` `:root`): surfaces `--bg`, `--bg-side`, `--bg-elev`, `--bg-hover`, `--bg-active`, `--bg-code` (by depth); `--border`, `--border-strong`; `--text`, `--text-dim`, `--text-faint`; `--ok`, `--warn`, `--danger` + `*-soft`, `--lv-low` (info); radii `--radius` 12 (cards), `--radius-panel` 16 (modals), `--radius-sm` 8 (controls), `--radius-pill` (buttons, chips); `--font`, `--mono` (code, IDs, numbers); `--shadow`, `--scrim`; safe areas `--sat/--sab/--sal/--sar`.
8. **Modal `<dialog>` content is in the top layer**: popovers and tooltips that float over it must be attached inside the open dialog, not `<body>` (a `ui-components` popover does the same).

Accessibility the host already provides: real labels, native controls, table semantics, tab keyboard, `aria-live`/`aria-invalid`/`aria-describedby` errors, modal focus trap with focus returned to the launcher, focusable scroll areas. Targets for changes: text contrast ≥4.5:1, touch targets ≥40 px on mobile, no text under 11 px. Inputs use 16 px text (prevents iOS zoom).

Known gaps (fix when touching these): in the light theme, tone text on its own tint is below 4.5:1 (info, success, warning, danger); permission lists use a green check for every permission, including risky ones; panel height is fixed, so short panels leave a large empty modal; on ≤640 px the panel is a floating card, not a bottom sheet like Settings.

## Recipes for extension authors

- **Dashboard**: `stack(large)` → `alert` (one-line status) → `grid(3)` of 3–4 `stat` → `tabs` (summary/detail) → `table`. Keep node IDs stable across updates.
- **Form**: `form` inside a `card(title, description)`; required fields first; `submitLabel` names the result; after submit show an `alert` and keep the values.
- **Always-on metric**: a `progress` or `stat` in the navbar. Need a custom look (rings, popovers)? Draw it yourself with `ui-components` ([trusted-ui.md](trusted-ui.md)); the core has no node for it on purpose.
- Panel title differs from the extension name; description is one sentence.
- Aim for ≤80 nodes per screen; the 200 / 100-row limits are ceilings, not targets.
- Treat form values as sensitive; do not log them.
- Express priority by content (titles, order, tone), not decorative badges and dividers.

## Tooling

`examples/extensions/ui-workbench.js` is a readable source; package it with:

```sh
node scripts/build-extension.cjs examples/extensions/ui-workbench.manifest.json \
  examples/extensions/ui-workbench.js examples/extensions/ui-workbench.json
```

The source is an async function body with `sdk` injected (not an ES module). The script checks syntax and size only; the client validates manifest, views and permissions. With TypeScript, import `ExtensionSDK`, `UIPanelSpec`, `UINode`, `UIEvent` type-only and emit a plain JS body. The example (`/workbench`) shows forms, tabs, stats, lists, tables, code, badges, alerts and a composer widget.

## Checklist for visible changes

- 1280 and 390 px (320 if possible) × dark and light, all four checked by eye.
- Loading, empty, success, failure and disabled states seen.
- Keyboard only: open → move → submit → close, focus returns to the launcher.
- Nothing that floats inside a modal is hidden (top layer).
- Tokens only; the source (extension name) still shows.
- Contrast, touch targets, ≥11 px text.
- This file and [sdk.md](sdk.md) updated in the same change.

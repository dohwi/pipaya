# Design system: spacing, grid and measuring

Source of truth for how the client is laid out. The values here are the ones the sidebar already uses
(`client/src/components/shell/Sidebar.svelte`, `shell/sidebar/*.svelte`); everything else is being moved onto the same rules.
Tokens live in `client/src/app.css` (`:root`); read it before adding a value.

> 한국어 요약은 맨 아래. The short, enforceable rules are in [`DESIGN.md`](../DESIGN.md) (read it first; `python3 scripts/ui-lint.py` checks them); this file has the reasons and the exact numbers.

## 1. One spacing scale

Use **4 / 8 / 12 / 16 / 24** (and 32+ for page-level gaps). Anything else needs a comment saying why.

| Step | Use |
|---|---|
| 4 | inside a control, between an icon and its label, a card's inner edge |
| 8 | between sibling rows or controls, the gap under a header |
| 12 | between blocks of a list, the padding of a search/tools strip |
| 16 | a panel's bottom edge, space around a section |
| 24 | the side gutter of the sidebar (left and right), a dialog's outer gutter (`--modal-gutter`) |

Allowed exceptions (write the reason next to the value):

- **1px** hairlines, the 1px between two rows (see 3), and borders. A 1px that exists only to nudge an icon onto a column is a bug: move the column instead.
- **Odd values that come from a measured alignment** (an icon's optical centre). Comment them with the column they serve.
- **Safe-area insets** (`var(--sat)`, `--sab`, `--sal`, `--sar`) are added on top of the scale, never replace it: `calc(8px + var(--sab))`.

Never mix 10 / 6 / 14 / 22 into new code. Audit history: 554 declarations in 119 files were off-scale; after the dialog and whole-app pass about 36 remain, all of them
deliberate (1px hairlines, `calc()` with safe areas, fractional optical centres) and commented. Moving a value onto the scale
needs a look at the element: 10 → 8 or 12, 6 → 4 or 8, 14 → 12 or 16 depends on what it spaces.

## 1b. Dialogs (one set of tokens)

Every dialog, sheet and settings page takes its edges from `app.css` tokens, so a field, a footer button and the close button
share one left and one right line. Never write a raw side padding in a dialog; use the token.

| Token | Value | Use |
|---|---|---|
| `--dlg-px` | 24 (16 on phones, `max-width: 640px`) | left / right padding of header, body, footer, search strip |
| `--dlg-gap` | 16 | between fields and sections in a body |
| `--dlg-gap-sm` | 8 | label to field, chips, buttons in a row |
| `--dlg-head-t` / `--dlg-head-b` | 16 / 12 | header top / bottom |
| `--dlg-body-t` / `--dlg-body-b` | 16 / 24 (16 on phones) | body top / bottom |
| `--dlg-foot-t` / `--dlg-foot-b` | 12 / 16 (+ `--sab`) | footer top / bottom |

- The close button is a 38px circle holding a 19px glyph (9.5px from its edge). The header's right padding is
  `calc(var(--dlg-px) - 10px)`, which puts the glyph on the body's right edge (measured: 24.5 vs 24, the 0.5px is the glyph's own rounding).
- A label above a field uses a whole-pixel line box (`line-height: 20px`, class `.lbl` in `app.css`): label 20 + gap 8 + field 40 = **68px**,
  so a form stacks on 16px steps. The body's `line-height: 1.55` would give 68.1 and drift.
- Search fields: icon at 12px from the left, 16px wide, text at 36px (`SearchField`, `ConnectModal`).
- A list of bordered cards (`SessionsPanel`): the card's 1px border sits inside the buttons' right edge (`margin: 0 -1px`), checkbox column x = 12 in the header and in every row.
- A header action row that can be too wide for a phone wraps (`flex-wrap`), it never overlaps the name (bulk buttons of the conversation list).

### Which control (toggle, choice, state)

- **On / off is a `Switch`** (in a `SettingRow`, a `ListItem` lead or a switch row). Never a chip or pill that stays pressed.
- **One of a few is `Segmented`** (`fill` for a mode, `cards` for a setting). A list of many is a picker (`PickerOption`).
- **A state or category you only read is a `Badge`** (`tone`: neutral, ok, warn, danger, accent, info; `--radius-xs` 4px rounded corners, not a round pill). No hand-made
  `.chip` / `.pill` / `.tag` spans with their own colours, no leading dot inside the badge (the tone already says it). Pass `title` directly on `<Badge>` instead of wrapping it in a bare `<span>`, which breaks flex centring.
- Chips that stay pressed are only for filters and multi-pick from a long list (`FilterChip`: quick folders, a role's tools).
  The settings server switcher is a `Segmented` plus an `IconButton` ("서버 추가"); there is no global `.chip` class any more. Toolbar toggles (mic, source view, a terminal modifier, favourite star) are icon
  buttons with `aria-pressed`, not chips.
- **Hybrid zero-shadow.** No `box-shadow` elevation on content, cards, rows, dim-backed modals (`Modal`, `Palette`, `NoServer`), toasts
  and notices, nor anywhere in dark mode: `--shadow`, `--shadow-soft`, `--shadow-sm`, `--shadow-up`, `--shadow-overlay` are all `none` there, and
  layers split by luminance steps (`--bg` #101012 → `--bg-side` #161619 → `--bg-elev` #1c1c21 → `--bg-active` #222227) plus crisp 1px borders
  (`--border` #2b2b30, `--border-strong` #3f3f46). The one exception is `--shadow-overlay` (a light-mode whisper) on a **non-modal** floating
  layer over content: `Select`, `RowMenu`, `SlashMenu`, `SendControls`, `FindBar`, `ExtensionFloating`, `SkillPicker`. A hairline `inset 0 0 0 1px` ring is not elevation.
  `ui-lint` flags `shadow` and `halo`.
- **Focus is an outline, never a halo.** `:focus-visible { outline: 2px solid var(--accent) }`; `outline-offset: 2px` on buttons and switches,
  `-1px` on a bordered input, select, textarea or row (the ring sits on the border: no double border, never clipped by a scrolling parent).
  `input/textarea/select` no longer reset `outline`. No `0 0 0 3px var(--accent-soft)`.
- **Disabled is explicit.** `--disabled-bg` / `--disabled-border` / `--disabled-fg` (dark #161619 / #26262d / #63636d, light #f5f5f7 / #e4e4e7 / #8f8f99).
  No blanket `opacity` on a `:disabled` / `.disabled` rule (`ui-lint` `disabled`): on dark it made controls vanish.
- **Hairline tinted groups, no box-in-box.** `.set-group`, `SessionsPanel .group`, and dialog-level `ListItem` / `EmptyState.card` surfaces are tinted groups with a subtle outer `1px solid var(--border)` hairline (`--radius-sm` 8px; light `#e4e4e7`, dark `#2b2b30`), and sidebars carry a `1px solid var(--border)` boundary hairline. Inside a bordered `.set-group`, `--item-bg` (`var(--bg)`) and `--item-border: transparent` keep inner rows/cards (`ListItem`, `EmptyState`, `ModelPage .capsw`, `ExtensionView` cards/lists) borderless or separated by `1px` dividers only — never a bordered card inside another bordered card. A selected row is a Hairline Inset Fill (`--bg-active` + 1px `--border-strong`, `--radius-xs`/6px); inactive siblings carry `1px solid transparent` so selecting never moves the layout.
- **Status is a Badge or a quieter name**, never a decorative leading dot (the settings nav's live state is a `Badge`, off is `--text-faint`).
- **Motion is restrained.** `--motion-fast/normal/slow` = 120 / 160 / 220ms, `--ease` calm ease-out; no `--ease-spring`, no idle shake, no expanding
  ping ring, no `box-shadow` in a `transition`. "Working" is a steady tinted border (`.glow-working`, no loop) and the logo / pin opacity breath.
  `ui-lint` flags `motion`.

### Shared dialog parts (use these, do not re-write the CSS)

- `DialogBody`: the scrolling body of a dialog (`--dlg-px` gutters, body top/bottom, rule under the header). Skills, commands, MCP and the context view (`SessionContext`) all use it.
- `DialogFooter`: the button row at the bottom of a dialog (`--dlg-px` gutters, `--dlg-foot-t` / `--dlg-foot-b`, `start` slot on the left, actions on the right; `rule`, `safe`, `compact`, `wrap`). Server form, folder picker, pickers, import and extension dialogs use it.
- `ListItem`: one card row (12px padding, 12px gap): optional leading `Switch`, title line (name + `Badge size="sm"`), body lines (`.meta`, `.desc`), trailing actions. The first row shares one centre line (22px with a switch, 34px with action buttons; actions drop below on a phone). Animate the keyed `<li>` around it (`animate:reflow in:rowIn out:rowOut`).
- `Notice`: the one boxed message. Flat by default (a tinted fill of its tone, no border). Add `raised` when it stands **on a tinted settings group** (`.set-group`): the fill is then an opaque mix of the tone over `--bg-lift` (one step above `--bg-set`, so the box reads as above the card, not painted on it), with a 1px ring of its own colour and `--shadow-soft`. The ring is a shadow, never a `border`, so the text keeps the flat notice's 12px inset and the box its height. A failed load that can be tried again passes `onretry` (a "다시 시도" link at the end) instead of writing the button.
- `FormField`: label (20px line) + 8px + control = 68px with a 40px field. `group` for a control that is not one input (`Segmented`).
- `StatusItem`: one item under the input (icon or mark + value + tooltip), a 21px box (19px in a narrow pane) with a 4px gap. A button when it has `onclick` (add `empty` when there is nothing to show, `level` for warn/danger).
  **Its marks are an even size: 12px (10px in a narrow pane), the context ring too.** A 13px mark centred on the 16px line
  sat on a half pixel, so its ink landed 1–2.6px off the value depending on the string (`2개` −2.6, `—` +2.6); an even mark
  keeps it on whole pixels and every item measures within 0.7px at 1x, 2x and 4x. Do not go back to an odd size, and do not
  nudge a mark with a margin.
- `EmptyState`: the one "nothing here" / "불러오는 중…" line in a list or panel (`card`, `plain`, `dashed`).
- Composer attachments: `ComposerStrip` (the sideways-scrolling row, 16px / 12px narrow gutters) and `RemoveBadge` (the 22px "x" hanging over an item's corner), shared by the image thumbnails and the file chips.
- `.sr-only` (`app.css`): text for a screen reader only.
- Check by measuring: every item in a row must have the same top, height and icon/text centre (`getBoundingClientRect`), at 1440, 820 and 390.

### Text inside badges and pills (measure the ink, not the box)

- A box can be centred and its text still look off: the fonts (Manrope, SUIT, JetBrains Mono) leave more room under the baseline than above. Measured at 8x on Hangul, Latin and digits, centred text sits **+1.0px low at 11px** (Badge, `.chip`), +0.66 at 12px, +0.3 at 13px, ~0 in mono.
- The composer (textarea, its mirror and hint) uses `--font-input`, a second Manrope face trimmed to ascent/descent 96.6% / 20% (1.166em, was 1.366em): Manrope's own metrics drew the text caret 22px at 16px, 2.5x a lowercase letter; now 18px, and the `#image`/`@name` highlights hug the text the same way. Keep ascent − descent at 76.6% so the text stays put. Do not move the override onto `--font`: Chromium rounds ascent and descent to whole pixels separately, so at 12, 18 and 28px every fixed line box shifted its text 1px.
- So `Badge` and `.chip` carry `padding: 0 8px 1px` (a 1px lift). A new badge or pill style gets its own measured value, never a guess.
- Dialogs sit on whole pixels (`Modal` places the panel by pixel offsets, not `top: 50%` + `translate`), otherwise a panel with the other parity than the window lands on x.5 and its badges are painted 0.5px higher than in the next dialog. Header title/subtitle have whole-pixel line boxes (28 / 18).
- A small label next to bigger text in a centred row (the `@name` handle and the parent mark beside a conversation title, the time on a graph card, a dialog title's sub line, a settings search hit's location) is aligned on the **centre line**, not the baseline: no nudge, just a whole-pixel line box (16px) centred by the row against the title's (20px). Measured on the Hangul ink, label centre − title centre is 0 at 1x and within ±0.5px at 1.5x / 2x. (It was lowered 1px onto the baseline in #135/#139; that left the handle's centre 1px below the title's.) Rows that put a small sub beside a big title use `align-items: center`, not `baseline` (the connection dialog's `연결 수정  fake` sat 2.5px low on the baseline).
- An icon beside a label in a flex row is centred by the row, not nudged: the queued row's sender icon once carried `top: -1px` from a 4x measurement and sat 1px high at 1x.
- Never add asymmetric vertical padding (`padding-bottom: 2px`) to text items inside an `align-items: center` flex row to lift lowercase x-height: it grows those text boxes (20 → 22px) and drops sibling icons/logos (`ModelLogo`, `IconButton`) 1px below Hangul and capitalised names (`2분 전 · ✦ Gemini 4 Neon`). Give the row a whole-pixel `line-height` (`16px` / `20px`) with zero asymmetric padding so every sibling shares one centre line; audit with `python3 scripts/ui-pairs.py --seed`.
- An extension's horizontal `stack` aligns its items on the baseline (badge included), so a status badge and the small text after it read as one line (measured: ink centres equal at 1440/820/390; `flex-start` left the text 4px high).
- The `@name` handle is one component, `Handle` (`text`, `state`), everywhere it appears (sidebar row, tab, group chip inside the group box, a row of the chats dialog; the split tab's title bar keeps its own bolder label): 11px
  `--fs-2xs`, weight 600, `--text-faint` while idle and the agent badge's state colour otherwise (working, asking, done, failed; badge and handle always match), on a 16px line box so it centres on the 28px tab / 22px chip and never inherits the body's 1.55.
  It sits between the agent badge and the title (4px gaps, the row's own), never after the title. It does not shrink (`flex: none`): a tab
  too narrow for both shows the handle whole and ellipsises the title, which is what the tab's `max-width: 220px` leaves room for.
  It also carries the activity colour (`working` `--info`, `asking` `--warn`, `done` `--ok`, `failed` `--danger`, idle `--text-faint`) in
  all four places, so a running conversation reads blue in the tab bar exactly as in the sidebar row; a group chip shows its own state even
  while its group is not the open tab.
  The graph view draws its own, larger name lines (a chat card's 14px name, a dialog row's 13px name) but the colour rule is the same: a
  chat's `@name` takes its state colour on the card, in the detail dialog's chat and call rows, and a running subagent card names its
  caller in `--info` on its live line. A subagent card is one role on one model (the same role on two models is two cards, stacked
  together, the model used last on top), so the line from a chat says which model its subagent ran on. 
  What is at rest steps back, one rule for every card (`quietCards`): an idle chat (not working, not asking, nothing new), a
  provider or model with only idle chats under it, a role that runs nothing and is called only by resting chats, a role's card on a
  model it moved off (not running, last call over an hour ago, a newer card of the same role exists; its dialog row adds when it was
  last used), and every card of an offline server. Such a card is at 60% and a line touching it at 40%; hovering or selecting it, or
  a card it belongs with, brings it back. An online server card never fades. Two or more servers are split by a 1px `--border`
  hairline in the 48px gap between them, not framed. A chat without a name shows its title in the body colour.
- Audit: render at `device_scale_factor` 4-8 with `scripts/ui-ink.py`, find the painted pixels inside each pill and compare their centre with the box centre; flag anything over 0.5px. Differences up to 0.5px represent the physical half-pixel grid limit of an odd-pixel glyph in an even-content box.

## 2. Vertical rhythm

| Thing | Value |
|---|---|
| Row height (list rows, tabs, headers, tree rows) | **32px** (**40px** in the sidebar on `pointer: coarse`: folder, server and tab rows; the 20px `+` / list buttons keep their columns and their touch boxes are 28px wide x 40px high, each grown 8px away from the other, so they touch but never overlap) |
| Compact control | `--control-h-sm` 34px; normal control `--control-h` 40px |
| Gap between two rows of one block | **1px** (the row's own `margin: 1px 0`) |
| Gap between blocks (a card's header and its first folder) | **4px** |
| Gap between folders in one card | **4px** between rows; **8px** after an open folder or project (4px `padding-bottom` on `.fold` + 4px `margin-top` on the next header, so toggling never shifts the clicked header) |
| Brand row | 44px + 1px hairline (matches the header capsule and the graph view's head) |
| Search strip | 12px above and below a 34px field |
| Gap under the strip before the first card | 8px |
| A card's inner bottom padding | 4px (+1px row margin + 1px border = 6px measured) |
| List bottom padding | 16px |

Do not give one kind of row a different height (the sidebar once had 28 / 30 / 32 mixed). If a row needs more room, the content
grows, not the row's declared height.

## 3. Horizontal grid (sidebar, 288px wide)

Columns are **centres**, measured from the sidebar's left edge. Neighbouring columns are **20px** apart.

```
 x=28     48        68                                   236      256    288
  │chevron │folder   │tab icon   … name (flexible) …       │list    │+ ⋯ ↺ │
  28       20        20                  168               20        32
```

| Column | x (centre) | Holds |
|---|---|---|
| chevron | 28 | fold arrows of the server and folder rows |
| folder icon | 48 | folder icon; the group chevron |
| tab icon | 68 | session logo, terminal, group icons |
| pane icon | 88 | members of a split tab (one step in, past the tree line) |
| list button | 236 | the conversation-list button of a server or folder |
| action | 256 | `+`, `⋯`, restore ↺ |

- **Projects** (`ProjectBlock`, `lib/projects.ts`): two or more folders of one git repository (its main checkout, worktrees, folders inside them) sit under a project header drawn like a folder row (chevron 28, box icon 48). Its folders hang one column in: chevron 48, branch icon 68, their tabs from 88 (a split tab's panes 108). The rows are named by branch, in mono, with the part below the working tree dim after it. A folder's menu also offers "프로젝트로 묶기…" (a picker: an existing project, or another folder to start one with) and "프로젝트에서 빼기"; a hand-made project (`sidebar.projects`, shared through the server) wins over the git grouping, keeps its folders' own labels, and its header menu renames or undoes it. Precedence: hand-made > git repository > plain folder.
- **Parent mark** (`parentLabel`, icon `fork` + `@parent`, read as "forked from"): a conversation another open session made (`peer create`, a fork) shows its maker after the title, a 12px fork icon then 11px mono `--text-faint`, centred like `.who`. It was the `↳` character once: none of the bundled fonts (JetBrains Mono, SUIT, Manrope) has it, so the browser drew it from a system fallback (Noto Sans Math on Linux), and any corner arrow reads as a Hangul `ㄴ` before a name (`ㄴ @영희`); the fork icon does not. It sits in the sidebar row (capped at 96px, it gives way first) and the tab bar.
- **Folders start folded** (`SidebarState.openDirs`): the tab bar lists the open folder's tabs, so the sidebar is a list of places. The chevron is its own button (opens the tab list); the rest of the row opens the folder. The open folder's row carries the selection marker while it is folded (`OPEN_ROW` in `Sidebar.svelte`). **A project's folders (its branches) start open** (`SidebarState.foldedProjectDirs` keeps the ones folded by hand): the project header already folds them all, so the tabs are one click away. The project menu offers "폴더 모두 펼치기 / 접기".
- The card stays **8px** from the sidebar edges and its content stands **12px** inside it (the card's padding, left and right alike), so the left gutter is 28 (edge → chevron centre) and the right gutter 32 (edge → action centre).
- Buttons in the right-hand columns are **20px** squares with **no margin**, so they sit edge to edge on the 20px grid. Server rows end where the card's content ends. A **tab row's highlight** (hover, open, drag) and a folded **folder or project row's** (open, drop) run **8px past** that edge (`margin-right: -8px` with `padding-right: 8px`), so its `⋯` / count / `+` stays on x 256 but sits 8px inside the highlight instead of touching it; every highlight in a block ends on the same edge. The drop line ends 16px before the row's edge for the same reason. **A pin is one component, `PinMark`**, set into its host icon's bottom-right corner so the pinned icon reads as one new icon: a 9px glyph slanted 35deg whose box ends 1px past a line icon's corner (`--pinmark-out: 1px`, icons in 3..21 of 24u) or 2px past a full-bleed brand logo's (`--pinmark-out: 2px`, logos in 1..23) so the ink sits on the same visual corner (whole pixels, crisp at 1x), with the icon knocked out in the mark's own outline, 0.9px wider all round (a mask: no plate or halo, so it works on any background; the top-right corner stays the status dot's `Pin`). Every pinned thing uses it, the same size everywhere: sidebar folders (plain and a project's branch folders), lone tabs, split-tab headers and terminals, the same tabs in the tab strip and the cards of the tab overview. The same corner carries one other mark, `PinMark kind="goal"` (a ring with a filled centre, the same 2.3 stroke weight as the pin), drawn by `AgentBadge` for a conversation with a goal, wherever its logo is: its cut-out is the ring's own round outline, 0.9px wider. An icon carries one mark only: a pinned conversation with a goal shows the goal's (it stays in its pinned place). A goal that rests (paused, achieved) draws its mark `quiet`, in `--text-dim`. In `AgentBadge` the cut is on a still wrapper (`.cut`) around the logo, so the logo's pulse, swell and shake play under a fixed hole instead of carrying it with them. A host whose glyph is smaller than its box sets `--pinmark-inset`. A host's icon rule targets its own glyph only (`.lead > svg`, `.dicon > svg`, `.ico > svg`): a descendant `svg` rule also resizes the mark's pin (the sidebar folders once drew a 14px pin this way), and `ui-lint` flags it as `pinhost`. It never moves with the title and never collides with the `+` / list buttons / `⋯`. On an idle/neutral icon its colour is `--pinned` (white on dark, black on light); on a coloured activity state (`working`, `asking`, `done`, `failed`) it takes `color-mix(in srgb, var(--<tone>) 72%, var(--pinned))` so it shares the logo's and `@name`'s hue while staying crisper on dark and deeper on light.
- **Dragging a row or tab.** The neighbours step aside: a **24px** gap opens on the side where it would land (sidebar rows get `margin` 25 = 24 + the usual 1px, tabs 20 + the strip's 4px gap), with the 2px `--accent` line in its middle. No gap opens where letting go would change nothing (right beside the carried row) or across the pinned border (pinned tabs always lead their folder). The carried row stays in place at 0.45 opacity (a split tab with its panes). The copy that follows the pointer is the row itself: same icon and title positions, the row's own corner, opaque on `--bg-lift` with `--shadow` and a 1px `--border-strong` ring, hanging 24px below a mouse pointer (clear of the line in the gap) (above a finger on touch) so the target and the line stay visible.
- The card is `margin: 0 8px` with a 1px border; its inner padding is **8px** left and **12px** right (the toggle adds 4 on the left), so the first and last columns both stand 12px inside the card. The server header has no tone of its own: an open card draws one 1px hairline under it (an inset shadow, so the row stays 32px). The server icon is faint while online; only a problem colours it (red offline, amber token refused / update needed) and adds the reason in words after the name (`.sstat`, 11px, same colour). A folded count is a bare number (muted while idle, coloured for working/done); only states needing attention (`asking`, `failed`) take a tinted circle. A folder in the sidebar shows its own final name (`leafName`, while project headers, the tab bar and the rail keep `shortName`) at weight 500 (700 when current), with its parent path on hover or always visible when another folder shares its name; empty folders hide their chevron while keeping the column, and never open an empty fold block. A folder's pin shows whenever it is pinned. The open tab is a wash with no outline (a framed row inside the framed card read as a box in a box).
- Search box and fold button share the card's left and right edges (8px from the sidebar edge).
- The search strip is a 44px box with no hairline under it (the list starts right below) and a 32px field centred in it (touch: the shared 34px field). The bottom buttons (graph view, scheduled tasks, settings) are 32px rows (40px on touch), 14px text, a 16px glyph on the search magnifier's column (x 28).
- **Do not let a spacing clean-up touch these.** Values on the sidebar's column path are alignment values, not spacing: `.dirtoggle` / `.srvtoggle`
  `gap: 6px` (a 14px chevron + 6 = the 20px step), `.gfold` left offset 21, `.item .open` `padding-left: 39`, group member `59`. A 4px
  sweep once moved them to 4 and shifted the folder / tab icons to 42 / 66; `python3 scripts/ui-rulers.py x --seed` must still print 28 / 48 / 68 / 88 / 236 / 256.
- A 14px icon inside a 16px column is centred in it (`place-items: center`), never nudged with a margin.
- Folded rows (`.dir.folded`, `.srvhead.folded`, a folded split tab) hide the list button and put their count in the column the row's button does not need. **On a mouse** the count sits on x 256 and the `+` (folders, servers) or `⋯` (split tab) comes back over it on hover. **On touch** the buttons stay visible on x 256, so the count moves onto the list button's column, x 236 (268 on the 320px phone drawer) — measured, never on a third x beside them. The badge is 20px wide like those buttons, so one and two digits both centre on the column. A split tab's `⋯` only appears while the tab is open, so on touch its count is pinned (`position: absolute`, `right: 28`, `inset-block: 0`, `margin-block: auto`) to that same column with or without the button, and the toggle keeps 40px of room for it.

When you add an icon or a button to a sidebar row: pick the column it belongs to, give it that column's box, and **measure** (section 6) instead of eyeballing.

## 4. Other tokens (already in `app.css`)

- Radius: `--radius-xs` 4, `--radius-sm` 8 (rows), `--radius-control` 10, `--radius` 12 (card), `--radius-panel` 16, `--radius-pill`.
  Corners come from these tokens only (an extension theme sets them): a size off the scale is a `calc()` of one (the composer box
  `calc(var(--radius-panel) * 1.375)` = 22, so 0 stays square, a card's inner header `var(--radius) - 1px`), a pill on a fixed box `min(var(--radius-pill), half its height)`.
  `scripts/ui-lint.py` flags a literal px radius above 3.
  Containers step up (10 → 12 → 16) so nested corners stay concentric.
- Type: `--fs-2xs` 11 … `--fs-2xl` 20. Inputs are at least `--fs-lg` 16 on iOS (smaller zooms the page).
- Dialog widths: `--modal-w-s/m/l/xl` = 420 / 480 / 560 / 720, with `--modal-gutter` 24 to the screen edge.
- Stacking: page layers `--z-popover` 20, `--z-dock` 25, `--z-droplayer` 30, `--z-notice` 40 (a pane's own toasts), `--z-drawer-scrim` / `--z-drawer` 49 / 50;
  dialogs `--z-scrim-1..5` / `--z-modal-1..5`; above them `--z-toast` 100 (the global toast strip), `--z-dropdown` 110, `--z-lightbox` 120, `--z-tooltip` 130.
  Anything that crosses components uses a token; a raw 0-9 stays inside one component (`ui-lint` flags anything higher without a comment).

### Loading skeletons

- **Few blunt blocks, never a stack of hairlines.** One bone per thing that is coming (a row, a bubble, a line of the reply), at least 16px thick:
  sidebar rows 16px, reply lines 24px, the question bubble 40px. Two lines of a reply are enough; more reads as content.
- Corners: `.skeleton-bar` is `--radius-xs` 4; a 24px line takes `--radius-sm` 8, a bubble the real bubble's `--radius` 12. No pills.
- **Each bone sits where the real thing lands** (measured, not guessed): sidebar bones start on the folder-icon column (x 41) centred in a 32px row (40 on touch);
  the chat's bubble top and first reply line match the loaded transcript (`ChatSkeleton`: bubble at the first bubble's top, the first bar around the reply's first line).
  The swap then changes colour, not layout.
- Colour and motion come from `app.css` only (`.skeleton-bar`, `--sk-i` for the sweep's order, `.skeleton-in` / `.skeleton-out`, held by `skeletonGate`).
  A new skeleton reuses them and gets its own component when it is more than a row (`ChatSkeleton.svelte`).

### Question and tool-call blocks (chat)

Applies to `ToolCard`, `QuestionReply` and the work box. Measured on 320 / 390 / 820 px; all values below are on the 4/8/12/16 scale.

- **A tool call is a line, not a card.** It is built like the work box's summary line above it: 16px kind icon, the tool's name (mono, faint), what it did (mono, dim, the part that is cut), then the time and chevron on the right. Rows are 28px (4 + 20 + 4), icons on the guide line's 24px column, every summary in a box starts on one line (the name column is as wide as the box's longest tool name, 4 to 8ch, `--name-w`; a longer skill name pushes only its own row), and times are right-aligned in a 5ch box so the word before them ends on one line too. No pills, no frames, no tinted badges: the icon says the kind.
- **One red word, no marks.** No check for work that went fine, no cross for a failure. A folded box says a failure once: a red "실패" / "N개 실패" in the time's size after its summary . Opened, a failed call keeps its colours and says how it ended in a short red word by its time ("종료 코드 2", "실패"; a skipped call says "실행 안 됨" in the faint colour); its output is not tinted. A waiting call turns icon and name to the warn colour and its question is the one framed block (warn border) under it. Running is three dots. A shell summary drops a leading `cd <dir> &&` (`splitCd`), hovering it says the whole line.
- **Opened**, a call's body (command, diff, output) hangs 24px in, under the name, 8px above the next line. A thought is the same line with a brain icon and its text under it in the dim colour (no italic: Hangul has no italic face).
- **Question block** (`.reply`): padding 12, groups 12 apart, left and right edges of the question, options and input all on the same 12px line.
- **Options** are equal-width buttons, 40px high (a long answer wraps to 58): two or three short answers (8 characters or fewer, the recommended one counts 2 more) share a row, four short ones make a 2x2, anything else is one per row. No numbers, no pills.
- **Recommended** answer: a 14px sparkle leading its text, in the warn colour. The button itself looks like the others, so it never reads as "already chosen". **Chosen** answer: a 2px text-colour border and a green check.
- **Input**: 40px high with the send arrow *inside* its right end (32px, 4px inset on three sides), hidden until there is text. The same control for typing and for "save" (check icon) in a multi-question block.
- **Steps** (several questions): up to 4 are numbered 28px circles joined by 16x2px lines, centred; answered = green outline and check, current = filled with the warn colour (a touch darker, 5:1 contrast), ahead = grey outline. From 5 questions on it is `‹ 3 / 8 ›` between two 28px arrows. Every circle and arrow carries `.tap`. The row is 28px and 12px above the question.
- **One height.** In a multi-question block the card keeps the same height on every tab (a question without an input holds the input's 40px).
- **Answers can be given in any order**: after an answer the block goes to the next unanswered question, else the first unanswered one before it; it sends only when every question has an answer.
- **Action rows** (copy / reply / branch / retry under an answer, copy / branch under your own message): 32px `sm` icon buttons, 16px glyphs, and the boxes overlap 2px so the pitch is 28px — 8px of air on each side of a glyph would read as 20px between neighbours. Both rows bleed by the glyph inset less that overlap (`-6px`), so the first glyph starts on the text's left line and the last one ends on the content's right line. Both rows are 32px high and the same on every device; a touch screen has no hover, so they stay visible there.

## 5. Breakpoints and touch

| Query | Meaning |
|---|---|
| `max-width: 860px` | sidebar becomes a drawer, groups show one session at a time (`lib/viewport.svelte.ts`) |
| `max-width: 640px` | phone layout of dialogs and panels |
| `pointer: coarse` | touch: action buttons are always visible, `.tap` adds an invisible 44px hit area |

**Hover tints only where a pointer hovers.** A `:hover` that only changes a colour (background, border, text) goes inside
`@media (hover: hover)`. On a touch screen the browser keeps `:hover` on the last tapped element, so a bare `:hover` tint
stays on that row and reads as "selected" (it did on the settings nav and the context sheet). Hovers that *reveal*
something (`opacity`, `display` of actions) stay as they are: touch shows those through `pointer: coarse` rules. `ui-lint` flags it as `hover`.

A control smaller than 44px stays visually small but must carry `.tap` (`app.css`). Check every change at **1440×900**, **820×1180** (tablet) and **390×844** (phone).

### Mobile bottom sheets (`<= 640px`)

- Every non-fullscreen `<Modal>`, `Palette`, and `ExtensionFloating` panel opens as a bottom sheet on phones (`bottom: 0`, `width: var(--vw)`, `border-bottom: 0`, top corners `--radius-panel`). Reserve `sheet={false}` strictly for small centered status/quit cards (`StatusCard`, `CloseConfirm`), which keep the centered dialog transition and symmetric padding rather than bottom-sheet slide or `--sab`. Keep dropdowns and compact anchored menus (`RowMenu`, `Select`, `SlashMenu`, `SendControls` quick menu, `FindBar`) anchored near their trigger (avoid stacking a second bottom sheet over drawers or settings sheets), and keep `TabOverview` / `Lightbox` full-screen.
- Every bottom sheet (`sheet={true}` and not `full`) carries the shared top grabber bar (`.sheet-handle::before`, `38×4px`, `top: 6px`, `--border-strong`) and pull-down-to-dismiss (`use:sheetPull` in `lib/sheet.ts`, supporting `<dialog>`, `[role="dialog"]`, `[role="alertdialog"]`, and `[data-sheet-root]`). Desktop (`> 640px`) and full-screen `100dvh` sheets (`full`) hide the grabber (`pull={sheet && !full}`).
- Every bottom sheet clears the home indicator via `safeArea` on `<Modal>`, `<DialogFooter safe>`, or explicit `calc(... + var(--sab))` on its lowest band — never double-padded when embedded inside a `safeArea` modal. Full-screen overlays (`Lightbox`, `full` sheets) also clear `--sat` at the top.

## 6. How to measure (do not guess)

Eyeballing a screenshot hides 1–2px errors. Measure the DOM, then draw rulers on a plain screenshot.

1. Start the worktree's own pair: `.agents/bin/dev-up.sh` (never a fixed port or someone else's server).
2. Seed data so every row type exists (a folder with a conversation, a closed one, a terminal, a split tab with two panes).
3. Make hover-only controls visible for the shot:
   `.side .dirnew,.side .listbtn{opacity:1!important} .side .acts{display:flex!important}`
4. Read centres with `getBoundingClientRect()` on the **svg/img** inside the control (`left + width/2`), not on the button. Compare columns; they must agree to the pixel.
5. Draw: vertical lines at each column centre, a top ruler with the gap between neighbours, a left ruler with element heights (teal) and spaces (magenta).
   `python3 scripts/ui-rulers.py <name> [--seed]` does steps 3–5 for the sidebar and prints the numbers (`--seed` creates the sample rows).
6. Report BEFORE / AFTER side by side, plain (no guides) **and** with rulers, with the numbers.

To capture every screen and dialog at the three viewports, write a throwaway Playwright script under `tmp/` modelled on `.agents/bin/shot.py`.
Exposing the store needs an audit-only line in `client/src/main.ts` (`window.__app = app`); never commit that line.

### Left/right margin audit

Every dialog band (header, search strip, body, footer, list rows) must start and end at the gutter: **24 (phone 16) + the modal's 1px border**.
Popovers that are lists (`Palette`, queue) use a fixed **16**: their rows start at 16, so the title and the close glyph do too. A settings window's body starts
after its nav column (nav right edge + the same gutter); the nav's icons and group labels start on the window's gutter too (nav 12 + row 12 + 1px border = 25, the title's and search field's line). Measure the content (text range or control box), not a scroller: a scroller that gives 4px of focus-ring room
and takes it back with `margin: 0 -4px` still has its content on the gutter. Ellipsised and wrapped text is judged by its box.
Checked at 1440 / 820 / 390, light and dark: 223 bands over 29 screens, 0 off-rule sides (extension dialogs and panels included, all routed through the shared `<Modal>`).

### The conversation column (main screen)

Header title, the first tab's label, the conversation text, the composer box and the status line share **one left and one right line**: 16px from the pane
(on a wide pane the column is 760px, centred, so the line is wherever the column starts). Do not give the composer or the status line its own narrower side
padding in a narrow pane (it used to step down to 8 and stood 8px out from the text). The tab strip pads 8px and a tab 8px, so the first icon is at 16.
The tab strip (wider than 600px) is a browser's: the bar is `--bg-tabbar`, a step below the page, and the header above it takes the same tone (one chrome band,
like a browser's title bar over its tabs; a white header over a grey strip read as three stacked tones). One `--tabbar-line` hairline still separates
the title row from the tabs, running from under the sidebar's brand row to the window's right edge at the same height. The tabs are 28px pills (8px corners) centred in the 38px strip, 4px apart. The front tab is a grey pill set into the strip:
`--bg-tabbar-on` (the strip mixed 12% toward `--text`), no ring or shadow, clear of the strip's bottom hairline; filled, never outlined. A group is a tray on the tabs' own row: 28px, 8px corners, a faint `--bg-tabbar-group` fill (the strip 5% toward `--text`, under hover's 8%), no ring. Its chips are tabs in all but name (28px, 8px padding, edge to edge, no inset), so the open one is the same `--bg-tabbar-on` pill as a lone front tab; one sliding marker covers the tabs and the chips (`.tab.on, .gchip.on`), so moving into or out of a group slides like moving between tabs and the group's icons and text share the tabs' top, bottom and baseline (a ring or an inset box set the group 2px taller and its chips 4px shorter, and read as a misfit). The other tabs have no fill, and hover fills the same pill with `--bg-tabbar-hover` (8% toward `--text`, a step short of the front tab). The × is a round 20px target. Each tab is as wide as its content (icon, handle, title; no minimum, up to 200px, the title ellipsised past that), so the tabs sit
edge to edge. The × appears at the tab's right end while the pointer is on the tab (also with its menu open or the × focused), its glyph 8px in from the pill's edge like the icon on the left, over the end of the title on a backing of the pill's own colour with a 24px fade (`--xbg`), so it needs no room of its own and the icon never turns into a close button: a short title makes a short tab, a tab never changes width on hover, and `+` after the last tab sits against the title instead of past a blank the width of a hidden ×. On touch (no hover) the × stays after the title, always shown. A chip inside a group has no ×: in the same place and the same way it shows "그룹에서 빼기" (`unlink`, as on a pane's title bar), which takes the pane out into a tab of its own; on touch and the phone strip that is only in the chip's long-press menu. The strip scrolls when they do not fit. **`+` follows the last tab** (a browser's new-tab button, 8px after the last pill; once the tabs overflow it stays at the strip's
visible edge) and **the tab count is pinned to the bar's right end**, its square on the 16px gutter (both `TabControls`, `part="add"` / `part="count"`). On a phone the same cluster sits at the header's right end, with no gap and both buttons 28px wide (not the header's 32), so the `+` ink and the count's square stand 12px apart and read as one pair.
Inside messages: quote text sits 16px from its 3px bar, a list's text 24px from the column, a user bubble 16px inside; code and tables fill the column. Check
with `tmp`-style scripts that measure each pane's own box, not the window (a split group has one column per pane).

### Things that sit on the conversation column (or on the composer's text line)

- **Toasts and notices** start their text at 16 (a compact session strip too), full width.
- **Terminal**: the screen's text and the key bar's first key start at 16, like the tab label above.
- **Composer**: the text line is 16 (12 in a narrow pane) from the box's inner edge; the attach button's glyph, the reply badge, the file and image strips, the placeholder
  hint and the slash menu's text all start on that same line. The 38px attach button holds a 19px glyph 9.5 from its edge, so the bar's left padding is 7 (3 narrow), not 8.
- A thing inside a bordered box (the slash menu has a 1px border) counts that border: 15 inside it to land on the same x as 16 inside the composer box.

### Strips, banners and cards that are not a column

Every full-width strip (toasts, session notices, version notice, the connection banner "서버에 다시 연결하는 중…" / "토큰 거부") has **16px** side padding, so a wrapped line keeps its
distance from the edge (the banner had 12). A centred card (update card, confirmations, link card) is judged on being **centred** (left == right within 1.5px) and on its full-width
rows (switch row, progress bar) ending at the dialog gutter. Image and file strips in the composer scroll sideways when they overflow; they never change the box width.
Dark and light are checked the same way (the theme must be confirmed from `data-theme` on every measurement, an unconfirmed theme is not counted).

### Right-edge rule (one line, never two close ones)

Everything you read in a dialog ends on **one** right line and starts on **one** left line. Two edges 2 to 16px apart are always a mistake
(a refresh button at 25 and a delete button at 38 in the same list).
- A control that sits inside a bordered box (card, list, row) ends one padding step inside the box, and **all** controls in that box end on the same line.
  A toolbar above such cards sits on the cards' inner line, not the dialog gutter (`SessionsPanel .row.head`).
- A row of controls that wraps (bulk buttons) wraps; it never overlaps and never leaves one button on a different edge.
- Slider rows use one grid (`RangeField`): track, a 48px value column, and an 88px action column only when there is an action, so the value
  or the action is the row's right edge like a switch.
- A close button's hit box is wider than what you see: measure the glyph. Header padding is `calc(var(--dlg-px) - 9.5px)` so the glyph lands on the body's right edge.

### Icon buttons (one size set, one gap, one bleed)

- **Sizes.** `IconButton` `md` is 38px with a 19px glyph (headers, drawers, modals); `sm` is 32px with a 16px glyph (inline and compact rows).
  A glyph is always an even size in an even box (14 in 20, 16 in 32, 19 in 38); never 13, 15 or 17.
  Do not write a custom 30/32 square for a close button: use `IconButton`.
- **Gap.** Adjacent icon buttons in a header or toolbar sit **4px** apart (`ModalHeader` wraps `actions` and the close button in `.mh-acts` for this;
  the 8px gap between the title and the buttons stays).
- **Right gutter.** The glyph, not the box, lands on the gutter: `md` bleeds `margin-right: -9.5px`, `sm` bleeds `-8px`, each with a comment naming the line it lands on.
  A bleeding button draws its focus ring inside (`outline-offset: -2px`).
- **Touch.** A custom button under 44px gets `.tap` (an invisible 44px hit box on coarse pointers). Not on `.iconbtn`: it is `overflow: hidden` for the ripple, which would clip the box.
- A topbar is 44px + 1px hairline everywhere (app header, sidebar brand row, graph head, extension dock), so the lines meet.

### Extra facts in a tooltip

Facts that only some rows have (a model's abilities and context size) go in the row's native `title`, like the status line's readouts, not in the row and not in a custom popup. A row stays a name and its controls.

### Icon/label pairs (`scripts/ui-pairs.py`)

The sibling check for "an icon and one line of text": every row that puts a line icon beside a label, measured on the painted ink at
device_scale_factor 4 over every screen (`main`, the settings sections, the server tabs, the conversation list, the folder picker, the
model picker, a row menu) at 1440 / 820 / 390. From **1px** apart it is a bug; 0.5px is the half-pixel limit. Two labels are exempt and
reported separately as *light glyph*: their ink has no height of its own (`..`, `—`, a lone `.`), so a centred box still paints low.
Rows whose label inherits the body's 1.55 line box are listed as
*fractional line box*: that is what once put the working-directory path 1.5px below its folder glyph, so give the label a whole-pixel
`line-height` (`16px` / `20px` / `24px`, including shared `.btn`, `.section-label`, `.hint`) before hunting anywhere else. Every icon
`<svg>` sets `display: block` (`Icon.svelte` `:where(.ic)` and `.btn svg`) so an icon wrapped in a non-flex `<span>` never rides on the
inline baseline strut; every path in `client/src/lib/icons.ts` is centred on `(12, 12)` in its 24×24 viewBox (`getBBox()` ±0.25); icons
beside text inside even-height controls use even sizes (`12`/`14`/`16`/`18px`); and fixed-height underline tabs mirror `border-bottom: 2px`
with `border-top: 2px solid transparent`. The script measures both element children and bare `TEXT_NODE`s (`Range.getBoundingClientRect()`)
against the inner `<svg>`/`<img>` rect (not its wrapper `<span>`), seeds a favourite model with `--seed`, and opens `dir-picker` before a
chat session so no screen is skipped. A label made only of a light glyph is rewritten rather than exempted: the folder picker's up row reads
"상위 폴더" beside its arrow, with `..` as the faint hint on the right. Only the label right after the icon is compared (a trailing unit
such as `tps` is not beside the glyph), and ink is the rows that reach half of the crop's peak contrast, so the faint background grid
does not count. The script exits 1 when a pair is 1px or more off. Audit result at the time of writing: 224 pairs over every screen at
1440 / 820 / 390, worst 0.88px, none at 1px or more.

### Focus rings (`scripts/ui-focus.py`)

Tabs through every screen (home, a conversation, the tab overview, settings, the model picker, the conversation list) at
1440 / 820 / 390 and checks each focused element's ring: its border box grown by `outline-offset + outline-width` (or a
`box-shadow` ring's spread) against the padding box of every ancestor that clips (`overflow` other than `visible`,
`contain: paint`) and the window. A cut of 0.5px or more is a bug; the script prints the element, the clipping parent and the
sides, saves a screenshot and exits 1. An item that fills a scroll box edge to edge (a strip tab, a group chip, the status
line's `⋯`) draws its ring inside (`outline-offset: -2px`); a grid of cards gets padding in its scroll box the ring fits in
(the tab overview's `.body` pads 8px on top for the current card's 2px frame + 4px offset). A strip that scrolls brings a
focused item into view itself (`TabBar` `reveal`): a chip inside a nested scroll box is not scrolled to by the browser.
`--seed` adds the conversations, a terminal and a split tab the screens need (`--echo` also runs a tool call, for the work box
and the answer's foot); `--only` picks screens, `--theme light` spot-checks the light theme. Each screen starts with fresh browser storage and must reach an identifiable element on the
intended surface. A missing screen, an exhausted Tab budget or no measured rings fails the run, not just a clipped ring.
Coverage includes all settings panes and search, nested server/connection/model forms, icon and catalog grids, unsaved
changes, MCP/role/schedule forms, extension settings and marketplace, graph details and chat preview, and context source rows.
Use `--seed --echo` for the tool transcript as well; `--seed` alone does not create it.

### Alignment lint (finds the misses by itself)

Walk each screen and compare the **edges** of everything that has a border or fill (inputs, buttons, cards, rows):

- two edges that differ by 1 to 8px (e.g. a search field ending at 1445 and a form ending at 1419) are a misalignment;
- a vertical gap between two stacked boxes that is not a multiple of 4 (ignoring a 1px hairline) is off the scale.

Run it for every screen at 1440 / 820 / 390 and treat any hit as a bug. A **right-edge cluster** check also runs: collect the right edge of every visible control and text, merge edges within 1px, and report any pair 2 to 16px apart. Scroll-strips of chips and switches are exempt (they have no shared edge).
Screens to cover: every settings tab, the server form (add / edit), conversation list (all / folder / selected),
skills, commands, folder picker, palette, confirmations (close, link, extension confirm / input / select), queue, file preview,
sidebar, header, tab bar, composer, status line, messages, terminal, split tab.

## 7. Process rules

- A spacing change is a UI change: follow "결과물 이미지" in `AGENTS.md` (before/after images, all three viewports when it touches shared components).
- Change a **shared component** (`Modal`, `Button`, `SettingRow`, `SearchField`, `Segmented`, …) only together with a check of every screen that uses it. Prefer fixing the token or the component over per-screen overrides.
- Do not fix a misalignment with `margin-left: -1px` or `translate`. Find the box that is the wrong size and fix that. If a nudge is unavoidable, comment what it aligns to.
- New values go into this file when they become a rule.
- Markdown in messages: blocks are **12px** apart, a heading **24px above / 8px below**, list items 4px; all in px (em values gave 12.75 / 14.25 / 23.8 / 9.1px).
- Tokens in a sent message (`TokenText`: `@name`, `#imageN`, `#path`, `/skill:x`, `/prompt:x`) and inside the composer (`ComposerEditor`) share one atomic inline chip shape: `0.88em`, `--radius-xs` (4px), `1px 0.4em` padding, a 1px inset ring of their hue, and `line-height: 18px` (20px box). `@name` is the one accent (amber `--mark-mention`, weight 600); image, file, skill and prompt chips carry a 12px dimmed icon (`image`/`file` drop the leading `#`). At 0.88em the 20px chip stays under the 24px line box of both `UserMessage .txt` and `ComposerEditor`, so chips on wrapped lines never touch.
- Text rows whose height adds up (conversation list, settings rows) use a whole-pixel `line-height` (20px), so a row is 36 + 1px hairline, never 37.14.
- Run `python3 scripts/ui-lint.py` before committing a style change; it must print `clean`.
- **Settings nav** (`SettingsNav.svelte`): every section row and tree row is **32px** (38px for a touch tab on a phone), one line, no description under the label (the pane header shows it; the row's tooltip repeats it). A section with children has one fold button at the row's right end, a 24x24 box around a centred 14px chevron (chevron centre 19px from the row's edge, like the 19px icon's 12px inset on the left), so its focus ring is a small square around the glyph: **down = open, right = folded**, the same chevron as the sidebar's folders. The count of a folded section is a quiet `.cbadge` in a fixed 20px column right before the arrow (same column rule as the sidebar's counts), display only (`pointer-events: none`, not a control, so it is never focused and a click on it reaches the section button): badge centre 46px and arrow centre 19px from the row's right edge on every row, with or without a badge, one or two digits. MCP and 확장 start folded (`lib/settings-fold.ts`).

## 한국어 요약

- 간격은 **4 / 8 / 12 / 16 / 24**만 씁니다. 그 밖의 값(10, 6, 14, 22 …)은 이유를 주석으로 남깁니다. 1px(구분선, 행 사이)과 측정으로 정한 정렬 값, 안전 영역(`--sat` 등)은 예외입니다.
- 행 높이는 **32px**, 같은 블록 안 행 사이는 **1px**, 블록 사이는 **4px**, 폴더 사이는 **12px**입니다.
- 사이드바(288px)는 열의 **중심** 기준으로 **20px** 간격입니다: 화살표 28, 폴더 아이콘 48, 탭 아이콘 68, 분할 패널 아이콘 88, 목록 버튼 236, `+`/`⋯`/↺ 256. 카드는 사이드바 끝에서 8px, 카드 안쪽 첫 열·끝 열은 카드 끝에서 12px입니다. 우측 버튼은 20px, 마진 없음입니다.
- 설정 왼쪽 내비: 모든 행 32px 한 줄(설명은 오른쪽 제목 아래와 툴팁), 접기 버튼은 14px 화살표를 감싼 24x24(포커스 링은 화살표 둘레 정사각형, 화살표 중심 오른쪽에서 19px)이고 방향은 펼침 아래 v, 접힘 오른쪽 >(사이드바 폴더와 같음), 접힌 섹션의 개수는 화살표 바로 앞 20px 칸의 약한 배지입니다(표시 전용, 포커스·클릭 대상 아님, 배지 중심 오른쪽에서 46px, 화살표 19px 고정).
- 눈대중으로 맞추지 말고 DOM의 아이콘 중심을 재서 맞춥니다(6장). 결과 보고는 수정 전/후를 가이드 있는 것과 없는 것으로 나란히, 숫자와 함께 냅니다.
- 공용 컴포넌트를 바꿀 때는 그것을 쓰는 모든 화면을 확인하고, 데스크톱 1440 · 태블릿 820 · 모바일 390 세 크기에서 확인합니다.
- 맞춤용 `margin: -1px`이나 `translate`로 땜질하지 않습니다. 크기가 틀린 박스를 고칩니다.
- 색만 바꾸는 `:hover`는 `@media (hover: hover)` 안에 둡니다. 터치에서는 마지막으로 탭한 행에 hover가 남아 선택된 것처럼 보입니다(`ui-lint`의 `hover`).
- 펼친 카드·그룹 카드 안쪽은 위·아래·좌우 여백을 같게 하고, 안쪽 행 사이 간격은 바깥 카드 사이와 같게 합니다. 부모가 `gap`을 주면 자식은 마진을 더하지 않습니다.
- 로딩 스켈레톤: 얇은 선 여러 줄 대신 굵은 블록 몇 개(사이드바 16px, 답변 줄 24px 두 줄, 질문 버블 40px)를 씁니다. 모서리는 4 / 8 / 12, 알약 모양은 쓰지 않습니다. 각 블록은 실제 내용이 놓일 자리에 재서 맞추고(사이드바 x 41, 버블 위치·첫 답변 줄), 색·움직임은 `app.css`의 `.skeleton-bar`만 씁니다.
- 질문·도구 호출 블록: 상태는 색으로 말하고 칩은 쓰지 않습니다(실행 중·준비 중·실행 안 됨만 칩). 실패는 빨간 테두리와 빨간 글씨, 대기는 주황 테두리. 보기는 같은 폭의 40px 버튼, 추천은 글자 앞 반짝이, 고른 답은 굵은 테두리와 체크, 입력창 안에 보내기 화살표. 여러 질문은 28px 번호 원(4개까지)을 선으로 이은 단계 표시, 5개부터는 `‹ 3 / 8 ›`. 어느 탭에서도 카드 높이는 같습니다.

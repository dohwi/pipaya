# Design system: spacing, grid and measuring

Source of truth for how the client is laid out. The values here are the ones the sidebar already uses
(`client/src/components/Sidebar.svelte`, `sidebar/*.svelte`); everything else is being moved onto the same rules.
Tokens live in `client/src/app.css` (`:root`); read it before adding a value.

> 한국어 요약은 맨 아래. Agents: the short version is in `AGENTS.md` ("UI 간격 규칙"); this file has the reasons and the exact numbers.

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

## 2. Vertical rhythm

| Thing | Value |
|---|---|
| Row height (list rows, tabs, headers, tree rows) | **32px** |
| Compact control | `--control-h-sm` 34px; normal control `--control-h` 40px |
| Gap between two rows of one block | **1px** (the row's own `margin: 1px 0`) |
| Gap between blocks (a card's header and its first folder) | **4px** |
| Gap between folders in one card | **12px** |
| Brand row | 44px + 1px hairline (matches the header capsule) |
| Search strip | 12px above and below a 34px field |
| Gap under the strip before the first card | 8px |
| A card's inner bottom padding | 4px (+1px row margin + 1px border = 6px measured) |
| List bottom padding | 16px |

Do not give one kind of row a different height (the sidebar once had 28 / 30 / 32 mixed). If a row needs more room, the content
grows, not the row's declared height.

## 3. Horizontal grid (sidebar, 288px wide)

Columns are **centres**, measured from the sidebar's left edge. Neighbouring columns are **20px** apart.

```
 x=24     44        64                                   244      264    288
  │chevron │folder   │tab icon   … name (flexible) …       │list    │+ ⋯ ↺ │
  24       20        20                  180               20        24
```

| Column | x (centre) | Holds |
|---|---|---|
| chevron | 24 | fold arrows of the server and folder rows |
| folder icon | 44 | folder icon; the archive / group chevron |
| tab icon | 64 | session logo, terminal, archive, group icons; archive header icon |
| pane icon | 84 | members of a split tab (one step in, past the tree line) |
| list button | 244 | the conversation-list button of a server, folder, archive |
| action | 264 | `+`, `⋯`, restore ↺ |

- Left gutter and right gutter are both **24px** (edge → chevron centre, edge → action centre).
- Buttons in the right-hand columns are **20px** squares with **no margin**, so they sit edge to edge on the 20px grid. The row ends where the card ends.
- The card is `margin: 0 8px` with 1px border and **4px** inner padding on both sides; the server header strip bleeds to the card's edge with the same 4px.
- Search box and fold button share the card's left and right edges (8px from the sidebar edge).
- **Do not let a spacing clean-up touch these.** Values on the sidebar's column path are alignment values, not spacing: `.dirtoggle` / `.srvtoggle`
  `gap: 6px` (a 14px chevron + 6 = the 20px step), `.gfold` and `.archtoggle` left offset 21, `.item .open` `padding-left: 39`, group member `59`. A 4px
  sweep once moved them to 4 and shifted the folder / tab icons to 42 / 66; `python3 scripts/ui-rulers.py x --seed` must still print 24 / 44 / 64 / 84 / 244 / 264.
- A 14px icon inside a 16px column is centred in it (`place-items: center`), never nudged with a margin. The one `translate` in `DirBlock.svelte` (archive header) exists because the 14px svg is not the same width as the 16px logo; its comment says so.
- Folded rows (`.dir.folded`, `.srvhead.folded`) put the `+` where the count badge was, at the same centre (x 264).

When you add an icon or a button to a sidebar row: pick the column it belongs to, give it that column's box, and **measure** (section 6) instead of eyeballing.

## 4. Other tokens (already in `app.css`)

- Radius: `--radius-xs` 4, `--radius-sm` 8 (rows), `--radius-control` 10, `--radius` 12 (card), `--radius-panel` 16, `--radius-pill`.
  Containers step up (10 → 12 → 16) so nested corners stay concentric.
- Type: `--fs-2xs` 11 … `--fs-2xl` 20. Inputs are at least `--fs-lg` 16 on iOS (smaller zooms the page).
- Dialog widths: `--modal-w-s/m/l/xl` = 420 / 480 / 560 / 720, with `--modal-gutter` 24 to the screen edge.
- Stacking: `--z-modal-1..5`, `--z-scrim-1..5`, `--z-notice`, `--z-toast`, `--z-lightbox`. Do not add a raw `z-index`.

## 5. Breakpoints and touch

| Query | Meaning |
|---|---|
| `max-width: 860px` | sidebar becomes a drawer, groups show one session at a time (`lib/viewport.svelte.ts`) |
| `max-width: 640px` | phone layout of dialogs and panels |
| `pointer: coarse` | touch: action buttons are always visible, `.tap` adds an invisible 44px hit area |

A control smaller than 44px stays visually small but must carry `.tap` (`app.css`). Check every change at **1440×900**, **820×1180** (tablet) and **390×844** (phone).

## 6. How to measure (do not guess)

Eyeballing a screenshot hides 1–2px errors. Measure the DOM, then draw rulers on a plain screenshot.

1. Start the worktree's own pair: `.agents/bin/dev-up.sh` (never a fixed port or someone else's server).
2. Seed data so every row type exists (a folder with a conversation, an archived one, a terminal, a split tab with two panes).
3. Make hover-only controls visible for the shot:
   `.side .dirnew,.side .listbtn{opacity:1!important} .side .acts{display:flex!important}`
4. Read centres with `getBoundingClientRect()` on the **svg/img** inside the control (`left + width/2`), not on the button. Compare columns; they must agree to the pixel.
5. Draw: vertical lines at each column centre, a top ruler with the gap between neighbours, a left ruler with element heights (teal) and spaces (magenta).
   `python3 scripts/ui-rulers.py <name> [--seed]` does steps 3–5 for the sidebar and prints the numbers (`--seed` creates the sample rows).
6. Report BEFORE / AFTER side by side, plain (no guides) **and** with rulers, with the numbers.

To capture every screen and dialog at the three viewports, write a throwaway Playwright script under `tmp/` modelled on `.agents/bin/shot.py`.
Exposing the store needs an audit-only line in `client/src/main.ts` (`window.__app = app`); never commit that line.

### Right-edge rule (one line, never two close ones)

Everything you read in a dialog ends on **one** right line and starts on **one** left line. Two edges 2 to 16px apart are always a mistake
(a refresh button at 25 and a delete button at 38 in the same list).
- A control that sits inside a bordered box (card, list, row) ends one padding step inside the box, and **all** controls in that box end on the same line.
  A toolbar above such cards sits on the cards' inner line, not the dialog gutter (`SessionsPanel .row.head`).
- A row of controls that wraps (bulk buttons) wraps; it never overlaps and never leaves one button on a different edge.
- Slider rows use one grid (`RangeField`): track, a 48px value column, and an 88px action column only when there is an action, so the value
  or the action is the row's right edge like a switch.
- A close button's hit box is wider than what you see: measure the glyph. Header padding is `calc(var(--dlg-px) - 9px)` so the glyph lands on the body's right edge.

### Alignment lint (finds the misses by itself)

Walk each screen and compare the **edges** of everything that has a border or fill (inputs, buttons, cards, rows):

- two edges that differ by 1 to 8px (e.g. a search field ending at 1445 and a form ending at 1419) are a misalignment;
- a vertical gap between two stacked boxes that is not a multiple of 4 (ignoring a 1px hairline) is off the scale.

Run it for every screen at 1440 / 820 / 390 and treat any hit as a bug. A **right-edge cluster** check also runs: collect the right edge of every visible control and text, merge edges within 1px, and report any pair 2 to 16px apart. Scroll-strips of chips and switches are exempt (they have no shared edge).
Screens to cover: every settings tab, the server form (add / edit), conversation list (all / folder / archive / selected),
skills, commands, folder picker, palette, confirmations (close, link, extension confirm / input / select), queue, file preview,
sidebar, header, tab bar, composer, status line, messages, terminal, split tab.

## 7. Process rules

- A spacing change is a UI change: follow "결과물 이미지" in `AGENTS.md` (before/after images, all three viewports when it touches shared components).
- Change a **shared component** (`Modal`, `Button`, `SettingRow`, `SearchField`, `Segmented`, …) only together with a check of every screen that uses it. Prefer fixing the token or the component over per-screen overrides.
- Do not fix a misalignment with `margin-left: -1px` or `translate`. Find the box that is the wrong size and fix that. If a nudge is unavoidable, comment what it aligns to.
- New values go into this file when they become a rule.

## 한국어 요약

- 간격은 **4 / 8 / 12 / 16 / 24**만 씁니다. 그 밖의 값(10, 6, 14, 22 …)은 이유를 주석으로 남깁니다. 1px(구분선, 행 사이)과 측정으로 정한 정렬 값, 안전 영역(`--sat` 등)은 예외입니다.
- 행 높이는 **32px**, 같은 블록 안 행 사이는 **1px**, 블록 사이는 **4px**, 폴더 사이는 **12px**입니다.
- 사이드바(288px)는 열의 **중심** 기준으로 **20px** 간격입니다: 화살표 24, 폴더 아이콘 44, 탭 아이콘 64, 분할 패널 아이콘 84, 목록 버튼 244, `+`/`⋯`/↺ 264. 좌우 가장자리는 모두 24px입니다. 우측 버튼은 20px, 마진 없음입니다.
- 눈대중으로 맞추지 말고 DOM의 아이콘 중심을 재서 맞춥니다(6장). 결과 보고는 수정 전/후를 가이드 있는 것과 없는 것으로 나란히, 숫자와 함께 냅니다.
- 공용 컴포넌트를 바꿀 때는 그것을 쓰는 모든 화면을 확인하고, 데스크톱 1440 · 태블릿 820 · 모바일 390 세 크기에서 확인합니다.
- 맞춤용 `margin: -1px`이나 `translate`로 땜질하지 않습니다. 크기가 틀린 박스를 고칩니다.

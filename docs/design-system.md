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

### Shared dialog parts (use these, do not re-write the CSS)

- `DialogBody`: the scrolling body of a dialog (`--dlg-px` gutters, body top/bottom, rule under the header). Skills, commands, MCP and the context view (`SessionContext`) all use it.
- `ListItem`: one card row (12px padding, 12px gap): optional leading `Switch`, title line (name + `Badge size="sm"`), body lines (`.meta`, `.desc`), trailing actions. The first row shares one centre line (22px with a switch, 34px with action buttons; actions drop below on a phone). Animate the keyed `<li>` around it (`animate:reflow in:rowIn out:rowOut`).
- `FormField`: label (20px line) + 8px + control = 68px with a 40px field. `group` for a control that is not one input (`Segmented`).
- `StatusItem`: one item under the input (icon or mark + value + tooltip), a 21px box (19px in a narrow pane) with a 4px gap. A button when it has `onclick` (add `empty` when there is nothing to show, `level` for warn/danger).
- Check by measuring: every item in a row must have the same top, height and icon/text centre (`getBoundingClientRect`), at 1440, 820 and 390.

### Text inside pills (measure the ink, not the box)

- A box can be centred and its text still look off: the fonts (Manrope, SUIT, JetBrains Mono) leave more room under the baseline than above. Measured at 8x on Hangul, Latin and digits, centred text sits **+1.0px low at 11px** (Badge, `.chip`), +0.66 at 12px, +0.3 at 13px, ~0 in mono.
- So `Badge` and `.chip` carry `padding: 0 8px 1px` (a 1px lift). A new pill style gets its own measured value, never a guess.
- Dialogs sit on whole pixels (`Modal` places the panel by pixel offsets, not `top: 50%` + `translate`), otherwise a panel with the other parity than the window lands on x.5 and its badges are painted 0.5px higher than in the next dialog. Header title/subtitle have whole-pixel line boxes (28 / 18).
- A small label next to bigger text in a centred row (the `@name` handle before a conversation title) is aligned on the **baseline**, not the centre: the handle is lowered 1.5px.
- Audit: render at `device_scale_factor` 4-8 with `scripts/ui-ink.py`, find the painted pixels inside each pill and compare their centre with the box centre; flag anything over 0.5px. Differences up to 0.5px represent the physical half-pixel grid limit of an odd-pixel glyph in an even-content box.

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
 x=28     48        68                                   236      256    288
  │chevron │folder   │tab icon   … name (flexible) …       │list    │+ ⋯ ↺ │
  28       20        20                  168               20        32
```

| Column | x (centre) | Holds |
|---|---|---|
| chevron | 28 | fold arrows of the server and folder rows |
| folder icon | 48 | folder icon; the archive / group chevron |
| tab icon | 68 | session logo, terminal, archive, group icons; archive header icon |
| pane icon | 88 | members of a split tab (one step in, past the tree line) |
| list button | 236 | the conversation-list button of a server, folder, archive |
| action | 256 | `+`, `⋯`, restore ↺ |

- The card stays **8px** from the sidebar edges and its content stands **12px** inside it (the card's padding, left and right alike), so the left gutter is 28 (edge → chevron centre) and the right gutter 32 (edge → action centre).
- Buttons in the right-hand columns are **20px** squares with **no margin**, so they sit edge to edge on the 20px grid. The row ends where the card ends.
- The card is `margin: 0 8px` with a 1px border; its inner padding is **8px** left and **12px** right (the toggle adds 4 on the left), so the first and last columns both stand 12px inside the card; the server header strip bleeds to the card's edge.
- Search box and fold button share the card's left and right edges (8px from the sidebar edge).
- **Do not let a spacing clean-up touch these.** Values on the sidebar's column path are alignment values, not spacing: `.dirtoggle` / `.srvtoggle`
  `gap: 6px` (a 14px chevron + 6 = the 20px step), `.gfold` and `.archtoggle` left offset 21, `.item .open` `padding-left: 39`, group member `59`. A 4px
  sweep once moved them to 4 and shifted the folder / tab icons to 42 / 66; `python3 scripts/ui-rulers.py x --seed` must still print 28 / 48 / 68 / 88 / 236 / 256.
- A 14px icon inside a 16px column is centred in it (`place-items: center`), never nudged with a margin. The one `translate` in `DirBlock.svelte` (archive header) exists because the 14px svg is not the same width as the 16px logo; its comment says so.
- Folded rows (`.dir.folded`, `.srvhead.folded`, a folded split tab, a folded archive) put the button where the count badge was, at the same centre (x 256): `+` on folders and servers, `⋯` on a split tab, the list button on an archive. The badge is 20px wide like those buttons, so one and two digits both centre on 264. On touch the buttons stay visible and the count keeps its room beside them.

When you add an icon or a button to a sidebar row: pick the column it belongs to, give it that column's box, and **measure** (section 6) instead of eyeballing.

## 4. Other tokens (already in `app.css`)

- Radius: `--radius-xs` 4, `--radius-sm` 8 (rows), `--radius-control` 10, `--radius` 12 (card), `--radius-panel` 16, `--radius-pill`.
  Containers step up (10 → 12 → 16) so nested corners stay concentric.
- Type: `--fs-2xs` 11 … `--fs-2xl` 20. Inputs are at least `--fs-lg` 16 on iOS (smaller zooms the page).
- Dialog widths: `--modal-w-s/m/l/xl` = 420 / 480 / 560 / 720, with `--modal-gutter` 24 to the screen edge.
- Stacking: `--z-modal-1..5`, `--z-scrim-1..5`, `--z-notice`, `--z-toast`, `--z-lightbox`. Do not add a raw `z-index`.

### Question and tool-call blocks (chat)

Applies to `ToolCard`, `QuestionReply` and the work box. Measured on 320 / 390 / 820 px; all values below are on the 4/8/12/16 scale.

- **Header** of a tool call: 44px high. Icon, name and summary sit on one row; the icon and the chevron are the same 16px box, so their centres match the row's centre. Name and summary share one baseline (`align-items: baseline`, both lines 20px).
- **Colour is the status.** A tool call's icon and name take the colour of its kind (`--th` from `badgeStyle`, no kind within 25° of the failure red, hue ~25). A failed call gets a red outline and a red icon, name, summary, time and chevron, and **no pill**. A call that is waiting is shown by the warn border and the block under it, never by a pill. Only *running*, *preparing* and *skipped* keep a pill.
- **Question block** (`.reply`): padding 12, groups 12 apart, left and right edges of the question, options and input all on the same 12px line.
- **Options** are equal-width buttons, 40px high (a long answer wraps to 58): two or three short answers (8 characters or fewer, the recommended one counts 2 more) share a row, four short ones make a 2x2, anything else is one per row. No numbers, no pills.
- **Recommended** answer: a 14px sparkle leading its text, in the warn colour. The button itself looks like the others, so it never reads as "already chosen". **Chosen** answer: a 2px text-colour border and a green check.
- **Input**: 40px high with the send arrow *inside* its right end (32px, 4px inset on three sides), hidden until there is text. The same control for typing and for "save" (check icon) in a multi-question block.
- **Steps** (several questions): up to 4 are numbered 28px circles joined by 16x2px lines, centred; answered = green outline and check, current = filled with the warn colour (a touch darker, 5:1 contrast), ahead = grey outline. From 5 questions on it is `‹ 3 / 8 ›` between two 28px arrows. Every circle and arrow carries `.tap`. The row is 28px and 12px above the question.
- **One height.** In a multi-question block the card keeps the same height on every tab (a question without an input holds the input's 40px).
- **Answers can be given in any order**: after an answer the block goes to the next unanswered question, else the first unanswered one before it; it sends only when every question has an answer.

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

### Left/right margin audit

Every dialog band (header, search strip, body, footer, list rows) must start and end at the gutter: **24 (phone 16) + the modal's 1px border**.
Popovers that are lists (`Palette`, queue) use a fixed **16**: their rows start at 16, so the title and the close glyph do too. A settings window's body starts
after its nav column (nav right edge + the same gutter). Measure the content (text range or control box), not a scroller: a scroller that gives 4px of focus-ring room
and takes it back with `margin: 0 -4px` still has its content on the gutter. Ellipsised and wrapped text is judged by its box.
Checked at 1440 / 820 / 390, light and dark: 223 bands over 29 screens, 0 off-rule sides (extension dialogs included, they are native `<dialog>` with
`padding: var(--dlg-head-t) var(--dlg-px) var(--dlg-foot-b)`).

### The conversation column (main screen)

Header title, the first tab's label, the conversation text, the composer box and the status line share **one left and one right line**: 16px from the pane
(on a wide pane the column is 760px, centred, so the line is wherever the column starts). Do not give the composer or the status line its own narrower side
padding in a narrow pane (it used to step down to 8 and stood 8px out from the text). The tab bar starts 8px from the window so its first label is at 16.
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
- A close button's hit box is wider than what you see: measure the glyph. Header padding is `calc(var(--dlg-px) - 9px)` so the glyph lands on the body's right edge.

### Extra facts in a tooltip

Facts that only some rows have (a model's abilities and context size) go in the row's native `title`, like the status line's readouts, not in the row and not in a custom popup. A row stays a name and its controls.

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
- 사이드바(288px)는 열의 **중심** 기준으로 **20px** 간격입니다: 화살표 28, 폴더 아이콘 48, 탭 아이콘 68, 분할 패널 아이콘 88, 목록 버튼 236, `+`/`⋯`/↺ 256. 카드는 사이드바 끝에서 8px, 카드 안쪽 첫 열·끝 열은 카드 끝에서 12px입니다. 우측 버튼은 20px, 마진 없음입니다.
- 눈대중으로 맞추지 말고 DOM의 아이콘 중심을 재서 맞춥니다(6장). 결과 보고는 수정 전/후를 가이드 있는 것과 없는 것으로 나란히, 숫자와 함께 냅니다.
- 공용 컴포넌트를 바꿀 때는 그것을 쓰는 모든 화면을 확인하고, 데스크톱 1440 · 태블릿 820 · 모바일 390 세 크기에서 확인합니다.
- 맞춤용 `margin: -1px`이나 `translate`로 땜질하지 않습니다. 크기가 틀린 박스를 고칩니다.
- 질문·도구 호출 블록: 상태는 색으로 말하고 칩은 쓰지 않습니다(실행 중·준비 중·실행 안 됨만 칩). 실패는 빨간 테두리와 빨간 글씨, 대기는 주황 테두리. 보기는 같은 폭의 40px 버튼, 추천은 글자 앞 반짝이, 고른 답은 굵은 테두리와 체크, 입력창 안에 보내기 화살표. 여러 질문은 28px 번호 원(4개까지)을 선으로 이은 단계 표시, 5개부터는 `‹ 3 / 8 ›`. 어느 탭에서도 카드 높이는 같습니다.

# DESIGN.md: how the client is laid out

Read this before you touch any style in `client/`. It is the short, enforceable version; the reasons, the sidebar grid and the
measuring recipes are in [`docs/design-system.md`](docs/design-system.md). Tokens live in `client/src/app.css` (`:root`).

## The ten rules

1. **Spacing is 4 / 8 / 12 / 16 / 24** (32+ for page gaps). No 6, 10, 14, 15, 22. The only exceptions: a 1px hairline,
   an optical value you measured (comment says what it aligns to), a safe area added on top (`calc(8px + var(--sab))`).
2. **px, not em, for spacing between blocks.** `0.85em` of a 15px font is 12.75px and the layout drifts off the 4px grid.
   em is fine only for things that must scale with their text (inline code padding, a text cursor) and then it carries a comment.
3. **Whole-pixel line boxes.** Any row, label or list item whose height matters gets `line-height: 20px` (or 16 / 24 / 28),
   never the body's `1.55`. A row = padding + line box + 1px hairline = whole numbers (36 + 1 = 37, not 37.14).
4. **One left line and one right line per surface.** Header, search, fields, list rows, footer buttons and the close glyph
   all start and end on the same gutter: dialogs `--dlg-px` (24, phone 16), the conversation column 16 from the pane,
   a bordered card 12 inside its border. Two edges 1 to 16px apart are a bug.
5. **Align the glyph, not the button.** A 38px icon button holds a 19px glyph 9.5px in; a 32px one holds 16px 8px in.
   To put the glyph on a line, the button bleeds by exactly that inset (`margin-left: -9.5px`, `-8px`), with a comment.
6. **Centre with the box, not with a nudge.** `top: calc(50% - 14px)` for a 28px box, `inset-inline: 0; margin-inline: auto`
   for a fixed-width bar. Never `top: 50%` + a guessed negative margin, never `translate` to fix an off box.
7. **Stacking only through tokens.** `z-index: var(--z-…)` from `app.css` for anything that crosses components
   (popover, dock, drawer, notice, modal layers, dropdown, toast, lightbox, tooltip). A raw 0-9 is fine inside one component; anything
   higher needs a token or a comment.
8. **Shared parts first.** Use `Modal`, `DialogBody`, `ListItem`, `ListGroup`, `ExtrasIntro`, `FormField`, `Button`, `IconButton`, `SearchField`, `Segmented`
   instead of re-writing their CSS. Change a shared part and you check every screen that uses it.
9. **Measure, never eyeball.** Read `getBoundingClientRect()` of the svg / text, not the wrapper. Every changed spot is checked
   at 1440×900, 820×1180 and 390×844, dark and light.
10. **Every exception carries a comment on the same line or the line above**: what it aligns to, or why it is not on the scale.
    No comment = it gets "fixed" by the next person.

## List dialogs (skills, MCP servers, extension commands, helper roles)

All four have one shape, so a new one is built from the same parts and never gets its own look:
`Modal` (title, `sub` = count and folder, refresh in `headerActions`) → `DialogBody gap` → `ExtrasIntro` (one sentence
that says what the thing is and who uses it, then one line on how) → one `ListGroup` per kind (heading, count, folder) →
`ListItem` cards. Add / edit goes in a dashed `Button` and an inline form. Do not restyle `.item`, `.desc` or `.meta`
from a screen: `ListItem` draws the card (page colour, `--border-strong`, so it reads on the dialog and on a grey
settings group) and a hairline between the description and the facts line.
Who uses what: skills and MCP tools are called by the agent, extension commands by the user (`/prefix:name`), helper
roles by the agent through `delegate`. Say it in the intro, in those words.

## Before you commit a style change

```sh
python3 scripts/ui-lint.py         # static: off-scale spacing, em spacing, raw z-index, uncommented negative margins (must print "clean")
python3 scripts/ui-rulers.py x --seed   # sidebar columns 28/48/68/88/236/256, rows 32 (needs .agents/bin/dev-up.sh)
```

Then capture the screens you touched (before and after, the changed spot boxed with its px) as described in `AGENTS.md`
("결과물 이미지"). `ui-lint` catches the number; only a measurement catches a wrong line, so do both.

## Common mistakes (all of these shipped once)

| Mistake | Symptom | Do instead |
|---|---|---|
| `margin: 0 0 0.85em` between markdown blocks | gaps of 12.75 / 14.25 / 23.8 / 9.1px | `12px` between blocks, a heading `24px 0 8px` |
| a list row with `padding: 8px` and the body line-height | rows 37.14px, borders drift and blur | `line-height: 20px` on the row |
| `.foot { margin-left: -4px }` on a row of 32px icon buttons | first icon 4px right of the text | `-8px` (the glyph's inset) |
| back arrow `margin-left: -8px` in a 38px button | glyph 1.5px inside the gutter | `-9.5px` |
| `top: 50%; margin-top: -12px` on a 28px arrow | 2px below the centre | `top: calc(50% - 14px)` |
| `left: 50%; margin-left: -19px` on a 38px bar | works until the width changes | `inset-inline: 0; margin-inline: auto` |
| `gap: 6px` between an 8px dot and its label | off-scale, uneven next to 4/8 chips | `gap: 8px` |
| `z-index: 20 / 49 / 50 / 110` scattered in components | layers collide when a new overlay lands | `--z-popover`, `--z-drawer`, `--z-dropdown`, … |

## 한국어 요약

- 간격은 4/8/12/16/24만, 블록 사이 간격은 em이 아니라 px로 줍니다(0.85em = 12.75px로 어긋남).
- 높이가 중요한 행·레이블은 `line-height: 20px` 같은 정수 줄 상자를 씁니다(37.14px 같은 소수 높이 금지).
- 한 화면(다이얼로그, 대화 열, 카드)의 모든 요소는 왼쪽 선 하나, 오른쪽 선 하나에 맞춥니다.
- 아이콘 버튼은 버튼이 아니라 글리프를 선에 맞춥니다(38px 버튼은 -9.5px, 32px 버튼은 -8px).
- 가운데 정렬은 `calc(50% - 높이/2)`나 `margin-inline: auto`로 하고, `translate`나 어림한 음수 마진으로 땜질하지 않습니다.
- z-index는 `app.css`의 `--z-*` 토큰만 씁니다(컴포넌트 안의 0~9 제외).
- 예외 값에는 같은 줄이나 바로 위 줄에 이유를 주석으로 답니다.
- 커밋 전에 `python3 scripts/ui-lint.py`가 "clean"이어야 하고, 바꾼 화면은 세 크기에서 재서 비포/애프터로 보고합니다.

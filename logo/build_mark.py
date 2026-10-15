#!/usr/bin/env python3
"""pipaya 마크 (a-crop 확정안): 작은 크기에서 보이도록 열매를 키우고 여백을 잘라 냈다. 눈/깜빡임 없음.
실행: python3 logo/build_mark.py   -> logo/svg/mark*.svg, favicon.svg, app-icon*.svg
기하는 client/src/components/PipayaMark.svelte 와 같다.
"""
from pathlib import Path

SVG = Path(__file__).resolve().parent / "svg"
TRUNK = "M52 60H76L84 118H44Z"
LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z"
CFG = [(-80, .8), (-42, .95), (0, 1), (42, .95), (80, .8)]
FRUITS = [(56, 66, 9), (72, 66, 9)]
GAP = 3.2
VB = "15 12 98 98"
DARK = dict(trunk="#7a5b44", leaf="#4a9443", fruit="#f08a24")
LIGHT = dict(trunk="#5a4130", leaf="#2f6d2d", fruit="#f08a24")


def num(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def body(mid, trunk, leaf, fruit):
    knock = "".join(f'<circle cx="{x}" cy="{y}" r="{r + GAP}" fill="#000"/>' for x, y, r in FRUITS)
    leaves = "".join(
        f'<path d="{LEAF}" transform="translate(64 62) rotate({a}) scale(1.05 {num(k * 1.05)})"/>' for a, k in CFG
    )
    fr = "".join(f'<circle cx="{x}" cy="{y}" r="{r}" fill="{fruit}"/>' for x, y, r in FRUITS)
    return (
        f'<defs><mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">'
        f'<rect width="128" height="128" fill="#fff"/>{knock}</mask></defs>'
        f'<g mask="url(#{mid})"><path d="{TRUNK}" fill="{trunk}"/>'
        f'<g fill="{leaf}"><ellipse cx="64" cy="58" rx="6" ry="8"/>{leaves}</g></g>{fr}'
    )


def mark(pal=None, size=104):
    if pal:
        b = body("m", pal["trunk"], pal["leaf"], pal["fruit"])
    else:
        b = body("m", "currentColor", "currentColor", "currentColor")
    fill = "" if pal else ' fill="currentColor"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{VB}" width="{size}" height="{size}"{fill} '
            f'role="img" aria-label="pipaya">{b}</svg>\n')


ICON_SCALE = 8.4  # 128 그리드 -> 1024. 나무 높이(약 105)가 캔버스의 약 86%, 폭 약 62%
ICON_CENTER = (64, 66)


def app_icon(glyph_only=False):
    tx = 512 - ICON_CENTER[0] * ICON_SCALE
    ty = 512 - ICON_CENTER[1] * ICON_SCALE
    bg = "" if glyph_only else '<rect width="1024" height="1024" fill="#FFFFFF"/>'
    b = body("ki", "#111111", "#111111", "#111111")
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'{bg}<g transform="translate({num(tx)} {num(ty)}) scale({ICON_SCALE})">{b}</g></svg>\n')


def main():
    SVG.mkdir(parents=True, exist_ok=True)
    (SVG / "mark.svg").write_text(mark(DARK))
    (SVG / "mark-light.svg").write_text(mark(LIGHT))
    (SVG / "mark-mono.svg").write_text(mark())
    (SVG / "favicon.svg").write_text(mark().replace("currentColor", "#111111"))
    (SVG / "app-icon.svg").write_text(app_icon())
    (SVG / "app-icon-glyph.svg").write_text(app_icon(True))
    print("ok")


if __name__ == "__main__":
    main()

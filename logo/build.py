#!/usr/bin/env python3
"""pipaya 로고 SVG 생성기.  실행: python3 logo/build.py   (logo/svg/ 를 다시 만든다)

기하(128 그리드)는 index.html(미리보기)의 값과 같다. 바꿀 땐 두 곳을 같이 고칠 것.
표정 좌표는 client/src/lib/faces.ts 와 같지만 `at` 오프셋은 쓰지 않고, 눈 영역의 중심을 항상 줄기 중심에 맞춘다.
"""
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent / "svg"

TRUNK = "M52 60H76L84 118H44Z"
LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z"
CFG = [(-80, .8), (-42, .95), (0, 1), (42, .95), (80, .8)]
CROWN_FILL = (64, 53.5, 5.5, 7.5)  # 잎·열매 사이 빈틈을 메우는 타원 (cx, cy, rx, ry)
FRUITS = [(58, 64), (70, 64)]
FRUIT_R, FRUIT_KNOCK = 5.2, 8.2
FACE_C, FS = (64, 89), .78

DARK = dict(trunk="#7a5b44", leaf="#4a9443", fruit="#f08a24", eye="#fbf3e2")
LIGHT = dict(trunk="#5a4130", leaf="#2f6d2d", fruit="#f08a24", eye="#fbf3e2")
ICON_BG = "#161616"

FACES = {
    "block": ["M-14 -5.5L-6 -5.5L-6 5.5L-14 5.5Z", "M6 -5.5L14 -5.5L14 5.5L6 5.5Z"],
    "slit": ["M-15 -2L-5 -2L-5 2L-15 2Z", "M5 -2L15 -2L15 2L5 2Z"],
    "pixel": ["M-14 -5L-8 -5L-6 -3L-6 5L-12 5L-14 3Z", "M6 -3L8 -5L14 -5L14 3L12 5L6 5Z"],
    "happy": ["M-15 2L-11 -3L-9 -3L-5 2L-7 4.5L-10 1L-13 4.5Z", "M5 2L9 -3L11 -3L15 2L13 4.5L10 1L7 4.5Z"],
    "focus": ["M-15 -5L-5 -1L-5 5L-15 1Z", "M5 -1L15 -5L15 1L5 5Z"],
    "curious": ["M-14 -3L-6 -3L-6 3L-14 3Z", "M5 -6.5L14 -6.5L14 6.5L5 6.5Z"],
    "wink": ["M-14 -5.5L-6 -5.5L-6 5.5L-14 5.5Z", "M5 2L9 -3L11 -3L15 2L13 4.5L10 1L7 4.5Z"],
    "sleepy": ["M-15 -2L-5 -2L-7 2L-13 2Z", "M5 -2L15 -2L13 2L7 2Z"],
}

BLINK_CSS = (
    ".eye{transform-box:fill-box;transform-origin:center;animation:b 3s infinite}"
    "@keyframes b{0%,26.667%{transform:scaleY(1)}28.667%,29.333%{transform:scaleY(.07)}"
    "32.667%,63.333%{transform:scaleY(1)}65.333%,66%{transform:scaleY(.07)}69.333%,100%{transform:scaleY(1)}}"
    "@media(prefers-reduced-motion:reduce){.eye{animation:none}}"
)


def num(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def bbox_center(paths):
    xs, ys = [], []
    for d in paths:
        v = [float(x) for x in re.findall(r"-?\d+(?:\.\d+)?", d)]
        xs += v[0::2]
        ys += v[1::2]
    return (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2


def eyes(face, fill, cls=False):
    paths = FACES[face]
    cx, cy = bbox_center(paths)
    tx, ty = FACE_C[0] - cx * FS, FACE_C[1] - cy * FS
    c = ' class="eye"' if cls else ""
    body = "".join(f'<path{c} d="{d}"/>' for d in paths)
    return f'<g transform="translate({num(tx)} {num(ty)}) scale({FS})" fill="{fill}">{body}</g>'


def fronds(fill):
    return "".join(
        f'<path d="{LEAF}" transform="translate(64 59) rotate({a}) scale(.92 {k})" fill="{fill}"/>' for a, k in CFG
    )


def crown(fill=None):
    cx, cy, rx, ry = CROWN_FILL
    f = f' fill="{fill}"' if fill else ""
    return f'<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}"{f}/>'


def color_body(face, pal, animated):
    fr = "".join(f'<circle cx="{x}" cy="{y}" r="{FRUIT_R}" fill="{pal["fruit"]}"/>' for x, y in FRUITS)
    return (
        f'<path d="{TRUNK}" fill="{pal["trunk"]}"/>{crown(pal["leaf"])}{fronds(pal["leaf"])}{fr}'
        f'{eyes(face, pal["eye"], animated)}'
    )


def color_svg(face="block", pal=DARK, animated=False, title="pipaya"):
    style = f"<style>{BLINK_CSS}</style>" if animated else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="{title}">'
        f'{style}{color_body(face, pal, animated)}</svg>\n'
    )


def mono_svg(face="block", animated=False, title="pipaya"):
    knock = "".join(f'<circle cx="{x}" cy="{y}" r="{FRUIT_KNOCK}" fill="#000"/>' for x, y in FRUITS)
    fr = "".join(f'<circle cx="{x}" cy="{y}" r="{FRUIT_R}"/>' for x, y in FRUITS)
    style = f"<style>{BLINK_CSS}</style>" if animated else ""
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" fill="currentColor" role="img" aria-label="{title}">{style}'
        f'<defs><mask id="k" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128"><rect width="128" height="128" fill="#fff"/>'
        f'{knock}{eyes(face, "#000", animated)}</mask></defs>'
        f'<g mask="url(#k)"><path d="{TRUNK}"/>{crown()}{fronds("currentColor")}</g>{fr}</svg>\n'
    )


ICON_SCALE = 6.6  # 128 그리드 -> 1024 캔버스 배율. 나무 높이(약 105)가 캔버스의 약 68%가 된다.
ICON_CENTER = (64, 65.5)  # 아트워크 bbox의 중심 (128 그리드). 이 점을 캔버스 중앙에 맞춘다.


def app_icon(glyph_only=False):
    tx = 512 - ICON_CENTER[0] * ICON_SCALE
    ty = 512 - ICON_CENTER[1] * ICON_SCALE
    bg = "" if glyph_only else f'<rect width="1024" height="1024" fill="{ICON_BG}"/>'
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
        f'{bg}<g transform="translate({num(tx)} {num(ty)}) scale({ICON_SCALE})">{color_body("block", DARK, False)}</g></svg>\n'
    )


def main():
    (OUT / "faces").mkdir(parents=True, exist_ok=True)
    (OUT / "pipaya.svg").write_text(color_svg())
    (OUT / "pipaya-light.svg").write_text(color_svg(pal=LIGHT))
    (OUT / "pipaya-mono.svg").write_text(mono_svg())
    (OUT / "pipaya-animated.svg").write_text(color_svg(animated=True))
    (OUT / "pipaya-mono-animated.svg").write_text(mono_svg(animated=True))
    (OUT / "app-icon.svg").write_text(app_icon())
    (OUT / "app-icon-glyph.svg").write_text(app_icon(glyph_only=True))
    for n in FACES:
        (OUT / "faces" / f"{n}.svg").write_text(color_svg(n))
        (OUT / "faces" / f"{n}-mono.svg").write_text(mono_svg(n))
    print("wrote", len(list(OUT.rglob("*.svg"))), "svg files ->", OUT)


if __name__ == "__main__":
    main()

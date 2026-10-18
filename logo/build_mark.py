#!/usr/bin/env python3
"""pipaya 마크 (정사각 크라운안): 양쪽 잎을 수평 아래로 늘어뜨려 크라운을 1:1에 가깝게 만들고, 열매를 키웠다. 눈/깜빡임 없음.

두 가지 형태가 같은 크라운(잎 5장 + 순 + 열매 2개)을 공유한다.
  mark  나무 전체 (짧고 굵은 줄기). 사이드바·빈 화면·파비콘·알림 아이콘 등 타일 없이 쓰는 곳.
  tile  1024 앱 아이콘. 크라운이 타일 폭의 약 86%를 채우고, 줄기는 타일 아래 끝까지 흘려 보낸다.

실행: python3 logo/build_mark.py
  -> logo/svg/mark.svg · mark-light.svg · mark-mono.svg · favicon.svg · app-icon.svg · app-icon-glyph.svg
     · app-icon-adaptive.svg (안드로이드 전경) · app-icon-mark.svg (알림 아이콘용 실루엣)
기하는 client/src/components/PipayaMark.svelte 와 같다 (MARK_VIEWBOX, 잎·열매·줄기 값).
앱 아이콘 PNG는 client/scripts/render-icons.ts -> make-icons.py 로 만든다.
"""
import math
from pathlib import Path

SVG = Path(__file__).resolve().parent / "svg"

CROWN = (64, 62)  # 잎이 뻗어 나가는 점
LEAF_W = 13  # 잎 곡선 제어점 폭 (잎 최대 반폭 ≈ 0.75 * LEAF_W)
LEAF_K = 1.1  # 잎 공통 배율
FRONDS = [(-100, .9), (-50, 1.0), (0, .94), (50, 1.0), (100, .9)]  # (각도, 길이 비)
BUD = (64, 58, 6.5, 8.5)  # 잎 사이 빈틈을 메우는 순 (cx, cy, rx, ry)
FRUITS = [(55.5, 68, 10.5), (72.5, 68, 10.5)]
GAP = 3.2  # 열매 둘레 노크아웃
MARK_TRUNK = (62, 13, 106, 22)  # (위 y, 위 반폭, 아래 y, 아래 반폭)
TILE_TRUNK = (62, 13, 150, 28)  # 타일 밖까지 이어지는 줄기 (같은 기울기)

DARK = dict(trunk="#7a5b44", leaf="#4a9443", fruit="#f08a24")
LIGHT = dict(trunk="#5a4130", leaf="#2f6d2d", fruit="#f08a24")
MONO = "#111111"
TILE_BG = "#fbf3e2"  # 앱 아이콘 타일 (크림)
TILE_CROWN_W = 0.86  # 크라운 폭 / 타일 폭
TILE_TOP = 0.075  # 가운데 잎 끝 위 여백 / 타일


def num(v):
    return f"{v:.2f}".rstrip("0").rstrip(".")


def leaf_d():
    w = LEAF_W
    return f"M0 0C{-w} -12 {-w} -30 0 -46C{w} -30 {w} -12 0 0Z"


def _leaf_pts(n=64):
    def bez(t, p):
        u = 1 - t
        return sum(c * q for c, q in zip((u ** 3, 3 * u * u * t, 3 * u * t * t, t ** 3), p))

    pts = []
    for s in (-1, 1):
        xs, ys = (0, -s * LEAF_W, -s * LEAF_W, 0), (0, -12, -30, -46)
        pts += [(bez(i / n, xs), bez(i / n, ys)) for i in range(n + 1)]
    return pts


def crown_bbox():
    """잎·순·열매 (줄기 제외) 의 bbox, 128 그리드."""
    cx, cy = CROWN
    pts = []
    for a, k in FRONDS:
        r = math.radians(a)
        c, s = math.cos(r), math.sin(r)
        sx, sy = LEAF_K, LEAF_K * k
        pts += [(cx + c * x * sx - s * y * sy, cy + s * x * sx + c * y * sy) for x, y in _leaf_pts()]
    for x, y, r in FRUITS:
        pts += [(x - r, y - r), (x + r, y + r)]
    xs, ys = [p[0] for p in pts], [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


def mark_viewbox(pad=3):
    x0, y0, x1, y1 = crown_bbox()
    y1 = max(y1, MARK_TRUNK[2])
    side = max(x1 - x0, y1 - y0) + 2 * pad
    return (x0 + x1) / 2 - side / 2, (y0 + y1) / 2 - side / 2, side


def trunk_d(t):
    ty, th, by, bh = t
    cx = CROWN[0]
    return f"M{num(cx - th)} {num(ty)}H{num(cx + th)}L{num(cx + bh)} {num(by)}H{num(cx - bh)}Z"


def body(mid, trunk, leaf, fruit, t=MARK_TRUNK):
    cx, cy = CROWN
    knock = "".join(f'<circle cx="{num(x)}" cy="{num(y)}" r="{num(r + GAP)}" fill="#000"/>' for x, y, r in FRUITS)
    leaves = "".join(
        f'<path d="{leaf_d()}" transform="translate({num(cx)} {num(cy)}) rotate({a}) scale({num(LEAF_K)} {num(LEAF_K * k)})"/>'
        for a, k in FRONDS)
    bx, by, rx, ry = BUD
    fr = "".join(f'<circle cx="{num(x)}" cy="{num(y)}" r="{num(r)}" fill="{fruit}"/>' for x, y, r in FRUITS)
    return (f'<defs><mask id="{mid}" maskUnits="userSpaceOnUse" x="-64" y="-64" width="256" height="256">'
            f'<rect x="-64" y="-64" width="256" height="256" fill="#fff"/>{knock}</mask></defs>'
            f'<g mask="url(#{mid})"><path d="{trunk_d(t)}" fill="{trunk}"/>'
            f'<g fill="{leaf}"><ellipse cx="{num(bx)}" cy="{num(by)}" rx="{num(rx)}" ry="{num(ry)}"/>{leaves}</g></g>{fr}')


def mark(pal=None, size=104, fixed=None):
    x, y, s = mark_viewbox()
    if pal:
        b, fill = body("m", pal["trunk"], pal["leaf"], pal["fruit"]), ""
    else:
        c = fixed or "currentColor"
        b, fill = body("m", c, c, c), f' fill="{c}"'
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{num(x)} {num(y)} {num(s)} {num(s)}" width="{size}" '
            f'height="{size}"{fill} role="img" aria-label="pipaya">{b}</svg>\n')


def tile_transform(crown_w=TILE_CROWN_W, top=TILE_TOP, canvas=1024):
    x0, y0, x1, y1 = crown_bbox()
    k = canvas * crown_w / (x1 - x0)
    return canvas / 2 - (x0 + x1) / 2 * k, canvas * top - y0 * k, k


def tile_radius(crown_w=TILE_CROWN_W, top=TILE_TOP):
    """크라운에서 타일 중심까지 가장 먼 거리 / 타일 한 변 (원형 마스크는 0.5 안쪽이어야 잘리지 않는다)."""
    tx, ty, k = tile_transform(crown_w, top, 1)
    cx, cy = CROWN
    far = 0.0
    for a, kk in FRONDS:
        r = math.radians(a)
        c, s = math.cos(r), math.sin(r)
        for x, y in _leaf_pts():
            x, y = x * LEAF_K, y * LEAF_K * kk
            px, py = tx + (cx + c * x - s * y) * k, ty + (cy + s * x + c * y) * k
            far = max(far, math.hypot(px - .5, py - .5))
    return far


def _tile(bg, crown_w, top):
    tx, ty, k = tile_transform(crown_w, top)
    rect = f'<rect width="1024" height="1024" fill="{bg}"/>' if bg else ""
    b = body("ki", LIGHT["trunk"], LIGHT["leaf"], LIGHT["fruit"], TILE_TRUNK)
    return ('<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">'
            f'{rect}<clipPath id="c"><rect width="1024" height="1024"/></clipPath>'
            f'<g clip-path="url(#c)"><g transform="translate({num(tx)} {num(ty)}) scale({num(k)})">{b}</g></g></svg>\n')


def app_icon(glyph_only=False):
    return _tile(None if glyph_only else TILE_BG, TILE_CROWN_W, TILE_TOP)


# 안드로이드 적응형 아이콘 전경 (108dp 레이어). 런처는 가운데 72dp만 보여 주고 원/스쿼클로 더 깎으므로
# 크라운을 가운데 2/3 (+ 여유) 안에 두고, 줄기는 레이어 아래 끝까지 흘려 보낸다. 배경은 TILE_BG 단색.
ADAPTIVE_CROWN_W = TILE_CROWN_W * 72 / 108 * 0.92
ADAPTIVE_TOP = 18 / 108 + TILE_TOP * 72 / 108 + 0.02


def app_icon_adaptive():
    return _tile(None, ADAPTIVE_CROWN_W, ADAPTIVE_TOP)


def app_icon_mark():
    """나무 전체를 1024 투명 캔버스 가운데에 (알림 아이콘처럼 타일 없이 실루엣만 쓰는 곳)."""
    x, y, s = mark_viewbox()
    b = body("ki", MONO, MONO, MONO)
    return (f'<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="{num(x)} {num(y)} {num(s)} {num(s)}">'
            f'{b}</svg>\n')


def main():
    SVG.mkdir(parents=True, exist_ok=True)
    (SVG / "mark.svg").write_text(mark(DARK))
    (SVG / "mark-light.svg").write_text(mark(LIGHT))
    (SVG / "mark-mono.svg").write_text(mark())
    (SVG / "favicon.svg").write_text(mark(DARK))  # 컬러 (위키와 동일). 밝은/어두운 탭 모두에서 보이는 DARK 팔레트
    (SVG / "app-icon.svg").write_text(app_icon())
    (SVG / "app-icon-glyph.svg").write_text(app_icon(True))
    (SVG / "app-icon-adaptive.svg").write_text(app_icon_adaptive())
    (SVG / "app-icon-mark.svg").write_text(app_icon_mark())
    x0, y0, x1, y1 = crown_bbox()
    tx, ty, k = tile_transform()
    print(f"crown {x1 - x0:.1f} x {y1 - y0:.1f} | mark viewBox {' '.join(num(v) for v in mark_viewbox())}")
    print(f"circle reach: tile {tile_radius():.3f}  adaptive {tile_radius(ADAPTIVE_CROWN_W, ADAPTIVE_TOP) * 108 / 33:.3f} of safe circle")
    print(f"tile: crown {tx + x0 * k:.0f}..{tx + x1 * k:.0f} x {ty + y0 * k:.0f}..{ty + y1 * k:.0f} px")


if __name__ == "__main__":
    main()

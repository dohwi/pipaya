#!/usr/bin/env python3
"""파파야 열매 기반 pipaya 아이콘 후보. 실행: python3 logo/build_papaya.py
-> logo/svg/papaya/<name>-{color,mono}.svg + logo/papaya.html (크기별 비교)
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "svg" / "papaya"
PEAR = "M64 10C75 10 80 26 85 46C92 70 100 88 92 106C86 120 42 120 36 106C28 88 36 70 43 46C48 26 53 10 64 10Z"
LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z"
GREEN, ORANGE, CREAM, DARK, LEAFC, BROWN = "#6aa84f", "#f08a24", "#fde3b0", "#1a1a1a", "#3f8a3a", "#7a5b44"
CS, CY = .56, 75  # 단면 구멍 배율/중심 y


def pear(s=1, cx=64, cy=65, **a):
    at = " ".join(f'{k.replace("_", "-")}="{v}"' for k, v in a.items())
    return f'<path d="{PEAR}" transform="translate({cx} {cy}) scale({s}) translate(-64 -65)" {at}/>'


def leaves(ox, oy, cfg, s, fill):
    return "".join(
        f'<path d="{LEAF}" transform="translate({ox} {oy}) rotate({a}) scale({s * .9} {s * k})" fill="{fill}"/>' for a, k in cfg
    )


def seeds(fill):
    pts = [(58, 66), (70, 66), (53, 77), (64, 77), (75, 77), (58, 88), (70, 88)]
    return "".join(f'<ellipse cx="{x}" cy="{y}" rx="3.6" ry="4.8" fill="{fill}"/>' for x, y in pts)


def eyes(fill):
    return "".join(f'<rect x="{x}" y="62" width="9" height="16" rx="1.5" fill="{fill}"/>' for x in (51, 68))


def few_seeds(fill):
    return "".join(f'<ellipse cx="{x}" cy="91" rx="3.2" ry="4.2" fill="{fill}"/>' for x in (55, 64, 73))


def mono_wrap(i, knock, body, top=""):
    return (f'<defs><mask id="{i}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">'
            f'<rect width="128" height="128" fill="#fff"/>{knock}</mask></defs>'
            f'<g fill="currentColor"><g mask="url(#{i})">{body}</g>{top}</g>')


# --- 각 후보: (mode, id) -> svg 내부 ---
def half(m, i, face=False):
    cav = pear(CS, 64, CY)
    if m == "c":
        return (pear(1, fill=GREEN) + pear(.88, fill=ORANGE) + pear(CS, 64, CY, fill=CREAM)
                + (eyes(DARK) + few_seeds(DARK) if face else seeds(DARK)))
    return mono_wrap(i, pear(CS, 64, CY, fill="#000"), pear(1), (eyes("currentColor") + few_seeds("currentColor")) if face else seeds("currentColor"))


def whole(m, i):
    rot = 'transform="rotate(14 64 64)"'
    stem = '<path d="M59 16L59 3Q64 -1 69 3L69 16Z"/>'
    lf = f'<path d="{LEAF}" transform="translate(66 8) rotate(62) scale(.55 .6)"/>'
    ey = "".join(f'<rect x="{x}" y="64" width="9" height="17" rx="1.5" fill="{{f}}"/>' for x in (51, 68))
    if m == "c":
        return (f'<g {rot}>' + pear(1, fill=ORANGE) + stem.replace("<path", f'<path fill="{LEAFC}"')
                + f'{ey.format(f=CREAM)}</g>' + lf.replace("<path", f'<path fill="{LEAFC}"'))
    return mono_wrap(i, f'<g {rot}>{ey.format(f="#000")}</g>', f'<g {rot}>{pear(1)}{stem}</g>{lf}')


def tree(m, i):
    cfg = [(-75, .8), (-38, .95), (0, 1), (38, .95), (75, .8)]
    fr = [(50, 80), (78, 80)]
    trunk = '<path d="M58 58H70L72 120H56Z"/>'
    if m == "c":
        return (trunk.replace("<path", f'<path fill="{BROWN}"') + leaves(64, 54, cfg, .9, LEAFC)
                + "".join(pear(.42, x, y, fill=ORANGE) for x, y in fr))
    knock = "".join(pear(.42, x, y, fill="#000", stroke="#000", stroke_width=9) for x, y in fr)
    return mono_wrap(i, knock, trunk + leaves(64, 54, cfg, .9, "currentColor"),
                     "".join(pear(.42, x, y) for x, y in fr))


def sprout(m, i):
    cfg = [(-55, .75), (0, 1), (55, .75)]
    tf = 'transform="translate(64 88) scale(.76) translate(-64 -70)"'
    body = half(m, i + "h")
    lv = leaves(64, 48, cfg, .75, LEAFC if m == "c" else "currentColor")
    return f"{lv}<g {tf}>{body}</g>"


def outline(m, i):
    col = ORANGE if m == "c" else "currentColor"
    fill = CREAM if m == "c" else "none"
    sd = seeds(DARK if m == "c" else "currentColor")
    return (pear(.86, 64, 68, fill=fill, stroke=col, stroke_width=10, stroke_linejoin="round") + sd.replace(
        'rx="3.6" ry="4.8"', 'rx="3.2" ry="4.2"'))


def pair(m, i):
    # 열매 두 개(단면 + 통열매) — pipaya의 '열매 2개'를 파파야로
    a = f'<g transform="translate(40 66) scale(.62) translate(-64 -65)">{half(m, i + "a")}</g>'
    cfg = [(-30, .8), (30, .8)]
    b = (pear(.62, 90, 68, fill=ORANGE) if m == "c" else pear(.62, 90, 68))
    st = f'<path d="M86 34L86 24Q90 21 94 24L94 36Z" fill="{LEAFC if m == "c" else "currentColor"}"/>'
    return f"{a}{b}{st}"


VARIANTS = {
    "1-half-seeds": lambda m, i: half(m, i),
    "2-half-face": lambda m, i: half(m, i, True),
    "3-whole-face": whole,
    "4-tree-fruits": tree,
    "5-half-sprout": sprout,
    "6-outline": outline,
}

_n = [0]


def svg(name, m, size=128):
    _n[0] += 1
    inner = VARIANTS[name](m, f"p{_n[0]}")
    ex = ' fill="currentColor"' if m == "m" else ""
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="{size}" height="{size}"{ex} '
            f'role="img" aria-label="pipaya">{inner}</svg>')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    sizes = [16, 24, 32, 48, 64]
    rows = ""
    for n in VARIANTS:
        for m, lab in (("c", "color"), ("m", "mono")):
            (OUT / f"{n}-{lab}.svg").write_text(svg(n, m, 128).replace('width="128" height="128"', 'width="128" height="128"') + "\n")
        def strip(m):
            return "".join(f'<div class="c">{svg(n, m, z)}<small>{z}</small></div>' for z in sizes)
        rows += (f'<div class="row"><b>{n}</b>'
                 f'<div class="bg l big">{svg(n, "c", 128)}</div>'
                 f'<div class="bg l">{strip("c")}</div><div class="bg d">{strip("c")}</div>'
                 f'<div class="bg l">{strip("m")}</div><div class="bg d">{strip("m")}</div>'
                 f'<div class="bg o">{strip("m")}</div></div>')
    html = f"""<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pipaya papaya icons</title><style>
body{{font:14px system-ui;margin:24px;background:#8d8d8d;color:#111}}
.row{{margin-bottom:20px}}b{{display:block;margin-bottom:6px;color:#fff;font-size:16px}}
.bg{{display:inline-flex;gap:14px;align-items:end;padding:12px 16px;border-radius:10px;margin:0 8px 8px 0;vertical-align:top}}
.l{{background:#fff;color:#111}}.d{{background:#1c1c1c;color:#eee}}.o{{background:#f08a24;color:#111}}
.c{{display:grid;gap:4px;justify-items:center}}small{{font-size:10px;opacity:.6}}
</style><h2 style="color:#fff">파파야 열매 기반 후보 · 왼쪽부터: 큰 컬러 / 컬러(밝은·어두운 배경) / 단색(밝은·어두운·주황 배경)</h2>{rows}</html>"""
    (ROOT / "papaya.html").write_text(html)
    print("ok", len(VARIANTS))


if __name__ == "__main__":
    main()

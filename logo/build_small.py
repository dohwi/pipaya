#!/usr/bin/env python3
"""작은 크기(16~64px, 트레이/파비콘/앱 아이콘)용 pipaya 변형. 열매를 크게, 눈/줄기는 크롭.
실행: python3 logo/build_small.py  -> logo/svg/small/*.svg + logo/small.html
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "svg" / "small"
LEAF = "M0 0C-11 -12 -11 -30 0 -46C11 -30 11 -12 0 0Z"
TRUNK = "M52 60H76L84 118H44Z"
FG = "#111111"

# name: (viewBox, leaves[(angle, scaleY)], fruits[(cx, cy, r)], knock gap, trunk, leaf origin)
VARIANTS = {
    "a-crop": dict(vb="12 6 104 104", leaves=[(-80, .8), (-42, .95), (0, 1), (42, .95), (80, .8)],
                   fruits=[(56, 66, 9), (72, 66, 9)], gap=3.2, trunk=True),
    "b-bold": dict(vb="18 10 92 92", leaves=[(-70, .8), (0, 1), (70, .8)],
                   fruits=[(52, 68, 13), (76, 68, 13)], gap=3.5, trunk=True),
    "c-fruit": dict(vb="20 14 88 88", leaves=[(-35, .75), (35, .75)],
                    fruits=[(50, 70, 17), (78, 70, 17)], gap=4, trunk=False),
}


def body(v, fg, mid):
    knock = "".join(f'<circle cx="{x}" cy="{y}" r="{r + v["gap"]}" fill="#000"/>' for x, y, r in v["fruits"])
    leaves = "".join(
        f'<path d="{LEAF}" transform="translate(64 62) rotate({a}) scale(1.05 {k * 1.05})"/>' for a, k in v["leaves"]
    )
    trunk = f'<path d="{TRUNK}"/>' if v["trunk"] else ""
    fr = "".join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in v["fruits"])
    return (
        f'<defs><mask id="{mid}" maskUnits="userSpaceOnUse" x="0" y="0" width="128" height="128">'
        f'<rect width="128" height="128" fill="#fff"/>{knock}</mask></defs>'
        f'<g fill="{fg}"><g mask="url(#{mid})">{trunk}<ellipse cx="64" cy="58" rx="6" ry="8"/>{leaves}</g>{fr}</g>'
    )


def svg(name, v, fg="currentColor", size=128):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="{v["vb"]}" width="{size}" height="{size}" '
            f'role="img" aria-label="pipaya">{body(v, fg, "m" + name[0])}</svg>\n')


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for n, v in VARIANTS.items():
        (OUT / f"{n}.svg").write_text(svg(n, v, FG))
    # 현재(원본) 파비콘과 비교용
    orig = (ROOT / "svg" / "favicon.svg").read_text().replace('width="128" height="128"', 'width="SZ" height="SZ"')
    rows = []
    sizes = [16, 24, 32, 48, 64]
    items = [("현재 (원본)", orig, 1)] + [(n, svg(n, v, "currentColor", "SZ"), 0) for n, v in VARIANTS.items()]
    for label, s, isorig in items:
        cells = ""
        for z in sizes:
            inner = s.replace("SZ", str(z)).replace('id="k"', f'id="k{z}"').replace("url(#k)", f"url(#k{z})")
            if not isorig:
                inner = inner.replace('id="m', f'id="z{z}m').replace("url(#m", f"url(#z{z}m")
            cells += f'<div class="c">{inner}<small>{z}</small></div>'
        rows.append(f'<div class="row"><b>{label}</b><div class="bg l">{cells}</div><div class="bg d">{cells}</div>'
                    f'<div class="bg o">{cells}</div></div>')
    html = f"""<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>pipaya small icons</title><style>
body{{font:14px system-ui;margin:24px;background:#888;color:#111}}
.row{{margin-bottom:22px}}b{{display:block;margin-bottom:6px;color:#fff}}
.bg{{display:inline-flex;gap:16px;align-items:end;padding:14px 18px;border-radius:10px;margin-right:10px;vertical-align:top}}
.l{{background:#fff;color:#111}}.d{{background:#1c1c1c;color:#eee}}.o{{background:#f08a24;color:#111}}
.c{{display:grid;gap:4px;justify-items:center}}small{{font-size:10px;opacity:.6}}
</style><h2 style="color:#fff">pipaya 작은 크기 비교</h2>{''.join(rows)}</html>"""
    (ROOT / "small.html").write_text(html)
    print("ok")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Measure the sidebar against docs/design-system.md and draw rulers on a plain screenshot.

Usage: python3 scripts/ui-rulers.py <name> [--seed]
Needs .agents/bin/dev-up.sh to have run (this worktree's own dev pair). Writes under tmp/shots/ (gitignored):
  <name>-plain.png   the sidebar, hover-only buttons forced visible, no guides
  <name>.png         the same with column lines, a top ruler (gap between columns) and a left ruler
                     (teal = element height, magenta = space between), plus the numbers printed on stdout.
--seed adds one folder with a conversation, an archived one, a terminal and a split tab, so every row type exists.
Expected result on a clean tree: columns 24 / 44 / 64 / 244 / 264 on a 288px sidebar, every row 32px.
"""
import json, pathlib, subprocess, sys, urllib.request

from PIL import Image, ImageDraw, ImageFont
from playwright.sync_api import sync_playwright

root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
envf = root / "tmp/dev/env"
if not envf.exists():
    sys.exit("ui-rulers: run .agents/bin/dev-up.sh first")
env = dict(l.split("=", 1) for l in envf.read_text().split() if "=" in l)
name = sys.argv[1] if len(sys.argv) > 1 and not sys.argv[1].startswith("--") else "rulers"
tok = pathlib.Path(env["TOKEN_FILE"]).read_text().strip()
base = f"http://127.0.0.1:{env['SERVER_PORT']}"


def api(method, path, body=None):
    req = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Authorization": f"Bearer {tok}", "content-type": "application/json"})
    with urllib.request.urlopen(req) as r:
        raw = r.read()
    return json.loads(raw) if raw else None


def seed():
    api("PUT", "/configuration/providers/fake", {"name": "fake", "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "authRequired": False,
                                                  "models": [{"id": "m1", "contextWindow": 100000, "maxTokens": 4000, "reasoning": False, "vision": False}]})
    mk = lambda cwd, title: api("POST", "/sessions", {"cwd": cwd, "title": title})["id"]
    mk("alpha", "로그인 버그 수정")
    for t in ("API 리팩터링", "테스트 추가"):
        api("PATCH", f"/sessions/{mk('alpha', t)}", {"archived": True})
    a, b = mk("beta", "문서 정리"), mk("beta", "차트 컴포넌트")
    pane = lambda i: {"type": "pane", "sessionId": i}
    api("POST", "/groups", {"layout": {"type": "split", "dir": "row", "ratio": 0.5, "a": pane(a), "b": pane(b)}})
    api("POST", "/terminals", {"cwd": "alpha", "title": "zsh"})


if "--seed" in sys.argv:
    seed()

SEEDS = {"pipaya.servers": json.dumps([{"id": "dev", "name": "dev", "baseUrl": base, "token": tok}]), "pipaya.server": json.dumps("dev")}
FORCE = "()=>{const s=document.createElement('style');s.textContent='.side .dirnew,.side .listbtn{opacity:1 !important}.side .acts{display:flex !important}';document.head.appendChild(s)}"
MEASURE = """()=>{const R=e=>e.getBoundingClientRect();const q=s=>[...document.querySelectorAll(s)].filter(e=>R(e).width>0);
 const cx=s=>{const e=q(s)[0];if(!e)return null;const b=R(e.querySelector('svg,img'));return b.left+b.width/2};
 const box=s=>{const e=q(s)[0];if(!e)return null;const r=R(e);return [r.left,r.top,r.right,r.bottom]};
 return {W:R(q('.side')[0]).width,
  cols:[['chevron',cx('.dir .chev')],['folder icon',cx('.dir .dicon')],['tab icon',cx('.item.nested.tab .lead')],['list button',cx('.dir .listbtn')],['+ ⋯ ↺',cx('.dir .dirnew:not(.listbtn)')]],
  extra:[['archive icon',cx('.archtoggle .dicon')],['group icon',cx('.grprow .lead')],['pane icon',cx('.item.member .lead')],['⋯ (tab)',cx('.item.tab .more')],['↺ (archived)',cx('.archived .more')],['server chevron',cx('.srvhead .chev')],['server +',cx('.srvhead .dirnew:not(.listbtn)')]],
  brand:box('.brandrow'),search:box('.tools input'),tools:box('.tools'),card:box('.srv.band'),
  rows:q('.srvhead,.dir,.archtoggle,.item').map(e=>{const b=R(e);return [b.top,b.bottom]})}}"""
S, H = 3, 520
with sync_playwright() as p:
    b = p.chromium.launch()
    c = b.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=S)
    c.add_init_script(f"if(!sessionStorage.__s){{for(const[k,v]of Object.entries({json.dumps(SEEDS)}))localStorage.setItem(k,v);sessionStorage.__s=1}}")
    pg = c.new_page()
    pg.goto(f"http://127.0.0.1:{env['CLIENT_PORT']}", wait_until="networkidle")
    pg.wait_for_timeout(1200)
    try:
        pg.locator(".archtoggle").first.click(timeout=2000)
    except Exception:
        pass
    pg.wait_for_timeout(400)
    pg.evaluate(FORCE)
    pg.wait_for_timeout(300)
    m = pg.evaluate(MEASURE)
    out = root / "tmp/shots"
    out.mkdir(parents=True, exist_ok=True)
    pg.screenshot(path=str(out / f"{name}-plain.png"), clip={"x": 0, "y": 0, "width": 290, "height": H})
    b.close()

cols = [(n, x) for n, x in m["cols"] if x is not None]
print(f"sidebar width {m['W']:.0f}")
for n, x in cols + [(n, x) for n, x in m["extra"] if x is not None]:
    print(f"  {n:16s} x={x:6.1f}")
rows = m["rows"]
heights = sorted({round(b - t) for t, b in rows})
print("row heights:", heights, "(expected [32] for every row)")
gaps = sorted({round(t - rows[i][1]) for i, (t, _) in enumerate(rows[1:])} )
print("gaps between rows:", gaps, "(expected 0/1 inside a block, 4 under the server header, 12 between folders)")

raw = Image.open(out / f"{name}-plain.png").convert("RGB")
PADT, PADL, PADB = 110, 150, 70
im = Image.new("RGB", (raw.width + PADL, raw.height + PADT + PADB), "white")
im.paste(raw, (PADL, PADT))
d = ImageDraw.Draw(im)
font = lambda sz, bold=True: ImageFont.truetype(f"/usr/share/fonts/truetype/dejavu/DejaVuSans{'-Bold' if bold else ''}.ttf", sz)
f, fs, fl = font(22), font(19), font(20, False)
X = lambda x: PADL + x * S
Y = lambda y: PADT + y * S
palette = ["#e11", "#06f", "#0a0", "#c0c", "#f80"]
for (n, x), cl in zip(cols, palette):
    d.line([(X(x), PADT), (X(x), PADT + H * S)], fill=cl, width=2)
pts = [("", 0)] + cols + [("", m["W"])]
for i, ((_, a), (_, b_)) in enumerate(zip(pts, pts[1:])):
    y = 42 if i % 2 == 0 else 88
    d.line([(X(a), y), (X(b_), y)], fill="#000", width=3)
    for x in (a, b_):
        d.line([(X(x), y - 9), (X(x), y + 9)], fill="#000", width=3)
    t = f"{b_ - a:.0f}"
    d.text(((X(a) + X(b_)) / 2 - len(t) * 6, y - 34), t, fill="#000", font=f)
RX0, RX1 = 24, 84
def element(t, b_, label):
    d.rectangle([(RX0, Y(t)), (RX1, Y(b_))], outline="#0aa", width=3)
    if (b_ - t) * S >= 26:
        d.text(((RX0 + RX1) / 2 - len(label) * 5, (Y(t) + Y(b_)) / 2 - 11), label, fill="#0aa", font=fs)
def space(t, b_, label):
    d.rectangle([(RX0, Y(t)), (RX1, Y(b_))], fill="#c0c")
    if label:
        d.text((RX1 + 8, (Y(t) + Y(b_)) / 2 - 10), label, fill="#c0c", font=fl)
parts = [("brand", m["brand"]), ("search", m["search"])]
prev = 0
for _, bx in parts:
    if bx:
        if bx[1] - prev > 0.4:
            space(prev, bx[1], f"{bx[1] - prev:.0f}")
        element(bx[1], bx[3], f"{bx[3] - bx[1]:.0f}")
        prev = bx[3]
if m["card"]:
    space(prev, m["card"][1], f"{m['card'][1] - prev:.0f}")
    prev = m["card"][1]
    if rows and rows[0][0] - prev > 0.4:
        space(prev, rows[0][0], "")
for i, (t, b_) in enumerate(rows):
    if i and t - rows[i - 1][1] > 0.4:
        space(rows[i - 1][1], t, f"{t - rows[i - 1][1]:.0f}")
    element(t, b_, f"{b_ - t:.0f}")
if m["card"] and rows:
    space(rows[-1][1], m["card"][3], f"{m['card'][3] - rows[-1][1]:.0f}")
ly = PADT + H * S + 14
d.rectangle([(PADL, ly), (PADL + 30, ly + 22)], outline="#0aa", width=3)
d.text((PADL + 38, ly), "element height (px)", fill="#0aa", font=fl)
d.rectangle([(PADL + 300, ly), (PADL + 330, ly + 22)], fill="#c0c")
d.text((PADL + 338, ly), "space between (px)", fill="#c0c", font=fl)
im.save(out / f"{name}.png")
print("wrote", (out / f"{name}.png").relative_to(root), "and", (out / f"{name}-plain.png").relative_to(root))

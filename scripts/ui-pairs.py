#!/usr/bin/env python3
"""Audit icon/label vertical centring: every row that puts a line icon beside one line of text.

For each screen it measures the painted ink centre of the icon and of the label (device_scale_factor 4,
background = the crop's corner colour) and reports the pairs that are off by 0.75px or more. Rows whose
label inherits the body's 1.55 line box are listed too: that fractional line box is what once put the
working-directory path 1.5px below its folder glyph (DESIGN.md rule 3).

Usage: python3 scripts/ui-pairs.py [--size 1440x900]... [--out DIR] [--json FILE]
Needs .agents/bin/dev-up.sh to have run (this worktree's own dev pair).

Reading the result: 0.5px is the physical half-pixel limit and is fine; from 1px on it is a bug. Two kinds of
label are reported separately because their ink has no height of its own ("light glyph", ink under 55% of the
font size: "..", an em dash, a lone "."): their box can be centred while the painted dots sit low. The status
line used to be the other exception (13px marks on a 16px line sat on a half pixel); with even 12 / 10px marks it is
measured like any other row. Ink is the rows that reach half of the crop's peak contrast, so the page's faint background
grid does not count as part of a glyph. A two-line block (label + sub label) is skipped: the icon centres
the block, not either line.
"""
import argparse, io, json, pathlib, subprocess, sys
from collections import Counter
from PIL import Image
from playwright.sync_api import sync_playwright

root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
envf = root / "tmp/dev/env"
if not envf.exists():
    sys.exit("ui-pairs: run .agents/bin/dev-up.sh first")
env = dict(l.split("=", 1) for l in envf.read_text().split() if "=" in l)
token = pathlib.Path(env["TOKEN_FILE"]).read_text().strip()
seed = {
    "pipaya.servers": json.dumps([{"id": "dev", "name": "dev", "baseUrl": f"http://127.0.0.1:{env['SERVER_PORT']}", "token": token}]),
    "pipaya.server": json.dumps("dev"),
}
url = f"http://127.0.0.1:{env['CLIENT_PORT']}/"
DSF = 4

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--size", action="append", help="WxH (default 1440x900, 820x1180, 390x844)")
ap.add_argument("--out", help="directory for the screenshots (default: <worktree>/tmp/ui-pairs)")
ap.add_argument("--json", help="write every measured pair here")
a = ap.parse_args()
sizes = a.size or ["1440x900", "820x1180", "390x844"]
out = pathlib.Path(a.out).resolve() if a.out else root / "tmp/ui-pairs"
out.mkdir(parents=True, exist_ok=True)

# The screens of the app and how to reach each one (clicks in order; `>> nth=N` picks one of several).
SCREENS = [
    ("main", []),
    ("main-context", [".statusline .b >> nth=0"]),
    ("settings-general", ["button.settings", '.nav button:has-text("내 설정")']),
    ("settings-keys", ["button.settings", '.nav button:has-text("단축키")']),
    ("settings-backup", ["button.settings", '.nav button:has-text("백업")']),
    # the server's panes sit in the same settings nav (srvtab), under the server's name
    ("srv-info", ["button.settings", '.nav button.srvtab:has-text("서버")']),
    ("srv-models", ["button.settings", '.nav button.srvtab:has-text("모델")']),
    ("srv-agent", ["button.settings", '.nav button.srvtab:has-text("에이전트")']),
    ("srv-mcp", ["button.settings", '.nav button.srvtab:has-text("MCP")']),
    ("srv-sessions", ["button.settings", '.nav button.srvtab:has-text("대화")']),
    ("srv-ext", ["button.settings", '.nav button.srvtab:has-text("확장")']),
    ("srv-devices", ["button.settings", '.nav button.srvtab:has-text("서버")', '.subtabs button:has-text("접속 기기")']),
    ("sessions-panel", [".listbtn"]),
    ("dir-picker", [".where"]),
    ("model-picker", [".trigger.inline"]),
    ("row-menu", ['button[aria-label*="새로 만들기"]']),
]

FIND = r"""() => {
  const describe = (e) => (e.getAttribute('class')||'').replace(/svelte-[\w-]+/g,'').replace(/\s+/g,' ').trim();
  const R = (e) => { const r = e.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height}; };
  const out = []; let n = 0;
  const iconOf = (host) => {
    for (const c of host.children) {
      const t = c.tagName.toLowerCase();
      if (t === 'svg' || t === 'img') return c;
      if (c.querySelector(':scope > svg, :scope > img') && (c.innerText||'').trim() === '') return c;
    }
    return null;
  };
  for (const host of document.querySelectorAll('*')) {
    const hcs = getComputedStyle(host);
    if (!/flex|grid/.test(hcs.display) || hcs.alignItems !== 'center') continue;
    const rr = host.getBoundingClientRect();
    if (rr.width < 16 || rr.height < 8 || rr.height > 90 || rr.width > 1400) continue;
    if (rr.bottom < 1 || rr.top > innerHeight-1) continue;
    // only what is on top: a row under an open dialog or sheet (the composer's path chip behind the folder picker) is painted
    // over, so its pixels are the dialog's. Asked at the icon's centre: the topmost element there must be the icon or inside the host.
    const icon = iconOf(host);
    if (!icon) continue;
    const ir = icon.getBoundingClientRect();
    if (ir.width < 5 || ir.height < 5) continue;
    { const hit = document.elementFromPoint(ir.left + ir.width/2, ir.top + ir.height/2);
      if (!hit || !(host.contains(hit) || hit === host)) continue; }
    // A direct text child beside the icon only: a two-line block (label + sub label) or a second word in the
    // same row is a different shape, and comparing it with the icon would report a 10px "error" that is by design.
    for (const c0 of host.children) {
      const cs0 = getComputedStyle(c0);
      if (cs0.visibility==='hidden' || cs0.display==='none' || +cs0.opacity===0) continue;
      if (c0 === icon || icon.contains(c0)) continue;
      // only the label that stands right after the icon: a trailing unit ("tps" after the value) is not beside the glyph
      if (c0.previousElementSibling && c0.previousElementSibling !== icon && !c0.previousElementSibling.contains(icon)) continue;
      // a one-line flex wrapper around the label (settings nav: icon + <span class=nt><span class=nl>…</span> badge</span>):
      // compare its first text child, which is what sits beside the icon
      let c = c0;
      if (/flex|grid/.test(cs0.display)) {
        if (cs0.flexDirection.startsWith('column')) continue;
        c = [...c0.children].find((k) => (k.innerText||'').trim() && !/flex|grid/.test(getComputedStyle(k).display));
        if (!c) continue;
      }
      const cs = getComputedStyle(c);
      if (['BUTTON','INPUT','TEXTAREA','SELECT'].includes(c.tagName)) continue;
      const t = (c.innerText||'').trim(); if (!t) continue;
      const r = c.getBoundingClientRect();
      if (r.width < 5 || r.height < 5 || r.height > 45) continue;
      const lh = cs.lineHeight==='normal' ? parseFloat(cs.fontSize)*1.2 : parseFloat(cs.lineHeight);
      if (r.height > lh*1.45) continue;
      if (Math.abs((r.top+r.height/2)-(ir.top+ir.height/2)) > 14) continue;
      const gapX = Math.max(r.left - ir.right, ir.left - r.right);
      if (gapX > 16) continue;
      // the label's cap-height centre from the font's own metrics: string-independent, unlike the ink ("beta" has no descender,
      // "alpha" has one, and their ink centres differ by 1px in the same row)
      const cv = (window.__pairsCv ||= document.createElement('canvas').getContext('2d'));
      cv.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      const fm = cv.measureText('Hg'), hm = cv.measureText('H');
      const lhpx = cs.lineHeight==='normal' ? fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent : parseFloat(cs.lineHeight);
      const lineTop = r.top + (r.height - lhpx) / 2;
      const base = lineTop + (lhpx - (fm.fontBoundingBoxAscent + fm.fontBoundingBoxDescent)) / 2 + fm.fontBoundingBoxAscent;
      const capC = base - hm.actualBoundingBoxAscent / 2;
      out.push({i: n++, inStatus: !!host.closest('.statusline'), host: describe(host), icon: describe(icon), cls: describe(c),
        text: t.replace(/\s+/g,' ').slice(0,30), fs: cs.fontSize, lh: cs.lineHeight,
        irect: R(icon), trect: R(c), hostrect: R(host), capC});
    }
  }
  return out;
}"""

def ink(shot, rect, ylim, tol=36):
    """Painted top-to-bottom extent of a glyph run (its centre is what the eye pairs with the icon's)."""
    x = int(round(rect["x"]*DSF)); w = int(round(rect["w"]*DSF))
    x0, x1 = max(0,x), min(shot.width, x+w)
    y0 = max(0, int(round(max(rect["y"]-3, ylim[0])*DSF)))
    y1 = min(shot.height, int(round(min(rect["y"]+rect["h"]+3, ylim[1])*DSF)))
    if x1-x0 < 2 or y1-y0 < 2: return None
    sub = shot.crop((x0,y0,x1,y1)).convert("RGB"); px = sub.load(); W,H = sub.size
    bg = Counter([px[0,0],px[W-1,0],px[0,H-1],px[W-1,H-1]]).most_common(1)[0][0]
    # a pixel counts as ink when it reaches half of the crop's peak contrast: the faint lines of the page's background grid
    # and the outer anti-aliasing (both under that) no longer stretch a glyph's box by a pixel or two
    d = [[abs(px[xx,yy][0]-bg[0])+abs(px[xx,yy][1]-bg[1])+abs(px[xx,yy][2]-bg[2]) for xx in range(W)] for yy in range(H)]
    peak = max(max(r) for r in d)
    if peak <= tol: return None
    cut = max(tol, peak * 0.5)
    count = [sum(v >= cut for v in r) for r in d]
    ys = [yy for yy in range(H) if count[yy]]
    if not ys: return None
    edge = min(ys) <= 1 or max(ys) >= H-2
    top = y0/DSF + min(ys)/DSF; bot = y0/DSF + (max(ys)+1)/DSF
    return {"centre": (top+bot)/2, "h": bot-top, "edge": edge}

def shoot(pg, name, clicks, narrow):
    pg.goto(url, wait_until="networkidle"); pg.wait_for_timeout(1400)
    if narrow and clicks and not clicks[0].startswith((".statusline", ".where", ".trigger")):
        pg.locator("button.tool.menu").first.click(force=True, timeout=8000); pg.wait_for_timeout(700)
    for c in clicks:
        if '>> nth=' in c:
            sel, nth = c.split(' >> nth='); loc = pg.locator(sel).nth(int(nth))
        else:
            loc = pg.locator(c).first
        loc.scroll_into_view_if_needed(timeout=4000)
        loc.click(force=True, timeout=8000); pg.wait_for_timeout(900)
    pg.wait_for_timeout(600)
    rows = pg.evaluate(FIND)
    shot = Image.open(io.BytesIO(pg.screenshot(path=str(out/f"{name}.png"))))
    res = []
    for r in rows:
        ylim = (r["hostrect"]["y"], r["hostrect"]["y"]+r["hostrect"]["h"])
        ii = ink(shot, r["irect"], ylim); ti = ink(shot, r["trect"], ylim)
        if not ii or not ti: continue
        lh = float(r["lh"].replace("px","")) if r["lh"].endswith("px") else None
        # the smaller of two readings: the painted ink, and the font's cap-height centre. A real offset moves both; a string
        # without descenders (or with tall ones) moves only the ink, so it is not reported as a layout bug
        d_ink = ti["centre"] - ii["centre"]; d_cap = r["capC"] - ii["centre"]
        res.append({**r, "dy": round(d_ink if abs(d_ink) <= abs(d_cap) else d_cap, 2), "dyInk": round(d_ink, 2), "dyCap": round(d_cap, 2),
                    "iconInkH": round(ii["h"],2), "textInkH": round(ti["h"],2),
                    "edge": bool(ii["edge"] or ti["edge"]),
                    "fracLine": bool(lh and abs(lh-round(lh)) > 0.01)})
    return res

allres = {}
problems = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for size in sizes:
        w,h = map(int, size.split("x"))
        ctx = b.new_context(viewport={"width":w,"height":h}, device_scale_factor=DSF,
                            is_mobile=w < 600, has_touch=w < 600)
        ctx.add_init_script("if(!sessionStorage.__s){for(const[k,v]of Object.entries(%s))localStorage.setItem(k,v);sessionStorage.__s=1}" % json.dumps(seed))
        pg = ctx.new_page()
        for name, clicks in SCREENS:
            try:
                rows = shoot(pg, f"{size}-{name}", clicks, narrow=w < 860)
            except Exception as e:
                print(f"{size} {name}: skipped ({str(e).splitlines()[0][:70]})"); continue
            allres[f"{size}/{name}"] = rows
            def light(r):
                return r["textInkH"] < float(r["fs"].replace("px", "")) * 0.55
            off = [r for r in rows if abs(r["dy"]) >= 1.0 and not r["edge"]]
            bad = [r for r in off if not light(r)]
            faint = [r for r in off if light(r)]
            frac = [r for r in rows if r["fracLine"]]
            problems += len(bad)
            print(f"{size} {name}: {len(rows)} pairs, {len(bad)} off, {len(faint)} light-glyph, {len(frac)} fractional line box")
            for r in sorted(off, key=lambda r: -abs(r["dy"])):
                kind = "light glyph" if light(r) else "OFF"
                print(f'   {r["dy"]:+6.2f}  [{kind:11}] {r["host"][:18]:18} | {r["text"][:22]:22} | {r["fs"]}/{r["lh"]} ink{r["textInkH"]:.1f}')
        ctx.close()
    b.close()

if a.json:
    pathlib.Path(a.json).write_text(json.dumps(allres, ensure_ascii=False, indent=1))
print(f"done: {problems} pair(s) 1px or more off")
sys.exit(1 if problems else 0)

#!/usr/bin/env python3
"""Measure text-in-box alignment (ink vs box center) and modal pixel-snapping against docs/design-system.md.

Usage: python3 scripts/ui-ink.py [name] [--click <sel>]... [--size <WxH>]... [--dsf <factor>] [--modals]
Needs .agents/bin/dev-up.sh to have run (this worktree's own dev pair).
"""
import argparse, io, json, pathlib, subprocess, sys
from PIL import Image
from playwright.sync_api import sync_playwright

root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
envf = root / "tmp/dev/env"
if not envf.exists():
    sys.exit("ui-ink: run .agents/bin/dev-up.sh first")
env = dict(l.split("=", 1) for l in envf.read_text().split() if "=" in l)
token = pathlib.Path(env["TOKEN_FILE"]).read_text().strip()
srv = {"id": "dev", "name": "dev", "baseUrl": f"http://127.0.0.1:{env['SERVER_PORT']}", "token": token}
seed = {"pipaya.servers": json.dumps([srv]), "pipaya.server": json.dumps("dev")}

ap = argparse.ArgumentParser(description=__doc__)
ap.add_argument("name", nargs="?", default="ink")
ap.add_argument("--click", action="append", default=[])
ap.add_argument("--size", action="append", default=[])
ap.add_argument("--dsf", type=int, default=4, help="Device scale factor (default: 4)")
ap.add_argument("--modals", action="store_true", help="Run the full modal whole-pixel snapping test across viewports")
args = ap.parse_args()

sizes = args.size or ["1440x900", "390x844"]
DSF = args.dsf

FIND = """() => {
  const sel = '.badge,.chip,.fchip,.tbadge,.cbadge,.reply-badge,[class*="badge"],[class*="chip"],[class*="pill"],[class*="tag"],button,[role=tab],.btn,.seg *,a.btn';
  const out = []; const seen = new Set();
  for (const e of document.querySelectorAll(sel)) {
    if (seen.has(e)) continue; seen.add(e);
    const r = e.getBoundingClientRect();
    if (r.width < 8 || r.height < 8 || r.height > 60 || r.width > 420) continue;
    const cs = getComputedStyle(e);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) continue;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || !(e === hit || e.contains(hit))) continue;
    const text = (e.innerText || '').trim().slice(0, 18);
    if (!text) continue;
    const pillish = /badge|chip|pill|tag|btn|seg/.test(e.getAttribute('class') || '') || e.getAttribute('role') === 'tab';
    out.push({
      cls: (e.getAttribute('class') || '').replace(/svelte-\\w+/g, '').replace(/\\s+/g, ' ').trim(),
      text, pillish, x: r.left, y: r.top, w: r.width, h: r.height,
      fs: cs.fontSize, lh: cs.lineHeight, pad: cs.padding
    });
  }
  return out;
}"""

def check_modals(p):
    M = 'button[aria-label="사이드바 열기"]'
    cases = [
        ("mcp", [".statusline .b.tap >> nth=2"]),
        ("skills", [".statusline .b.tap >> nth=1"]),
        ("cmds", [".statusline .b.tap >> nth=3"]),
        ("ctx", ['button[aria-label^="AGENTS.md"]']),
        ("settings", ["SET"]),
        ("settings-agent", ["SET", ".srvbar .fchip >> nth=1", '[role=tab]:has-text("에이전트")']),
        ("add-conn", ["SET", ".srvbar .fchip >> nth=1", '[role=tab]:has-text("에이전트")', 'button:has-text("연결 추가")']),
        ("model-picker", ["button.trigger"]),
    ]
    check_sizes = [(1440, 900), (1441, 901), (820, 1180), (390, 844)]
    b = p.chromium.launch()
    print("=== Modal Whole-Pixel Snapping Audit ===")
    for name, clicks in cases:
        row = []
        for vw, vh in check_sizes:
            ctx = b.new_context(viewport={"width": vw, "height": vh}, is_mobile=vw < 600, has_touch=vw < 600)
            ctx.add_init_script(f"if(!sessionStorage.__s){{for(const[k,v]of Object.entries({json.dumps(seed)}))localStorage.setItem(k,v);sessionStorage.__s=1}}")
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{env['CLIENT_PORT']}/", wait_until="networkidle")
            try:
                for c in clicks:
                    if c == "SET":
                        if vw <= 820:
                            pg.locator(M).first.click(timeout=2000)
                            pg.wait_for_timeout(300)
                        c = "button.settings"
                    pg.locator(c).first.click(timeout=2500)
                    pg.wait_for_timeout(300)
            except Exception:
                row.append(f"{vw}: n/a")
                ctx.close()
                continue
            pg.wait_for_timeout(1000)
            r = pg.evaluate("()=>{const ms=[...document.querySelectorAll('.modal,dialog[open]')];const m=ms[ms.length-1];if(!m)return null;const q=m.getBoundingClientRect();return [q.x,q.y,q.width,q.height]}")
            if not r:
                row.append(f"{vw}: none")
                ctx.close()
                continue
            sheet = vw <= 640
            inside = r[0] >= -0.01 and r[1] >= -0.01 and r[0] + r[2] <= vw + 0.01 and r[1] + r[3] <= vh + 0.01
            whole = abs(r[0] - round(r[0])) < 0.01 and (sheet or abs(r[1] - round(r[1])) < 0.01)
            centred = abs((r[0] + r[2] / 2) - vw / 2) <= 0.51 and (sheet or abs((r[1] + r[3] / 2) - vh / 2) <= 0.51)
            status = 'ok' if inside and whole and centred else ('OUT ' if not inside else '') + ('FRAC ' if not whole else '') + ('OFFC ' if not centred else '')
            row.append(f"{vw}: {status.strip()}")
            ctx.close()
        print(f"{name:15}", "  ".join(row))
    b.close()

def main():
    with sync_playwright() as p:
        if args.modals:
            check_modals(p)
            return

        b = p.chromium.launch()
        for size in sizes:
            w, h = map(int, size.split("x"))
            ctx = b.new_context(viewport={"width": w, "height": h}, device_scale_factor=DSF)
            ctx.add_init_script(f"if(!sessionStorage.__s){{for(const[k,v]of Object.entries({json.dumps(seed)}))localStorage.setItem(k,v);sessionStorage.__s=1}}")
            pg = ctx.new_page()
            pg.goto(f"http://127.0.0.1:{env['CLIENT_PORT']}/", wait_until="networkidle")
            skipped = False
            for c in args.click:
                try:
                    pg.locator(c).first.click(timeout=2500)
                    pg.wait_for_timeout(300)
                except Exception:
                    skipped = True
                    break
            if skipped:
                print(f"{args.name} {size}: skipped (click target unreachable)")
                ctx.close()
                continue
            pg.wait_for_timeout(900)
            items = pg.evaluate(FIND)
            png = pg.screenshot()
            img = Image.open(io.BytesIO(png))
            k = DSF
            agg = {}
            bad = 0
            for it in items:
                centered = it["pillish"] and not it["cls"].startswith(('tab', 'srvtab', 'open', 'item'))
                x0, y0 = int(it["x"] * k) + 2 * k, int(it["y"] * k) + 2 * k
                x1, y1 = int((it["x"] + it["w"]) * k) - 2 * k, int((it["y"] + it["h"]) * k) - 2 * k
                if x1 <= x0 or y1 <= y0:
                    continue
                c = img.crop((x0, y0, x1, y1)).convert("RGB")
                px = c.load(); W, H = c.size
                base = px[1, 1] if W > 2 and H > 2 else px[0, 0]
                ys = [j for j in range(H) for i in range(0, W, 2) if sum(abs(px[i, j][q] - base[q]) for q in range(3)) > 110]
                if not ys:
                    continue
                top = y0 / k + min(ys) / k
                bot = y0 / k + (max(ys) + 1) / k
                dy = ((top + bot) / 2) - (it["y"] + it["h"] / 2)
                tag = it["cls"].split()[0] if it["cls"] else '?'
                if centered:
                    agg.setdefault((tag, round(it["h"]), it["fs"]), []).append((dy, it["text"]))
                    if abs(dy) > 0.51:
                        bad += 1
                        print(f"  {size} dy={dy:+.2f} h={it['h']:.0f} fs={it['fs']} [{it['cls']}] '{it['text']}'")
            print(f"{args.name} {size}: {len(items)} boxes, {bad} off by >0.5px")
            for k_key, v_list in sorted(agg.items()):
                mdy = sum(a[0] for a in v_list) / len(v_list)
                print(f"  AGG {size} {k_key[0]:12} h={k_key[1]:>2} fs={k_key[2]} n={len(v_list):>2} mean dy={mdy:+.2f}  {[a[1] for a in v_list][:3]}")
            ctx.close()
        b.close()

if __name__ == "__main__":
    main()

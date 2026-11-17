#!/usr/bin/env python3
"""Audit focus rings: walk every screen with the keyboard and report each ring that is cut off by a scroll box or a clipping
parent (`overflow: hidden / auto / clip`), or that runs off the window.

Usage: python3 scripts/ui-focus.py [--size 1440x900]... [--seed [--echo]] [--only a,b] [--out DIR] [--max-tabs 80]
Needs .agents/bin/dev-up.sh to have run (this worktree's own dev pair). `--seed` adds a few conversations, a terminal and a
split tab first, so the tab strip and the tab overview have cards.

How a ring is measured: the focused element's border box grown by `outline-offset + outline-width` (or by the spread of a
`box-shadow` ring when there is no outline), compared with the padding box of every ancestor that clips. A cut of 0.5px or
more is reported with the clipping ancestor; the screenshot of the moment goes to the output directory.
Fix a cut ring by giving the scroll box room (padding the ring fits in), or by drawing the ring inside (`outline-offset:
-2px`) when the element fills its box edge to edge. Never by dropping the ring.
"""
import argparse, json, pathlib, subprocess, sys, urllib.request
from playwright.sync_api import sync_playwright

root = pathlib.Path(subprocess.check_output(["git", "rev-parse", "--show-toplevel"], text=True).strip())
envf = root / "tmp/dev/env"
if not envf.exists():
    sys.exit("ui-focus: run .agents/bin/dev-up.sh first")
env = dict(l.split("=", 1) for l in envf.read_text().split() if "=" in l)
tok = pathlib.Path(env["TOKEN_FILE"]).read_text().strip()
base = f"http://127.0.0.1:{env['SERVER_PORT']}"
url = f"http://127.0.0.1:{env['CLIENT_PORT']}/"

ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
ap.add_argument("--size", action="append", help="WxH (default 1440x900, 820x1180, 390x844)")
ap.add_argument("--seed", action="store_true")
ap.add_argument("--echo", action="store_true", help="with --seed: also run a tool call through the echo model (left running until the script ends)")
ap.add_argument("--only", help="comma-separated screen names")
ap.add_argument("--theme", default="dark", choices=["dark", "light"], help="colour scheme (rings and clipping do not change with it; light is a spot check)")
ap.add_argument("--out", help="screenshots of each cut ring (default: <worktree>/tmp/ui-focus)")
ap.add_argument("--max-tabs", type=int, default=80, help="Tab presses per screen")
a = ap.parse_args()
sizes = a.size or ["1440x900", "820x1180", "390x844"]
out = pathlib.Path(a.out).resolve() if a.out else root / "tmp/ui-focus"
out.mkdir(parents=True, exist_ok=True)


def api(method, path, body=None):
    r = urllib.request.Request(base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                               headers={"Authorization": f"Bearer {tok}", "Content-Type": "application/json"})
    return json.loads(urllib.request.urlopen(r).read() or b"null")


echo_up = None
if a.seed:
    # a model that never answers: the sessions only need to exist (the same stub ui-rulers.py seeds with)
    api("PUT", "/configuration/providers/fake", {"name": "fake", "baseUrl": "http://127.0.0.1:9/v1", "api": "openai-completions", "authRequired": False,
                                                  "models": [{"id": "m1", "contextWindow": 100000, "maxTokens": 4000, "reasoning": False, "vision": False}]})
    mk = lambda cwd, title: api("POST", "/sessions", {"cwd": cwd, "title": title})["id"]
    for title in ("로그인 버그 수정", "API 리팩터링", "문서 정리"):
        mk("alpha", title)
    x, y = mk("alpha", "디자인 리뷰"), mk("alpha", "QA")
    pane = lambda i: {"type": "pane", "sessionId": i}
    api("POST", "/groups", {"layout": {"type": "split", "dir": "row", "ratio": 0.5, "a": pane(x), "b": pane(y)}})
    api("POST", "/terminals", {"cwd": "alpha", "title": "zsh"})
    # a conversation with tool calls and a finished answer (the echo model runs `!bash`): work boxes, the answer's foot
    if a.echo:
        echo_up = up = subprocess.Popen(["bun", "scripts/echo-upstream.ts"], cwd=root / "server", stdout=subprocess.PIPE, text=True)
        ready = json.loads(up.stdout.readline()[6:])
        api("PUT", "/configuration/providers/echo", ready["provider"])
        sid = api("POST", "/sessions", {"cwd": "alpha", "title": "도구 실행", "provider": "echo", "model": ready["model"]})["id"]
        api("POST", f"/sessions/{sid}/messages", {"text": "!bash echo one && echo two", "mode": "prompt"})
        import time
        time.sleep(4)

SEED = {"pipaya.servers": json.dumps([{"id": "dev", "name": "dev", "baseUrl": base, "token": tok}]), "pipaya.server": json.dumps("dev")}

# The screens and how to reach each one. A step is a selector to click; "key:<Key>" presses a key, "open:<text>" opens a
# conversation from the sidebar (through the drawer on a narrow window). Settings panes are listed by their nav label.
SETTINGS = ["내 설정", "단축키", "백업", "정보", "모델", "음성 입력", "에이전트 도구", "MCP", "대화", "예약 작업", "확장", "기기"]
SCREENS = [
    ("home", []),
    ("main", ["open:로그인 버그 수정"]),
    ("work", ["open:도구 실행"]),
    ("tab-overview", ["open:로그인 버그 수정", '[data-part="tab-count"] >> visible=true']),
    *[(f"settings-{n}", ["button.settings", f'.nav button:has-text("{n}")']) for n in SETTINGS],
    ("model-picker", [".trigger.inline"]),
    ("sessions-panel", [".listbtn"]),
    ("dir-picker", [".where"]),
    ("context", ["open:로그인 버그 수정", ".statusline .b >> nth=0"]),
    ("palette", ["open:로그인 버그 수정", "key:Control+k"]),
    ("find", ["open:도구 실행", "key:Control+f"]),
    ("schedules", ['button.navbtn:has-text("예약 작업")']),
    ("graph", ['button.navbtn:has-text("그래프 뷰")']),
    ("new-menu", ["open:로그인 버그 수정", 'button.add[aria-haspopup="menu"] >> visible=true']),  # the strip's "+", the header's on a phone
]

CHECK = r"""() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (!el.matches(':focus-visible')) return {skip: 'not focus-visible'};
  const cs = getComputedStyle(el);
  let grow = 0, how = 'none';
  const ow = parseFloat(cs.outlineWidth) || 0;
  if (cs.outlineStyle !== 'none' && ow > 0) { grow = ow + (parseFloat(cs.outlineOffset) || 0); how = 'outline'; }
  else {
    // a ring drawn as a box-shadow: the largest spread of an outer shadow without blur
    for (const part of cs.boxShadow.split(/,(?![^(]*\))/)) {
      if (/inset/.test(part)) continue;
      const nums = (part.match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (nums.length >= 4 && nums[0] === 0 && nums[1] === 0 && nums[2] === 0) { grow = Math.max(grow, nums[3]); how = 'shadow'; }
    }
  }
  if (how === 'none') return {skip: 'no ring'};
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return {skip: 'empty'};
  const ring = {l: r.left - grow, t: r.top - grow, r: r.right + grow, b: r.bottom + grow};
  const describe = (e) => `${e.tagName.toLowerCase()}${e.id ? '#' + e.id : ''}.${(e.getAttribute('class') || '').replace(/svelte-[\w-]+/g, '').trim().split(/\s+/).filter(Boolean).slice(0, 3).join('.')}`;
  const label = (el.getAttribute('aria-label') || el.innerText || el.getAttribute('title') || '').replace(/\s+/g, ' ').trim().slice(0, 40);
  const cuts = [];
  for (let p = el.parentElement; p; p = p.parentElement) {
    const pcs = getComputedStyle(p);
    const clips = (v) => /hidden|auto|scroll|clip/.test(v);
    const cx = clips(pcs.overflowX), cy = clips(pcs.overflowY);
    if (!cx && !cy && !/paint|strict|content/.test(pcs.contain)) continue;
    const pr = p.getBoundingClientRect();
    // the padding box: inside the borders
    const box = {l: pr.left + p.clientLeft, t: pr.top + p.clientTop, r: pr.left + p.clientLeft + p.clientWidth, b: pr.top + p.clientTop + p.clientHeight};
    const sides = {};
    if (cx) { if (box.l - ring.l >= 0.5) sides.left = box.l - ring.l; if (ring.r - box.r >= 0.5) sides.right = ring.r - box.r; }
    if (cy) { if (box.t - ring.t >= 0.5) sides.top = box.t - ring.t; if (ring.b - box.b >= 0.5) sides.bottom = ring.b - box.b; }
    // a scroll box that has the element scrolled partly out of view is the reader's doing, not a layout bug
    const scrolledAway = (sides.top && el.getBoundingClientRect().top < box.t) || (sides.bottom && el.getBoundingClientRect().bottom > box.b);
    if (Object.keys(sides).length && !scrolledAway)
      cuts.push({by: describe(p), sides: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, Math.round(v * 10) / 10]))});
  }
  const vw = innerWidth, vh = innerHeight, off = {};
  if (ring.l < -0.5) off.left = -ring.l; if (ring.r > vw + 0.5) off.right = ring.r - vw;
  if (ring.t < -0.5) off.top = -ring.t; if (ring.b > vh + 0.5) off.bottom = ring.b - vh;
  if (Object.keys(off).length) cuts.push({by: 'window', sides: off});
  return {el: describe(el), label, how, grow, cuts};
}"""


def drawer(pg):
    """On a narrow window the sidebar is a drawer: open it when what comes next lives there."""
    menu = pg.locator("button.tool.menu")
    if menu.count() and menu.first.is_visible():
        menu.first.click()
        pg.wait_for_timeout(600)


def reach(pg, steps):
    pg.goto(url, wait_until="networkidle")
    pg.wait_for_timeout(1200)
    for s in steps:
        if s.startswith("key:"):
            pg.keyboard.press(s[4:])
        elif s.startswith("open:"):
            row = pg.get_by_text(s[5:], exact=True)
            if not row.first.is_visible():
                drawer(pg)
            if not row.first.is_visible():  # its folder is folded
                pg.get_by_text("alpha").first.click()
                pg.wait_for_timeout(400)
            pg.locator(f"text={s[5:]} >> visible=true").first.click(timeout=6000)
        else:
            loc = pg.locator(f"{s} >> visible=true").first
            try:
                loc.click(timeout=2500)
            except Exception:  # behind the drawer (a narrow window), or covered by it: open it and try again
                drawer(pg)
                pg.locator(f"{s} >> visible=true").first.click(timeout=6000)
        pg.wait_for_timeout(700)


bad = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for size in sizes:
        w, h = map(int, size.split("x"))
        for theme in (a.theme,):
            ctx = b.new_context(viewport={"width": w, "height": h}, is_mobile=w < 600, has_touch=w < 600, locale="ko-KR", color_scheme=theme)
            ctx.add_init_script(f"if(!sessionStorage.__s){{for(const[k,v]of Object.entries({json.dumps(SEED)}))localStorage.setItem(k,v);sessionStorage.__s=1}}")
            pg = ctx.new_page()
            for name, steps in SCREENS:
                if a.only and name not in a.only.split(","):
                    continue
                try:
                    reach(pg, steps)
                except Exception as e:
                    print(f"{size} {name}: not reached ({str(e).splitlines()[0][:80]})")
                    continue
                seen, found, checked, first = set(), 0, 0, None
                # the keyboard took the page over: the first press makes later focus :focus-visible
                for i in range(a.max_tabs):
                    pg.keyboard.press("Tab")
                    pg.wait_for_timeout(350)  # a smooth scroll that brings the element into view settles first
                    r = pg.evaluate(CHECK)
                    if not r or "skip" in r:
                        continue
                    key = (r["el"], r["label"])
                    if key == first:
                        break  # came round to the start
                    first = first or key
                    if key in seen:
                        continue
                    seen.add(key)
                    checked += 1
                    if r["cuts"]:
                        found += 1
                        bad += 1
                        f = out / f"{name}-{size}-{len(seen)}.png"
                        pg.screenshot(path=str(f))
                        for c in r["cuts"]:
                            print(f"{size} {name}: CUT {r['el']} \"{r['label']}\" ({r['how']} +{r['grow']:g}px) by {c['by']} {c['sides']}  -> {f.relative_to(root) if f.is_relative_to(root) else f}")
                print(f"{size} {name}: {checked} focusable, {found} cut")
            ctx.close()
    b.close()
if echo_up:
    echo_up.terminate()
print(f"done: {bad} cut ring(s)")
sys.exit(1 if bad else 0)

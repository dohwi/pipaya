#!/usr/bin/env python3
"""Audit focus rings: walk every screen with the keyboard and report each ring that is cut off by a scroll box or a clipping
parent (`overflow: hidden / auto / clip`), or that runs off the window.

Usage: python3 scripts/ui-focus.py [--size 1440x900]... [--seed [--echo]] [--only a,b] [--out DIR] [--max-tabs 256]
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
ap.add_argument("--max-tabs", type=int, default=256, help="Tab presses per screen")
a = ap.parse_args()
sizes = a.size or ["1440x900", "820x1180", "390x844"]
out = pathlib.Path(a.out).resolve() if a.out else root / "tmp/ui-focus"
out.mkdir(parents=True, exist_ok=True)
if a.max_tabs < 1:
    ap.error("--max-tabs must be positive")


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

def settings(label):
    return ["button.settings", f'.nav [role="tab"]:has(.nl:text-is("{label}"))']


CHAT = ["open:로그인 버그 수정"]
MODELS = settings("모델")
CONNECT = MODELS + ['button:text-is("연결 추가")']
API_KEY = CONNECT + ['.cm button:text-is("API KEY")']
EDIT = MODELS + ['[data-provider="fake"] button:text-is("수정")']
MODEL = EDIT + [".mopen"]
GRAPH = ['button.navbtn:has-text("그래프 뷰")']
# The last selector is a postcondition: a successful click need not mean that the intended page actually opened.
SCREENS = [
    ("home", [], '[data-part="composer"]'),
    ("main", CHAT, '.statusline'),
    ("work", ["open:도구 실행"], '.work'),
    ("tab-overview", CHAT + ['[data-part="tab-count"] >> visible=true'], '[role="dialog"] .card'),
    *[(f"settings-{n}", settings(n), f'.pane[role="tabpanel"]:has(> .phead h3:text-is("{n}"))') for n in SETTINGS],
    ("settings-search", ["button.settings", 'fill:.searchbar input|모델'], '.hits button'),
    ("server-add", ["button.settings", 'button[title="서버 추가"]'], '[role="dialog"][aria-label="서버 추가"]'),
    ("connect", CONNECT, '.cm .tabpane'),
    ("connect-api", API_KEY, '.cm .item:has-text("OpenAI 호환")'),
    ("connection-new", API_KEY + ['.cm .item:has-text("OpenAI 호환")'], '.cm .fform'),
    ("connection-edit", EDIT, '.fform .mopen'),
    ("discard-connection", EDIT + ['fill:.fform input[placeholder="예: 내 프록시"]|audit', "key:Escape"], '[role="alertdialog"]'),
    ("connection-model", MODEL, '.fform .iconpick'),
    ("model-strength", MODEL + ['.cap:text-is("추론")'], '.dseg button.on'),
    ("icon-picker", MODEL + ['.iconpick'], '.grid .cell[aria-pressed="true"]'),
    ("catalog-picker", MODEL + ['.mtrigger'], '.pk-list .pk-opt'),
    ("model-picker", [".trigger.inline"], '.pk-list .pk-opt'),
    ("mcp-form", settings("MCP") + ['button:text-is("MCP 서버 추가")'], 'form input[placeholder="github"]'),
    ("role-form", settings("에이전트 도구") + ['button:text-is("서브에이전트 역할 추가")'], 'form .chips'),
    ("schedule-form", settings("예약 작업") + ['button:text-is("예약 추가")'], 'form textarea'),
    ("extension-detail", settings("확장") + ['.extensions .expand:has-text("Focus audit")'], '.extensions .page input'),
    ("extension-market", settings("확장") + ['button:text-is("마켓플레이스")'], 'input[aria-label="확장 검색"]'),
    ("sessions-panel", [".listbtn"], '[data-part="sessions"]'),
    ("sessions-selected", [".listbtn", '.sessions .gh input'], '.sessions .gh input:checked'),
    ("dir-picker", [".where"], '.path input'),
    ("dir-create", [".where", 'button:text-is("새 폴더")'], 'form.mk input'),
    ("context-tools", CHAT + ["status:AGENTS.md", '.fold:has(.source-name:text-is("도구"))'], '.source .inner .fold'),
    ("context", CHAT + ['status:AGENTS.md'], '[role="dialog"][aria-label="적용된 컨텍스트"]'),
    ("skills", CHAT + ["status:스킬"], '[role="dialog"][aria-label="스킬"]'),
    ("palette", CHAT + ["key:Control+k"], '.pal'),
    ("find", CHAT + ["key:Control+f"], '.find'),
    ("schedules", ['button.navbtn:has-text("예약 작업")'], '[role="dialog"][aria-label="예약 작업"]'),
    ("graph", GRAPH, '.graph .world'),
    *[(f"graph-{kind}", GRAPH + [f'.card.{kind}[data-card]'], '.modal .kv') for kind in ("server", "provider", "model")],
    ("graph-chat", GRAPH + ['.card.session[data-card]'], '.modal button.open'),
    ("new-menu", CHAT + ['button.add[aria-haspopup="menu"] >> visible=true'], '[role="menu"]'),
]

if a.only and (unknown := set(a.only.split(",")) - {n for n, _, _ in SCREENS}):
    ap.error("unknown screens: " + ", ".join(sorted(unknown)))

CHECK = r"""() => {
  const el = document.activeElement;
  if (!el || el === document.body) return null;
  if (!el.matches(':focus-visible')) return {skip: 'not focus-visible'};
  const cs = getComputedStyle(el);
  let grow = 0, how = 'none';
  const ow = parseFloat(cs.outlineWidth) || 0;
  if (cs.outlineStyle !== 'none' && ow > 0) { grow = ow + (parseFloat(cs.outlineOffset) || 0); how = 'outline'; }
  else {
    // A zero-blur shadow can be an outer halo or an inset ring (no growth).
    for (const part of cs.boxShadow.split(/,(?![^(]*\))/)) {
      const nums = (part.match(/-?[\d.]+px/g) || []).map(parseFloat);
      if (nums.length >= 4 && nums[0] === 0 && nums[1] === 0 && nums[2] === 0 && nums[3] > 0) {
        grow = Math.max(grow, /inset/.test(part) ? 0 : nums[3]); how = 'shadow';
      }
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
    const paint = /paint|strict|content/.test(pcs.contain);
    const cx = paint || clips(pcs.overflowX), cy = paint || clips(pcs.overflowY);
    if (!cx && !cy) continue;
    const pr = p.getBoundingClientRect();
    // the padding box: inside the borders
    const box = {l: pr.left + p.clientLeft, t: pr.top + p.clientTop, r: pr.left + p.clientLeft + p.clientWidth, b: pr.top + p.clientTop + p.clientHeight};
    const sides = {};
    if (cx) { if (box.l - ring.l >= 0.5) sides.left = box.l - ring.l; if (ring.r - box.r >= 0.5) sides.right = ring.r - box.r; }
    if (cy) { if (box.t - ring.t >= 0.5) sides.top = box.t - ring.t; if (ring.b - box.b >= 0.5) sides.bottom = ring.b - box.b; }
    // a scroll box that has the element scrolled partly out of view is the reader's doing, not a layout bug
    const scrolledAway = (sides.top && el.getBoundingClientRect().top < box.t) || (sides.bottom && el.getBoundingClientRect().bottom > box.b);
    if (scrolledAway && /auto|scroll/.test(pcs.overflowY)) { delete sides.top; delete sides.bottom; }
    if (Object.keys(sides).length)
      cuts.push({by: describe(p), sides: Object.fromEntries(Object.entries(sides).map(([k, v]) => [k, Math.round(v * 10) / 10]))});
  }
  const vw = innerWidth, vh = innerHeight, off = {};
  if (ring.l <= -0.5) off.left = -ring.l; if (ring.r >= vw + 0.5) off.right = ring.r - vw;
  if (ring.t <= -0.5) off.top = -ring.t; if (ring.b >= vh + 0.5) off.bottom = ring.b - vh;
  if (Object.keys(off).length) cuts.push({by: 'window', sides: off});
  // Repeated labels are common (rows, switches, and nested Close buttons). Only the same node completes a lap.
  const ids = (window.__focusIds ??= new Map());
  if (!ids.has(el)) ids.set(el, ids.size);
  return {id: ids.get(el), el: describe(el), label, how, grow, cuts};
}"""


def drawer(pg):
    """On a narrow window the sidebar is a drawer: open it when what comes next lives there."""
    menu = pg.locator("button.tool.menu")
    if pg.locator("div.side[inert]").count() and menu.first.is_visible():
        menu.first.click()
        pg.wait_for_timeout(600)


def reach(pg, steps):
    pg.goto(url, wait_until="domcontentloaded")
    pg.locator('[data-part="composer"]').first.wait_for(timeout=10000)
    pg.wait_for_timeout(450)
    for s in steps:
        if s.startswith("key:"):
            pg.keyboard.press(s[4:])
        elif s.startswith("fill:"):
            selector, value = s[5:].split("|", 1)
            pg.locator(selector).fill(value)
        elif s.startswith("status:"):
            button = pg.locator(f'.statusline button[aria-label^="{s[7:]}"]')
            button.first.wait_for(state="attached", timeout=6000)
            if not button.first.is_visible():
                pg.locator('.morebtn:visible').first.click(timeout=2500)
            button.first.click(timeout=2500)
        elif s.startswith("open:"):
            drawer(pg)
            row = pg.locator('.side button.open').filter(has_text=s[5:]).first
            pg.locator('.dirblock[data-block$="/alpha"]').first.wait_for(timeout=6000)
            if not row.is_visible():
                pg.locator('.dirblock[data-block$="/alpha"] > .dir .dirfold[aria-expanded="false"]').first.click(timeout=3500)
            row.click(timeout=6000)
        else:
            if s in ("button.settings", ".listbtn") or s.startswith("button.navbtn"):
                drawer(pg)
            pg.locator(f"{s} >> visible=true").first.click(timeout=6000)
        pg.wait_for_timeout(400)


bad = missed = 0
with sync_playwright() as p:
    b = p.chromium.launch()
    for size in sizes:
        w, h = map(int, size.split("x"))
        for theme in (a.theme,):
            for name, steps, expected in SCREENS:
                if a.only and name not in a.only.split(","):
                    continue
                # A new storage area per screen: an open drawer, active chat or remembered folder from the last
                # screen must not change which page the steps open. Work needs the optional echo transcript.
                if name == "work" and a.seed and not a.echo and not a.only:
                    print(f"{size} work: optional (--seed --echo)")
                    continue
                ctx = b.new_context(viewport={"width": w, "height": h}, is_mobile=w < 600, has_touch=w < 600, locale="ko-KR", color_scheme=theme)
                ctx.add_init_script(f"if(!sessionStorage.__s){{for(const[k,v]of Object.entries({json.dumps(SEED)}))localStorage.setItem(k,v);sessionStorage.__s=1}}")
                pg = ctx.new_page()
                try:
                    # Render an installed entry with a settings form, without installing code or touching a live extension.
                    if name == "extension-detail":
                        detail = {"name": "focus-audit", "title": "Focus audit", "settingsId": "focus-audit",
                                  "settings": [{"key": "label", "type": "string", "label": "Label"}],
                                  **{k: [] for k in ("tools", "commands", "commandFamilies", "methods", "providers", "flags", "events")}}
                        pg.route(base + "/server-extensions", lambda route: route.fulfill(json={"extensions": [detail], "commands": []}))
                    reach(pg, steps)
                    pg.locator(expected).first.wait_for(state="visible", timeout=3500)
                    pg.locator(f'html[data-theme="{theme}"]').wait_for(timeout=2000)
                except Exception as e:
                    missed += 1
                    print(f"{size} {name}: not reached ({str(e).splitlines()[0][:80]}; expected {expected})")
                    ctx.close()
                    continue
                seen, found, checked, first = set(), 0, 0, None
                # the keyboard took the page over: the first press makes later focus :focus-visible
                for i in range(a.max_tabs):
                    pg.keyboard.press("Tab")
                    pg.evaluate("() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))")
                    # TabBar reveals a chip with a smooth scroll. Measure after it settles, not midway through the move.
                    if pg.evaluate("!!document.activeElement?.closest('[data-part=tabbar]')"):
                        pg.wait_for_timeout(350)
                    r = pg.evaluate(CHECK)
                    if not r or "skip" in r:
                        continue
                    key = r["id"]
                    if key == first:
                        break  # came round to the start
                    if first is None:
                        first = key
                    if key in seen:
                        continue
                    seen.add(key)
                    checked += 1
                    if r["cuts"]:
                        found += 1
                        bad += 1
                        f = out / f"{name}-{size}-{len(seen)}.png"
                        pg.screenshot(path=str(f), mask=[pg.locator('input[type="password"], .tokenrow input')])
                        for c in r["cuts"]:
                            print(f"{size} {name}: CUT {r['el']} \"{r['label']}\" ({r['how']} +{r['grow']:g}px) by {c['by']} {c['sides']}  -> {f.relative_to(root) if f.is_relative_to(root) else f}")
                else:
                    print(f"{size} {name}: Tab budget exhausted before completing a lap")
                    missed += 1
                if not checked:
                    missed += 1
                print(f"{size} {name}: {checked} focusable, {found} cut")
                ctx.close()
    b.close()
if echo_up:
    echo_up.terminate()
print(f"done: {bad} cut ring(s), {missed} missed screen(s)")
sys.exit(1 if bad or missed else 0)

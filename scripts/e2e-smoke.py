#!/usr/bin/env python3
"""Screen smoke test: opens the built client in a real browser and walks the main flows once.

Usage: python3 scripts/e2e-smoke.py [--build] [--headed] [--out DIR]
Needs: bun, client/node_modules + server/node_modules (bun install), `pip install playwright` + `playwright install chromium`.
Needs client/dist (cd client && bun run build), or pass --build.

It starts everything itself and removes it on exit (success, failure, Ctrl+C):
  - a pipaya server (loopback, free port, throw-away data dir, no push) with an echo model behind it
    (server/scripts/echo-upstream.ts: answers "hello" with "Echo: hello"),
  - `vite preview` serving client/dist on a free port.
Elements are found by visible text, role or aria-label, never by file path or CSS class. The UI language is pinned to
Korean through localStorage `pipaya.lang`. Nothing waits with a fixed sleep: every step waits for what it expects.
On failure: tmp/e2e/<step>.png and console.log in the output dir (CI: $E2E_OUT or tmp/e2e), exit code 1.
The access token is never printed; it is only typed into the connect form and compared against request URLs.
"""
import argparse, contextlib, json, os, pathlib, re, shutil, signal, socket, subprocess, sys, tempfile, time, urllib.request

from playwright.sync_api import expect, sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
TIMEOUT = 20_000  # ms; generous on purpose, a slow CI runner must not turn into a red check
DEAD_URL = "http://127.0.0.1:9/v1"  # port 9 (discard) refuses connections

# Console errors that are expected, by exact text, and why. Anything else fails the run.
ALLOWED_CONSOLE_ERRORS: list[str] = []

procs: list[subprocess.Popen] = []


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def spawn(cmd, cwd, env=None, log=None):
    full = {**os.environ, **(env or {})}
    full = {k: v for k, v in full.items() if v is not None}  # None = unset
    p = subprocess.Popen(cmd, cwd=cwd, env=full, stdout=log or subprocess.DEVNULL, stderr=subprocess.STDOUT,
                         text=True, start_new_session=True)  # own process group: only what we started gets signalled
    procs.append(p)
    return p


def stop_all():
    for p in reversed(procs):
        if p.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(p.pid, signal.SIGTERM)
    deadline = time.time() + 5
    for p in procs:
        with contextlib.suppress(Exception):
            p.wait(max(0.1, deadline - time.time()))
        if p.poll() is None:
            with contextlib.suppress(ProcessLookupError):
                os.killpg(p.pid, signal.SIGKILL)
    procs.clear()


def wait_http(url, what, proc, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        if proc.poll() is not None:
            raise RuntimeError(f"{what} exited early (code {proc.returncode}); see the server log in the data dir")
        try:
            with urllib.request.urlopen(url, timeout=2):
                return
        except Exception:
            time.sleep(0.2)  # polling a port that is not open yet, not a UI wait
    raise RuntimeError(f"{what} did not answer at {url} within {seconds}s")


class Api:
    def __init__(self, base, token):
        self.base, self.token = base, token

    def call(self, method, path, body=None):
        req = urllib.request.Request(self.base + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                     headers={"Authorization": f"Bearer {self.token}", "content-type": "application/json"})
        with urllib.request.urlopen(req, timeout=15) as r:
            raw = r.read()
        return json.loads(raw) if raw else None

    def default_model(self, provider, model):
        self.call("PUT", "/configuration/defaults", {"provider": provider, "model": model})


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--build", action="store_true", help="build client/dist first")
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--out", default=os.environ.get("E2E_OUT") or str(ROOT / "tmp/e2e"), help="failure screenshots and console log")
    a = ap.parse_args()
    out = pathlib.Path(a.out).resolve()
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("*"):
        if old.is_file():
            old.unlink()

    dist = ROOT / "client/dist/index.html"
    if a.build:
        subprocess.run(["bun", "run", "build"], cwd=ROOT / "client", check=True, stdout=subprocess.DEVNULL)
    if not dist.exists():
        sys.exit("e2e-smoke: client/dist is missing. Run `cd client && bun run build` first (or pass --build).")

    base_tmp = pathlib.Path(os.environ.get("RUNNER_TEMP") or ROOT / "tmp")
    base_tmp.mkdir(parents=True, exist_ok=True)
    work = pathlib.Path(tempfile.mkdtemp(prefix="pipaya-e2e-", dir=base_tmp))
    log = (work / "processes.log").open("w")
    failed = None
    console: list[str] = []
    try:
        data = work / "data"
        data.mkdir()
        # echo model
        up = spawn(["bun", "scripts/echo-upstream.ts"], ROOT / "server", log=subprocess.PIPE)
        line = up.stdout.readline()
        if not line.startswith("READY "):
            raise RuntimeError("echo upstream did not start")
        ready = json.loads(line[6:])
        # server
        sport = free_port()
        server_env = {"PIPAYA_HOST": "127.0.0.1", "PIPAYA_PORT": str(sport), "PIPAYA_DATA_DIR": str(data), "PIPAYA_PUSH_FCM": "0", "PIPAYA_LOG_LEVEL": "warn"}
        for k in ("PIPAYA_TOKEN", "PIPAYA_WORKSPACE", "PIPAYA_DB", "PIPAYA_PROVIDER", "PIPAYA_MODEL", "PIPAYA_RESTRICT_WORKSPACE"):
            server_env[k] = None  # the developer's own settings must not leak into the run
        srv = spawn(["bun", "src/index.ts"], ROOT / "server", env=server_env, log=log)
        api_base = f"http://127.0.0.1:{sport}"
        wait_http(api_base + "/health", "server", srv)
        token = (data / "token").read_text().strip()
        api = Api(api_base, token)
        api.call("PUT", "/configuration/providers/echo", ready["provider"])
        api.call("PUT", "/configuration/providers/dead", {"name": "Dead upstream", "baseUrl": DEAD_URL, "api": "openai-completions", "authRequired": False,
                                                          "models": [{"id": "dead-model", "name": "Dead", "contextWindow": 8192, "maxTokens": 1024, "reasoning": False, "vision": False}]})
        api.default_model("echo", ready["model"])
        # client
        cport = free_port()
        vite = ROOT / "client/node_modules/.bin/vite"
        pv = spawn([str(vite), "preview", "--host", "127.0.0.1", "--port", str(cport), "--strictPort"], ROOT / "client", log=log)
        client_url = f"http://127.0.0.1:{cport}"
        wait_http(client_url + "/", "vite preview", pv)

        failed = run_flows(a, out, client_url, api_base, token, api, console, work)
    except BaseException as e:  # includes KeyboardInterrupt / SIGTERM
        failed = failed or f"setup: {type(e).__name__}: {str(e).replace(locals().get('token') or chr(0), '***')[:300]}"
    finally:
        stop_all()
        with contextlib.suppress(Exception):
            log.close()
            if failed:  # keep the process log (no token in it: the server logs at warn level) next to the screenshots
                shutil.copy(work / "processes.log", out / "processes.log")
        shutil.rmtree(work, ignore_errors=True)
        if console:
            (out / "console.log").write_text("\n".join(console) + "\n")
    if failed:
        print(f"FAIL {failed}\n(screenshots and logs: {out})")
        sys.exit(1)
    print("PASS e2e smoke")


def run_flows(a, out, client_url, api_base, token, api, console, work):
    """Runs the steps in order; returns None, or "<step>: <reason>" for the first one that failed."""
    requests: list[str] = []
    errors: list[str] = []
    state = {"step": "start"}

    def scrub(s):
        return s.replace(token, "***")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=not a.headed)
        ctx = browser.new_context(viewport={"width": 1280, "height": 800})
        ctx.set_default_timeout(TIMEOUT)
        ctx.add_init_script("if(!sessionStorage.__seeded){localStorage.setItem('pipaya.lang','ko');sessionStorage.__seeded=1}")
        page = ctx.new_page()
        page.on("request", lambda r: requests.append(r.url))
        page.on("websocket", lambda w: requests.append(w.url))
        page.on("pageerror", lambda e: errors.append(f"pageerror: {scrub(str(e))[:300]}"))
        page.on("console", lambda m: m.type == "error" and errors.append(f"console.error: {scrub(m.text)[:300]}"))
        page.on("console", lambda m: console.append(f"[{m.type}] {scrub(m.text)[:300]}"))

        def step(name, fn):
            state["step"] = name
            t = time.time()
            fn()
            print(f"ok   {name} ({time.time() - t:.1f}s)", flush=True)

        def a_first_screen():
            page.goto(client_url + "/")
            expect(page.get_by_role("button", name="주소와 토큰으로 연결")).to_be_visible()
            expect(page.get_by_text("서버가 아직 없나요?")).to_be_visible()  # the "how to get a server" help
            page.get_by_role("button", name="주소와 토큰으로 연결").click()
            dialog = page.get_by_role("dialog", name="서버 추가")
            dialog.get_by_label("서버 주소").fill(api_base)
            dialog.get_by_label("액세스 토큰").fill(token)
            dialog.get_by_role("button", name="추가", exact=True).click()
            expect(composer()).to_be_visible()

        def composer():
            return page.get_by_role("textbox", name="에이전트에게 메시지 보내기 · / 명령")

        def b_send():
            composer().fill("hello smoke")
            expect(composer()).to_have_value("hello smoke")
            page.get_by_role("button", name="보내기", exact=True).click()
            expect(page.locator('[data-part="message.user"]').get_by_text("hello smoke")).to_be_visible()
            expect(page.get_by_text("Echo: hello smoke")).to_be_visible()
            expect(composer()).to_have_value("")

        def c_stream_auth():
            events = [u for u in requests if re.search(r"/events(\?|$)", u)]
            assert events, "the page never opened /events"
            assert all("ticket=" in u for u in events), "an /events request has no ticket="
            leaked = [u.split("?")[0] for u in requests if token in u]
            assert not leaked, f"the server token is in {len(leaked)} request URL(s), e.g. {leaked[0]}"

        def d_retry_notice():
            api.default_model("dead", "dead-model")
            # a fresh conversation takes the new default (the first one may keep the model it started with)
            page.keyboard.press("Escape")
            page.get_by_role("button", name="새 대화 또는 터미널").click()
            page.get_by_role("menuitem").first.click()
            # the new conversation is ready when its composer shows the new default model; typing earlier gets wiped by the remount
            expect(page.get_by_role("button", name=re.compile("Dead"))).to_be_visible()
            page.mouse.move(700, 400)  # the "+" menu opens on hover and can stay open under the pointer; it does not matter here
            expect(composer()).to_be_empty()
            composer().fill("will fail")
            expect(composer()).to_have_value("will fail")
            page.get_by_role("button", name="보내기", exact=True).click()
            status = page.get_by_role("status").filter(has_text="다시 시도 중")
            expect(status).to_be_visible()
            expect(status).to_contain_text(re.compile(r"\d+/\d+"))
            status.get_by_role("button", name="중지").click()
            expect(status).to_be_hidden()
            # stopped: the stop button of the running composer is gone and the send button is back
            expect(page.get_by_role("button", name="중지")).to_have_count(0)
            expect(page.get_by_role("button", name="보내기", exact=True)).to_be_visible()

        def e_phone_settings():
            api.default_model("echo", "echo-model")
            ph = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True, device_scale_factor=1)
            ph.set_default_timeout(TIMEOUT)
            ph.add_init_script("if(!sessionStorage.__seeded){localStorage.setItem('pipaya.lang','ko');"
                               f"localStorage.setItem('pipaya.servers',JSON.stringify([{{id:'smoke',name:'smoke',baseUrl:{json.dumps(api_base)},token:{json.dumps(token)}}}]));"
                               "localStorage.setItem('pipaya.server',JSON.stringify('smoke'));sessionStorage.__seeded=1}")
            pp = ph.new_page()
            pp.on("pageerror", lambda e: errors.append(f"pageerror(phone): {scrub(str(e))[:300]}"))
            pp.on("console", lambda m: m.type == "error" and errors.append(f"console.error(phone): {scrub(m.text)[:300]}"))
            state["phone"] = pp
            pp.goto(client_url + "/")
            pp.get_by_role("button", name="사이드바 열기").tap()
            pp.get_by_role("button", name="설정", exact=True).tap()
            settings = pp.get_by_role("dialog", name="설정")
            tabs = settings.get_by_role("tab")
            expect(settings.get_by_role("tab", name="모델")).to_be_visible()
            expect(settings.get_by_role("tab", name="기기")).to_be_visible()
            assert tabs.count() >= 5, f"expected a list of sections, found {tabs.count()}"
            expect(settings.get_by_role("button", name="뒤로")).to_have_count(0)
            settings.get_by_role("tab", name="모델").tap()
            expect(settings.get_by_role("button", name="뒤로")).to_be_visible()
            expect(settings.get_by_role("heading", name="모델")).to_be_visible()
            expect(settings.get_by_role("tab", name="기기")).to_have_count(0)
            settings.get_by_role("button", name="뒤로").tap()
            expect(settings.get_by_role("tab", name="기기")).to_be_visible()
            expect(settings.get_by_role("button", name="뒤로")).to_have_count(0)

        def f_no_errors():
            bad = [e for e in errors if not any(ok in e for ok in ALLOWED_CONSOLE_ERRORS)]
            assert not bad, f"{len(bad)} error(s): " + " | ".join(bad[:3])

        try:
            step("a. first screen -> connect", a_first_screen)
            step("b. send a message, see the echo", b_send)
            step("c. stream auth (ticket, no token in URLs)", c_stream_auth)
            step("d. model call fails -> retry notice -> stop", d_retry_notice)
            step("e. phone settings: list -> section -> back", e_phone_settings)
            step("f. no page or console errors", f_no_errors)
            return None
        except Exception as e:
            msg = scrub(str(e)).strip().splitlines()
            reason = " ".join(msg[:3])[:400]
            for name, pg in (("page", page), ("phone", state.get("phone"))):
                if pg:
                    with contextlib.suppress(Exception):
                        pg.screenshot(path=str(out / f"{re.sub(r'[^a-z0-9]+', '-', state['step'].lower()).strip('-')}-{name}.png"))
            if errors:
                console.extend(f"[collected] {x}" for x in errors)
            return f"{state['step']}: {reason}"
        finally:
            browser.close()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: (_ for _ in ()).throw(KeyboardInterrupt()))
    main()

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../../src/app.ts";
import { BrowserManager, findBrowser, normalizeUrl, profileId } from "../../src/browser.ts";
import { BROWSER_TOOLS, browserTools } from "../../src/browser-tools.ts";
import type { Config } from "../../src/config.ts";
import type { EventBus } from "../../src/events.ts";

const bus = () => ({ publish: () => {} }) as unknown as EventBus;

const exe = findBrowser();
const live = exe ? describe : describe.skip;

describe("normalizeUrl", () => {
	test("adds https and keeps http(s)", () => {
		expect(normalizeUrl("example.com")).toBe("https://example.com/");
		expect(normalizeUrl("http://localhost:3000/a")).toBe("http://localhost:3000/a");
		expect(normalizeUrl("localhost:3000")).toBe("https://localhost:3000/");
		expect(normalizeUrl("about:blank")).toBe("about:blank");
	});
	test("refuses local and script schemes", () => {
		for (const u of ["file:///etc/passwd", "chrome://settings", "javascript:alert(1)", "data:text/html,hi", ""]) expect(() => normalizeUrl(u)).toThrow();
	});
});

describe("findBrowser", () => {
	test("PIPAYA_BROWSER wins and must exist", () => {
		expect(findBrowser({ PIPAYA_BROWSER: "/nope/chrome" })).toBeNull();
		expect(findBrowser({ PIPAYA_BROWSER: process.execPath })).toBe(process.execPath);
	});
});

describe("profile names", () => {
	test("are small slugs; nothing can climb out of the profiles folder", () => {
		expect(profileId(" Work ")).toBe("work");
		for (const bad of ["", "..", "../x", "a/b", ".hidden", "x".repeat(41), "sp ace", "ü"]) expect(() => profileId(bad)).toThrow();
	});
});

describe("disabled browser", () => {
	test("is unavailable and refuses tabs", async () => {
		const b = new BrowserManager(bus(), { enabled: false, dataDir: tmpdir(), executable: exe });
		expect(b.available()).toBe(false);
		await expect(b.create()).rejects.toMatchObject({ code: "browser_unavailable" });
	});
});

live("browser tabs (real Chromium)", () => {
	let dir: string;
	let site: ReturnType<typeof Bun.serve>;
	let app: App;
	let origin: string;
	const api = async (method: any, url: string, payload?: unknown) => {
		const r = await app.server.inject({ method, url, headers: { authorization: "Bearer test-token", ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
		return { status: r.statusCode, json: r.body ? r.json() : undefined };
	};

	beforeAll(async () => {
		dir = mkdtempSync(join(tmpdir(), "pipaya-browser-"));
		mkdirSync(join(dir, "ws"));
		site = Bun.serve({
			port: 0,
			fetch: () => new Response("<title>Demo</title><input aria-label=name><button onclick=\"document.title='clicked:'+document.querySelector('input').value\">Go</button>", { headers: { "content-type": "text/html" } }),
		});
		origin = `http://127.0.0.1:${site.port}/`;
		const cfg: Config = { host: "0.0.0.0", port: 0, dataDir: dir, dbPath: join(dir, "db.sqlite"), token: "test-token", workspaceRoot: join(dir, "ws"), logLevel: "silent" };
		app = await buildApp(cfg, { strictResponses: true, home: dir });
	});
	afterAll(async () => {
		await app.close();
		site.stop(true);
		rmSync(dir, { recursive: true, force: true });
	});

	test("REST: open, list, navigate, close", async () => {
		expect((await api("GET", "/browsers/info")).json).toMatchObject({ enabled: true, available: true });
		const created = await api("POST", "/browsers", { url: origin });
		expect(created.status).toBe(201);
		expect(created.json.id).toStartWith("web_");
		expect(created.json.title).toBe("Demo");
		expect((await api("GET", "/browsers")).json.tabs.map((t: any) => t.id)).toContain(created.json.id);
		expect((await api("POST", `/browsers/${created.json.id}/navigate`, { url: "file:///etc/passwd" })).status).toBe(400);
		expect((await api("POST", `/browsers/${created.json.id}/navigate`, { url: "about:blank" })).json.url).toBe("about:blank");
		expect((await api("DELETE", `/browsers/${created.json.id}`)).status).toBe(200);
		expect((await api("GET", "/browsers")).json.tabs).toEqual([]);
		expect((await api("DELETE", `/browsers/${created.json.id}`)).status).toBe(404);
	});

	test("a view gets frames and its input reaches the page", async () => {
		const tab = (await api("POST", "/browsers", { url: origin })).json;
		const address = await app.server.listen({ port: 0, host: "127.0.0.1" });
		const ws = new WebSocket(`${address.replace("http", "ws")}/browsers/${tab.id}/ws?token=test-token`);
		ws.binaryType = "arraybuffer";
		const got = { hello: false, frames: 0, jpeg: false, png: false };
		ws.onmessage = (e) => {
			if (typeof e.data === "string") got.hello ||= JSON.parse(e.data).type === "hello";
			else {
				got.frames++;
				got.jpeg ||= new Uint8Array(e.data)[0] === 0xff && new Uint8Array(e.data)[1] === 0xd8;
				got.png ||= new Uint8Array(e.data)[0] === 0x89 && new Uint8Array(e.data)[1] === 0x50;
			}
		};
		await new Promise((r) => (ws.onopen = r));
		for (let i = 0; i < 100 && !got.frames; i++) await Bun.sleep(50);
		expect(got.hello).toBe(true);
		expect(got.frames).toBeGreaterThan(0);
		expect(got.jpeg).toBe(true);
		// once the page has been still for a moment, one lossless picture follows the JPEGs
		for (let i = 0; i < 100 && !got.png; i++) await Bun.sleep(50);
		expect(got.png).toBe(true);
		ws.send(JSON.stringify({ type: "fit", width: 500, height: 400 }));
		ws.send(JSON.stringify({ type: "text", text: "x" }));
		ws.send(JSON.stringify({ type: "navigate", to: "reload" }));
		ws.close();
		await api("DELETE", `/browsers/${tab.id}`);
	});

	test("agent tools drive the same tab and mark who is in control", async () => {
		const tools = await api("GET", "/tools");
		const names = tools.json.tools.map((t: any) => t.name);
		for (const n of BROWSER_TOOLS) expect(names).toContain(n);

		const b = new BrowserManager(bus(), { enabled: true, dataDir: join(dir, "own") });
		const defs = browserTools(b);
		const run = async (name: string, params: object, session = "s1") => (defs[name]!.create(dir, [], { sessionId: session }) as any).execute("call", params, undefined);
		try {
			const opened = await run("browser_open", { url: origin });
			const tab = opened.details.tab as string;
			expect(opened.content[0].text).toContain("untrusted");
			const ref = /textbox "name" \[ref=(e\d+)\]/.exec(opened.content[0].text)?.[1];
			const btn = /button "Go" \[ref=(e\d+)\]/.exec(opened.content[0].text)?.[1];
			expect(ref && btn).toBeTruthy();

			const states: string[] = [];
			const by: (string | undefined)[] = [];
			b.attach(tab, { frame() {}, state: (_i, c, who) => (states.push(c), by.push(who)), closed() {} });
			await run("browser_type", { ref, text: "pipaya" });
			const after = await run("browser_click", { ref: btn });
			expect(after.content[0].text).toContain("clicked:pipaya");
			expect(states).toContain("agent");
			expect(by).toContain("s1"); // the page says which session acts
			expect(states.at(-1)).toBe("user");
			await expect(run("browser_click", { ref: "not-a-ref" })).rejects.toThrow("not a ref");

			const shot = await run("browser_screenshot", {});
			expect(shot.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
			expect(b.list().length).toBe(1); // one tab was reused, not one per call
			expect(after.content[0].text).toContain(`Tab: ${tab}`);

			// the new tools
			await run("browser_scroll", { direction: "bottom" });
			await run("browser_press", { key: "Tab" });
			const waited = await run("browser_wait", { text: "Go", seconds: 3 });
			expect(waited.content[0].text).toContain("Found: Go");
			const back = await run("browser_back", { action: "reload" });
			expect(back.content[0].text).toContain(`Tab: ${tab}`);

			// no guessing: with two tabs an unnamed call fails and lists them, a named one works
			const second = (await run("browser_open", { url: origin, newTab: true })).details.tab as string;
			expect(second).not.toBe(tab);
			expect(b.list().length).toBe(2);
			await expect(run("browser_snapshot", {}, "s2")).rejects.toThrow(/2 browser tabs are open/);
			const listed = await run("browser_tabs", {});
			expect(listed.content[0].text).toContain(tab);
			expect(listed.content[0].text).toContain(second);
			expect((await run("browser_snapshot", { tab: second }, "s2")).details.tab).toBe(second);
			// a ref from another page is explained, not a raw timeout
			await expect(run("browser_click", { ref: "e999", tab: second })).rejects.toThrow(/Call browser_snapshot/);
			expect((await run("browser_close", { tab: second })).content[0].text).toContain(`Closed ${second}`);
			expect(b.list().length).toBe(1);
		} finally {
			await b.shutdown();
		}
	}, 60_000);

	test("profiles keep logins apart, survive a restart, and can be cleared, renamed and deleted", async () => {
		const own = join(dir, "profiles");
		const b = new BrowserManager(bus(), { enabled: true, dataDir: own, actionTimeoutMs: 12_000 });
		const defs = browserTools(b);
		const run = async (name: string, params: object) => (defs[name]!.create(own, [], { sessionId: "s1" }) as any).execute("call", params, undefined);
		const cookieOf = async (tab: string) => b.asAgent(tab, (page) => page.evaluate("document.cookie") as Promise<string>);
		try {
			expect(b.listProfiles().map((p) => p.id)).toEqual(["default"]);
			expect(() => b.createProfile({ id: "Bad Name" })).toThrow();
			expect(b.createProfile({ id: "work" })).toMatchObject({ id: "work", agent: true, temporary: false, tabs: 0 });
			expect(() => b.createProfile({ id: "work" })).toThrow(/already exists/);
			expect(b.createProfile({ id: "private", agent: false }).agent).toBe(false);

			// logins (cookies) belong to a profile
			const a = await b.create({ url: origin, profile: "work" });
			const c = await b.create({ url: origin, profile: "default" });
			await b.asAgent(a.id, (page) => page.evaluate("document.cookie = 'who=work; path=/; max-age=86400'"));
			expect(await cookieOf(a.id)).toContain("who=work");
			expect(await cookieOf(c.id)).not.toContain("who=work");
			expect(a.profile).toBe("work");

			// a profile with open tabs cannot be deleted or renamed
			await expect(b.deleteProfile("work")).rejects.toThrow(/close the tabs/);
			await expect(b.updateProfile("work", { id: "job" })).rejects.toThrow(/close the tabs/);
			await b.close(a.id);
			await b.close(c.id);

			// the cookie is still there after the browser closed and started again
			const again = await b.create({ url: origin, profile: "work" });
			expect(await cookieOf(again.id)).toContain("who=work");
			await b.close(again.id);

			// clearing forgets the login but keeps the profile
			await b.clearProfile("work");
			const cleared = await b.create({ url: origin, profile: "work" });
			expect(await cookieOf(cleared.id)).not.toContain("who=work");
			await b.close(cleared.id);
			expect((await b.updateProfile("work", { id: "job" })).id).toBe("job");
			expect(b.listProfiles().map((p) => p.id)).toContain("job");
			await b.deleteProfile("job");
			expect(b.listProfiles().map((p) => p.id)).not.toContain("job");
		} finally {
			await b.shutdown();
		}
	}, { timeout: 90_000, retry: 2 });

	test("a profile can be reserved for people, and the temp one leaves nothing behind", async () => {
		const own = join(dir, "profiles2");
		const b = new BrowserManager(bus(), { enabled: true, dataDir: own, actionTimeoutMs: 12_000 });
		const defs = browserTools(b);
		const run = async (name: string, params: object) => (defs[name]!.create(own, [], { sessionId: "s1" }) as any).execute("call", params, undefined);
		try {
			b.createProfile({ id: "private", agent: false });
			// a profile reserved for people: agents neither see its tabs nor can use them or open one in it
			const mine = await b.create({ url: origin, profile: "private" });
			const open = await run("browser_open", { url: origin, newTab: true });
			const shared = open.details.tab as string;
			expect(shared).not.toBe(mine.id);
			const listed = (await run("browser_tabs", {})).content[0].text as string;
			expect(listed).toContain(shared);
			expect(listed).not.toContain(mine.id);
			await expect(run("browser_snapshot", { tab: mine.id })).rejects.toThrow(/reserved for people/);
			await expect(run("browser_open", { url: origin, profile: "private" })).rejects.toThrow(/reserved for people/);
			// the person can still use it
			expect(b.get(mine.id).profile).toBe("private");
			await b.updateProfile("private", { agent: true });
			expect((await run("browser_snapshot", { tab: mine.id })).details.tab).toBe(mine.id);
			await b.close(mine.id);
			await b.close(shared);

			// throw-away profile: its own folder, deleted with its last tab
			const t1 = (await run("browser_open", { url: origin, profile: "temp" })).details.tab as string;
			const t2 = (await run("browser_open", { url: origin, profile: "temp", newTab: true })).details.tab as string;
			expect(b.get(t1).profile).toBe("temp");
			const during = readdirSync(join(own, "browser-profiles")).filter((n) => n.startsWith(".temp-"));
			expect(during.length).toBe(1);
			await b.close(t1);
			expect(readdirSync(join(own, "browser-profiles")).filter((n) => n.startsWith(".temp-")).length).toBe(1); // still one tab
			await b.close(t2);
			for (let i = 0; i < 50 && readdirSync(join(own, "browser-profiles")).some((n) => n.startsWith(".temp-")); i++) await Bun.sleep(100);
			expect(readdirSync(join(own, "browser-profiles")).filter((n) => n.startsWith(".temp-"))).toEqual([]);
			expect(existsSync(join(own, "browser-profiles", "temp"))).toBe(false);
		} finally {
			await b.shutdown();
		}
	}, { timeout: 90_000, retry: 2 });

	test("handoff: the agent waits for the person in the same page, then continues", async () => {
		const own = join(dir, "handoff");
		const b = new BrowserManager(bus(), { enabled: true, dataDir: own });
		const defs = browserTools(b);
		let asked: { id: string; question: string; options?: string[] } | null = null;
		let answer: (a: string) => void = () => {};
		const ctx = {
			sessionId: "s1",
			ask: (id: string, req: { question: string; options?: string[] }) => ((asked = { id, ...req }), new Promise<string>((r) => (answer = r))),
		};
		const tool = (name: string) => defs[name]!.create(own, [], ctx as any) as any;
		try {
			const tab = (await tool("browser_open").execute("c1", { url: origin }, undefined)).details.tab as string;
			const seen: { control: string; handoff: { by: string; note: string } | null }[] = [];
			b.attach(tab, { frame() {}, state: (_i, c, _by, h) => seen.push({ control: c, handoff: h ?? null }), closed() {} });

			const pending = tool("browser_handoff").execute("c2", { note: "Log in with your account", tab }, undefined);
			for (let i = 0; i < 50 && !asked; i++) await Bun.sleep(20);
			expect(asked!.question).toContain("Log in with your account");
			expect(asked!.question).toContain(tab);
			expect(asked!.options).toEqual(["Done", "I can't do this"]);
			// while it waits, the view is told the page is the person's, with the note
			expect(seen.at(-1)).toEqual({ control: "user", handoff: { by: "s1", note: "Log in with your account" } });
			// the person acts in the page, then answers
			await b.asAgent(tab, (page) => page.evaluate("document.title = 'logged in'"));
			answer("Done");
			const res = await pending;
			expect(res.content[0].text).toContain("The user says it is done.");
			expect(res.content[0].text).toContain("logged in");
			expect(seen.at(-1)!.handoff).toBeNull();

			// a refusal is reported as such, free text is passed on
			const no = tool("browser_handoff").execute("c3", { note: "Solve the captcha", tab }, undefined);
			for (let i = 0; i < 50 && asked!.id !== "c3"; i++) await Bun.sleep(20);
			answer("I can't do this");
			expect((await no).content[0].text).toContain("could not do it");

			// an aborted run (the question rejects) clears the hand-over
			const abort = tool("browser_handoff").execute("c4", { note: "x", tab }, undefined);
			for (let i = 0; i < 50 && asked!.id !== "c4"; i++) await Bun.sleep(20);
			const failing = tool("browser_handoff");
			void failing;
			(ctx as any).ask = undefined;
			answer("Done");
			await abort;
			expect(seen.at(-1)!.handoff).toBeNull();
			await expect(tool("browser_handoff").execute("c5", { note: "x", tab }, undefined)).rejects.toThrow(/no way to ask/);
		} finally {
			await b.shutdown();
		}
	}, 60_000);

	test("a profile's logins can be exported and imported into another server", async () => {
		const from = new BrowserManager(bus(), { enabled: true, dataDir: join(dir, "export-a"), actionTimeoutMs: 12_000 });
		const to = new BrowserManager(bus(), { enabled: true, dataDir: join(dir, "export-b"), actionTimeoutMs: 12_000 });
		const probe = async (m: BrowserManager, tab: string) => m.asAgent(tab, (page) => page.evaluate("document.cookie + '|' + localStorage.getItem('theme')") as Promise<string>);
		try {
			if (!from.listProfiles().some((p) => p.id === "work")) from.createProfile({ id: "work" });
			const a = await from.create({ url: origin, profile: "work" });
			await from.asAgent(a.id, (page) => page.evaluate("document.cookie = 'who=work; path=/; max-age=86400'; localStorage.setItem('theme', 'dark')"));
			await from.close(a.id);

			// exported while no tab is open: a short-lived browser reads it, and none is left running
			const state = await from.exportProfile("work");
			expect(state.cookies.some((c) => c.name === "who" && c.value === "work")).toBe(true);
			expect(JSON.stringify(state.origins)).toContain("theme"); // local storage too, though no page was open
			expect(from.listProfiles().find((p) => p.id === "work")!.running).toBe(false);

			// another server has no such profile: importing creates it, and the login works there
			expect(to.listProfiles().map((p) => p.id)).toEqual(["default"]);
			const made = await to.importProfile("work", state);
			expect(made).toMatchObject({ id: "work", agent: true });
			const b = await to.create({ url: origin, profile: "work" });
			expect(await probe(to, b.id)).toBe("who=work|dark");
			await to.close(b.id);

			// the throw-away profile has nothing to move; a file that is too big is refused
			await expect(from.exportProfile("temp")).rejects.toThrow(/throw-away/);
			await expect(to.importProfile("work", { cookies: [{ name: "x", value: "y".repeat(5 * 1024 * 1024) }], origins: [] })).rejects.toThrow(/too big/);
		} finally {
			await from.shutdown();
			await to.shutdown();
		}
	}, { timeout: 90_000, retry: 2 });

	test("only the admin token may export or import logins", async () => {
		const own = (await api("POST", "/pairing", {})).json;
		expect(own.code).toBeTruthy();
		const redeemed = await app.server.inject({ method: "POST", url: "/pairing/redeem", headers: { "content-type": "application/json" }, payload: JSON.stringify({ code: own.code, name: "phone" }) });
		const device = redeemed.json().token as string;
		const asDevice = async (method: any, url: string, payload?: unknown) => {
			const r = await app.server.inject({ method, url, headers: { authorization: `Bearer ${device}`, ...(payload !== undefined ? { "content-type": "application/json" } : {}) }, ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}) });
			return r.statusCode;
		};
		expect(await asDevice("POST", "/browsers/profiles/default/export", {})).toBe(403);
		expect(await asDevice("POST", "/browsers/profiles/default/import", { cookies: [], origins: [] })).toBe(403);
		// the rest of the browser is open to a paired device
		expect(await asDevice("GET", "/browsers/profiles")).toBe(200);
	});

	test("text being composed (Korean) shows in the page, and the finished text replaces it", async () => {
		const own = join(dir, "ime");
		const b = new BrowserManager(bus(), { enabled: true, dataDir: own, actionTimeoutMs: 12_000 });
		try {
			const t = await b.create({ url: origin });
			const value = () => b.asAgent(t.id, (page) => page.evaluate("document.querySelector('input').value") as Promise<string>);
			await b.asAgent(t.id, (page) => page.locator("input").click());
			await b.input(t.id, { type: "compose", text: "ㅎ" });
			await b.input(t.id, { type: "compose", text: "하" });
			expect(await value()).toBe("하"); // visible while it is still being composed
			await b.input(t.id, { type: "text", text: "한" });
			expect(await value()).toBe("한"); // the composition was replaced, not appended
			await b.input(t.id, { type: "text", text: "글" });
			expect(await value()).toBe("한글");
		} finally {
			await b.shutdown();
		}
	}, { timeout: 60_000, retry: 2 });
});

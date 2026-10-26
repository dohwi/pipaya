import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type App } from "../src/app.ts";
import { BrowserManager, findBrowser, normalizeUrl } from "../src/browser.ts";
import { BROWSER_TOOLS, browserTools } from "../src/browser-tools.ts";
import type { Config } from "../src/config.ts";
import type { EventBus } from "../src/events.ts";

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
		const got = { hello: false, frames: 0, jpeg: false };
		ws.onmessage = (e) => {
			if (typeof e.data === "string") got.hello ||= JSON.parse(e.data).type === "hello";
			else {
				got.frames++;
				got.jpeg ||= new Uint8Array(e.data)[0] === 0xff && new Uint8Array(e.data)[1] === 0xd8;
			}
		};
		await new Promise((r) => (ws.onopen = r));
		for (let i = 0; i < 100 && !got.frames; i++) await Bun.sleep(50);
		expect(got.hello).toBe(true);
		expect(got.frames).toBeGreaterThan(0);
		expect(got.jpeg).toBe(true);
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
});

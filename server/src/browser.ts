import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import Type, { type Static } from "typebox";
import { badRequest, HttpError, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";

/**
 * Browser tabs on the server, shown in the client as panes next to conversations and driven by agents with the same
 * pages the user sees. One Chromium (the server's own Chrome/Chromium, nothing is downloaded) runs with a persistent
 * profile under `<dataDir>/browser-profiles/default`, so logins survive restarts. Tabs live in memory only; the
 * browser itself starts with the first tab and ends with the last.
 *
 * Ids start with `web_`, so they can share the group layout with session and terminal ids.
 */

export const BROWSER_PREFIX = "web_";
export const isBrowserId = (id: string) => id.startsWith(BROWSER_PREFIX);
export const MAX_BROWSER_TABS = 8;
export const DEFAULT_PROFILE = "default";
/** Output of one snapshot handed to a model. */
export const MAX_SNAPSHOT_BYTES = 50 * 1024;

export const BrowserTabSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	url: Type.String(),
	profile: Type.String(),
	createdAt: Type.Integer(),
});
export const BrowserTabList = Type.Object({ tabs: Type.Array(BrowserTabSchema) });
export const BrowserSupport = Type.Object({ enabled: Type.Boolean(), available: Type.Boolean(), max: Type.Integer() });
export const CreateBrowserBody = Type.Object({ url: Type.Optional(Type.String({ maxLength: 4000 })) });
export const NavigateBrowserBody = Type.Object({ url: Type.String({ minLength: 1, maxLength: 4000 }) });
export type BrowserTabInfo = Static<typeof BrowserTabSchema>;

/** Only web pages: no file://, chrome://, javascript: or data: for what a user or agent types. */
export function normalizeUrl(input: string): string {
	const raw = input.trim();
	if (!raw) throw badRequest("url is empty");
	if (raw === "about:blank") return raw;
	const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw) && !/^[^/]+:\d+(\/|$)/.test(raw) ? raw : `https://${raw}`;
	let u: URL;
	try {
		u = new URL(withScheme);
	} catch {
		throw badRequest(`not a valid address: ${raw}`);
	}
	if (u.protocol !== "http:" && u.protocol !== "https:") throw badRequest(`only http(s) pages can be opened (got ${u.protocol})`);
	return u.toString();
}

/** The Chrome/Chromium to run: PIPAYA_BROWSER, a system install, or one Playwright cached. */
export function findBrowser(env: Record<string, string | undefined> = process.env, platform: NodeJS.Platform = process.platform): string | null {
	if (env.PIPAYA_BROWSER) return existsSync(env.PIPAYA_BROWSER) ? env.PIPAYA_BROWSER : null;
	const home = env.HOME ?? env.USERPROFILE ?? homedir();
	const fixed: string[] = [];
	const cacheRoot = platform === "darwin" ? join(home, "Library/Caches/ms-playwright") : platform === "win32" ? join(env.LOCALAPPDATA ?? "", "ms-playwright") : join(home, ".cache/ms-playwright");
	if (platform === "linux") {
		for (const dir of (env.PATH ?? "").split(":")) for (const n of ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]) fixed.push(join(dir, n));
	} else if (platform === "darwin") {
		fixed.push("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium");
	} else if (platform === "win32") {
		for (const base of [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA]) if (base) fixed.push(join(base, "Google/Chrome/Application/chrome.exe"));
	}
	for (const p of fixed) if (existsSync(p)) return p;
	try {
		const builds = readdirSync(cacheRoot).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
		for (const b of builds) {
			for (const rel of ["chrome-linux64/chrome", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium", "chrome-win/chrome.exe"]) {
				const p = join(cacheRoot, b, rel);
				if (existsSync(p)) return p;
			}
		}
	} catch {
		/* no cache */
	}
	return null;
}

/** What a view of a tab receives. Frames are JPEG bytes; the rest is small JSON. */
export interface BrowserClient {
	frame(jpeg: Uint8Array, size: { width: number; height: number }): void;
	state(info: BrowserTabInfo, control: "user" | "agent"): void;
	closed(): void;
}

interface Tab {
	info: BrowserTabInfo;
	page: Page;
	cdp: CDPSession;
	clients: Set<BrowserClient>;
	screencasting: boolean;
	agentBusy: number;
	lastFrame: { jpeg: Uint8Array; width: number; height: number } | null;
	closing: boolean;
}

export type BrowserInput =
	| { type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number }
	| { type: "key"; action: "down" | "up"; key: string; code?: string; text?: string; modifiers?: number }
	| { type: "text"; text: string };

export interface BrowserOptions {
	enabled: boolean;
	dataDir: string;
	/** Defaults to `findBrowser()`. */
	executable?: string | null;
	headless?: boolean;
}

export class BrowserManager {
	private tabs = new Map<string, Tab>();
	private context: Promise<BrowserContext> | null = null;
	/** Most recently used tab: the one an agent tool acts on when it names none. */
	private current: string | null = null;
	private exe: string | null;

	constructor(
		private bus: EventBus,
		private opts: BrowserOptions,
	) {
		this.exe = opts.executable === undefined ? findBrowser() : opts.executable;
	}

	available(): boolean {
		return this.opts.enabled && this.exe !== null;
	}

	support(): Static<typeof BrowserSupport> {
		return { enabled: this.opts.enabled, available: this.available(), max: MAX_BROWSER_TABS };
	}

	has(id: string): boolean {
		return this.tabs.has(id);
	}

	list(): BrowserTabInfo[] {
		return [...this.tabs.values()].map((t) => t.info).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): BrowserTabInfo {
		return this.tab(id).info;
	}

	private tab(id: string): Tab {
		const t = this.tabs.get(id);
		if (!t) throw notFound("browser tab");
		return t;
	}

	private launch(): Promise<BrowserContext> {
		if (!this.available()) throw new HttpError(403, "browser_unavailable", this.opts.enabled ? "no Chrome or Chromium was found on this server (install one or set PIPAYA_BROWSER)" : "the browser is turned off on this server (PIPAYA_BROWSER=0)");
		this.context ??= (async () => {
			const dir = join(this.opts.dataDir, "browser-profiles", DEFAULT_PROFILE);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			const ctx = await chromium.launchPersistentContext(dir, {
				executablePath: this.exe!,
				headless: this.opts.headless ?? true,
				viewport: { width: 1280, height: 800 },
				acceptDownloads: false,
				args: ["--no-first-run", "--no-default-browser-check", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
			});
			ctx.on("close", () => {
				this.context = null;
				for (const t of [...this.tabs.values()]) this.drop(t);
			});
			return ctx;
		})().catch((e) => {
			this.context = null;
			throw new HttpError(502, "browser_launch_failed", `could not start the browser: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
		});
		return this.context;
	}

	async create(input: Static<typeof CreateBrowserBody> = {}): Promise<BrowserTabInfo> {
		if (this.tabs.size >= MAX_BROWSER_TABS) throw new HttpError(409, "too_many_browser_tabs", `at most ${MAX_BROWSER_TABS} browser tabs can be open at once`);
		const url = input.url?.trim() ? normalizeUrl(input.url) : "about:blank";
		const ctx = await this.launch();
		const page = await ctx.newPage();
		const cdp = await ctx.newCDPSession(page);
		const id = BROWSER_PREFIX + randomUUID();
		const tab: Tab = { info: { id, title: "", url: "about:blank", profile: DEFAULT_PROFILE, createdAt: Date.now() }, page, cdp, clients: new Set(), screencasting: false, agentBusy: 0, lastFrame: null, closing: false };
		this.tabs.set(id, tab);
		this.current = id;
		cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
			cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
			const jpeg = Buffer.from(f.data, "base64");
			tab.lastFrame = { jpeg, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight };
			for (const c of tab.clients) c.frame(jpeg, { width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
		});
		page.on("framenavigated", (f) => f === page.mainFrame() && void this.refresh(tab));
		page.on("load", () => void this.refresh(tab));
		page.on("close", () => this.drop(tab));
		// A page that opens a new window (target=_blank, window.open) stays in this tab: a tab is one pane.
		page.on("popup", (p) => {
			const target = p.url();
			p.close().catch(() => {});
			if (/^https?:/.test(target)) page.goto(target).catch(() => {});
		});
		this.bus.publish(null, "browser_created", tab.info, { ephemeral: true });
		if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {});
		await this.refresh(tab);
		return tab.info;
	}

	private async refresh(tab: Tab) {
		if (tab.closing || tab.page.isClosed()) return;
		const title = await tab.page.title().catch(() => tab.info.title);
		const url = tab.page.url();
		if (title === tab.info.title && url === tab.info.url) return;
		tab.info = { ...tab.info, title, url };
		this.bus.publish(null, "browser_updated", tab.info, { ephemeral: true });
		for (const c of tab.clients) c.state(tab.info, tab.agentBusy ? "agent" : "user");
	}

	/** The tab was closed (by us, by the page, or because the browser went away). */
	private drop(tab: Tab) {
		if (tab.closing) return;
		tab.closing = true;
		this.tabs.delete(tab.info.id);
		if (this.current === tab.info.id) this.current = [...this.tabs.keys()].pop() ?? null;
		for (const c of tab.clients) c.closed();
		tab.clients.clear();
		this.bus.publish(null, "browser_closed", { id: tab.info.id }, { ephemeral: true });
		if (!this.tabs.size) void this.stopBrowser();
	}

	private async stopBrowser() {
		const pending = this.context;
		this.context = null;
		if (pending) await (await pending.catch(() => null))?.close().catch(() => {});
	}

	async close(id: string): Promise<void> {
		const tab = this.tab(id);
		await tab.page.close().catch(() => {});
		this.drop(tab);
	}

	async navigate(id: string, input: string | "back" | "forward" | "reload"): Promise<BrowserTabInfo> {
		const tab = this.tab(id);
		if (input === "back") await tab.page.goBack({ timeout: 15_000 }).catch(() => null);
		else if (input === "forward") await tab.page.goForward({ timeout: 15_000 }).catch(() => null);
		else if (input === "reload") await tab.page.reload({ timeout: 30_000 }).catch(() => null);
		else await tab.page.goto(normalizeUrl(input), { waitUntil: "domcontentloaded", timeout: 30_000 });
		await this.refresh(tab);
		return tab.info;
	}

	/* ---------- views ---------- */

	attach(id: string, client: BrowserClient): { info: BrowserTabInfo; detach(): void } {
		const tab = this.tab(id);
		tab.clients.add(client);
		if (tab.lastFrame) client.frame(tab.lastFrame.jpeg, tab.lastFrame);
		void this.syncScreencast(tab);
		return {
			info: tab.info,
			detach: () => {
				tab.clients.delete(client);
				void this.syncScreencast(tab);
			},
		};
	}

	/** Frames only flow while someone watches. */
	private async syncScreencast(tab: Tab) {
		if (tab.closing) return;
		const want = tab.clients.size > 0;
		if (want === tab.screencasting) return;
		tab.screencasting = want;
		try {
			if (want) await tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, maxWidth: 1600, maxHeight: 1200, everyNthFrame: 1 });
			else await tab.cdp.send("Page.stopScreencast");
		} catch {
			tab.screencasting = false;
		}
	}

	async input(id: string, ev: BrowserInput): Promise<void> {
		const tab = this.tab(id);
		this.current = id;
		const send = (method: string, params: object) => tab.cdp.send(method as never, params as never);
		if (ev.type === "mouse") {
			const type = ev.action === "move" ? "mouseMoved" : ev.action === "down" ? "mousePressed" : "mouseReleased";
			await send("Input.dispatchMouseEvent", { type, x: ev.x, y: ev.y, button: ev.action === "move" ? "none" : (ev.button ?? "left"), clickCount: ev.clickCount ?? (ev.action === "move" ? 0 : 1) });
		} else if (ev.type === "wheel") {
			await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
		} else if (ev.type === "key") {
			await send("Input.dispatchKeyEvent", { type: ev.action === "down" ? (ev.text ? "keyDown" : "rawKeyDown") : "keyUp", key: ev.key, code: ev.code, text: ev.action === "down" ? ev.text : undefined, modifiers: ev.modifiers ?? 0 });
		} else {
			await send("Input.insertText", { text: ev.text });
		}
	}

	/* ---------- agents ---------- */

	/** The tab an agent tool acts on: the named one, else the last one used, else a new one. */
	async forAgent(id?: string): Promise<string> {
		if (id) {
			this.tab(id);
			return id;
		}
		if (this.current && this.tabs.has(this.current)) return this.current;
		return (await this.create()).id;
	}

	/** Marks the tab as agent-driven while `fn` runs, so views can show who is in control. */
	async asAgent<T>(id: string, fn: (page: Page) => Promise<T>): Promise<T> {
		const tab = this.tab(id);
		this.current = id;
		tab.agentBusy++;
		for (const c of tab.clients) c.state(tab.info, "agent");
		try {
			return await fn(tab.page);
		} finally {
			tab.agentBusy--;
			await this.refresh(tab);
			for (const c of tab.clients) c.state(tab.info, tab.agentBusy ? "agent" : "user");
		}
	}

	async shutdown(): Promise<void> {
		for (const t of [...this.tabs.values()]) {
			t.closing = true;
			for (const c of t.clients) c.closed();
		}
		this.tabs.clear();
		await this.stopBrowser();
	}
}

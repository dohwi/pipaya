import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium, type BrowserContext, type CDPSession, type Page } from "playwright-core";
import Type, { type Static } from "typebox";
import { badRequest, HttpError, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { isInside } from "./tools.ts";

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
/** The throw-away profile: no history, and its folder is deleted once its last tab closes. */
export const TEMP_PROFILE = "temp";
export const MAX_PROFILES = 12;
/** One agent action on a page may take this long; a page that never answers fails the call instead of hanging the run. */
export const ACTION_TIMEOUT_MS = 45_000;
/** A browser that does not answer within this is started again (see `start`). */
export const LAUNCH_TIMEOUT_MS = 6000;
export const LAUNCH_ATTEMPTS = 3;
const PROFILE_ID = /^[a-z0-9][a-z0-9_-]{0,38}$/;
export const profileId = (raw: string): string => {
	const id = raw.trim().toLowerCase();
	if (!PROFILE_ID.test(id)) throw badRequest("a profile name is 1-39 characters: letters a-z, digits, - and _ (starting with a letter or digit)");
	return id;
};
/** At most ~15 frames per second go to the views. */
export const FRAME_INTERVAL_MS = 66;
/** After this long without a new frame the page is "still": one sharp (lossless) picture replaces the last JPEG. */
export const SETTLE_MS = 450;
/** How long the frames that our own sharp picture causes are ignored. */
export const SETTLE_QUIET_MS = 250;
/** Page size limits when a view fits the page to its panel (CSS px) */
export const MIN_VIEW = { width: 320, height: 240 };
export const MAX_VIEW = { width: 1920, height: 1440 };
/** Output of one snapshot handed to a model. */
export const MAX_SNAPSHOT_BYTES = 50 * 1024;

export const BrowserTabSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	url: Type.String(),
	/** Absolute folder the tab is filed under in the sidebar (browsing itself is not tied to it). */
	cwd: Type.String(),
	profile: Type.String(),
	createdAt: Type.Integer(),
});
export const BrowserProfileSchema = Type.Object({
	/** Folder name under browser-profiles/, also what tabs and tools call it */
	id: Type.String(),
	/** `temp`: lives in a throw-away folder that is deleted when its last tab closes */
	temporary: Type.Boolean(),
	/** Agents may open and act on tabs of this profile (off = people only) */
	agent: Type.Boolean(),
	/** Tabs open right now */
	tabs: Type.Integer(),
	/** Its browser is running */
	running: Type.Boolean(),
	createdAt: Type.Integer(),
});
export const BrowserProfileList = Type.Object({ profiles: Type.Array(BrowserProfileSchema), default: Type.String() });
export const CreateProfileBody = Type.Object({ id: Type.String({ minLength: 1, maxLength: 40 }), agent: Type.Optional(Type.Boolean()) });
export const PatchProfileBody = Type.Object({ agent: Type.Optional(Type.Boolean()), id: Type.Optional(Type.String({ minLength: 1, maxLength: 40 })) });
export type BrowserProfileInfo = Static<typeof BrowserProfileSchema>;
/** Cookies and local storage of a profile (Playwright's storage state): the logins, as a file that can move between servers. */
export const ProfileStateSchema = Type.Object({
	cookies: Type.Array(Type.Record(Type.String(), Type.Unknown())),
	origins: Type.Array(Type.Record(Type.String(), Type.Unknown())),
});
export type ProfileState = Static<typeof ProfileStateSchema>;
/** An exported profile is at most this big (cookies and local storage as JSON). */
export const MAX_PROFILE_STATE_BYTES = 4 * 1024 * 1024;
export const BrowserTabList = Type.Object({ tabs: Type.Array(BrowserTabSchema) });
export const BrowserSupport = Type.Object({ enabled: Type.Boolean(), available: Type.Boolean(), max: Type.Integer() });
export const CreateBrowserBody = Type.Object({ url: Type.Optional(Type.String({ maxLength: 4000 })), cwd: Type.Optional(Type.String({ maxLength: 4000 })), profile: Type.Optional(Type.String({ maxLength: 40 })) });
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
	/** `by`: the session whose agent is acting, while `control` is "agent" */
	state(info: BrowserTabInfo, control: "user" | "agent", by?: string, handoff?: { by: string; note: string } | null): void;
	closed(): void;
}

interface Tab {
	info: BrowserTabInfo;
	/** The browser this tab lives in. A profile can be started again while its old browser is still ending, so "the tabs of a profile" can belong to two browsers. */
	context: BrowserContext;
	page: Page;
	cdp: CDPSession;
	clients: Set<BrowserClient>;
	screencasting: boolean;
	/** Sessions whose agents are acting on the page right now (a stack: calls may overlap) */
	agents: string[];
	/** An agent asked the person to do something here (login, captcha …) and waits: the note views show */
	handoff: { by: string; note: string } | null;
	/** When the last frame went out (frames are rate-limited) */
	lastSent: number;
	/** Waits for the page to be still, then sends one sharp picture */
	settleTimer: ReturnType<typeof setTimeout> | null;
	/** Until this time, frames are the echo of our own sharp picture (taking it repaints the page): they are not sent and do not restart the wait */
	quietUntil: number;
	/** Size the page was last fitted to by a view */
	fit: { width: number; height: number } | null;
	lastFrame: { jpeg: Uint8Array; width: number; height: number } | null;
	closing: boolean;
}

export type BrowserInput =
	| { type: "mouse"; action: "move" | "down" | "up"; x: number; y: number; button?: "left" | "middle" | "right"; clickCount?: number }
	| { type: "wheel"; x: number; y: number; dx: number; dy: number }
	| { type: "key"; action: "down" | "up"; key: string; code?: string; text?: string; modifiers?: number }
	| { type: "text"; text: string }
	/** Text still being composed (Korean, Japanese …): shown underlined in the page until it is committed with `text` */
	| { type: "compose"; text: string };

export interface BrowserOptions {
	enabled: boolean;
	dataDir: string;
	/** Folder a new tab is filed under; default: the data dir. */
	defaultWorkdir?: () => string;
	/** Defaults to `findBrowser()`. */
	executable?: string | null;
	headless?: boolean;
	/** Limit of one agent action (default `ACTION_TIMEOUT_MS`; tests shorten it). */
	actionTimeoutMs?: number;
}

export class BrowserManager {
	private tabs = new Map<string, Tab>();
	/** One Chromium per profile (a profile folder can only be open in one process). */
	private contexts = new Map<string, Promise<BrowserContext>>();
	/** Pages that already are a tab (a browser's first blank page is taken over once). */
	private claimed = new WeakSet<Page>();
	/** Browsers that are shutting down: their profile folder is still theirs until `close()` has finished. */
	private stopping = new Map<string, Promise<void>>();
	/** Throw-away profile folders, removed once their browser has ended (or on shutdown). */
	private tempDirs = new Set<string>();
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

	/* ---------- profiles ---------- */

	private get root(): string {
		return join(this.opts.dataDir, "browser-profiles");
	}
	private profileDir(id: string): string {
		const dir = join(this.root, id);
		if (!isInside(this.root, dir)) throw badRequest("invalid profile name");
		return dir;
	}
	private metaFile(id: string): string {
		return join(this.profileDir(id), ".pipaya-profile.json");
	}
	private meta(id: string): { agent: boolean; createdAt: number } {
		if (id === TEMP_PROFILE) return { agent: true, createdAt: 0 };
		try {
			const m = JSON.parse(readFileSync(this.metaFile(id), "utf8"));
			return { agent: m.agent !== false, createdAt: typeof m.createdAt === "number" ? m.createdAt : 0 };
		} catch {
			return { agent: true, createdAt: 0 };
		}
	}
	private writeMeta(id: string, m: { agent: boolean; createdAt: number }) {
		writeFileSync(this.metaFile(id), JSON.stringify(m), { mode: 0o600 });
	}
	private tabsOf(id: string): Tab[] {
		return [...this.tabs.values()].filter((t) => t.info.profile === id);
	}

	/** Saved profiles (folders) plus the throw-away one while it is in use. */
	listProfiles(): BrowserProfileInfo[] {
		const ids = new Set<string>([DEFAULT_PROFILE]);
		try {
			for (const d of readdirSync(this.root, { withFileTypes: true })) if (d.isDirectory() && PROFILE_ID.test(d.name) && d.name !== TEMP_PROFILE) ids.add(d.name);
		} catch {
			/* nothing saved yet */
		}
		if (this.contexts.has(TEMP_PROFILE) || this.tabsOf(TEMP_PROFILE).length) ids.add(TEMP_PROFILE);
		return [...ids]
			.map((id) => {
				const m = this.meta(id);
				return { id, temporary: id === TEMP_PROFILE, agent: id === TEMP_PROFILE ? true : m.agent, tabs: this.tabsOf(id).length, running: this.contexts.has(id), createdAt: m.createdAt };
			})
			.sort((a, b) => (a.id === DEFAULT_PROFILE ? -1 : b.id === DEFAULT_PROFILE ? 1 : a.createdAt - b.createdAt || a.id.localeCompare(b.id)));
	}

	createProfile(input: Static<typeof CreateProfileBody>): BrowserProfileInfo {
		const id = profileId(input.id);
		if (id === TEMP_PROFILE) throw badRequest(`"${TEMP_PROFILE}" is the throw-away profile and cannot be created`);
		if (existsSync(this.profileDir(id))) throw new HttpError(409, "profile_exists", `profile "${id}" already exists`);
		if (this.listProfiles().filter((p) => !p.temporary).length >= MAX_PROFILES) throw new HttpError(409, "too_many_profiles", `at most ${MAX_PROFILES} profiles can be saved`);
		mkdirSync(this.profileDir(id), { recursive: true, mode: 0o700 });
		this.writeMeta(id, { agent: input.agent !== false, createdAt: Date.now() });
		return this.listProfiles().find((p) => p.id === id)!;
	}

	/** Wait until a profile's browser, if it is closing, has really exited: its folder is not free before that. */
	private async settled(profile: string): Promise<void> {
		await this.stopping.get(profile);
	}

	/** Allow or forbid agents on a profile, or rename it (not while it has tabs: its browser holds the folder). */
	async updateProfile(rawId: string, changes: Static<typeof PatchProfileBody>): Promise<BrowserProfileInfo> {
		const id = profileId(rawId);
		if (id === TEMP_PROFILE) throw badRequest("the throw-away profile cannot be changed");
		if (!this.listProfiles().some((p) => p.id === id)) throw notFound("browser profile");
		let at = id;
		if (changes.id !== undefined && profileId(changes.id) !== id) {
			const next = profileId(changes.id);
			if (id === DEFAULT_PROFILE) throw badRequest(`"${DEFAULT_PROFILE}" cannot be renamed`);
			if (next === TEMP_PROFILE || next === DEFAULT_PROFILE || existsSync(this.profileDir(next))) throw new HttpError(409, "profile_exists", `profile "${next}" already exists`);
			await this.settled(id);
			if (this.tabsOf(id).length || this.contexts.has(id)) throw new HttpError(409, "profile_in_use", `close the tabs of "${id}" before renaming it`);
			renameSync(this.profileDir(id), this.profileDir(next));
			at = next;
		}
		mkdirSync(this.profileDir(at), { recursive: true, mode: 0o700 });
		const m = this.meta(at);
		this.writeMeta(at, { agent: changes.agent ?? m.agent, createdAt: m.createdAt || Date.now() });
		return this.listProfiles().find((p) => p.id === at)!;
	}

	/** Delete a profile's saved data (logins, cookies). Not while tabs are open on it. */
	async deleteProfile(rawId: string): Promise<void> {
		const id = profileId(rawId);
		if (id === TEMP_PROFILE) throw badRequest("the throw-away profile cannot be deleted");
		await this.settled(id);
		if (this.tabsOf(id).length || this.contexts.has(id)) throw new HttpError(409, "profile_in_use", `close the tabs of "${id}" first`);
		if (!existsSync(this.profileDir(id))) throw notFound("browser profile");
		rmSync(this.profileDir(id), { recursive: true, force: true });
	}

	/** Forget what a profile has stored (cookies, logins, site data) but keep the profile itself. */
	async clearProfile(rawId: string): Promise<void> {
		const id = profileId(rawId);
		await this.settled(id);
		const ctx = this.contexts.get(id) ? await this.contexts.get(id)!.catch(() => null) : null;
		if (ctx) {
			await ctx.clearCookies().catch(() => {});
			for (const t of this.tabsOf(id)) await t.cdp.send("Storage.clearDataForOrigin" as never, { origin: "*", storageTypes: "all" } as never).catch(() => {});
			return;
		}
		if (!this.listProfiles().some((p) => p.id === id)) throw notFound("browser profile");
		const meta = this.meta(id);
		rmSync(this.profileDir(id), { recursive: true, force: true });
		mkdirSync(this.profileDir(id), { recursive: true, mode: 0o700 });
		this.writeMeta(id, meta);
	}

	/**
	 * The logins of a profile as one JSON value (cookies and local storage), to move them to another server or keep a
	 * copy. The profile's browser has to run to read them: when it is not running a short-lived one is started.
	 */
	async exportProfile(rawId: string): Promise<ProfileState> {
		const id = profileId(rawId);
		if (id === TEMP_PROFILE) throw badRequest("the throw-away profile has nothing to export");
		await this.settled(id);
		if (!this.listProfiles().some((p) => p.id === id)) throw notFound("browser profile");
		const running = this.contexts.get(id);
		const ctx = running ? await running : await this.launch(id);
		try {
			// Local storage only shows for a site while a page of it is open: visit each site the profile has cookies for
			// (answered from nothing, so no request leaves the server) and read it, then take the state.
			const sites = new Set<string>([...this.storedOrigins(id)]);
			for (const c of await ctx.cookies()) {
				const host = String(c.domain).replace(/^\./, "");
				if (host) sites.add(`${c.secure ? "https" : "http"}://${host}`);
			}
			for (const origin of [...sites].slice(0, 40)) {
				const page = await ctx.newPage();
				try {
					await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>export</title>" }));
					await page.goto(origin, { waitUntil: "commit", timeout: 8_000 }).catch(() => {});
				} finally {
					await page.close().catch(() => {});
				}
			}
			const state = (await ctx.storageState()) as ProfileState;
			if (Buffer.byteLength(JSON.stringify(state)) > MAX_PROFILE_STATE_BYTES) throw badRequest("this profile has too much stored data to export");
			return state;
		} finally {
			if (!running && !this.tabsOf(id).length) await this.stopBrowser(id);
		}
	}

	/**
	 * Sites that have local storage in a profile, read from Chromium's own store on disk (`_<origin>` keys). A site with
	 * local storage but no cookie would otherwise be missed. Best effort: an unreadable store gives nothing.
	 */
	private storedOrigins(id: string): string[] {
		const dir = join(this.profileDir(id), "Default", "Local Storage", "leveldb");
		const out = new Set<string>();
		try {
			for (const f of readdirSync(dir)) {
				if (!/\.(ldb|log)$/.test(f)) continue;
				const raw = readFileSync(join(dir, f)).toString("latin1");
				for (const m of raw.matchAll(/_(https?:\/\/[A-Za-z0-9.\-]+(?::\d{1,5})?)/g)) out.add(m[1]!);
			}
		} catch {
			/* no store yet */
		}
		return [...out].slice(0, 60);
	}

	/** Put logins into a profile (it is created when missing). Existing cookies of the same name and site are replaced; session cookies are kept for a week. */
	async importProfile(rawId: string, state: ProfileState): Promise<BrowserProfileInfo> {
		const id = profileId(rawId);
		if (id === TEMP_PROFILE) throw badRequest("the throw-away profile cannot be imported into");
		if (Buffer.byteLength(JSON.stringify(state)) > MAX_PROFILE_STATE_BYTES) throw badRequest("the profile file is too big");
		await this.settled(id);
		if (!existsSync(this.profileDir(id)) && id !== DEFAULT_PROFILE) this.createProfile({ id });
		const running = this.contexts.get(id);
		const ctx = running ? await running : await this.launch(id);
		try {
			// A session cookie (no expiry) would be dropped when this browser closes, so a login that rests on one would be
			// gone at once. Give those a week: long enough to be used, short enough not to outlive a forgotten import.
			const week = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
			const cookies = (state.cookies as { expires?: number }[]).map((c) => (typeof c.expires === "number" && c.expires > 0 ? c : { ...c, expires: week }));
			await ctx.addCookies(cookies as never);
			// local storage is set per site, by opening that site's origin in a scratch page of this browser
			for (const o of state.origins as { origin?: string; localStorage?: { name: string; value: string }[] }[]) {
				if (!o.origin || !/^https?:\/\//.test(o.origin) || !o.localStorage?.length) continue;
				const page = await ctx.newPage();
				try {
					await page.route("**/*", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>import</title>" }));
					await page.goto(o.origin, { waitUntil: "commit", timeout: 10_000 });
					await page.evaluate(`((items) => { for (const i of items) localStorage.setItem(i.name, i.value); })(${JSON.stringify(o.localStorage)})`);
				} finally {
					await page.close().catch(() => {});
				}
			}
		} finally {
			if (!running && !this.tabsOf(id).length) await this.stopBrowser(id);
		}
		return this.listProfiles().find((p) => p.id === id)!;
	}

	/** May an agent act on tabs of this profile? */
	agentMayUse(profile: string): boolean {
		return profile === TEMP_PROFILE || this.meta(profile).agent;
	}

	/**
	 * Start Chromium on a profile folder. A browser that ends on its own right after it was started (it hands the folder
	 * to another instance that is still shutting down, then exits with code 0) never answers, so playwright would wait
	 * out its whole timeout. Start again a few times, each with a short limit, instead of hanging.
	 */
	private async start(dir: string): Promise<BrowserContext> {
		let last: unknown;
		for (let attempt = 0; attempt < LAUNCH_ATTEMPTS; attempt++) {
			// playwright's own `timeout` does not always fire (the browser can end without ever answering), so the limit is
			// kept here too. A start that is abandoned may still finish later: it is closed then, so no browser is left over.
			const starting = chromium.launchPersistentContext(dir, {
				executablePath: this.exe!,
				headless: this.opts.headless ?? true,
				viewport: { width: 1280, height: 800 },
				acceptDownloads: false,
				timeout: LAUNCH_TIMEOUT_MS,
				args: ["--no-first-run", "--no-default-browser-check", ...(process.getuid?.() === 0 ? ["--no-sandbox"] : [])],
			});
			let timer: ReturnType<typeof setTimeout> | undefined;
			const limit = new Promise<"late">((r) => (timer = setTimeout(() => r("late"), LAUNCH_TIMEOUT_MS + 1500)));
			try {
				const got = await Promise.race([starting, limit]);
				if (got !== "late") return got;
				void starting.then((late) => late.close().catch(() => {}), () => {});
				last = new Error(`the browser did not start within ${LAUNCH_TIMEOUT_MS}ms`);
			} catch (e) {
				last = e;
			} finally {
				clearTimeout(timer);
			}
			await new Promise((r) => setTimeout(r, 150 * (attempt + 1)));
		}
		throw last;
	}

	private launch(profile: string): Promise<BrowserContext> {
		if (!this.available()) throw new HttpError(403, "browser_unavailable", this.opts.enabled ? "no Chrome or Chromium was found on this server (install one or set PIPAYA_BROWSER)" : "the browser is turned off on this server (PIPAYA_BROWSER=0)");
		let pending = this.contexts.get(profile);
		if (pending) return pending;
		pending = (async () => {
			// A profile folder belongs to one browser at a time: let the one that is closing finish first.
			await this.stopping.get(profile);
			const dir = profile === TEMP_PROFILE ? join(this.root, `.${TEMP_PROFILE}-${randomUUID().slice(0, 8)}`) : this.profileDir(profile);
			mkdirSync(dir, { recursive: true, mode: 0o700 });
			if (profile === TEMP_PROFILE) this.tempDirs.add(dir);
			if (profile !== TEMP_PROFILE && !existsSync(this.metaFile(profile))) this.writeMeta(profile, { agent: true, createdAt: Date.now() });
			const ctx = await this.start(dir);
			ctx.on("close", () => {
				if (this.contexts.get(profile) === pending) this.contexts.delete(profile);
				for (const t of [...this.tabs.values()]) if (t.context === ctx) this.drop(t);
				// The throw-away profile leaves nothing behind, whichever way its browser ended.
				if (profile === TEMP_PROFILE) void this.sweepTemp(dir);
			});
			return ctx;
		})().catch((e) => {
			if (this.contexts.get(profile) === pending) this.contexts.delete(profile);
			throw new HttpError(502, "browser_launch_failed", `could not start the browser: ${e instanceof Error ? e.message.split("\n")[0] : e}`);
		});
		this.contexts.set(profile, pending);
		return pending;
	}

	async create(input: Static<typeof CreateBrowserBody> = {}, cwd?: string): Promise<BrowserTabInfo> {
		if (this.tabs.size >= MAX_BROWSER_TABS) throw new HttpError(409, "too_many_browser_tabs", `at most ${MAX_BROWSER_TABS} browser tabs can be open at once`);
		const url = input.url?.trim() ? normalizeUrl(input.url) : "about:blank";
		const profile = input.profile?.trim() ? profileId(input.profile) : DEFAULT_PROFILE;
		if (profile !== TEMP_PROFILE && profile !== DEFAULT_PROFILE && !existsSync(this.profileDir(profile))) throw notFound("browser profile");
		const ctx = await this.launch(profile);
		// A fresh browser already holds one blank page: the first tab takes it over instead of opening a second beside it.
		const spare = ctx.pages().find((p) => !this.claimed.has(p) && p.url() === "about:blank");
		const page = spare ?? (await ctx.newPage());
		this.claimed.add(page);
		const cdp = await ctx.newCDPSession(page);
		const id = BROWSER_PREFIX + randomUUID();
		const tab: Tab = { context: ctx, info: { id, title: "", url: "about:blank", cwd: input.cwd?.trim() || cwd || this.opts.defaultWorkdir?.() || this.opts.dataDir, profile, createdAt: Date.now() }, page, cdp, clients: new Set(), screencasting: false, agents: [], handoff: null, lastSent: 0, settleTimer: null, quietUntil: 0, fit: null, lastFrame: null, closing: false };
		this.tabs.set(id, tab);
		cdp.on("Page.screencastFrame", (f: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
			cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {});
			// A page that animates would flood the link: keep to FRAME_INTERVAL_MS (the next frame repairs what was skipped).
			const now = performance.now();
			if (now < tab.quietUntil) return;
			if (now - tab.lastSent < FRAME_INTERVAL_MS) return;
			tab.lastSent = now;
			const jpeg = Buffer.from(f.data, "base64");
			tab.lastFrame = { jpeg, width: f.metadata.deviceWidth, height: f.metadata.deviceHeight };
			for (const c of tab.clients) c.frame(jpeg, { width: f.metadata.deviceWidth, height: f.metadata.deviceHeight });
			this.settle(tab);
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
		this.tell(tab);
	}

	/** Tell every view who is acting on the page. */
	private tell(tab: Tab) {
		const by = tab.agents[tab.agents.length - 1];
		for (const c of tab.clients) c.state(tab.info, by ? "agent" : "user", by, tab.handoff);
	}

	/** The tab was closed (by us, by the page, or because the browser went away). */
	private drop(tab: Tab) {
		if (tab.closing) return;
		tab.closing = true;
		if (tab.settleTimer) clearTimeout(tab.settleTimer);
		this.tabs.delete(tab.info.id);
		for (const c of tab.clients) c.closed();
		tab.clients.clear();
		this.bus.publish(null, "browser_closed", { id: tab.info.id }, { ephemeral: true });
		if (![...this.tabs.values()].some((t) => t.context === tab.context)) void this.stopBrowser(tab.info.profile, tab.context);
	}

	private removeTemp(dir: string) {
		this.tempDirs.delete(dir);
		rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
	}

	/**
	 * Chromium keeps writing into its profile for a moment after `close()` resolves (a deleted folder comes back). Delete,
	 * check, and repeat until the folder stays gone.
	 */
	private async sweepTemp(dir: string) {
		for (let i = 0; i < 40; i++) {
			this.removeTemp(dir);
			await new Promise((r) => setTimeout(r, i < 5 ? 50 : 200));
			if (!existsSync(dir)) return;
			this.tempDirs.add(dir);
		}
	}

	/**
	 * End a browser. `ctx` is the one whose last tab just closed: if the profile has already been started again, the
	 * registered browser is a newer one and must be left alone. The promise is kept so anything that needs the profile's
	 * folder next (a new start, a rename, a delete) waits until the old browser has really exited.
	 */
	private stopBrowser(profile: string, ctx?: BrowserContext): Promise<void> {
		const pending = this.contexts.get(profile);
		if (!pending) return this.stopping.get(profile) ?? Promise.resolve();
		// Unregister at once, before anything awaits: a start that begins now must launch a new browser, never reuse this one.
		this.contexts.delete(profile);
		const closing = (async () => {
			const registered = await pending.catch(() => null);
			await (ctx ?? registered)?.close().catch(() => {});
		})();
		const prev = this.stopping.get(profile);
		const done: Promise<void> = Promise.all([prev, closing]).then(() => {}).finally(() => {
			if (this.stopping.get(profile) === done) this.stopping.delete(profile);
		});
		this.stopping.set(profile, done);
		return done;
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

	/**
	 * Moving pictures go out as JPEG (small and quick). Once the page has been still for `SETTLE_MS` one lossless picture
	 * follows: text is sharp when someone stops to read, and for text pages it is also smaller than the JPEG was.
	 */
	private settle(tab: Tab) {
		if (tab.settleTimer) clearTimeout(tab.settleTimer);
		tab.settleTimer = setTimeout(async () => {
			tab.settleTimer = null;
			if (tab.closing || !tab.clients.size || tab.page.isClosed()) return;
			try {
				const sent = tab.lastSent;
				// Taking the picture repaints the page and makes the screencast emit a frame of its own: let that pass unseen.
				tab.quietUntil = performance.now() + SETTLE_QUIET_MS;
				const png = await tab.page.screenshot({ type: "png", timeout: 4000, animations: "disabled", caret: "initial" });
				tab.quietUntil = performance.now() + SETTLE_QUIET_MS;
				// something moved while it was being taken: the next settle will send a fresh one
				if (tab.lastSent !== sent || tab.closing) return;
				const size = tab.lastFrame ? { width: tab.lastFrame.width, height: tab.lastFrame.height } : (tab.fit ?? { width: 1280, height: 800 });
				tab.lastFrame = { jpeg: png, ...size };
				for (const c of tab.clients) c.frame(png, size);
			} catch {
				/* the page went away or is busy: the JPEG stays */
			}
		}, SETTLE_MS);
	}

	/** Frames only flow while someone watches. */
	private async syncScreencast(tab: Tab) {
		if (tab.closing) return;
		const want = tab.clients.size > 0;
		if (want === tab.screencasting) return;
		tab.screencasting = want;
		try {
			if (want) await tab.cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: MAX_VIEW.width, maxHeight: MAX_VIEW.height, everyNthFrame: 1 });
			else await tab.cdp.send("Page.stopScreencast");
		} catch {
			tab.screencasting = false;
		}
	}

	/**
	 * A view tells how big its panel is: the page is laid out for that size, so a small panel or a phone gets a small
	 * picture (and a page that fits it) instead of a big one scaled down. The newest view wins.
	 */
	async fit(id: string, width: number, height: number): Promise<void> {
		const tab = this.tab(id);
		const w = Math.round(Math.min(MAX_VIEW.width, Math.max(MIN_VIEW.width, width)));
		const h = Math.round(Math.min(MAX_VIEW.height, Math.max(MIN_VIEW.height, height)));
		if (tab.fit && Math.abs(tab.fit.width - w) < 8 && Math.abs(tab.fit.height - h) < 8) return;
		tab.fit = { width: w, height: h };
		await tab.page.setViewportSize({ width: w, height: h }).catch(() => {});
	}

	async input(id: string, ev: BrowserInput): Promise<void> {
		const tab = this.tab(id);
		const send = (method: string, params: object) => tab.cdp.send(method as never, params as never);
		if (ev.type === "mouse") {
			const type = ev.action === "move" ? "mouseMoved" : ev.action === "down" ? "mousePressed" : "mouseReleased";
			await send("Input.dispatchMouseEvent", { type, x: ev.x, y: ev.y, button: ev.action === "move" ? "none" : (ev.button ?? "left"), clickCount: ev.clickCount ?? (ev.action === "move" ? 0 : 1) });
		} else if (ev.type === "wheel") {
			await send("Input.dispatchMouseEvent", { type: "mouseWheel", x: ev.x, y: ev.y, deltaX: ev.dx, deltaY: ev.dy });
		} else if (ev.type === "key") {
			await send("Input.dispatchKeyEvent", { type: ev.action === "down" ? (ev.text ? "keyDown" : "rawKeyDown") : "keyUp", key: ev.key, code: ev.code, text: ev.action === "down" ? ev.text : undefined, modifiers: ev.modifiers ?? 0 });
		} else if (ev.type === "compose") {
			await send("Input.imeSetComposition", { text: ev.text, selectionStart: ev.text.length, selectionEnd: ev.text.length });
		} else {
			await send("Input.insertText", { text: ev.text });
		}
	}

	/* ---------- agents ---------- */

	/** The tabs an agent may see and act on: not those of a profile reserved for people. */
	agentTabs(): BrowserTabInfo[] {
		return this.list().filter((t) => this.agentMayUse(t.profile));
	}

	/**
	 * The tab an agent tool acts on. Nothing is guessed: a named tab is that tab; with no name the one open tab is used
	 * (a new one is opened when none is); with several open the call fails and lists them, so the agent picks one by id
	 * (or asks the user) instead of landing on whatever tab was used last. Tabs of a profile reserved for people are
	 * invisible to agents and refused by name.
	 */
	async forAgent(id?: string): Promise<string> {
		if (id) {
			const t = this.tab(id);
			if (!this.agentMayUse(t.info.profile)) throw new Error(`tab ${id} belongs to the profile "${t.info.profile}", which is reserved for people. Ask the user, or open a page in another profile.`);
			return id;
		}
		const open = this.agentTabs();
		if (open.length === 1) return open[0]!.id;
		if (open.length === 0) return (await this.create()).id;
		throw new Error(`${open.length} browser tabs are open, so say which one with \`tab\` (or ask the user):\n${this.describe()}`);
	}

	/** One line per tab an agent may use. */
	describe(): string {
		const tabs = this.agentTabs();
		if (!tabs.length) return "(no browser tabs are open)";
		return tabs
			.map((t) => {
				const tab = this.tabs.get(t.id)!;
				const watching = tab.clients.size ? `, ${tab.clients.size} viewer(s)` : "";
				return `- ${t.id}: ${t.title || "(untitled)"} <${t.url}> [profile ${t.profile}]${watching}`;
			})
			.join("\n");
	}

	/**
	 * Hand a tab to the person: an agent that hit a login or captcha asks for it, and `wait` resolves when the person says
	 * they are done (or rejects when the run is aborted). While it waits, views show the note and the page is theirs.
	 */
	async handoff<T>(id: string, by: string, note: string, wait: () => Promise<T>): Promise<T> {
		const tab = this.tab(id);
		tab.handoff = { by, note };
		this.tell(tab);
		try {
			return await wait();
		} finally {
			tab.handoff = null;
			await this.refresh(tab);
			this.tell(tab);
		}
	}

	/** Profiles an agent may open tabs in, for the tool description. */
	agentProfiles(): string[] {
		return this.listProfiles().filter((p) => p.agent).map((p) => p.id);
	}

	/** Marks the tab as agent-driven (by `who`, the session) while `fn` runs, so views can show who is in control. */
	async asAgent<T>(id: string, fn: (page: Page) => Promise<T>, who = "agent"): Promise<T> {
		const tab = this.tab(id);
		tab.agents.push(who);
		this.tell(tab);
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			const limit = this.opts.actionTimeoutMs ?? ACTION_TIMEOUT_MS;
			return await Promise.race([
				fn(tab.page),
				new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(`the page did not respond within ${Math.round(limit / 1000)}s (tab ${id}); take a new snapshot or reload it`)), limit))),
			]);
		} finally {
			clearTimeout(timer);
			tab.agents.splice(tab.agents.lastIndexOf(who), 1);
			await this.refresh(tab);
			this.tell(tab);
		}
	}

	/** Open one more tab on purpose (an agent that wants a second page next to the first). */
	async openAnother(url?: string, profile?: string): Promise<BrowserTabInfo> {
		if (profile && !this.agentMayUse(profileId(profile))) throw new Error(`the profile "${profile}" is reserved for people. Available to agents: ${this.agentProfiles().join(", ")}`);
		return this.create({ url, ...(profile ? { profile } : {}) });
	}

	async shutdown(): Promise<void> {
		for (const t of [...this.tabs.values()]) {
			t.closing = true;
			for (const c of t.clients) c.closed();
		}
		this.tabs.clear();
		await Promise.all([...new Set([...this.contexts.keys(), ...this.stopping.keys()])].map((p) => this.stopBrowser(p)));
		await Promise.all([...this.tempDirs].map((dir) => this.sweepTemp(dir)));
	}
}

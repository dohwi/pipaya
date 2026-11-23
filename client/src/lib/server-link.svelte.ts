import { untrack } from "svelte";
import { Api, ApiError, errorText, isUnsupportedRoute } from "./api";
import type { RepoInfo } from "./projects";
import { workDir } from "./nav";
import { compat, isClientTooOld, type ServerVersions } from "./protocol";
import { t } from "./i18n";
import { settingsProblems, type SettingsProblem } from "./settings-problems";
import { emptyLinkData, type LinkData } from "./server-link-model";
import { fingerprint, readListCache, readShape, toCache, writeListCache } from "./list-cache";
import type { Server } from "./store-model";
import type { TerminalInfo, TerminalSupport } from "./terminal";
import type {
	CompactionSettings, CustomProvider, DefaultModelSelection, FallbackModelSettings, SystemModelSettings, Group, ModelInfo, PipayaEvent, ProviderInfo, Session, ToolInfo, ToolsInfo, WorkdirInfo, WorkspaceInfo,
} from "./types";

export type NetState = "idle" | "connecting" | "online" | "offline" | "unauthorized" | "incompatible";

export interface LinkHooks {
	/** An event arrived on this server's stream. */
	event(link: ServerLink, e: PipayaEvent): void;
	/**
	 * Everything was (re)loaded and the stream is open. `warm` is true for a reconnect that only had to catch up: the
	 * lists were already there and the events since the last cursor were replayed, so nothing has to be reloaded.
	 */
	ready(link: ServerLink, warm: boolean): void;
	/** Rows per top-level entry as the sidebar draws this server (the app owns that order), kept with the cached lists. */
	shape?(link: ServerLink): number[];
}

/** How long a change to the lists waits before they are written to the cache. */
const SAVE_DELAY_MS = 2000;

/** How long the initial sidebar lists may take before the attempt counts as a network failure (and is retried). */
const LISTS_TIMEOUT_MS = 25_000;

/** How long the model/provider catalog may take after the sidebar lists have loaded. */
const CATALOG_TIMEOUT_MS = 25_000;

/** How long `/health` may take during sync before counting as unreachable (allows high-latency / relayed links). */
const HEALTH_SYNC_TIMEOUT_MS = 8_000;

/** How long `/health` may take during a foreground probe or wake check. */
const HEALTH_PROBE_TIMEOUT_MS = 6_000;

/**
 * Longest wait between two tries at a server that does not answer. A tailnet that comes back (VPN reconnected, phone off
 * the lift) fires no browser event, so this is how long the app may stay offline after the server is reachable again.
 * Offline retries check `/health` alone before fanning out, so waiting up to 10 s stays responsive without flooding.
 */
const MAX_RETRY_MS = 10_000;

/**
 * How long a reopened stream must stay up before backoff resets. Without this, a stream that opens (200) and drops
 * immediately during replay resets `retryDelay` to 1 s every time and flickers online/offline once per second forever.
 */
const STABLE_STREAM_MS = 5_000;

/** Consecutive reopen failures before falling back to a full sync (which advances the cursor past a broken replay). */
const MAX_REOPEN_FAILS = 2;

function withDeadline<T>(p: Promise<T>, ms: number, fail: () => Error): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => reject(fail()), ms);
		p.then(
			(v) => (clearTimeout(timer), resolve(v)),
			(e) => (clearTimeout(timer), reject(e)),
		);
	});
}

/**
 * One server, kept live for as long as the app runs: its lists, models and what each session is doing, read first-hand
 * and updated by its own event stream. Every saved server has one, so none of them is "the" open server: the app only
 * decides which link its conversation view is on.
 */
export class ServerLink {
	readonly api: Api;
	net = $state<NetState>("connecting");
	netError = $state("");
	/** What the server said about its version on connect (`/health`), or null before that. */
	versions = $state<ServerVersions | null>(null);
	/** True once the lists below were read at least once. */
	loaded = $state(false);
	/** True once what the sidebar draws (sessions, groups, terminals, workspace, activity) was read; comes before `loaded`. */
	listed = $state(false);
	/**
	 * The lists on screen are the ones this device kept from its last visit (see list-cache), not read from the server yet:
	 * the sidebar draws them at once and marks them as waiting, and nothing that acts on a session trusts them.
	 */
	cached = $state(false);
	/** Rows per top-level entry at the last visit, for a skeleton of the right height when the copy itself cannot be shown. */
	readonly shape: number[] | null;
	data = $state<LinkData>(emptyLinkData());
	/**
	 * The listed sessions by id, rebuilt only when the list changes. Every badge in the sidebar, rail and tab bar looks its
	 * session up, and a `find` per badge turned each list change into (rows x rows) comparisons.
	 */
	sessionById: Map<string, Session> = $derived(new Map(this.data.sessions.map((x) => [x.id, x] as const)));
	/**
	 * The git repository of each listed folder (null: not in one), so the sidebar can put a repository's worktrees under one
	 * project. Asked for folders not seen yet; empty on a server from before projects (every folder then stands alone).
	 */
	repos = $state<Record<string, RepoInfo | null>>({});
	models = $state<ModelInfo[]>([]);
	providers = $state<ProviderInfo[]>([]);
	tools = $state<ToolInfo[]>([]);
	workspace = $state<WorkspaceInfo | null>(null);
	workdirInfo = $state<WorkdirInfo | null>(null);
	toolsInfo = $state<ToolsInfo | null>(null);
	serverDefault = $state<DefaultModelSelection | null>(null);
	/** The connections the owner added (address, API format, key), from `/configuration`; empty on a server without it. */
	customProviders = $state<CustomProvider[]>([]);
	terminalSupport = $state<TerminalSupport | null>(null);
	/** The compaction, system and fallback models, kept to flag the ones that stopped working (see settings-problems). */
	compaction = $state<CompactionSettings | null>(null);
	systemModel = $state<SystemModelSettings | null>(null);
	fallbackModel = $state<FallbackModelSettings | null>(null);
	/** Settings of this server that no longer work. Empty until the lists were read. */
	problems: SettingsProblem[] = $derived(
		this.loaded ? settingsProblems({ defaults: this.serverDefault, compaction: this.compaction, system: this.systemModel, fallback: this.fallbackModel, models: this.models, providers: this.providers }) : [],
	);

	private unsubscribe: (() => void) | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private stableTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelay = 1000;
	private reopenFails = 0;
	/** Cancels the requests of the sync in progress. */
	private attempt: AbortController | null = null;
	private token = 0;
	private stopped = false;
	private probing = false;
	private resuming = false;
	/** The newest event id that reached `hooks.event`: where a reopened stream resumes from. */
	private cursor = 0;

	/** Bound this link's API to a deadline (falls back cleanly for test doubles without `scoped`). */
	private boundedApi(ms: number): Api {
		return typeof this.api.scoped === "function" ? this.api.scoped(AbortSignal.timeout(ms)) : this.api;
	}

	constructor(
		readonly server: Server,
		private readonly hooks: LinkHooks,
	) {
		this.api = new Api({ baseUrl: server.baseUrl, token: server.token });
		this.shape = readShape(server.id);
		const c = readListCache(server.id, this.fp);
		if (c) {
			this.data = { ...emptyLinkData(), sessions: c.sessions, groups: c.groups, terminals: c.terminals };
			if (c.workspace) this.workspace = { ...c.workspace, workdirs: [] };
			if (c.repos) this.repos = c.repos;
			this.cached = true;
		}
	}

	private get fp(): string {
		return fingerprint(this.server.baseUrl, this.server.token);
	}

	private saveTimer: ReturnType<typeof setTimeout> | undefined;
	/** Follows the lists (whoever writes them: a read, an event, an action of this device) and keeps them for next time. */
	private stopSaving: (() => void) | null = null;
	private followLists(): void {
		if (this.stopSaving) return;
		this.stopSaving = $effect.root(() => {
			$effect(() => {
				// read what is stored, so any change to it (not to activity) schedules a write
				void this.data.sessions.length, this.data.sessions.map((s) => s.title + workDir(s) + s.updatedAt), this.data.groups.map((g) => g.updatedAt), this.data.terminals.length, this.repos;
				this.saveLists();
			});
			$effect(() => {
				const paths = this.listedPaths();
				untrack(() => void this.lookUpRepos(paths));
			});
		});
	}

	/** Set once the server said it cannot tell repositories apart (an older build): it is not asked again. */
	private reposUnsupported = false;
	/** Folders asked about and not answered yet, so a burst of list changes asks once per folder. */
	private reposAsked = new Set<string>();
	private listedPaths(): string[] {
		return [...new Set([...this.data.sessions.map(workDir), ...this.data.terminals.map((x) => x.cwd)])];
	}

	/**
	 * Look up the repository of the folders not known yet (`all`: every listed folder again, as after a (re)connect, since
	 * a branch may have been switched meanwhile). A failure leaves them as they were until the next change.
	 */
	private async lookUpRepos(paths: string[], all = false): Promise<void> {
		if (this.reposUnsupported || this.stopped) return;
		const known = this.repos;
		const ask = paths.filter((p) => (all || !(p in known)) && !this.reposAsked.has(p));
		if (!ask.length) return;
		for (const p of ask) this.reposAsked.add(p);
		try {
			const r = await this.boundedApi(10_000).repos(ask);
			if (this.stopped) return;
			this.repos = { ...this.repos, ...Object.fromEntries(ask.map((p) => [p, r.repos[p] ?? null])) };
		} catch (e) {
			if (isUnsupportedRoute(e)) this.reposUnsupported = true;
		} finally {
			for (const p of ask) this.reposAsked.delete(p);
		}
	}

	/** Keep the lists for the next cold start; a burst of events (a run renaming, a group forming) is written once. */
	private saveLists(): void {
		if (!this.listed || this.stopped) return;
		clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			if (this.listed && !this.stopped) writeListCache(this.id, toCache(this.fp, this.data, this.workspace, Date.now(), this.hooks.shape?.(this), this.repos));
		}, SAVE_DELAY_MS);
	}

	get id(): string {
		return this.server.id;
	}

	get conn(): { baseUrl: string; token: string } {
		return { baseUrl: this.server.baseUrl, token: this.server.token };
	}

	/** Can its lists be trusted to be current (the stream is open)? */
	get online(): boolean {
		return this.net === "online";
	}

	start(): void {
		this.stopped = false;
		void this.sync();
	}

	stop(): void {
		this.stopped = true;
		this.probing = false;
		this.resuming = false;
		this.token++;
		this.attempt?.abort();
		this.disarmStable();
		clearTimeout(this.retryTimer);
		clearTimeout(this.saveTimer);
		this.stopSaving?.();
		this.stopSaving = null;
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/**
	 * A user action failed with a network error while this link still claimed to be online (half-open socket / dropped
	 * tailnet): verify quickly with `/health` and kick off a reconnect if the server is no longer answering.
	 */
	async probe(): Promise<void> {
		if (this.stopped || !this.online || this.probing) return;
		this.probing = true;
		const token = this.token;
		try {
			await this.api.health(AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS));
		} catch {
			if (token === this.token && !this.stopped && this.online) {
				this.net = "offline";
				void this.sync();
			}
		} finally {
			this.probing = false;
		}
	}

	private armStable(token: number, onStable?: () => void): void {
		clearTimeout(this.stableTimer);
		this.stableTimer = setTimeout(() => {
			this.stableTimer = undefined;
			if (token !== this.token || this.stopped || this.net !== "online") return;
			this.retryDelay = 1000;
			this.reopenFails = 0;
			onStable?.();
		}, STABLE_STREAM_MS);
	}

	private disarmStable(): void {
		clearTimeout(this.stableTimer);
		this.stableTimer = undefined;
	}

	/**
	 * Try again after a failure. A stream that dropped only needs its stream back (the replay covers the gap), so once the
	 * lists are loaded a retry reopens the stream instead of reading everything again and rebuilding the open transcript.
	 * If reopening fails repeatedly or dies right after opening, fall back to a full sync so the cursor moves past the gap.
	 */
	private scheduleRetry(): void {
		clearTimeout(this.retryTimer);
		if (this.stopped) return;
		const useSync = !this.loaded || this.reopenFails >= MAX_REOPEN_FAILS;
		if (useSync) this.reopenFails = 0;
		// Spread concurrent retries across saved servers / clients with ±20% jitter (keep short test delays exact).
		const wait = this.retryDelay >= 500 ? Math.round(this.retryDelay * (0.8 + Math.random() * 0.4)) : this.retryDelay;
		this.retryTimer = setTimeout(() => void (useSync ? this.sync(true) : this.reopen(false)), wait);
		this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
	}

	/**
	 * The app came back to the foreground. A mobile OS may have killed the stream without telling us, so a link that
	 * still says "online" is checked with a short ping and resynced if it does not answer. Backoff starts over.
	 */
	async resume(force: boolean): Promise<void> {
		if (this.stopped) return;
		this.retryDelay = 1000;
		this.reopenFails = 0;
		if (!this.online) return this.sync();
		if (!force) {
			if (this.resuming) return;
			this.resuming = true;
			// A short absence: the socket is probably fine, so only check that the server answers at all.
			const token = this.token;
			try {
				await this.api.health(AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS));
			} catch {
				if (token === this.token) void this.sync();
				return;
			} finally {
				this.resuming = false;
			}
			if (token !== this.token) return;
		}
		// The server answers and the page was only in the background: the stream itself may still be dead (a phone OS
		// kills sockets silently, and a ping on a fresh connection says nothing about the old one), but the lists do not
		// have to be read again. Reopening from the last event id replays what was missed, so neither the transcript nor
		// the sidebar is rebuilt. That reload was the "wriggle" on coming back to the window.
		this.reopen(true);
	}

	private applyActivity(activity: { sessions: { sessionId: string; running: boolean; pendingQuestions: number }[]; unread: { sessionId: string; kind: "done" | "failed" }[] }): void {
		const running: Record<string, boolean> = {};
		const awaiting: Record<string, number> = {};
		const unread: Record<string, boolean> = {};
		const failed: Record<string, boolean> = {};
		for (const a of activity.sessions) {
			if (a.running) running[a.sessionId] = true;
			if (a.pendingQuestions) awaiting[a.sessionId] = a.pendingQuestions;
		}
		for (const u of activity.unread) (u.kind === "failed" ? failed : unread)[u.sessionId] = true;
		const d = this.data;
		// Written one field at a time: a whole new object re-renders every badge that reads the lists.
		if (!sameMap(d.running, running)) d.running = running;
		for (const id of Object.keys(d.compacting)) if (!running[id]) delete d.compacting[id];
		if (!sameMap(d.awaiting, awaiting)) d.awaiting = awaiting;
		if (!sameMap(d.unread, unread)) d.unread = unread;
		if (!sameMap(d.failed, failed)) d.failed = failed;
	}

	/** Re-read live activity when an event arrives without enough context to infer whether the session is still busy. */
	async refreshActivity(): Promise<void> {
		const token = this.token;
		try {
			const activity = await this.boundedApi(10_000).activity();
			if (token !== this.token) return;
			this.applyActivity(activity);
		} catch {
			/* ignore: the next catchUp or event will settle it */
		}
	}

	/**
	 * The events that are never persisted (a read mark, a terminal opening, an extension reloading, a run starting or
	 * finishing) are the ones a replay cannot bring back, so they are read again here: one small request each, and only
	 * the state that actually changed is written, so nothing on screen is rebuilt. Without this a wake left the unread
	 * marks, the terminal tabs and a run that started while the window was away frozen at what they were before.
	 */
	private async catchUp(): Promise<void> {
		const token = this.token;
		const api = this.boundedApi(8_000);
		try {
			const [activity, terminals, support, latestId] = await Promise.all([
				api.activity().catch(() => null),
				api.terminals().catch(() => null),
				api.terminalSupport().catch(() => null),
				api.latestEventId().catch(() => null),
			]);
			if (token !== this.token || this.net !== "online") return;
			if (latestId !== null && latestId < this.cursor) {
				void this.sync();
				return;
			}
			if (activity) this.applyActivity(activity);
			if (terminals && !sameTerminals(this.data.terminals, terminals)) this.data.terminals = terminals;
			if (support) this.terminalSupport = support;
		} catch {
			/* the lists stay as they were; the next wake tries again */
		}
	}

	/**
	 * Reopen the event stream from the last id seen, keeping everything already loaded. On open, both a foreground wake
	 * and a retry after a dropped stream catch up live-only state (activity, failed/unread marks, terminals, open chats)
	 * without rebuilding the lists or transcripts when nothing changed.
	 */
	private reopen(_wake: boolean): void {
		if (this.stopped || !this.loaded) {
			void this.sync();
			return;
		}
		const token = ++this.token;
		this.disarmStable();
		clearTimeout(this.retryTimer);
		this.unsubscribe?.();
		this.unsubscribe = null;
		let opened = false;
		let stable = false;
		this.unsubscribe = this.api.subscribe(
			{
				onEvent: (e) => {
					if (token !== this.token) return;
					if (e.id > this.cursor) this.cursor = e.id;
					this.hooks.event(this, e);
				},
				onOpen: () => {
					if (token !== this.token) return;
					opened = true;
					stable = false;
					this.net = "online";
					this.netError = "";
					this.armStable(token, () => { stable = true; });
					void this.catchUp();
					this.hooks.ready(this, true);
				},
				onError: () => {
					if (token !== this.token) return;
					this.disarmStable();
					this.net = "offline";
					// A stream that opened and died before stabilizing (e.g. replay backpressure cutoff) will fail the same way on
					// the same cursor: advance straight to a full sync on the next retry instead of looping on reopen().
					if (stable) this.reopenFails = 0;
					else if (opened) this.reopenFails = MAX_REOPEN_FAILS;
					else this.reopenFails++;
					this.scheduleRetry();
				},
			},
			this.cursor,
		);
	}

	/** (Re)load everything and (re)open the event stream. Safe to call repeatedly. */
	async sync(fromRetry = false): Promise<void> {
		if (this.stopped) return;
		const token = ++this.token;
		this.disarmStable();
		clearTimeout(this.retryTimer);
		this.unsubscribe?.();
		this.unsubscribe = null;
		if (!fromRetry) {
			this.retryDelay = 1000;
			this.reopenFails = 0;
		}
		// "connecting" only before the first attempt settles; a retry keeps showing online/offline instead of flickering
		if (this.net === "idle") this.net = "connecting";
		// This attempt's requests end with it: a deadline, a newer attempt or stop() cancels the ones still out, so a server
		// that went silent does not keep the browser's connections to it busy for the retry (see Api.scoped).
		this.attempt?.abort();
		const attempt = (this.attempt = new AbortController());
		const api = this.api.scoped(attempt.signal);
		try {
			const startListed = () => {
				// Capture the replay cursor before reading /activity, so any run_started/run_finished between them is replayed
				// once the stream opens instead of falling into a gap between the snapshot and the cursor.
				const latestIdReq = api.latestEventId();
				latestIdReq.catch(() => {});
				// Sidebar batch stays within HTTP/1.1's 6-connection-per-host budget; the heavier model/provider catalog waits
				// for Wave 2 so it never blocks the conversation list or `/health` on slow or relayed links.
				const req = Promise.all([
					api.listSessions(200, false),
					api.workspace().catch(() => null), // servers from before workspaces existed
					api.groups().catch(() => [] as Group[]), // servers from before session groups existed
					api.terminals().catch(() => [] as TerminalInfo[]), // servers from before terminals existed
					api.terminalSupport().catch(() => null),
					latestIdReq.then(
						() => api.activity().catch(() => null),
						() => api.activity().catch(() => null),
					),
					latestIdReq,
				]);
				req.catch(() => {});
				const bounded = withDeadline(req, LISTS_TIMEOUT_MS, () => new ApiError(0, "network", t("서버에 연결할 수 없습니다")));
				bounded.catch(() => {});
				return bounded;
			};

			// Offline retries probe `/health` alone first so an unreachable server does not re-fire a burst of list requests
			// every retry interval. Initial boot and foreground syncs pipeline `/health` + sidebar lists in one round trip.
			const gateOnHealth = fromRetry && !this.listed;
			const healthReq = api.health(AbortSignal.timeout(HEALTH_SYNC_TIMEOUT_MS));
			const listed = gateOnHealth ? null : startListed();
			const health = await healthReq;
			if (token !== this.token) return;
			this.versions = { version: health.version, protocol: health.protocol, minClientProtocol: health.minClientProtocol };
			if (compat(this.versions) === "update-app") {
				// Every other call would be refused (426) or answered in a shape this app cannot read: say why instead.
				attempt.abort();
				this.net = "incompatible";
				this.netError = t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요");
				return;
			}
			const [list, workspace, groups, terminals, terminalSupport, activity, cursor] = await (listed ?? startListed());
			if (token !== this.token) return;
			const running: Record<string, boolean> = {};
			const awaiting: Record<string, number> = {};
			const unread: Record<string, boolean> = {};
			const failed: Record<string, boolean> = {};
			for (const a of activity?.sessions ?? []) {
				if (a.running) running[a.sessionId] = true;
				if (a.pendingQuestions) awaiting[a.sessionId] = a.pendingQuestions;
			}
			for (const u of activity?.unread ?? []) (u.kind === "failed" ? failed : unread)[u.sessionId] = true;
			this.data = {
				sessions: list.sessions.filter((s: Session) => !s.closed),
				groups,
				terminals,
				running,
				compacting: {},
				awaiting,
				unread,
				failed,
				queued: {},
				tool: {},
			};
			this.workspace = workspace;
			this.terminalSupport = terminalSupport;
			this.listed = true;
			this.cached = false;
			this.followLists();

			// Wave 2: model/provider catalog (4 requests, cleanly within HTTP/1.1's socket budget and its own deadline).
			const catalogReq = Promise.all([
				api.models(),
				api.providers(),
				api.tools(),
				api.configuration().catch(() => null), // servers from before model configuration existed
			]);
			catalogReq.catch(() => {});
			const [models, providers, tools, config] = await withDeadline(
				catalogReq,
				CATALOG_TIMEOUT_MS,
				() => new ApiError(0, "network", t("서버에 연결할 수 없습니다")),
			);
			if (token !== this.token) return;
			this.models = models;
			this.providers = providers;
			this.tools = tools.tools;
			this.serverDefault = config?.effectiveDefaults ?? null;
			this.customProviders = config?.providers ?? [];
			this.workdirInfo = config?.workdir ?? null;
			this.toolsInfo = config?.tools ?? null;
			this.loaded = true;
			// Where a reopened stream resumes from: the newest event id the server has, so a wake does not replay the
			// whole history (it did: 1.7s of re-rendering in one frame).
			this.cursor = cursor;

			let opened = false;
			let stable = false;
			this.unsubscribe = this.api.subscribe(
				{
					onEvent: (e) => {
						if (token !== this.token) return;
						if (e.id > this.cursor) this.cursor = e.id;
						this.hooks.event(this, e);
					},
					onOpen: () => {
						if (token !== this.token) return;
						const first = !opened;
						opened = true;
						stable = false;
						this.net = "online";
						this.netError = "";
						if (first && !fromRetry) {
							this.retryDelay = 1000;
							this.reopenFails = 0;
						}
						this.armStable(token, () => { stable = true; });
						if (first) {
							// Background metadata waits until the stream is open so it does not compete for HTTP/1.1 sockets
							// with `/stream-tickets` or `/events`.
							void this.lookUpRepos(this.listedPaths(), true);
							void this.refreshModelSettings();
							this.hooks.ready(this, false);
						}
					},
					onError: () => {
						if (token !== this.token) return;
						this.disarmStable();
						this.net = "offline";
						if (stable) this.reopenFails = 0;
						this.scheduleRetry();
					},
				},
				cursor,
			);
		} catch (e) {
			if (token !== this.token) return;
			attempt.abort(); // what is still out (the catalog after a health failure, the rest after a deadline) stops here
			if (e instanceof ApiError && isClientTooOld(e.status, e.code)) {
				this.net = "incompatible";
				this.netError = t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요");
				return;
			}
			if (e instanceof ApiError && (e.status === 401 || e.status === 403)) {
				this.net = "unauthorized";
				this.netError = t("토큰이 거부되었습니다");
				return;
			}
			this.net = "offline";
			this.netError = errorText(e);
			this.scheduleRetry();
		}
	}

	/** Reread providers, models and the server's defaults. False when the server could not be reached. */
	async refreshCatalog(): Promise<boolean> {
		const api = this.boundedApi(10_000);
		try {
			const [providers, models, config] = await Promise.all([api.providers(), api.models(), api.configuration().catch(() => null)]);
			this.providers = providers;
			this.models = models;
			this.serverDefault = config?.effectiveDefaults ?? null;
			if (config) this.customProviders = config.providers;
			if (config?.workdir) this.workdirInfo = config.workdir;
			if (config?.tools) this.toolsInfo = config.tools;
			void this.refreshModelSettings();
			return true;
		} catch {
			return false; // the next sync retries
		}
	}

	/** Reread which models compaction, system jobs and fallback use. A server without them keeps null (no problem to flag). */
	async refreshModelSettings(): Promise<void> {
		const api = this.boundedApi(10_000);
		const [c, s, f] = await Promise.all([
			api.compactionSettings().catch(() => null),
			api.systemModelSettings().catch(() => null),
			api.fallbackModelSettings?.().catch(() => null) ?? null,
		]);
		this.compaction = c?.settings ?? null;
		this.systemModel = s?.settings ?? null;
		this.fallbackModel = f?.settings ?? null;
	}

	async refreshWorkspace(): Promise<void> {
		try {
			this.workspace = await this.boundedApi(10_000).workspace();
		} catch {
			/* offline: keep what we have */
		}
	}
}

/** Two of these maps say the same thing (so writing one over the other would only re-render what reads it). */
function sameMap(a: Record<string, boolean | number>, b: Record<string, boolean | number>): boolean {
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	return keys.every((k) => a[k] === b[k]);
}

/** The same terminals, in the same order, with the same titles (a renamed shell must still show through). */
function sameTerminals(a: readonly TerminalInfo[], b: readonly TerminalInfo[]): boolean {
	return a.length === b.length && a.every((x, i) => x.id === b[i]!.id && x.title === b[i]!.title && x.pid === b[i]!.pid);
}

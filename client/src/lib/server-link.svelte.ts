import { Api, ApiError, errorText } from "./api";
import { compat, isClientTooOld, type ServerVersions } from "./protocol";
import { t } from "./i18n";
import { emptyLinkData, type LinkData } from "./server-link-model";
import type { Server } from "./store-model";
import type { TerminalInfo, TerminalSupport } from "./terminal";
import type {
	DefaultModelSelection, Group, ModelInfo, PipayaEvent, ProviderInfo, Session, ToolInfo, ToolsInfo, WorkdirInfo, WorkspaceInfo,
} from "./types";

export type NetState = "idle" | "connecting" | "online" | "offline" | "unauthorized" | "incompatible";

export interface LinkHooks {
	/** An event arrived on this server's stream. */
	event(link: ServerLink, e: PipayaEvent): void;
	/** Everything was (re)loaded and the stream is open. */
	ready(link: ServerLink): void;
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
	data = $state<LinkData>(emptyLinkData());
	models = $state<ModelInfo[]>([]);
	providers = $state<ProviderInfo[]>([]);
	tools = $state<ToolInfo[]>([]);
	workspace = $state<WorkspaceInfo | null>(null);
	workdirInfo = $state<WorkdirInfo | null>(null);
	toolsInfo = $state<ToolsInfo | null>(null);
	serverDefault = $state<DefaultModelSelection | null>(null);
	terminalSupport = $state<TerminalSupport | null>(null);

	private unsubscribe: (() => void) | null = null;
	private retryTimer: ReturnType<typeof setTimeout> | undefined;
	private retryDelay = 1000;
	private token = 0;
	private stopped = false;

	constructor(
		readonly server: Server,
		private readonly hooks: LinkHooks,
	) {
		this.api = new Api({ baseUrl: server.baseUrl, token: server.token });
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
		this.token++;
		clearTimeout(this.retryTimer);
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	private scheduleRetry(): void {
		clearTimeout(this.retryTimer);
		if (this.stopped) return;
		this.retryTimer = setTimeout(() => void this.sync(), this.retryDelay);
		this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
	}

	/** (Re)load everything and (re)open the event stream. Safe to call repeatedly. */
	async sync(): Promise<void> {
		if (this.stopped) return;
		const token = ++this.token;
		clearTimeout(this.retryTimer);
		this.unsubscribe?.();
		this.unsubscribe = null;
		this.net = this.net === "online" ? "online" : "connecting";
		const api = this.api;
		try {
			const health = await api.health();
			if (token !== this.token) return;
			this.versions = { version: health.version, protocol: health.protocol, minClientProtocol: health.minClientProtocol };
			if (compat(this.versions) === "update-app") {
				// Every other call would be refused (426) or answered in a shape this app cannot read: say why instead.
				this.net = "incompatible";
				this.netError = t("이 서버는 더 새로운 앱이 필요합니다. 앱을 업데이트하세요");
				return;
			}
			const [list, models, providers, tools, cursor, workspace, config, groups, terminals, terminalSupport, activity] = await Promise.all([
				api.listSessions(200, false),
				api.models(),
				api.providers(),
				api.tools(),
				api.latestEventId(),
				api.workspace().catch(() => null), // servers from before workspaces existed
				api.configuration().catch(() => null), // servers from before model configuration existed
				api.groups().catch(() => [] as Group[]), // servers from before session groups existed
				api.terminals().catch(() => [] as TerminalInfo[]), // servers from before terminals existed
				api.terminalSupport().catch(() => null),
				api.activity().catch(() => null),
			]);
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
				sessions: list.sessions.filter((s: Session) => !s.closed && !s.archived),
				archived: list.sessions.filter((s: Session) => !s.closed && s.archived),
				groups,
				terminals,
				running,
				awaiting,
				unread,
				failed,
			};
			this.workspace = workspace;
			this.terminalSupport = terminalSupport;
			this.models = models;
			this.providers = providers;
			this.tools = tools.tools;
			this.serverDefault = config?.effectiveDefaults ?? null;
			this.workdirInfo = config?.workdir ?? null;
			this.toolsInfo = config?.tools ?? null;
			this.loaded = true;

			this.unsubscribe = api.subscribe(
				{
					onEvent: (e) => this.hooks.event(this, e),
					onOpen: () => {
						this.net = "online";
						this.netError = "";
						this.retryDelay = 1000;
					},
					onError: () => {
						if (token !== this.token) return;
						this.net = "offline";
						this.scheduleRetry();
					},
				},
				cursor,
			);
			this.net = "online";
			this.netError = "";
			this.retryDelay = 1000;
			this.hooks.ready(this);
		} catch (e) {
			if (token !== this.token) return;
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
		try {
			const [providers, models, config] = await Promise.all([this.api.providers(), this.api.models(), this.api.configuration().catch(() => null)]);
			this.providers = providers;
			this.models = models;
			this.serverDefault = config?.effectiveDefaults ?? null;
			if (config?.workdir) this.workdirInfo = config.workdir;
			if (config?.tools) this.toolsInfo = config.tools;
			return true;
		} catch {
			return false; // the next sync retries
		}
	}

	async refreshWorkspace(): Promise<void> {
		try {
			this.workspace = await this.api.workspace();
		} catch {
			/* offline: keep what we have */
		}
	}
}

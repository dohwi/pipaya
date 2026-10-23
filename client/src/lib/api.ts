import type { CatalogModel, CompactionSettings, CompactionSettingsInfo, DefaultModelSelection, SystemModelSettings, SystemModelSettingsInfo,
	AgentMessage,
	Approval,
	Question,
	ActivityInfo,
	ConfigurationInfo,
	ToolsInfo,
	LoginState,
	CompactionResult,
	ConnectionResult,
	DirListing,
	Group,
	WorkdirInfo,
	CustomProvider,
	ApiFormat,
	CustomProviderInput,
	ModelSelection,
	PipayaEvent,
	ModelInfo,
	ProviderInfo,
	SendMode,
	Session,
	SessionDetail,
	SessionContext,
	SkillList,
	TemplateList,
	ToolInfo,
	Usage,
	WorkspaceInfo,
	ThinkingLevel,
} from "./types";
import { getLang, t } from "./i18n";
import { PROTOCOL_HEADER, PROTOCOL_QUERY, PROTOCOL_VERSION, type ServerUpdateStatus, type ServerVersions } from "./protocol";

export class ApiError extends Error {
	constructor(
		readonly status: number,
		readonly code: string,
		message: string,
	) {
		super(message);
	}
}

export interface Connection {
	baseUrl: string;
	token: string;
}

export interface StoredMessage {
	seq: number;
	role: string;
	createdAt: number;
	message: AgentMessage;
}

export interface CreateSessionInput {
	title?: string;
	cwd?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	systemPrompt?: string;
	tools?: string[];
	/** UI language; picks the language of the session's @name. Added by `createSession`. */
	lang?: string;
}

export interface PatchSessionInput {
	title?: string;
	provider?: string;
	model?: string;
	thinkingLevel?: ThinkingLevel;
	closed?: boolean;
}

export const normalizeUrl = (url: string): string => {
	let u = url.trim().replace(/\/+$/, "");
	if (u && !/^https?:\/\//i.test(u)) u = `http://${u}`;
	return u;
};

export class Api {
	constructor(private conn: Connection) {}

	get baseUrl() {
		return this.conn.baseUrl;
	}

	private async req<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
		let res: Response;
		try {
			res = await fetch(this.conn.baseUrl + path, {
				method,
				signal,
				headers: {
					Authorization: `Bearer ${this.conn.token}`,
					[PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (e) {
			if ((e as Error).name === "AbortError") throw e;
			throw new ApiError(0, "network", t("서버에 연결할 수 없습니다"));
		}
		if (res.status === 204) return undefined as T;
		const text = await res.text();
		let json: any;
		try {
			json = text ? JSON.parse(text) : undefined;
		} catch {
			json = undefined;
		}
		if (!res.ok) {
			throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? res.statusText);
		}
		return json as T;
	}

	/** Access tokens issued to paired devices (admin token only). The secret itself is never listed. */
	deviceTokens() { return this.req<{ tokens: { id: string; name: string; createdAt: number; lastUsedAt: number | null }[] }>("GET", "/devices/tokens", undefined, AbortSignal.timeout(5000)); }
	revokeDeviceToken(id: string) { return this.req("DELETE", `/devices/tokens/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(5000)); }
	notificationStatus() { return this.req<{ pushConfigured: boolean; providers: ("fcm" | "apns")[] }>("GET", "/notifications/status"); }
	notificationPresence(id: string, presence: { platform: "desktop" | "android" | "ios" | "web"; focused: boolean; enabled: boolean; visibleSessionIds: string[]; lang?: string; name?: string; os?: string; app?: string; push?: { provider: "fcm" | "apns"; token: string } | null }) { return this.req("PUT", `/notifications/devices/${encodeURIComponent(id)}`, presence, AbortSignal.timeout(3500)); }
	notificationDevices() { return this.req<{ devices: import("./notification-contract").NotificationDevice[] }>("GET", "/notifications/devices", undefined, AbortSignal.timeout(5000)); }
	removeNotificationDevice(id: string) { return this.req("DELETE", `/notifications/devices/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(5000)); }
	testNotification(deviceId: string) { return this.req<import("./notification-contract").NotificationTestResult>("POST", `/notifications/devices/${encodeURIComponent(deviceId)}/test`, {}, AbortSignal.timeout(5000)); }
	notificationReceived(id: string) { return this.req("POST", `/notifications/${encodeURIComponent(id)}/received`, {}, AbortSignal.timeout(3500)); }
	sendNotification(source: string, notification: import("./notification-contract").NotificationSpec) { return this.req<import("./notification-contract").NotificationResult>("POST", "/notifications", { source, notification }, AbortSignal.timeout(3500)); }
	setNotificationRule(owner: string, id: string, rule: import("./notification-contract").NotificationRule) { return this.req("PUT", `/notifications/rules/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`, rule, AbortSignal.timeout(3500)); }
	revokeNotificationRules(owner: string) { return this.req("DELETE", `/notifications/rules/${encodeURIComponent(owner)}`, undefined, AbortSignal.timeout(3500)); }
	removeNotificationRule(owner: string, id: string) { return this.req("DELETE", `/notifications/rules/${encodeURIComponent(owner)}/${encodeURIComponent(id)}`, undefined, AbortSignal.timeout(3500)); }

	/** Public endpoint; also used to validate a URL before a token is known. */
	async health(signal?: AbortSignal) {
		const res = await fetch(`${this.conn.baseUrl}/health`, { signal });
		if (!res.ok) throw new ApiError(res.status, "http_error", res.statusText);
		return (await res.json()) as { ok: boolean; uptimeMs?: number; runningSessions?: number; subscribers?: number } & ServerVersions;
	}

	/** Is there a newer server build, and can this server update itself? (admin token only) */
	serverUpdateStatus = (signal?: AbortSignal) => this.req<ServerUpdateStatus>("GET", "/server/update", undefined, signal ?? AbortSignal.timeout(90_000));
	/** Update the server's code and restart it. The connection drops while it restarts. */
	updateServer = (force = false) => this.req<{ ok: boolean; from: string; to: string; restarting: boolean }>("POST", "/server/update", { force }, AbortSignal.timeout(10 * 60_000));

	/** Newest persisted event id; used as the starting cursor so we do not replay all history. */
	latestEventId = () =>
		this.req<{ latestId: number }>("GET", "/events/history?after=0&limit=1").then((r) => r.latestId);

	tools = (signal?: AbortSignal) => this.req<{ tools: ToolInfo[]; defaults: string[] }>("GET", "/tools", undefined, signal);
	models = () => this.req<{ models: ModelInfo[] }>("GET", "/models?configured=true").then((r) => r.models);
	providers = () => this.req<{ providers: ProviderInfo[] }>("GET", "/providers").then((r) => r.providers);
	setCredential = (id: string, key: string) =>
		this.req<{ ok: boolean }>("PUT", `/providers/${encodeURIComponent(id)}/credential`, { key });
	removeCredential = (id: string) =>
		this.req<{ ok: boolean }>("DELETE", `/providers/${encodeURIComponent(id)}/credential`);
	startLogin = (id: string, type: "api_key" | "oauth") =>
		this.req<LoginState>("POST", `/providers/${encodeURIComponent(id)}/login`, { type });
	login = (loginId: string) => this.req<LoginState>("GET", `/logins/${encodeURIComponent(loginId)}`);
	answerLogin = (loginId: string, promptId: number, value: string) =>
		this.req<LoginState>("POST", `/logins/${encodeURIComponent(loginId)}/answer`, { promptId, value });
	cancelLogin = (loginId: string) => this.req<LoginState>("POST", `/logins/${encodeURIComponent(loginId)}/cancel`);

	/* ---------- extension settings (server is the source of truth) ---------- */
	extensionSettings = (signal?: AbortSignal) =>
		this.req<{ settings: Record<string, Record<string, unknown>> }>("GET", "/extensions/settings", undefined, signal);
	saveExtensionSettings = (id: string, settings: Record<string, unknown>, signal?: AbortSignal) =>
		this.req<{ settings: Record<string, unknown> }>("PUT", `/extensions/${encodeURIComponent(id)}/settings`, { settings }, signal);
	deleteExtension = (id: string, signal?: AbortSignal) =>
		this.req<{ ok: boolean }>("DELETE", `/extensions/${encodeURIComponent(id)}`, undefined, signal);

	/* ---------- extensions that run inside the server (server/src/extensions) ---------- */
	serverExtensions = (signal?: AbortSignal) =>
		this.req<{ extensions: { name: string; tools: string[]; commands: { name: string; description?: string }[]; methods: string[]; companion?: string; error?: string }[]; commands: { name: string; description?: string; extension: string }[] }>("GET", "/server-extensions", undefined, signal);
	callServerExtension = (extension: string, method: string, params: unknown, sessionId: string | null, signal?: AbortSignal) =>
		this.req<{ result: unknown }>("POST", `/server-extensions/${encodeURIComponent(extension)}/methods/${encodeURIComponent(method)}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ""}`, params ?? {}, signal).then((r) => r.result);
	serverExtensionEntries = (sessionId: string, extension?: string, type?: string, signal?: AbortSignal) => {
		const q = new URLSearchParams();
		if (extension) q.set("extension", extension);
		if (type) q.set("type", type);
		return this.req<{ entries: { id: number; extension: string; type: string; data: unknown; createdAt: number }[] }>("GET", `/sessions/${encodeURIComponent(sessionId)}/extension-entries${q.size ? `?${q}` : ""}`, undefined, signal).then((r) => r.entries);
	};
	installServerExtension = (src: { id: string; repo: string; dir?: string; ref: string; commit: string }, signal?: AbortSignal) =>
		this.req<{ extensions: unknown[] }>("POST", "/server-extensions/install", src, signal);
	reloadServerExtensions = (signal?: AbortSignal) => this.req<{ extensions: unknown[] }>("POST", "/server-extensions/reload", {}, signal);

	/* ---------- settings that belong to this server ---------- */
	clientSettings = (signal?: AbortSignal) =>
		this.req<{ settings: Record<string, { value: unknown; updatedAt: number }> }>("GET", "/client-settings", undefined, signal);
	clientSetting = (key: string, signal?: AbortSignal) =>
		this.req<{ value: unknown; updatedAt: number }>("GET", `/client-settings/${encodeURIComponent(key)}`, undefined, signal);
	putClientSetting = (key: string, value: unknown, at: number, origin: string, signal?: AbortSignal) =>
		this.req<{ value: unknown; updatedAt: number; applied: boolean }>("PUT", `/client-settings/${encodeURIComponent(key)}`, { value, at, origin }, signal);

	/* ---------- connect another device by QR (server/src/pairing.ts) ---------- */
	createPairing = (signal?: AbortSignal) =>
		this.req<{ code: string; expiresAt: number }>("POST", "/pairing", {}, signal);
	revokePairing = (signal?: AbortSignal) => this.req<{ ok: boolean }>("DELETE", "/pairing", undefined, signal);

	/* ---------- UI language packs ---------- */
	locales = (signal?: AbortSignal) =>
		this.req<{ locales: { tag: string; name: string; owner?: string; messages: number; updatedAt: number }[] }>("GET", "/locales", undefined, signal).then((r) => r.locales);
	locale = (tag: string, signal?: AbortSignal) =>
		this.req<{ tag: string; name: string; owner?: string; messages: Record<string, string>; updatedAt: number }>("GET", `/locales/${encodeURIComponent(tag)}`, undefined, signal);
	saveLocale = (tag: string, pack: { name: string; messages: Record<string, string>; owner?: string }, signal?: AbortSignal) =>
		this.req<{ tag: string; updatedAt: number }>("PUT", `/locales/${encodeURIComponent(tag)}`, pack, signal);
	deleteLocale = (tag: string, owner?: string, signal?: AbortSignal) =>
		this.req<{ ok: boolean }>("DELETE", `/locales/${encodeURIComponent(tag)}${owner ? `?owner=${encodeURIComponent(owner)}` : ""}`, undefined, signal);

	activity = () => this.req<ActivityInfo>("GET", "/activity");

	/* ---------- model connection settings ---------- */
	configuration = () => this.req<ConfigurationInfo>("GET", "/configuration");
	catalog = () => this.req<{ models: CatalogModel[] }>("GET", "/configuration/catalog");
	discoverModels = (input: { baseUrl: string; api: ApiFormat; providerId?: string; apiKey?: string }) =>
		this.req<{ models: { id: string; name?: string }[] }>("POST", "/configuration/discover", input);
	saveCustomProvider = (id: string, input: CustomProviderInput) =>
		this.req<CustomProvider>("PUT", `/configuration/providers/${encodeURIComponent(id)}`, input);
	/** Re-read the connection's model list from its upstream now; resolves with the updated connection. */
	refreshCustomProvider = (id: string) =>
		this.req<CustomProvider>("POST", `/configuration/providers/${encodeURIComponent(id)}/refresh`);
	deleteCustomProvider = (id: string) =>
		this.req<{ ok: boolean }>("DELETE", `/configuration/providers/${encodeURIComponent(id)}`);
	setDefaultModel = (sel: DefaultModelSelection | null) =>
		this.req<Pick<ConfigurationInfo, "defaults" | "effectiveDefaults">>("PUT", "/configuration/defaults", sel);
	setDisabledTools = (disabled: string[]) => this.req<ToolsInfo>("PUT", "/configuration/tools", { disabled });
	setDefaultWorkdir = (path: string | null) => this.req<WorkdirInfo>("PUT", "/configuration/workdir", { path });
	listDirs = (path?: string, hidden = false) =>
		this.req<DirListing>("GET", `/fs/dirs?${new URLSearchParams({ ...(path ? { path } : {}), ...(hidden ? { hidden: "true" } : {}) })}`);
	listFiles = (cwd: string, q: string, signal?: AbortSignal) =>
		this.req<{ entries: { path: string; dir: boolean }[] }>("GET", `/fs/files?${new URLSearchParams({ cwd, q })}`, undefined, signal);
	makeDir = (parent: string, name: string) => this.req<{ path: string }>("POST", "/fs/dirs", { parent, name });
	testModel = (sel: ModelSelection) => this.req<ConnectionResult>("POST", "/configuration/test", sel);

	compactionSettings = () => this.req<CompactionSettingsInfo>("GET", "/compaction");
	setCompactionSettings = (settings: CompactionSettings) => this.req<CompactionSettingsInfo>("PUT", "/compaction", settings);
	systemModelSettings = () => this.req<SystemModelSettingsInfo>("GET", "/system-model");
	setSystemModelSettings = (settings: SystemModelSettings) => this.req<SystemModelSettingsInfo>("PUT", "/system-model", settings);

	/** `closed`: false = active only (the sidebar), true = closed only (/resume). */
	listSessions = (limit = 100, closed?: boolean) =>
		this.req<{ sessions: Session[]; nextBefore: number | null }>(
			"GET",
			`/sessions?limit=${limit}${closed === undefined ? "" : `&closed=${closed}`}`,
		);
	/** One page of every session, active and closed, newest first. `before` is the previous page's `nextBefore`. */
	listSessionsPage = (limit = 200, before?: number) =>
		this.req<{ sessions: Session[]; nextBefore: number | null }>("GET", `/sessions?limit=${limit}${before === undefined ? "" : `&before=${before}`}`);
	workspace = () => this.req<WorkspaceInfo>("GET", "/workspace");
	createSession = (input: CreateSessionInput = {}) => this.req<Session>("POST", "/sessions", { lang: getLang(), ...input });
	/** The UI language changed: every session's @name becomes its twin in that language (민수 <-> Minsu). */
	localizeNames = (lang: string) => this.req<{ renamed: number }>("POST", "/sessions/localize-names", { lang });
	getSession = (id: string) => this.req<SessionDetail>("GET", `/sessions/${id}`);
	sessionContext = (id: string, signal?: AbortSignal) =>
		this.req<SessionContext>("GET", `/sessions/${encodeURIComponent(id)}/context`, undefined, signal);
	skills = (cwd?: string, signal?: AbortSignal, sessionId?: string | null) => {
		const q = new URLSearchParams();
		if (cwd) q.set("cwd", cwd);
		if (sessionId) q.set("sessionId", sessionId);
		return this.req<SkillList>("GET", `/skills${q.size ? `?${q}` : ""}`, undefined, signal);
	};
	/** scope "project"/"session": enabled null removes the override. "session" needs sessionId. */
	setSkill = (name: string, body: { scope: "global" | "project" | "session"; enabled: boolean | null; cwd?: string; sessionId?: string }) =>
		this.req<SkillList>("PUT", `/skills/${encodeURIComponent(name)}`, body);
	/** Prompt templates come from the server's bundled `prompt-templates` extension; without it the call fails and the UI hides them. */
	templates = (cwd?: string, signal?: AbortSignal) =>
		this.callServerExtension("prompt-templates", "list", cwd ? { cwd } : {}, null, signal) as Promise<TemplateList>;
	patchSession = (id: string, patch: PatchSessionInput) => this.req<Session>("PATCH", `/sessions/${id}`, patch);
	deleteSession = (id: string) => this.req<void>("DELETE", `/sessions/${id}`);
	/** Delete several at once. Ones running or waiting for the user are skipped and come back in `skipped`. */
	deleteSessions = (ids: string[]) => this.req<{ deleted: string[]; skipped: string[] }>("POST", "/sessions/delete", { ids });
	forkSession = (id: string, atSeq?: number, title?: string) =>
		this.req<Session>("POST", `/sessions/${id}/fork`, { atSeq, title });
	usage = (id: string) => this.req<Usage>("GET", `/sessions/${id}/usage`);

	messages = (id: string, after?: number) =>
		this.req<{ messages: StoredMessage[] }>(
			"GET",
			`/sessions/${id}/messages?limit=5000${after !== undefined ? `&after=${after}` : ""}`,
		).then((r) => r.messages);
	send = (id: string, text: string, mode: SendMode = "prompt", images?: { type: "image"; data: string; mimeType: string }[], files?: { name: string; data: string }[]) =>
		this.req<{ accepted: SendMode }>("POST", `/sessions/${id}/messages`, {
			text,
			mode,
			...(images?.length ? { images } : {}),
			...(files?.length ? { files: files.map((f) => ({ name: f.name, data: f.data })) } : {}),
		});
	/** A file of the session's working directory (an upload, or something the agent wrote), as bytes. */
	async fetchFile(id: string, path: string, signal?: AbortSignal): Promise<Blob> {
		let res: Response;
		try {
			res = await fetch(`${this.conn.baseUrl}/sessions/${encodeURIComponent(id)}/files?${new URLSearchParams({ path })}`, { signal, headers: { Authorization: `Bearer ${this.conn.token}`, [PROTOCOL_HEADER]: String(PROTOCOL_VERSION) } });
		} catch (e) {
			if ((e as Error).name === "AbortError") throw e;
			throw new ApiError(0, "network", t("서버에 연결할 수 없습니다"));
		}
		if (!res.ok) {
			const json = await res.json().catch(() => undefined);
			throw new ApiError(res.status, json?.error?.code ?? "http_error", json?.error?.message ?? res.statusText);
		}
		return res.blob();
	}
	abort = (id: string) => this.req<{ aborted: boolean }>("POST", `/sessions/${id}/abort`);
	cancelQueued = (id: string, mode: "steer" | "follow_up", text: string) =>
		this.req<{ cancelled: boolean }>("POST", `/sessions/${id}/queue/cancel`, { mode, text });
	retry = (id: string) => this.req<{ accepted: "retry" }>("POST", `/sessions/${id}/retry`);
	/** Resolves only after the server has durably committed the compacted model context. */
	compactSession = (id: string, customInstructions?: string) =>
		this.req<CompactionResult>("POST", `/sessions/${id}/compact`, {
			...(customInstructions?.trim() ? { customInstructions: customInstructions.trim() } : {}),
		});

	/* ---------- session groups ---------- */
	groups = () => this.req<{ groups: Group[] }>("GET", "/groups").then((r) => r.groups);
	createGroup = (input: { name?: string; layout: Group["layout"]; autoName?: boolean }) => this.req<Group>("POST", "/groups", input);
	patchGroup = (id: string, patch: { name?: string; layout?: Group["layout"] }) =>
		this.req<Group>("PATCH", `/groups/${id}`, patch);
	deleteGroup = (id: string) => this.req<{ ok: boolean }>("DELETE", `/groups/${id}`);

	/* ---------- terminals (the server's own shell) ---------- */
	terminalSupport = () => this.req<import("./terminal").TerminalSupport>("GET", "/terminals/info");
	terminals = () => this.req<{ terminals: import("./terminal").TerminalInfo[] }>("GET", "/terminals").then((r) => r.terminals);
	createTerminal = (input: { cwd?: string; shell?: string; title?: string; cols?: number; rows?: number }) =>
		this.req<import("./terminal").TerminalInfo>("POST", "/terminals", input);
	renameTerminal = (id: string, title: string) => this.req<import("./terminal").TerminalInfo>("PATCH", `/terminals/${encodeURIComponent(id)}`, { title });
	closeTerminal = (id: string) => this.req<{ ok: boolean }>("DELETE", `/terminals/${encodeURIComponent(id)}`);

	approvals = () => this.req<{ approvals: Approval[] }>("GET", "/approvals").then((r) => r.approvals);
	decide = (sessionId: string, toolCallId: string, approved: boolean, reason?: string) =>
		this.req<{ ok: boolean }>("POST", `/sessions/${sessionId}/approvals/${encodeURIComponent(toolCallId)}`, {
			approved,
			reason,
		});

	questions = () =>
		this.req<{ questions: Question[] }>("GET", "/questions").then((r) => r.questions).catch(() => [] as Question[]);
	answer = (sessionId: string, toolCallId: string, answer: string | string[]) =>
		this.req<{ ok: boolean }>("POST", `/sessions/${sessionId}/questions/${encodeURIComponent(toolCallId)}`, Array.isArray(answer) ? { answers: answer } : { answer });

	/**
	 * Subscribe to the global event stream. EventSource cannot set headers, so the token goes in the
	 * query string. `after` is the replay cursor; the caller owns reconnects (see AppStore) because a
	 * dropped stream also loses live-only deltas and needs a full resync rather than a replay.
	 */
	subscribe(
		handlers: { onEvent: (e: PipayaEvent) => void; onOpen?: () => void; onError?: () => void },
		after: number,
	): () => void {
		const url = `${this.conn.baseUrl}/events?after=${after}&${PROTOCOL_QUERY}=${PROTOCOL_VERSION}&token=${encodeURIComponent(this.conn.token)}`;
		const es = new EventSource(url);
		let dead = false;
		es.onopen = () => handlers.onOpen?.();
		es.onerror = () => {
			if (dead) return;
			dead = true;
			es.close();
			handlers.onError?.();
		};
		const onMessage = (m: MessageEvent) => {
			try {
				handlers.onEvent(JSON.parse(m.data) as PipayaEvent);
			} catch {
				/* ignore malformed frame */
			}
		};
		for (const t of EVENT_TYPES) es.addEventListener(t, onMessage as EventListener);
		return () => {
			dead = true;
			es.close();
		};
	}
}

/** Every event name the server can send. EventSource only delivers names registered here, so a missing one is dropped without an error. */
export const EVENT_TYPES = [
	"session_created",
	"session_updated",
	"session_deleted",
	"session_forked",
	"group_created",
	"group_updated",
	"group_deleted",
	"terminal_created",
	"terminal_updated",
	"terminal_closed",
	"run_started",
	"run_finished",
	"run_limit",
	"compaction_started",
	"compaction_finished",
	"compaction_failed",
	"context_updated",
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
	"approval_requested",
	"approval_resolved",
	"question_requested",
	"question_resolved",
	"message_queued",
	"message_dequeued",
	"provider_updated",
	"configuration_updated",
	"skills_updated",
	"locales_updated",
	"client_settings_updated",
	"extensions_updated",
	"extension_error",
	"extension_event",
	"extension_entry",
	"notification",
	"device_revoked",
];

/* ---------- helpers for the server list ---------- */

export type ServerProbe = "online" | "offline" | "unauthorized";

/**
 * The server answered "no such route": it is older than this app and lacks the feature. (A missing *thing*, such as a
 * deleted session, is also a not_found, but its message names the thing; only the unrouted fallback says "route".)
 */
export const isUnsupportedRoute = (e: unknown): boolean => e instanceof ApiError && e.status === 404 && e.code === "not_found" && e.message === "route not found";

/** User-facing (Korean) text for any error thrown by the client. */
export function errorText(e: unknown): string {
	if (e instanceof ApiError) {
		if (e.status === 0) return t("서버에 연결할 수 없습니다");
		if (e.status === 401 || e.status === 403) return t("토큰이 거부되었습니다");
		if (isUnsupportedRoute(e)) return t("이 서버는 아직 이 기능을 지원하지 않습니다. 서버를 업데이트하세요");
		if (e.code === "not_found") return t("대상을 찾을 수 없습니다");
		return e.message;
	}
	return (e as Error)?.message || t("문제가 발생했습니다");
}

/** Throws if the server is unreachable or rejects the token. `/health` is public, so `/tools` proves the token. */
export async function verifyServer(baseUrl: string, token: string, timeoutMs = 8000): Promise<void> {
	const ctl = new AbortController();
	const timer = setTimeout(() => ctl.abort(), timeoutMs);
	try {
		const api = new Api({ baseUrl, token });
		await api.health(ctl.signal);
		await api.tools(ctl.signal);
	} finally {
		clearTimeout(timer);
	}
}

export function describeConnectError(e: unknown, baseUrl: string): string {
	if (e instanceof ApiError) {
		if (e.status === 401 || e.status === 403) return t("서버가 토큰을 거부했습니다. 토큰을 다시 확인하세요.");
		if (e.status === 0) return t("{url}에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.", { url: baseUrl });
		return e.message;
	}
	if ((e as Error)?.name === "AbortError") return t("서버 응답 시간이 초과되었습니다.");
	if (e instanceof TypeError) return t("{url}에 연결할 수 없습니다. 주소와 서버 실행 여부를 확인하세요.", { url: baseUrl });
	return (e as Error)?.message || t("연결하지 못했습니다.");
}

/** Quick reachability check used for the status dots of servers that are not currently open. */
export async function probeServer(baseUrl: string, token: string): Promise<ServerProbe> {
	try {
		await verifyServer(baseUrl, token, 4000);
		return "online";
	} catch (e) {
		return e instanceof ApiError && (e.status === 401 || e.status === 403) ? "unauthorized" : "offline";
	}
}

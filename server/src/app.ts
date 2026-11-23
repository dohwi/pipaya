import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { join, resolve } from "node:path";
import { QuestionManager } from "./questions.ts";
import type { Config } from "./config.ts";
import { Configuration } from "./configuration.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ModelRoles } from "./model-roles.ts";
import { Llm } from "./llm.ts";
import { registerLlmRoutes } from "./llm-routes.ts";
import { CompactionSettings } from "./compaction.ts";
import { registerCompactionRoutes } from "./compaction-routes.ts";
import { Retention } from "./retention.ts";
import { registerRetentionRoutes } from "./retention-routes.ts";
import { Scheduler } from "./scheduler.ts";
import { registerSchedulerRoutes } from "./scheduler-routes.ts";
import { GoalManager } from "./goals.ts";
import { registerGoalRoutes } from "./goals-routes.ts";
import { GROUP_NAME_SYSTEM, groupNameRequest, parseGroupName, SystemModelSettings } from "./system-model.ts";
import { registerSystemModelRoutes } from "./system-model-routes.ts";
import { FallbackModelSettings } from "./fallback-model.ts";
import { registerFallbackModelRoutes } from "./fallback-model-routes.ts";
import { TOGGLEABLE_TOOLS } from "./tools.ts";
import { IMAGE_TOOL, ImageModelSettings } from "./image-generation.ts";
import { registerImageModelRoutes } from "./image-model-routes.ts";
import { VoiceSettings, realtimeSocketOf, VOICE_REALTIME_CREDENTIAL_ID, type RealtimeSettingsValue } from "./voice-input.ts";
import { registerVoiceRoutes } from "./voice-routes.ts";
import { probeRealtime, registerRealtimeVoice, type RealtimeTarget } from "./voice-realtime.ts";
import { ExtensionSettings } from "./extension-settings.ts";
import { registerExtensionSettingsRoutes } from "./extension-settings-routes.ts";
import { ClientSettings } from "./client-settings.ts";
import { registerClientSettingsRoutes } from "./client-settings-routes.ts";
import { DeviceTokens } from "./device-tokens.ts";
import { Pairing } from "./pairing.ts";
import { registerPairingRoutes } from "./pairing-routes.ts";
import { registerFsRoutes } from "./fs-routes.ts";
import { registerFileRoutes } from "./file-routes.ts";
import { workDirOf } from "./work-tree.ts";
import { GroupManager, panesOf, peerGroupOps, type GroupRecord } from "./groups.ts";
import { registerGroupRoutes } from "./groups-routes.ts";
import { isTerminalId, TerminalManager } from "./terminals.ts";
import { registerTerminalRoutes } from "./terminal-routes.ts";
import { LocaleStore } from "./locales.ts";
import { registerLocaleRoutes } from "./locales-routes.ts";
import { openDb } from "./db.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { EventBus } from "./events.ts";
import { createModelRegistry, describeModels } from "./models.ts";
import { SessionManager } from "./sessions.ts";
import { McpManager } from "./mcp.ts";
import { registerMcpRoutes } from "./mcp-routes.ts";
import { GuardSettings } from "./guard.ts";
import { registerGuardRoutes } from "./guard-routes.ts";
import { registerTemplateRoutes } from "./templates-routes.ts";
import { SkillService } from "./skills.ts";
import { registerSkillRoutes } from "./skills-routes.ts";
import { AgentsWatcher } from "./agents-watch.ts";
import { SessionStore, SqliteCredentialStore, THINKING_LEVELS, type ThinkingLevel } from "./store.ts";
import { makeSerializerCompiler, validatorCompiler } from "./typebox-provider.ts";
import { registerWebSocket, type WebSocketOptions } from "./ws.ts";
import { NotificationService, type PushTransports } from "./notifications.ts";
import { UnreadTracker } from "./unread.ts";
import { registerNotificationRoutes } from "./notification-routes.ts";
import { createCorsPolicy, redactUrl } from "./security.ts";
import { registerCompression } from "./compression.ts";
import { StreamTickets } from "./stream-tickets.ts";
import { AuthThrottle } from "./auth-throttle.ts";
import { createPushTransports } from "./push.ts";
import { reachableUrls } from "./server-address.ts";
import { ExtensionHost } from "./extensions/host.ts";
import { registerExtensionHttpRoutes, registerServerExtensionRoutes } from "./extensions/routes.ts";
import { REPO_ROOT } from "./version.ts";
import { restartSoon, SelfUpdater, type SelfUpdateOptions } from "./self-update.ts";
import { IdleSockets } from "./idle-sockets.ts";
import { isStreamPath } from "./auth-policy.ts";
import { registerHttpHooks } from "./http-hooks.ts";
import { registerMetaRoutes } from "./routes/meta-routes.ts";
import { registerProviderRoutes } from "./routes/providers-routes.ts";
import { registerSessionRoutes } from "./routes/sessions-routes.ts";

/** How long persisted events are kept for a client that reconnects with a cursor. */
export const EVENT_RETENTION_MS = 3 * 24 * 3600_000;

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
// A message may carry images and files (up to 100 MB of files, as base64: x1.34) alongside each other.
export const IMAGE_BODY_LIMIT = 192 * 1024 * 1024;

export interface App {
	server: FastifyInstance;
	sessions: SessionManager;
	bus: EventBus;
	close(): Promise<void>;
}

export interface BuildOptions {
	/** Validate response contracts in tests; production uses plain JSON serialization. */
	strictResponses?: boolean;
	/** Home directory used to find global skills (tests); defaults to the OS user home. */
	home?: string;
	/** Directory of built-in skills (tests); defaults to the bundled `builtin-skills/`, `false` turns them off. */
	builtinSkills?: string | false;
	/** Inject FCM/APNs transports for deployments or tests. */
	pushTransports?: PushTransports;
	/** How long a live device has to show a notification before the phone is pushed instead (tests shorten it) */
	mobileDelayMs?: number;
	/** WebSocket heartbeat and slow-client limits (tests shorten them) */
	websocket?: WebSocketOptions;
	/** Tests: how the realtime voice relay opens its upstream socket. */
	realtimeConnect?: (url: string, key: string) => WebSocket;
	/** Directories scanned for server extensions (tests); defaults to `<dataDir>/extensions` and `~/.agents/extensions`. */
	extensionDirs?: string[];
	/** Extra extension files or folders to load. */
	extensionPaths?: string[];
	/** Shorten the deadline for one-off subagents in tests. */
	delegateTimeoutMs?: number;
	/** Shorten the deadline for active runs during `close()` in tests. */
	shutdownStopMs?: number;
	/** Self-update wiring (tests replace git, the installer and the restart); defaults to this checkout and a SIGTERM restart. */
	selfUpdate?: Partial<SelfUpdateOptions>;
}

/** The closing text of the latest assistant message: what a person wants to see in a notification. */
function lastAnswer(store: SessionStore, id: string): string | undefined {
	const row = store.latestAssistantText(id);
	return row || undefined;
}

/** How long a browser may reuse a CORS preflight answer (seconds; Chromium caps it at 7200). */
export const CORS_MAX_AGE_S = 7200;

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<App> {
	const startedAt = Date.now();
	const db = openDb(cfg.dbPath);
	const bus = new EventBus(db);
	const store = new SessionStore(db);
	const push = await createPushTransports(opts.pushTransports === undefined && cfg.pushEnabled === true);
	const clientSettings = new ClientSettings(db);
	let goalActive = (_id: string) => false;
	const notifications = new NotificationService(db, bus, opts.pushTransports ?? push.transports, Date.now, opts.mobileDelayMs, () => clientSettings.escalateMs(), {
		title: (id) => store.get(id)?.title ?? "",
		lastAnswer: (id) => lastAnswer(store, id),
		quietPeers: () => clientSettings.quietPeers(),
		isGoalActive: (id) => goalActive(id),
	});
	const unread = new UnreadTracker(db, bus, (id) => notifications.watching(id), () => clientSettings.quietPeers(), (id) => goalActive(id));
	notifications.onLook = (ids) => unread.read(ids);
	const credentials = new SqliteCredentialStore(db);
	const registry = createModelRegistry(credentials);
	const questions = new QuestionManager(bus);
	const skills = new SkillService(db, { home: opts.home, builtin: opts.builtinSkills, defaultWorkdir: () => configuration.defaultWorkdir() });
	const modelRoles = new ModelRoles(db, registry);
	const compactionSettings = new CompactionSettings(db, registry);
	const systemModel = new SystemModelSettings(db, registry);
	const fallbackModel = new FallbackModelSettings(db, registry);
	const imageModel = new ImageModelSettings(db, registry);
	const voice = new VoiceSettings(db);
	// Above the Configuration that asks them: a provider delete says what still uses it instead of a bare conflict.
	const configuration = new Configuration(db, cfg, registry, credentials, () => {
		// Role ids the client translates; a delete refuses while any of these still points here.
		const used: { role: string; provider: string; model: string }[] = [];
		for (const [role, m] of [
			["compaction", compactionSettings.get().model],
			["system", systemModel.get().model],
			["fallback", fallbackModel.get().model],
			["image", imageModel.get().model],
		] as const) if (m?.provider) used.push({ role, provider: m.provider, model: m.model });
		return used;
	});
	const extensionSettings = new ExtensionSettings(cfg.dataDir);
	const extensions = new ExtensionHost({
		db, bus, registry, dataDir: cfg.dataDir, settings: extensionSettings,
		dirs: opts.extensionDirs ?? ExtensionHost.defaultDirs(cfg.dataDir, opts.home),
		paths: opts.extensionPaths,
		home: opts.home,
		log: (m) => server.log.warn(m),
	});
	const mcp = new McpManager(db, () => bus.publish(null, "mcp_updated", {}));
	// Seed once from an older copy's saved settings when the built-in setting is not yet in SQLite.
	const guard = new GuardSettings(db, join(cfg.dataDir, "extensions", "guard", "settings.json"));
	const sessions = new SessionManager(cfg, store, bus, registry, () => configuration.defaultWorkdir(), skills, questions, compactionSettings, extensions, () => configuration.disabledTools(), systemModel, imageModel, mcp, opts.home, () => configuration.delegatePolicy(), () => configuration.disabledSubagents(), opts.delegateTimeoutMs, guard, opts.shutdownStopMs, fallbackModel);
	const busy = (id: string) => sessions.isRunning(id) || questions.list(id).length > 0;
	const info = (r: NonNullable<ReturnType<typeof store.get>>) => ({
		id: r.id, name: r.name, title: r.title, purpose: r.purpose, cwd: r.cwd, provider: r.provider, model: r.model, thinkingLevel: r.thinkingLevel,
		tools: r.tools, closed: r.closed, parentId: r.parentId, createdAt: r.createdAt, updatedAt: r.updatedAt, running: sessions.isRunning(r.id), busy: busy(r.id),
	});
	const groupInfo = (g: GroupRecord) => ({ id: g.id, name: g.name, sessionIds: panesOf(g.layout).filter((id) => !isTerminalId(id)), terminalIds: panesOf(g.layout).filter(isTerminalId), layout: g.layout, createdAt: g.createdAt, updatedAt: g.updatedAt });
	const thinking = (v: string | undefined) => {
		if (v !== undefined && !(THINKING_LEVELS as readonly string[]).includes(v)) throw badRequest(`unknown thinking level "${v}"`);
		return v as ThinkingLevel | undefined;
	};
	const llm = new Llm(registry, modelRoles);
	extensions.attach({
		cwd: (id) => { const r = store.get(id); return r ? workDirOf(r) : undefined; },
		defaultCwd: () => configuration.defaultWorkdir(),
		groups: {
			list: () => groups.list().map(groupInfo),
			get: (id) => { try { return groupInfo(groups.get(id)); } catch { return undefined; } },
			create: (o) => groupInfo(groups.create({ name: o.name, layout: o.layout })),
			update: (id, c) => groupInfo(groups.update(id, c)),
			delete: (id) => { try { groups.delete(id); return true; } catch { return false; } },
		},
		models: {
			list: async (o) => (await describeModels(registry, o?.provider, (p, id) => configuration.isUnavailable(p, id)))
				.map(({ provider, id, name, reasoning, thinkingLevels, contextWindow, maxTokens, vision, configured }) => ({ provider, id, name, reasoning, thinkingLevels, contextWindow, maxTokens, vision, configured })),
			complete: async ({ signal, ...input }) => {
				const r = await llm.complete(input, signal);
				return { text: r.text, provider: r.provider, model: r.model, usage: { input: r.usage.input, output: r.usage.output, totalTokens: r.usage.totalTokens, cost: r.usage.cost } };
			},
		},
		// `terminals` is made below; extensions only reach it once loaded, after construction.
		terminals: {
			list: () => terminals.list(),
			get: (id) => (terminals.has(id) ? terminals.get(id) : undefined),
			create: (o = {}) => terminals.create(o),
			rename: (id, title) => {
				if (typeof title !== "string" || !title.trim() || title.length > 100) throw badRequest("title must be 1-100 characters");
				return terminals.rename(id, title);
			},
			write: (id, data) => {
				if (!terminals.has(id)) throw notFound("terminal");
				if (typeof data !== "string" || data.length > 64 * 1024) throw badRequest("data must be a string of at most 64 KB");
				terminals.write(id, data);
			},
			resize: (id, cols, rows) => {
				if (!terminals.has(id)) throw notFound("terminal");
				if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) throw badRequest("cols 2-1000 and rows 1-500");
				terminals.resize(id, cols, rows);
			},
			close: (id) => {
				if (!terminals.has(id)) return false;
				terminals.kill(id);
				return true;
			},
		},
		notify: (source, n) => { notifications.send(source, { title: n.title.slice(0, 183), ...(n.body ? { body: n.body.slice(0, 300) } : {}), ...(n.kind ? { kind: n.kind } : {}), ...(n.sessionId ? { sessionId: n.sessionId } : {}), ...(n.key ? { key: n.key.slice(0, 160) } : {}) }); },
		sessions: {
			list: (o) => store.list({ limit: Math.min(o?.limit ?? 1000, 5000), before: o?.before, closed: o?.closed }).map(info),
			get: (id) => { const r = store.get(id); return r ? info(r) : undefined; },
			messages: (id, count = 10, o) => (o?.after !== undefined
				? store.messages(id, { after: o.after, limit: Math.min(200, Math.max(1, count)) })
				: store.lastMessages(id, Math.min(200, Math.max(1, count)))),
			send: async (id, text, mode) => {
				await sessions.send(id, { text, mode: mode ?? (sessions.isRunning(id) ? "follow_up" : "prompt") });
			},
			create: async (o = {}) => {
				const r = await sessions.create({ title: o.title, cwd: o.cwd, provider: o.provider, model: o.model, thinkingLevel: thinking(o.thinkingLevel), systemPrompt: o.systemPrompt, tools: o.tools }, o.parentId && store.get(o.parentId) ? o.parentId : null);
				return info(r);
			},
			update: (id, c) => info(sessions.update(id, { ...c, thinkingLevel: thinking(c.thinkingLevel) })),
			fork: async (id, o) => info(await sessions.fork(id, o?.atSeq, o?.title)),
			abort: (id) => sessions.abort(id),
			compact: async (id, instructions) => {
				const r = await sessions.compact(id, instructions);
				return { tokensBefore: r.tokensBefore, tokensAfter: r.context.tokens };
			},
			questions: (id) => questions.list(id).map((q) => ({ toolCallId: q.toolCallId, question: q.question, ...(q.options ? { options: q.options } : {}), requestedAt: q.requestedAt })),
			answer: (id, toolCallId, a) => questions.answer(id, toolCallId, Array.isArray(a) ? { answers: a } : { answer: a }) === "ok",
			delete: (id) => {
				if (!store.get(id) || busy(id)) return false;
				sessions.delete(id);
				return true;
			},
		},
		send: (id, text, mode) => sessions.send(id, { text, mode }),
		abort: (id) => sessions.abort(id),
		isRunning: (id) => sessions.isRunning(id),
		ask: async (id, toolCallId, req, signal) => {
			const items = req.items?.map((q) => ({ ...q, allowFreeText: q.allowFreeText ?? true }));
			const outcome = await questions.ask({ sessionId: id, toolCallId, question: req.question, options: req.options, ...(req.recommended ? { recommended: req.recommended } : {}), ...(req.scale ? { scale: true } : {}), ...(req.multiple ? { multiple: true } : {}), ...(req.descriptions ? { descriptions: req.descriptions } : {}), allowFreeText: req.allowFreeText ?? true, ...(items?.length ? { items } : {}) }, signal);
			if (outcome.status === "abort") throw new Error("Run aborted while waiting for the user");
			return outcome.answer;
		},
	});
	const terminals = new TerminalManager(bus, {
		enabled: cfg.terminals !== false,
		defaultWorkdir: () => configuration.defaultWorkdir(),
		confineTo: cfg.restrictWorkspace ? cfg.workspaceRoot : undefined,
	});
	// A group pane shows a session or a terminal; terminal ids carry their own prefix so the two never clash.
	// generate_image can be switched off like an extension tool, while an image model makes it exist at all.
	configuration.setSwitchableSource(() => [...TOGGLEABLE_TOOLS, ...extensions.switchableTools(), ...(imageModel.resolve() ? [IMAGE_TOOL] : [])]);
	const groups = new GroupManager(db, bus, (id) => (isTerminalId(id) ? terminals.has(id) : store.get(id) !== undefined), () => store.allNames());
	groups.evictWhere(isTerminalId);
	sessions.setGroupSource(() => groups.list().map((g) => ({ name: g.name, sessionIds: panesOf(g.layout).filter((id) => !isTerminalId(id)) })));
	sessions.setGroupOps(peerGroupOps(groups));
	const server = Fastify({
		logger: cfg.logLevel === "silent" ? false : {
			level: cfg.logLevel,
			// SSE/WebSocket clients pass ?ticket= (or ?token=, older ones); keep both out of request logs.
			serializers: {
				req: (req) => ({
					method: req.method,
					url: redactUrl(req.url),
					host: req.host,
					remoteAddress: req.ip,
					remotePort: req.socket?.remotePort,
				}),
			},
		},
		// Small by default; only a message with pasted images (below) may be large.
		bodyLimit: DEFAULT_BODY_LIMIT,
		// Close every socket on shutdown, open SSE streams and upgraded WebSockets included: under Bun an upgraded socket
		// still counts as an HTTP connection, and without this `close()` (restart, tests) waits on it forever.
		forceCloseConnections: true,
	});
	// Voice input uploads the browser's own recording as multipart; the runtime's FormData parser reads it (no plugin).
	// Bun ignores keepAliveTimeout: sockets left by sleeping or vanished devices are closed here instead.
	const idleSockets = new IdleSockets();
	idleSockets.attach(server.server);
	server.addContentTypeParser("multipart/form-data", { parseAs: "buffer" }, (_req, body, done) => done(null, body));
	server.setValidatorCompiler(validatorCompiler);
	server.setSerializerCompiler(makeSerializerCompiler(opts.strictResponses ?? false));
	const corsPolicy = createCorsPolicy(cfg.corsOrigins);
	if (corsPolicy.allowsAll) server.log.warn("PIPAYA_CORS_ORIGINS=* lets every web page call this server from a browser that holds a token; list exact origins instead");
	// Every request carries a bearer token, so a browser client asks first (OPTIONS) for each new URL: a whole extra round
	// trip on a slow link. `maxAge` lets it reuse the answer (Chromium caps it at 2h).
	await server.register(cors, { origin: (origin, cb) => cb(null, !origin || corsPolicy.allows(origin)), methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"], maxAge: CORS_MAX_AGE_S });
	registerCompression(server);

	const deviceTokens = new DeviceTokens(db, Date.now, cfg.deviceTokenIdleDays);
	const streamTickets = new StreamTickets();
	const authThrottle = new AuthThrottle();
	const auth = registerHttpHooks(server, {
		token: cfg.token,
		corsPolicy,
		idleSockets,
		deviceTokens,
		streamTickets,
		authThrottle,
		extensions,
	});
	const { deviceOf, publicAuthed } = auth;

	// `pi.api.request`: an extension calls the REST API in-process with the admin token, through the same hooks, schemas,
	// body limits and handlers as a client's request. Streams never end, so they are refused (extensions have `pi.subscribe`).
	extensions.attachServer({
		request: async ({ extension, method, url, body, signal }) => {
			const path = url.split("?")[0] ?? "";
			if (isStreamPath(path)) throw new Error(`${path} is a stream; use pi.subscribe for events`);
			server.log.info({ extension, method, url: redactUrl(url) }, "extension api request");
			const res = await server.inject({
				method, url, signal,
				headers: { authorization: `Bearer ${cfg.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
				...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
			});
			const type = res.headers["content-type"];
			return { status: res.statusCode, contentType: typeof type === "string" ? type : undefined, body: res.body };
		},
		info: () => {
			// Before `listen` (tests, startup) the configured port; after, the one actually bound (port 0 picks a free one).
			const bound = server.server.address();
			const port = bound && typeof bound === "object" ? bound.port : cfg.port;
			return { port, host: cfg.host, urls: reachableUrls(cfg.host, port) };
		},
	});

	// ── core routes (meta, providers, sessions, events) ──
	const updater = new SelfUpdater({
		root: REPO_ROOT,
		serverDir: join(REPO_ROOT, "server"),
		running: () => sessions.runningCount,
		restart: restartSoon,
		...opts.selfUpdate,
	});
	registerMetaRoutes(server, {
		startedAt,
		auth,
		deviceTokens,
		streamTickets,
		updater,
		sessions,
		bus,
		extensions,
		configuration,
		registry,
		corsPolicy,
	});
	registerProviderRoutes(server, { db, registry, credentials, configuration, bus });
	registerSessionRoutes(server, {
		sessions,
		store,
		unread,
		questions,
		credentials,
		configuration,
		compactionSettings,
		busy,
		imageBodyLimit: IMAGE_BODY_LIMIT,
	});
	await registerExtensionHttpRoutes(server, extensions, (raw) => ({ device: deviceOf.get(raw) ?? null, authenticated: publicAuthed.has(raw) }));
	registerServerExtensionRoutes(server, extensions, (id) => store.get(id) !== undefined, join(cfg.dataDir, "extensions"), (cwd) => resolve(configuration.defaultWorkdir(), cwd?.trim() || "."));
	registerNotificationRoutes(server, notifications, id => store.get(id) !== undefined);
	registerConfigurationRoutes(server, configuration, bus, opts.home);
	registerLlmRoutes(server, modelRoles, llm, bus);
	registerCompactionRoutes(server, compactionSettings, bus);
	const retention = new Retention(db, store, busy, (id) => sessions.delete(id), (m) => server.log.info(m));
	registerRetentionRoutes(server, retention, bus);
	const scheduler = new Scheduler(db, { session: (id) => store.get(id), isRunning: (id) => sessions.isRunning(id), send: (id, input) => sessions.send(id, input) }, {
		onChange: (c) => bus.publish(null, "schedules_updated", c, { ephemeral: true }),
		log: (m) => server.log.info(m),
	});
	bus.subscribe((e) => { if (e.type === "session_deleted") scheduler.onSessionDeleted((e.data as { id: string }).id); });
	registerSchedulerRoutes(server, scheduler);
	sessions.setScheduler(scheduler);
	const goals = new GoalManager(
		db,
		{
			session: (id) => store.get(id),
			isRunning: (id) => sessions.isRunning(id),
			tokens: (id) => {
				const u = store.usage(id);
				const billable = u.input + u.output;
				return billable > 0 ? billable : u.totalTokens;
			},
			send: (id, input) => sessions.send(id, input),
		},
		{
			onChange: (c) => bus.publish(null, "goals_updated", c, { ephemeral: true }),
			log: (m) => server.log.info(m),
		},
	);
	goalActive = (id) => goals.isActive(id);
	bus.subscribe((e) => { if (e.type === "session_deleted") goals.onSessionDeleted((e.data as { id: string }).id); });
	registerGoalRoutes(server, goals);
	sessions.setGoals(goals);
	registerSystemModelRoutes(server, systemModel, bus, () => sessions.describeAll());
	registerFallbackModelRoutes(server, fallbackModel, bus);
	registerImageModelRoutes(server, imageModel, bus);
	// Realtime voice input: its own address and key (Settings > Voice), so any OpenAI-compatible Realtime server works.
	const realtimeTarget = async (rt: RealtimeSettingsValue): Promise<RealtimeTarget | { error: string }> => {
		const url = realtimeSocketOf(rt);
		if (!url) return { error: "set the Realtime API address" };
		const credential = await credentials.read(VOICE_REALTIME_CREDENTIAL_ID);
		return { url, key: credential?.type === "api_key" ? credential.key ?? "" : "" };
	};
	registerVoiceRoutes(server, voice, credentials, bus, async (current) => {
		const target = await realtimeTarget(current.realtime);
		if ("error" in target) throw new HttpError(400, "not_configured", target.error);
		await probeRealtime(target, current.realtime, current.language, opts.realtimeConnect);
	});
	registerFsRoutes(server, () => configuration.defaultWorkdir(), cfg.restrictWorkspace ? cfg.workspaceRoot : undefined);
	registerFileRoutes(server, (id) => { const r = store.get(id); return r ? [...new Set([workDirOf(r), r.cwd])] : undefined; });
	// A group the client named by default gets a better name from the system model, unless someone renamed it meanwhile.
	registerGroupRoutes(server, groups, (rec) => {
		if (!systemModel.resolve()) return;
		const members = panesOf(rec.layout).flatMap((id) => {
			const r = store.get(id);
			return r ? [{ cwd: r.cwd, title: r.title, purpose: r.purpose }] : [];
		});
		if (!members.length) return;
		void (async () => {
			const name = parseGroupName((await systemModel.complete(GROUP_NAME_SYSTEM, groupNameRequest(members), 60)) ?? "");
			if (!name || name === rec.name) return;
			try {
				if (groups.get(rec.id).name === rec.name) groups.update(rec.id, { name });
			} catch {
				/* the group is gone */
			}
		})();
	});
	registerSkillRoutes(server, skills, bus);
	registerTemplateRoutes(server, () => configuration.defaultWorkdir(), bus, opts.home);
	registerGuardRoutes(server, guard, bus);
	registerMcpRoutes(server, mcp);
	registerExtensionSettingsRoutes(server, extensionSettings, bus);
	registerClientSettingsRoutes(server, clientSettings, bus);
	registerPairingRoutes(server, new Pairing((label) => deviceTokens.issue(label).token), deviceTokens, (id) => streamTickets.revokeDevice(id));
	registerLocaleRoutes(server, new LocaleStore(cfg.dataDir), bus);
	await registerWebSocket(server, { bus, sessions, questions }, opts.websocket);
	registerTerminalRoutes(server, terminals);
	// Realtime voice input borrows a chat connection's address and key (the Realtime API lives next to its chat API).
	registerRealtimeVoice(server, voice, realtimeTarget, opts.realtimeConnect);

	await extensions.load();
	mcp.start();
	// Skills, AGENTS.md and whatever extensions read from those folders live in plain files: tell open clients when they change on disk.
	const agentsWatch = new AgentsWatcher(bus, { home: opts.home, workdirs: () => [configuration.defaultWorkdir(), ...store.workdirs().filter((w) => w.active > 0).map((w) => w.cwd)] });
	agentsWatch.start();
	// The events table holds a copy of every message (the messages table is the record), so it is the bulk of the database. Clients
	// resume from the latest id, not from old ones: keep a few days for reconnects. Also at startup: a server restarted more often
	// than the 6 hour timer would otherwise never prune.
	const pruneEvents = () => { try { bus.prune(EVENT_RETENTION_MS); } catch (e) { server.log.warn({ err: e }, "pruning old events failed"); } };
	pruneEvents();
	const prune = setInterval(pruneEvents, 6 * 3600_000);
	prune.unref?.();
	// Finalize any runs left active by a previous crash / SIGKILL / sudden reboot before scheduled tasks or clients act on them.
	sessions.recoverInterruptedRuns();
	idleSockets.start();
	retention.start();
	scheduler.start();
	// Read every connection's model list once at startup, in the background, so a fresh start already shows what the upstreams offer.
	void configuration.refreshStale();
	// Same for OpenRouter's own catalog: refreshed when it is stale, so the model picker opens on a current list.
	void configuration.refreshCatalog();
	return { server, sessions, bus, async close() {
		clearInterval(prune);
		idleSockets.stop();
		retention.stop();
		scheduler.stop();
		goals.stop();
		configuration.close();
		agentsWatch.stop();
		terminals.shutdown();
		sessions.shutdown();
		await sessions.idle();
		await mcp.close();
		unread.dispose();
		await notifications.close();
		await push.close();
		await extensions.shutdown();
		await server.close();
		db.close();
	} };
}

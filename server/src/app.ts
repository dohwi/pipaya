import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import Type from "typebox";
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
import { GROUP_NAME_SYSTEM, groupNameRequest, parseGroupName, SystemModelSettings } from "./system-model.ts";
import { registerSystemModelRoutes } from "./system-model-routes.ts";
import { TOGGLEABLE_TOOLS } from "./tools.ts";
import { IMAGE_TOOL, ImageModelSettings } from "./image-generation.ts";
import { registerImageModelRoutes } from "./image-model-routes.ts";
import { ExtensionSettings } from "./extension-settings.ts";
import { registerExtensionSettingsRoutes } from "./extension-settings-routes.ts";
import { ClientSettings } from "./client-settings.ts";
import { registerClientSettingsRoutes } from "./client-settings-routes.ts";
import { DeviceTokens } from "./device-tokens.ts";
import { Pairing } from "./pairing.ts";
import { isAdminOnlyPath, PUBLIC_PAIRING_PATH, registerPairingRoutes } from "./pairing-routes.ts";
import { registerFsRoutes } from "./fs-routes.ts";
import { registerFileRoutes } from "./file-routes.ts";
import { GroupManager, panesOf, type GroupRecord } from "./groups.ts";
import { registerGroupRoutes } from "./groups-routes.ts";
import { isTerminalId, TerminalManager } from "./terminals.ts";
import { registerTerminalRoutes, TERMINAL_SOCKET } from "./terminal-routes.ts";
import { LocaleStore } from "./locales.ts";
import { registerLocaleRoutes } from "./locales-routes.ts";
import { openDb } from "./db.ts";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { EventBus } from "./events.ts";
import { builtinProvider, createModelRegistry, describeModels } from "./models.ts";
import { AccountEmails } from "./account-email.ts";
import { deviceId, ProviderLogins } from "./provider-login.ts";
import * as S from "./schemas.ts";
import { SessionManager } from "./sessions.ts";
import { SkillService } from "./skills.ts";
import { registerSkillRoutes } from "./skills-routes.ts";
import { AgentsWatcher } from "./agents-watch.ts";
import { streamEvents } from "./sse.ts";
import { SessionStore, SqliteCredentialStore, THINKING_LEVELS, type ThinkingLevel } from "./store.ts";
import { makeSerializerCompiler, validatorCompiler, type TypeBoxProvider } from "./typebox-provider.ts";
import { registerWebSocket, type WebSocketOptions } from "./ws.ts";
import { NotificationService, type PushTransports } from "./notifications.ts";
import { UnreadTracker } from "./unread.ts";
import { registerNotificationRoutes } from "./notification-routes.ts";
import { createCorsPolicy, redactUrl } from "./security.ts";
import { createPushTransports } from "./push.ts";
import { ExtensionHost } from "./extensions/host.ts";
import { registerServerExtensionRoutes } from "./extensions/routes.ts";
import { MIN_CLIENT_PROTOCOL, PROTOCOL_HEADER, PROTOCOL_QUERY, PROTOCOL_VERSION, REPO_ROOT, SERVER_VERSION } from "./version.ts";
import { restartSoon, SelfUpdater, type SelfUpdateOptions } from "./self-update.ts";
import { join, resolve } from "node:path";

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
	/** Directories scanned for server extensions (tests); defaults to `<dataDir>/extensions` and `~/.agents/extensions`. */
	extensionDirs?: string[];
	/** Extra extension files or folders to load. */
	extensionPaths?: string[];
	/** Self-update wiring (tests replace git, the installer and the restart); defaults to this checkout and a SIGTERM restart. */
	selfUpdate?: Partial<SelfUpdateOptions>;
}

/** API-only server. No frontend assets, bundling or client-directory dependency. */
/** The closing text of the latest assistant message: what a person wants to see in a notification. */
function lastAnswer(store: SessionStore, id: string): string | undefined {
	const row = store.latestAssistantText(id);
	return row || undefined;
}

export async function buildApp(cfg: Config, opts: BuildOptions = {}): Promise<App> {
	const startedAt = Date.now();
	const db = openDb(cfg.dbPath);
	const bus = new EventBus(db);
	const store = new SessionStore(db);
	const push = createPushTransports(opts.pushTransports === undefined && cfg.pushEnabled === true);
	const clientSettings = new ClientSettings(db);
	const notifications = new NotificationService(db, bus, opts.pushTransports ?? push.transports, Date.now, opts.mobileDelayMs, () => clientSettings.escalateMs(), {
		title: (id) => store.get(id)?.title ?? "",
		lastAnswer: (id) => lastAnswer(store, id),
	});
	const unread = new UnreadTracker(db, bus, (id) => notifications.watching(id));
	notifications.onLook = (ids) => unread.read(ids);
	const credentials = new SqliteCredentialStore(db);
	const registry = createModelRegistry(credentials);
	const configuration = new Configuration(db, cfg, registry, credentials);
	const questions = new QuestionManager(bus);
	const skills = new SkillService(db, { home: opts.home, builtin: opts.builtinSkills, defaultWorkdir: () => configuration.defaultWorkdir() });
	const modelRoles = new ModelRoles(db, registry);
	const compactionSettings = new CompactionSettings(db, registry);
	const systemModel = new SystemModelSettings(db, registry);
	const imageModel = new ImageModelSettings(db, registry);
	const extensionSettings = new ExtensionSettings(cfg.dataDir);
	const extensions = new ExtensionHost({
		db, bus, registry, dataDir: cfg.dataDir, settings: extensionSettings,
		dirs: opts.extensionDirs ?? ExtensionHost.defaultDirs(cfg.dataDir, opts.home),
		paths: opts.extensionPaths,
		home: opts.home,
		log: (m) => server.log.warn(m),
	});
	const sessions = new SessionManager(cfg, store, bus, registry, () => configuration.defaultWorkdir(), skills, questions, compactionSettings, extensions, () => configuration.disabledTools(), systemModel, imageModel);
	const busy = (id: string) => sessions.isRunning(id) || questions.list(id).length > 0;
	const info = (r: NonNullable<ReturnType<typeof store.get>>) => ({
		id: r.id, name: r.name, title: r.title, purpose: r.purpose, cwd: r.cwd, provider: r.provider, model: r.model, thinkingLevel: r.thinkingLevel,
		tools: r.tools, closed: r.closed, archived: r.archived, parentId: r.parentId, createdAt: r.createdAt, updatedAt: r.updatedAt, running: sessions.isRunning(r.id), busy: busy(r.id),
	});
	const groupInfo = (g: GroupRecord) => ({ id: g.id, name: g.name, sessionIds: panesOf(g.layout).filter((id) => !isTerminalId(id)), terminalIds: panesOf(g.layout).filter(isTerminalId), layout: g.layout, createdAt: g.createdAt, updatedAt: g.updatedAt });
	const thinking = (v: string | undefined) => {
		if (v !== undefined && !(THINKING_LEVELS as readonly string[]).includes(v)) throw badRequest(`unknown thinking level "${v}"`);
		return v as ThinkingLevel | undefined;
	};
	const llm = new Llm(registry, modelRoles);
	extensions.attach({
		cwd: (id) => store.get(id)?.cwd,
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
			const outcome = await questions.ask({ sessionId: id, toolCallId, question: req.question, options: req.options, ...(req.recommended ? { recommended: req.recommended } : {}), allowFreeText: req.allowFreeText ?? true, ...(items?.length ? { items } : {}) }, signal);
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
	const groups = new GroupManager(db, bus, (id) => (isTerminalId(id) ? terminals.has(id) : store.get(id) !== undefined), () => store.activeNames());
	groups.evictWhere(isTerminalId);
	sessions.setGroupSource(() => groups.list().map((g) => ({ name: g.name, sessionIds: panesOf(g.layout).filter((id) => !isTerminalId(id)) })));
	const server = Fastify({
		logger: cfg.logLevel === "silent" ? false : {
			level: cfg.logLevel,
			// SSE/WebSocket clients pass ?token=; keep it out of request logs.
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
	server.setValidatorCompiler(validatorCompiler);
	server.setSerializerCompiler(makeSerializerCompiler(opts.strictResponses ?? false));
	const corsPolicy = createCorsPolicy(cfg.corsOrigins);
	await server.register(cors, { origin: (origin, cb) => cb(null, !origin || corsPolicy.allows(origin)), methods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"] });

	const deviceTokens = new DeviceTokens(db);
	const expected = Buffer.from(cfg.token);
	const tokenMatches = (given: string | undefined) => {
		if (!given) return false;
		const token = Buffer.from(given);
		return token.length === expected.length && timingSafeEqual(token, expected);
	};
	const bearerOf = (header: string | undefined) => (header?.startsWith("Bearer ") ? header.slice(7) : undefined);
	server.addHook("onRequest", async (req) => {
		if (req.method === "OPTIONS") return;
		const path = req.url.split("?")[0];
		if (req.method === "GET" && path === "/health") return;
		// A client that declares a protocol older than the oldest this server serves is told so before anything else, so it can
		// ask its user to update instead of failing on a changed response. A client that declares nothing is not judged.
		const raw = req.headers[PROTOCOL_HEADER] ?? (req.query as Record<string, unknown> | undefined)?.[PROTOCOL_QUERY];
		const declared = typeof raw === "string" && /^\d{1,6}$/.test(raw) ? Number(raw) : null;
		if (declared !== null && declared < MIN_CLIENT_PROTOCOL) {
			throw new HttpError(426, "client_too_old", `this server needs a client with protocol ${MIN_CLIENT_PROTOCOL} or newer (yours is ${declared}); update the app`);
		}
		if (req.method === "POST" && path === PUBLIC_PAIRING_PATH) return; // the one-time code is the credential
		const bearer = bearerOf(req.headers.authorization);
		// Browser EventSource/WebSocket cannot set headers. REST requires a Bearer header.
		const browserStream = req.method === "GET" && (path === "/ws" || path === "/events" || TERMINAL_SOCKET.test(path ?? "") || /^\/sessions\/[^/]+\/events$/.test(path ?? ""));
		const query = (req.query as { token?: string } | undefined)?.token;
		const given = bearer ?? (browserStream ? query : undefined);
		if (tokenMatches(given)) return; // the admin token
		const device = deviceTokens.verify(given);
		if (!device) throw new HttpError(401, "unauthorized", "missing or invalid token");
		if (isAdminOnlyPath(req.method, path ?? "")) throw new HttpError(403, "admin_only", "this needs the server's admin token, not a paired device's");
		deviceTokens.track(device, req.raw.socket);
	});

	server.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
		if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message } });
		const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
		if (status >= 500) req.log.error(err);
		return reply.status(status).send({
			error: { code: status === 500 ? "internal_error" : (err.code ?? "error"), message: status === 500 ? "internal server error" : err.message },
		});
	});
	server.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "route not found" } }));
	const app = server.withTypeProvider<TypeBoxProvider>();

	// ── meta ──
	app.get("/health", {
		schema: { response: { 200: S.Health } },
		handler: async (req) =>
			tokenMatches(bearerOf(req.headers.authorization)) || deviceTokens.verify(bearerOf(req.headers.authorization))
				? { ok: true, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL, uptimeMs: Date.now() - startedAt, runningSessions: sessions.runningCount, subscribers: bus.subscriberCount }
				: { ok: true, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL },
	});

	// ── self-update: the client offers "update the server too" when it updates itself ──
	const updater = new SelfUpdater({
		root: REPO_ROOT,
		serverDir: join(REPO_ROOT, "server"),
		running: () => sessions.runningCount,
		restart: restartSoon,
		...opts.selfUpdate,
	});
	app.get("/server/update", {
		schema: { response: { 200: S.UpdateStatus, ...S.errors(401, 403) } },
		handler: async () => updater.status(),
	});
	app.post("/server/update", {
		schema: { body: S.UpdateBody, response: { 200: S.UpdateResult, ...S.errors(400, 401, 403, 409, 502) } },
		handler: async (req) => {
			const done = await updater.apply(req.body?.force === true);
			return { ok: true, ...done, restarting: true };
		},
	});
	app.get("/tools", {
		schema: { response: { 200: S.ToolList, ...S.errors(401) } },
		handler: async () => ({
			tools: Object.values(sessions.toolDefs()).map((t) => ({ name: t.name, description: t.description })),
			defaults: extensions.defaultTools(),
		}),
	});
	app.get("/models", {
		schema: { querystring: S.ModelsQuery, response: { 200: S.ModelList, ...S.errors(400, 401) } },
		handler: async (req) => {
			configuration.refreshStale();
			const all = await describeModels(registry, req.query.provider, (p, id) => configuration.isUnavailable(p, id), configuration.icons());
			return { models: req.query.configured ? all.filter((m) => m.configured) : all };
		},
	});
	app.get("/providers", {
		schema: { response: { 200: S.ProviderList, ...S.errors(401) } },
		handler: async () => {
			const stored = new Map((await credentials.list()).map((c) => [c.providerId, c.type]));
			const custom = new Set(configuration.list().map((c) => c.id));
			return { providers: await Promise.all(registry.models.getProviders().map(async (p) => ({
				id: p.id, name: p.name ?? p.id,
				configured: Boolean(await registry.models.checkAuth(p.id).catch(() => undefined)), storedCredential: stored.get(p.id) ?? null,
				...(stored.get(p.id) === "oauth" ? await accountEmails.backfill(p.id, () => credentials.read(p.id)).then((email) => (email ? { accountEmail: email } : {})) : {}),
				loginMethods: [...(p.auth.apiKey?.login ? ["api_key" as const] : []), ...(p.auth.oauth ? ["oauth" as const] : [])],
				...(p.auth.oauth ? { oauthLabel: p.auth.oauth.loginLabel ?? p.auth.oauth.name } : {}),
				builtin: !custom.has(p.id) && builtinProvider(p.id) !== undefined,
			}))) };
		},
	});
	const accountEmails = new AccountEmails(db);
	const logins = new ProviderLogins(registry.models, async (id) => {
		const credential = await credentials.read(id).catch(() => undefined);
		if (credential) await accountEmails.refresh(id, credential);
		bus.publish(null, "provider_updated", { id, configured: Boolean(await registry.models.checkAuth(id).catch(() => undefined)) });
	}, { agentName: "Pipaya", deviceId: () => deviceId(db) });
	app.post("/providers/:id/login", {
		schema: { params: S.IdParams, body: S.LoginStartBody, response: { 200: S.LoginState, ...S.errors(400, 401, 404) } },
		handler: async (req) => logins.start(req.params.id, req.body.type),
	});
	app.get("/logins/:id", {
		schema: { params: S.IdParams, response: { 200: S.LoginState, ...S.errors(401, 404) } },
		handler: async (req) => logins.get(req.params.id),
	});
	app.post("/logins/:id/answer", {
		schema: { params: S.IdParams, body: S.LoginAnswerBody, response: { 200: S.LoginState, ...S.errors(401, 404, 409) } },
		handler: async (req) => logins.answer(req.params.id, req.body.promptId, req.body.value),
	});
	app.post("/logins/:id/cancel", {
		schema: { params: S.IdParams, response: { 200: S.LoginState, ...S.errors(401, 404) } },
		handler: async (req) => logins.cancel(req.params.id),
	});
	app.put("/providers/:id/credential", {
		schema: { params: S.IdParams, body: S.CredentialBody, response: { 200: S.Ok, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			const { id } = req.params;
			if (!registry.models.getProvider(id)) throw notFound("provider");
			await credentials.modify(id, async () => ({ type: "api_key", key: req.body.key }));
			accountEmails.clear(id);
			bus.publish(null, "provider_updated", { id, configured: true });
			return { ok: true };
		},
	});
	app.delete("/providers/:id/credential", {
		schema: { params: S.IdParams, response: { 200: S.Ok, ...S.errors(401) } },
		handler: async (req) => {
			const { id } = req.params;
			await credentials.delete(id);
			accountEmails.clear(id);
			bus.publish(null, "provider_updated", { id, configured: Boolean(await registry.models.checkAuth(id)) });
			return { ok: true };
		},
	});

	// ── sessions ──
	app.get("/workspace", {
		schema: { response: { 200: S.WorkspaceInfo, ...S.errors(401) } },
		handler: async () => {
			const root = configuration.defaultWorkdir();
			const label = (cwd: string) => {
				const r = relative(root, cwd);
				return r === "" ? "." : r === ".." || r.startsWith("../") || r.startsWith("..\\") || isAbsolute(r) ? cwd : r.replaceAll("\\", "/");
			};
			return { root, home: homedir(), workdirs: store.workdirs().map((w) => ({ ...w, path: label(w.cwd) })) };
		},
	});
	app.get("/activity", {
		schema: { response: { 200: S.ActivityInfo, ...S.errors(401) } },
		handler: async () => ({ sessions: sessions.activity(), unread: unread.list() }),
	});
	app.post("/sessions/:id/read", {
		schema: { params: S.IdParams, response: { 200: Type.Object({ ok: Type.Boolean() }), ...S.errors(401) } },
		handler: async (req) => { unread.read([req.params.id]); return { ok: true }; },
	});
	app.post("/sessions/localize-names", {
		schema: { body: S.LocalizeNamesBody, response: { 200: Type.Object({ renamed: Type.Integer() }), ...S.errors(400, 401) } },
		handler: async (req) => ({ renamed: sessions.peers.localize(req.body.lang) }),
	});
	app.post("/sessions", {
		schema: { body: S.CreateSessionBody, response: { 201: S.Session, ...S.errors(400, 401) } },
		handler: async (req, reply) => reply.status(201).send(await sessions.create(req.body)),
	});
	app.get("/sessions", {
		schema: { querystring: S.ListSessionsQuery, response: { 200: S.SessionList, ...S.errors(400, 401) } },
		handler: async (req) => {
			const limit = req.query.limit ?? 50;
			const list = store.list({ limit, before: req.query.before, closed: req.query.closed });
			return { sessions: list, nextBefore: list.length === limit ? list[list.length - 1]!.updatedAt : null };
		},
	});
	app.post("/sessions/delete", {
		schema: { body: S.DeleteSessionsBody, response: { 200: S.DeleteSessionsResult, ...S.errors(400, 401) } },
		handler: async (req) => {
			const deleted: string[] = [], skipped: string[] = [];
			for (const id of new Set(req.body.ids)) {
				if (!store.get(id) || busy(id)) skipped.push(id);
				else { sessions.delete(id); deleted.push(id); }
			}
			return { deleted, skipped };
		},
	});
	app.get("/sessions/:id", {
		schema: { params: S.IdParams, response: { 200: S.SessionDetail, ...S.errors(401, 404) } },
		handler: async (req) => ({
			...sessions.get(req.params.id), status: sessions.status(req.params.id), usage: store.usage(req.params.id),
			context: sessions.contextUsage(req.params.id) ?? undefined,
			compaction: { supported: true, autoEnabled: compactionSettings.get().auto },
		}),
	});
	app.post("/sessions/:id/compact", {
		schema: { params: S.IdParams, body: S.CompactBody, response: { 200: S.CompactResult, ...S.errors(400, 401, 404, 409, 501, 502) } },
		handler: async (req) => {
			const r = await sessions.compact(req.params.id, req.body?.customInstructions);
			return { tokensBefore: r.tokensBefore, context: r.context, model: r.model };
		},
	});
	app.get("/sessions/:id/context", {
		schema: { params: S.IdParams, response: { 200: S.SessionContext, ...S.errors(401, 404) } },
		handler: async (req) => {
			// The Claude Code identity line is only added for a subscription (OAuth) sign-in, not an API key.
			const provider = sessions.get(req.params.id).provider;
			const credential = await credentials.read(provider).catch(() => undefined);
			return sessions.context(req.params.id, { anthropicOAuth: credential?.type === "oauth" });
		},
	});
	app.get("/context", {
		schema: { querystring: Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096 })) }), response: { 200: S.SessionContext, ...S.errors(400, 401) } },
		handler: async (req) => sessions.previewContext(req.query.cwd),
	});
	app.patch("/sessions/:id", {
		schema: { params: S.IdParams, body: S.PatchSessionBody, response: { 200: S.Session, ...S.errors(400, 401, 404, 409) } },
		handler: async (req) => sessions.update(req.params.id, req.body),
	});
	app.delete("/sessions/:id", {
		schema: { params: S.IdParams, response: { 204: Type.Null(), ...S.errors(401, 404) } },
		handler: async (req, reply) => { sessions.delete(req.params.id); return reply.status(204).send(); },
	});
	app.get("/sessions/:id/status", {
		schema: { params: S.IdParams, response: { 200: S.SessionStatus, ...S.errors(401, 404) } },
		handler: async (req) => sessions.status(req.params.id),
	});
	app.get("/sessions/:id/usage", {
		schema: { params: S.IdParams, response: { 200: S.Usage, ...S.errors(401, 404) } },
		handler: async (req) => { sessions.get(req.params.id); return store.usage(req.params.id); },
	});
	app.post("/sessions/:id/abort", {
		schema: { params: S.IdParams, response: { 200: Type.Object({ aborted: Type.Boolean() }), ...S.errors(401, 404) } },
		handler: async (req) => ({ aborted: sessions.abort(req.params.id) }),
	});
	app.post("/sessions/:id/queue/cancel", {
		schema: { params: S.IdParams, body: S.CancelQueuedBody, response: { 200: Type.Object({ cancelled: Type.Boolean() }), ...S.errors(400, 401, 404) } },
		handler: async (req) => ({ cancelled: sessions.cancelQueued(req.params.id, req.body.mode, req.body.text) }),
	});
	app.post("/sessions/:id/retry", {
		schema: { params: S.IdParams, response: { 202: Type.Object({ accepted: Type.Literal("retry") }), ...S.errors(401, 404, 409) } },
		handler: async (req, reply) => { sessions.retry(req.params.id); return reply.status(202).send({ accepted: "retry" }); },
	});
	app.post("/sessions/:id/fork", {
		schema: { params: S.IdParams, body: S.ForkBody, response: { 201: S.Session, ...S.errors(400, 401, 404) } },
		handler: async (req, reply) => reply.status(201).send(await sessions.fork(req.params.id, req.body.atSeq, req.body.title)),
	});

	// ── messages & questions ──
	app.post("/sessions/:id/messages", {
		bodyLimit: IMAGE_BODY_LIMIT, // a route option, not part of `schema`
		schema: { params: S.IdParams, body: S.SendBody, response: { 202: S.SendResult, ...S.errors(400, 401, 404, 409, 413) } },
		handler: async (req, reply) => reply.status(202).send(await sessions.send(req.params.id, req.body)),
	});
	app.get("/sessions/:id/messages", {
		schema: { params: S.IdParams, querystring: S.MessagesQuery, response: { 200: S.MessageList, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			sessions.get(req.params.id);
			return { messages: store.messages(req.params.id, { after: req.query.after, limit: req.query.limit ?? 1000 }) };
		},
	});
	app.get("/questions", {
		schema: { querystring: S.QuestionsQuery, response: { 200: S.QuestionList, ...S.errors(400, 401) } },
		handler: async (req) => ({ questions: questions.list(req.query.sessionId) }),
	});
	app.post("/sessions/:id/questions/:toolCallId", {
		schema: { params: S.DecisionParams, body: S.QuestionAnswerBody, response: { 200: S.Ok, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			const { id, toolCallId } = req.params;
			sessions.get(id);
			const r = questions.answer(id, toolCallId, req.body);
			if (r === "not_found") throw notFound("pending question");
			if (r === "invalid") throw badRequest("the answer is empty or not one of the options");
			return { ok: true };
		},
	});

	// ── events ──
	const parseTypes = (raw?: string) => raw ? new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)) : undefined;
	app.get("/events", {
		schema: { querystring: S.StreamQuery, response: S.errors(400, 401) },
		handler: async (req, reply) => streamEvents(req, reply, bus, { types: parseTypes(req.query.types), corsPolicy }),
	});
	app.get("/sessions/:id/events", {
		schema: { params: S.IdParams, querystring: S.StreamQuery, response: S.errors(400, 401, 404) },
		handler: async (req, reply) => {
			sessions.get(req.params.id);
			streamEvents(req, reply, bus, { sessionId: req.params.id, types: parseTypes(req.query.types), corsPolicy });
		},
	});
	app.get("/events/history", {
		schema: { querystring: S.HistoryQuery, response: { 200: S.HistoryResult, ...S.errors(400, 401) } },
		handler: async (req) => ({ events: bus.history({ sessionId: req.query.sessionId, after: req.query.after ?? 0, limit: req.query.limit ?? 200 }), latestId: bus.latestId() }),
	});
	app.get("/events/types", {
		schema: { response: { 200: S.EventTypeList, ...S.errors(401) } },
		handler: async () => ({ events: S.EVENTS.map((e) => ({ type: e.type, persisted: e.persisted, description: e.description, data: e.data })) }),
	});
	registerServerExtensionRoutes(server, extensions, (id) => store.get(id) !== undefined, join(cfg.dataDir, "extensions"), (cwd) => resolve(configuration.defaultWorkdir(), cwd?.trim() || "."));
	registerNotificationRoutes(server, notifications, id => store.get(id) !== undefined);
	registerConfigurationRoutes(server, configuration, bus);
	registerLlmRoutes(server, modelRoles, llm, bus);
	registerCompactionRoutes(server, compactionSettings, bus);
	const retention = new Retention(db, store, busy, (id) => sessions.delete(id), (m) => server.log.info(m));
	registerRetentionRoutes(server, retention, bus);
	registerSystemModelRoutes(server, systemModel, bus, () => sessions.describeAll());
	registerImageModelRoutes(server, imageModel, bus);
	registerFsRoutes(server, () => configuration.defaultWorkdir(), cfg.restrictWorkspace ? cfg.workspaceRoot : undefined);
	registerFileRoutes(server, (id) => store.get(id)?.cwd);
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
	registerExtensionSettingsRoutes(server, extensionSettings, bus);
	registerClientSettingsRoutes(server, clientSettings, bus);
	registerPairingRoutes(server, new Pairing((label) => deviceTokens.issue(label).token), deviceTokens);
	registerLocaleRoutes(server, new LocaleStore(cfg.dataDir), bus);
	await registerWebSocket(server, { bus, sessions, questions }, opts.websocket);
	registerTerminalRoutes(server, terminals);

	await extensions.load();
	// Skills, AGENTS.md and whatever extensions read from those folders live in plain files: tell open clients when they change on disk.
	const agentsWatch = new AgentsWatcher(bus, { home: opts.home, workdirs: () => [configuration.defaultWorkdir(), ...store.workdirs().filter((w) => w.active > 0).map((w) => w.cwd)] });
	agentsWatch.start();
	const prune = setInterval(() => bus.prune(7 * 24 * 3600_000), 6 * 3600_000);
	prune.unref?.();
	retention.start();
	// Read every connection's model list once at startup, in the background, so a fresh start already shows what the upstreams offer.
	void configuration.refreshStale();
	return { server, sessions, bus, async close() {
		clearInterval(prune);
		retention.stop();
		configuration.close();
		agentsWatch.stop();
		unread.dispose();
		await notifications.close();
		await push.close();
		terminals.shutdown();
		sessions.shutdown();
		await sessions.idle();
		await extensions.shutdown();
		await server.close();
		db.close();
	} };
}

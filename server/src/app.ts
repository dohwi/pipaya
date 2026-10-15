import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import Type from "typebox";
import { ApprovalManager } from "./approvals.ts";
import { QuestionManager } from "./questions.ts";
import { Retention, RetentionInfo, RetentionPolicy } from "./retention.ts";
import type { Config } from "./config.ts";
import { Configuration } from "./configuration.ts";
import { registerConfigurationRoutes } from "./configuration-routes.ts";
import { ModelRoles } from "./model-roles.ts";
import { Llm } from "./llm.ts";
import { registerLlmRoutes } from "./llm-routes.ts";
import { SubAgents } from "./subagent.ts";
import { SubAgentSettings } from "./subagent-settings.ts";
import { CompactionSettings } from "./compaction.ts";
import { registerSubAgentRoutes } from "./subagent-routes.ts";
import { registerCompactionRoutes } from "./compaction-routes.ts";
import { ExtensionSettings } from "./extension-settings.ts";
import { registerExtensionSettingsRoutes } from "./extension-settings-routes.ts";
import { ClientSettings } from "./client-settings.ts";
import { registerClientSettingsRoutes } from "./client-settings-routes.ts";
import { DeviceTokens } from "./device-tokens.ts";
import { Pairing } from "./pairing.ts";
import { isAdminOnlyPath, PUBLIC_PAIRING_PATH, registerPairingRoutes } from "./pairing-routes.ts";
import { registerFsRoutes } from "./fs-routes.ts";
import { registerFileRoutes } from "./file-routes.ts";
import { GroupManager } from "./groups.ts";
import { registerGroupRoutes } from "./groups-routes.ts";
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
import { TemplateService } from "./templates.ts";
import { registerTemplateRoutes } from "./templates-routes.ts";
import { streamEvents } from "./sse.ts";
import { SessionStore, SqliteCredentialStore } from "./store.ts";
import { makeSerializerCompiler, validatorCompiler, type TypeBoxProvider } from "./typebox-provider.ts";
import { registerWebSocket, type WebSocketOptions } from "./ws.ts";
import { NotificationService, type PushTransports } from "./notifications.ts";
import { registerNotificationRoutes } from "./notification-routes.ts";
import { createCorsPolicy, redactUrl } from "./security.ts";
import { createPushTransports } from "./push.ts";
import { ExtensionHost } from "./extensions/host.ts";
import { registerServerExtensionRoutes } from "./extensions/routes.ts";

const DEFAULT_BODY_LIMIT = 2 * 1024 * 1024;
// A message may carry images and files (up to 25 MB of files, as base64: x1.34) alongside each other.
export const IMAGE_BODY_LIMIT = 64 * 1024 * 1024;

export interface App {
	server: FastifyInstance;
	sessions: SessionManager;
	bus: EventBus;
	retention: Retention;
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
	const credentials = new SqliteCredentialStore(db);
	const registry = createModelRegistry(credentials);
	const configuration = new Configuration(db, cfg, registry, credentials);
	const approvals = new ApprovalManager(bus, cfg.approvalTimeoutMs);
	const questions = new QuestionManager(bus);
	const skills = new SkillService(db, { home: opts.home, builtin: opts.builtinSkills, defaultWorkdir: () => configuration.defaultWorkdir() });
	const modelRoles = new ModelRoles(db, registry);
	const subagentSettings = new SubAgentSettings(db, registry);
	const compactionSettings = new CompactionSettings(db, registry);
	const extensions = new ExtensionHost({
		db, bus, registry, dataDir: cfg.dataDir,
		dirs: opts.extensionDirs ?? ExtensionHost.defaultDirs(cfg.dataDir, opts.home),
		paths: opts.extensionPaths,
		log: (m) => server.log.warn(m),
	});
	const templates = new TemplateService({ home: opts.home, defaultWorkdir: () => configuration.defaultWorkdir() });
	const sessions = new SessionManager(cfg, store, bus, registry, approvals, () => configuration.defaultWorkdir(), skills, questions, new SubAgents(registry, subagentSettings), compactionSettings, extensions, templates, () => configuration.approvalInfo().effective);
	extensions.attach({
		cwd: (id) => store.get(id)?.cwd,
		send: (id, text, mode) => sessions.send(id, { text, mode }),
		abort: (id) => sessions.abort(id),
		isRunning: (id) => sessions.isRunning(id),
	});
	const retention = new Retention(db, store, sessions, approvals, questions);
	const groups = new GroupManager(db, bus, (id) => store.get(id) !== undefined);
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
		if (req.method === "POST" && path === PUBLIC_PAIRING_PATH) return; // the one-time code is the credential
		const bearer = bearerOf(req.headers.authorization);
		// Browser EventSource/WebSocket cannot set headers. REST requires a Bearer header.
		const browserStream = req.method === "GET" && (path === "/ws" || path === "/events" || /^\/sessions\/[^/]+\/events$/.test(path ?? ""));
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
				? { ok: true, uptimeMs: Date.now() - startedAt, runningSessions: sessions.runningCount, subscribers: bus.subscriberCount }
				: { ok: true },
	});
	app.get("/tools", {
		schema: { response: { 200: S.ToolList, ...S.errors(401) } },
		handler: async () => ({
			tools: Object.values(sessions.toolDefs()).map((t) => ({ name: t.name, description: t.description, mutating: t.mutating })),
			defaults: extensions.defaultTools(),
			defaultApproval: configuration.approvalInfo().effective,
		}),
	});
	app.get("/models", {
		schema: { querystring: S.ModelsQuery, response: { 200: S.ModelList, ...S.errors(400, 401) } },
		handler: async (req) => {
			const all = await describeModels(registry, req.query.provider);
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
				return r === "" ? "." : r === ".." || r.startsWith("../") || isAbsolute(r) ? cwd : r;
			};
			return { root, home: homedir(), workdirs: store.workdirs().map((w) => ({ ...w, path: label(w.cwd) })) };
		},
	});
	app.get("/activity", {
		schema: { response: { 200: S.ActivityInfo, ...S.errors(401) } },
		handler: async () => ({ sessions: sessions.activity() }),
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
		handler: async (req) => retention.remove(req.body.ids),
	});
	app.get("/sessions/retention", {
		schema: { response: { 200: RetentionInfo, ...S.errors(401) } },
		handler: async () => retention.info(),
	});
	app.put("/sessions/retention", {
		schema: { body: RetentionPolicy, response: { 200: RetentionInfo, ...S.errors(400, 401) } },
		handler: async (req) => {
			retention.setPolicy(req.body);
			bus.publish(null, "configuration_updated", { scope: "retention", ...retention.policy() });
			return retention.info();
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
		handler: async (req) => sessions.context(req.params.id),
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

	// ── messages & approvals ──
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
	app.get("/approvals", {
		schema: { querystring: S.ApprovalsQuery, response: { 200: S.ApprovalList, ...S.errors(400, 401) } },
		handler: async (req) => ({ approvals: approvals.list(req.query.sessionId) }),
	});
	app.post("/sessions/:id/approvals/:toolCallId", {
		schema: { params: S.DecisionParams, body: S.DecisionBody, response: { 200: S.Ok, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			const { id, toolCallId } = req.params;
			sessions.get(id);
			if (!approvals.decide(id, toolCallId, req.body)) throw notFound("pending approval");
			return { ok: true };
		},
	});

	app.get("/questions", {
		schema: { querystring: S.ApprovalsQuery, response: { 200: S.QuestionList, ...S.errors(400, 401) } },
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
	registerServerExtensionRoutes(server, extensions, (id) => store.get(id) !== undefined);
	registerNotificationRoutes(server, notifications, id => store.get(id) !== undefined);
	registerConfigurationRoutes(server, configuration, bus);
	registerLlmRoutes(server, modelRoles, new Llm(registry, modelRoles), bus);
	registerSubAgentRoutes(server, subagentSettings, bus);
	registerCompactionRoutes(server, compactionSettings, bus);
	registerFsRoutes(server, () => configuration.defaultWorkdir(), cfg.restrictWorkspace ? cfg.workspaceRoot : undefined);
	registerFileRoutes(server, (id) => store.get(id)?.cwd);
	registerGroupRoutes(server, groups);
	registerSkillRoutes(server, skills, bus);
	registerTemplateRoutes(server, templates);
	registerExtensionSettingsRoutes(server, new ExtensionSettings(cfg.dataDir), bus);
	registerClientSettingsRoutes(server, clientSettings, bus);
	registerPairingRoutes(server, new Pairing((label) => deviceTokens.issue(label).token), deviceTokens);
	registerLocaleRoutes(server, new LocaleStore(cfg.dataDir), bus);
	await registerWebSocket(server, { bus, sessions, approvals, questions }, opts.websocket);

	await extensions.load();
	retention.start();
	// Skills, prompt templates and AGENTS.md live in plain files: tell open clients when they change on disk.
	const agentsWatch = new AgentsWatcher(bus, { home: opts.home, workdirs: () => [configuration.defaultWorkdir(), ...store.workdirs().filter((w) => w.active > 0).map((w) => w.cwd)] });
	agentsWatch.start();
	const prune = setInterval(() => bus.prune(7 * 24 * 3600_000), 6 * 3600_000);
	prune.unref?.();
	return { server, sessions, bus, retention, async close() {
		clearInterval(prune);
		retention.stop();
		agentsWatch.stop();
		await notifications.close();
		await push.close();
		sessions.shutdown();
		await sessions.idle();
		await extensions.shutdown();
		await server.close();
		db.close();
	} };
}

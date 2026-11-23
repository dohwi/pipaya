import { homedir } from "node:os";
import { isAbsolute, relative } from "node:path";
import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { CompactionSettings } from "../compaction.ts";
import type { Configuration } from "../configuration.ts";
import type { SqliteCredentialStore } from "../credential-store.ts";
import { badRequest, notFound } from "../errors.ts";
import type { QuestionManager } from "../questions.ts";
import * as S from "../schemas.ts";
import type { SessionManager } from "../sessions.ts";
import type { SessionStore } from "../store.ts";
import { stripToolMessageImages } from "../tool-images.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";
import type { UnreadTracker } from "../unread.ts";

export interface SessionRoutesDeps {
	sessions: SessionManager;
	store: SessionStore;
	unread: UnreadTracker;
	questions: QuestionManager;
	credentials: SqliteCredentialStore;
	configuration: Configuration;
	compactionSettings: CompactionSettings;
	busy: (id: string) => boolean;
	imageBodyLimit: number;
}

/** Workspace, session lifecycle, messaging, compaction, context, and ask_user question routes. */
export function registerSessionRoutes(server: FastifyInstance, deps: SessionRoutesDeps): void {
	const { sessions, store, unread, questions, credentials, configuration, compactionSettings, busy, imageBodyLimit } = deps;
	const app = server.withTypeProvider<TypeBoxProvider>();

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
	app.get("/delegates", {
		schema: { response: { 200: S.DelegateRuns, ...S.errors(401) } },
		handler: async () => ({ runs: sessions.delegateRuns() }),
	});
	app.post("/sessions/:id/read", {
		schema: { params: S.IdParams, response: { 200: Type.Object({ ok: Type.Boolean() }), ...S.errors(401) } },
		handler: async (req) => {
			unread.read([req.params.id]);
			return { ok: true };
		},
	});
	app.post("/sessions", {
		schema: { body: S.CreateSessionBody, response: { 201: S.Session, ...S.errors(400, 401, 502) } },
		handler: async (req, reply) => reply.status(201).send(await sessions.create(req.body)),
	});
	app.get("/sessions", {
		schema: { querystring: S.ListSessionsQuery, response: { 200: S.SessionList, ...S.errors(400, 401) } },
		handler: async (req) => {
			const limit = req.query.limit ?? 50;
			const list = store.list({ limit: limit + 1, before: req.query.before, beforeId: req.query.beforeId, closed: req.query.closed });
			const cursor = list.length > limit ? list[limit - 1] : null;
			return { sessions: list.slice(0, limit), nextBefore: cursor?.updatedAt ?? null, nextBeforeId: cursor?.id ?? null };
		},
	});
	app.post("/sessions/delete", {
		schema: { body: S.DeleteSessionsBody, response: { 200: S.DeleteSessionsResult, ...S.errors(400, 401) } },
		handler: async (req) => {
			const deleted: string[] = [];
			const skipped: string[] = [];
			for (const id of new Set(req.body.ids)) {
				if (!store.get(id) || busy(id)) skipped.push(id);
				else {
					sessions.delete(id);
					deleted.push(id);
				}
			}
			return { deleted, skipped };
		},
	});
	app.get("/sessions/:id", {
		schema: { params: S.IdParams, response: { 200: S.SessionDetail, ...S.errors(401, 404) } },
		handler: async (req) => ({
			...sessions.get(req.params.id),
			status: sessions.status(req.params.id),
			usage: store.usage(req.params.id),
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
			await sessions.refreshChatModels();
			return sessions.context(req.params.id, { anthropicOAuth: credential?.type === "oauth" });
		},
	});
	app.get("/context", {
		schema: { querystring: Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096 })) }), response: { 200: S.SessionContext, ...S.errors(400, 401) } },
		handler: async (req) => {
			await sessions.refreshChatModels();
			return sessions.previewContext(req.query.cwd);
		},
	});
	app.patch("/sessions/:id", {
		schema: { params: S.IdParams, body: S.PatchSessionBody, response: { 200: S.Session, ...S.errors(400, 401, 404, 409, 502) } },
		handler: async (req) => {
			const { workDir, ...rest } = req.body;
			if (workDir !== undefined) sessions.moveWorkdir(req.params.id, workDir === null || workDir === "" ? null : workDir, "user");
			return Object.keys(rest).length || workDir === undefined ? sessions.configureSession(req.params.id, rest) : sessions.get(req.params.id);
		},
	});
	app.get("/sessions/:id/workdirs", {
		schema: {
			description: "The working trees (main checkout, git worktrees) of the session's repository it may be moved to (PATCH workDir), its own first; empty outside a repository",
			params: S.IdParams,
			response: {
				200: Type.Object({
					workdirs: Type.Array(
						Type.Object({
							path: Type.String(),
							branch: Type.Union([Type.String(), Type.Null()]),
							home: Type.Boolean({ description: "The working tree of the session's own cwd" }),
							current: Type.Boolean({ description: "Where the session works now" }),
						}),
					),
				}),
				...S.errors(401, 404),
			},
		},
		handler: async (req) => ({ workdirs: sessions.workdirs(req.params.id) }),
	});
	app.delete("/sessions/:id", {
		schema: { params: S.IdParams, response: { 204: Type.Null(), ...S.errors(401, 404) } },
		handler: async (req, reply) => {
			sessions.delete(req.params.id);
			return reply.status(204).send();
		},
	});
	app.get("/sessions/:id/status", {
		schema: { params: S.IdParams, response: { 200: S.SessionStatus, ...S.errors(401, 404) } },
		handler: async (req) => sessions.status(req.params.id),
	});
	app.get("/sessions/:id/usage", {
		schema: { params: S.IdParams, response: { 200: S.Usage, ...S.errors(401, 404) } },
		handler: async (req) => {
			sessions.get(req.params.id);
			return store.usage(req.params.id);
		},
	});
	app.post("/sessions/:id/abort", {
		schema: { params: S.IdParams, response: { 200: Type.Object({ aborted: Type.Boolean() }), ...S.errors(401, 404) } },
		handler: async (req) => ({ aborted: sessions.abort(req.params.id) }),
	});
	app.post("/sessions/:id/queue/cancel", {
		schema: { params: S.IdParams, body: S.CancelQueuedBody, response: { 200: Type.Object({ cancelled: Type.Boolean() }), ...S.errors(400, 401, 404) } },
		handler: async (req) => ({ cancelled: sessions.cancelQueued(req.params.id, req.body.mode, req.body.text, req.body.deferred) }),
	});
	app.post("/sessions/:id/retry", {
		schema: { params: S.IdParams, response: { 202: Type.Object({ accepted: Type.Literal("retry") }), ...S.errors(401, 404, 409) } },
		handler: async (req, reply) => {
			sessions.retry(req.params.id);
			return reply.status(202).send({ accepted: "retry" });
		},
	});
	app.post("/sessions/:id/fork", {
		schema: { params: S.IdParams, body: S.ForkBody, response: { 201: S.Session, ...S.errors(400, 401, 404) } },
		handler: async (req, reply) => reply.status(201).send(await sessions.fork(req.params.id, req.body.atSeq, req.body.title)),
	});

	app.post("/sessions/:id/messages", {
		bodyLimit: imageBodyLimit, // a route option, not part of `schema`
		schema: { params: S.IdParams, body: S.SendBody, response: { 202: S.SendResult, ...S.errors(400, 401, 404, 409, 413) } },
		handler: async (req, reply) => reply.status(202).send(await sessions.send(req.params.id, req.body)),
	});
	app.get("/sessions/:id/messages", {
		schema: { params: S.IdParams, querystring: S.MessagesQuery, response: { 200: S.MessageList, ...S.errors(400, 401, 404) } },
		handler: async (req) => {
			sessions.get(req.params.id);
			const { after, limit, tail, before, turn, omitToolImages } = req.query;
			const rows = store.messages(req.params.id, tail ? { after, tail, before, wholeTurn: turn === true } : { after, limit: limit ?? 1000 });
			return { messages: omitToolImages ? rows.map((r) => ({ ...r, message: stripToolMessageImages(r.message) })) : rows };
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
}
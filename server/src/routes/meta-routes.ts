import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { Configuration } from "../configuration.ts";
import type { DeviceTokens } from "../device-tokens.ts";
import type { EventBus } from "../events.ts";
import type { ExtensionHost } from "../extensions/host.ts";
import type { HttpAuthContext } from "../http-hooks.ts";
import { describeModels, type ModelRegistry } from "../models.ts";
import * as S from "../schemas.ts";
import type { CorsPolicy } from "../security.ts";
import type { SelfUpdater } from "../self-update.ts";
import type { SessionManager } from "../sessions.ts";
import { streamEvents } from "../sse.ts";
import type { StreamTickets } from "../stream-tickets.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";
import { MIN_CLIENT_PROTOCOL, PROTOCOL_VERSION, SERVER_VERSION } from "../version.ts";

export interface MetaRoutesDeps {
	startedAt: number;
	auth: HttpAuthContext;
	deviceTokens: DeviceTokens;
	streamTickets: StreamTickets;
	updater: SelfUpdater;
	sessions: SessionManager;
	bus: EventBus;
	extensions: ExtensionHost;
	configuration: Configuration;
	registry: ModelRegistry;
	corsPolicy: CorsPolicy;
}

const parseTypes = (raw?: string) => (raw ? new Set(raw.split(",").map((s) => s.trim()).filter(Boolean)) : undefined);

/** Meta, stream ticket, self-update, catalog, and event stream routes. */
export function registerMetaRoutes(server: FastifyInstance, deps: MetaRoutesDeps): void {
	const { startedAt, auth, deviceTokens, streamTickets, updater, sessions, bus, extensions, configuration, registry, corsPolicy } = deps;
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/health", {
		schema: { response: { 200: S.Health } },
		handler: async (req) =>
			auth.tokenMatches(auth.bearerOf(req.headers.authorization)) || deviceTokens.verify(auth.bearerOf(req.headers.authorization))
				? { ok: true, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL, uptimeMs: Date.now() - startedAt, runningSessions: sessions.runningCount, subscribers: bus.subscriberCount }
				: { ok: true, version: SERVER_VERSION, protocol: PROTOCOL_VERSION, minClientProtocol: MIN_CLIENT_PROTOCOL },
	});

	// A browser cannot send the Authorization header on EventSource/WebSocket: it asks for a one-time ticket here and
	// puts that in the URL instead of the token.
	app.post("/stream-tickets", {
		schema: { response: { 200: Type.Object({ ticket: Type.String(), expiresAt: Type.Integer() }), ...S.errors(401) } },
		handler: async (req) => streamTickets.issue({ device: auth.deviceOf.get(req.raw) ?? null }),
	});

	app.get("/server/update", {
		schema: { response: { 200: S.UpdateStatus, ...S.errors(401, 403) } },
		handler: async () => updater.status(),
	});
	app.post("/server/update", {
		schema: { body: S.UpdateBody, response: { 200: S.UpdateResult, ...S.errors(400, 401, 403, 409, 502) } },
		handler: async (req) => {
			const done = await updater.apply({ force: req.body?.force === true, queue: req.body?.queue === true });
			return { ok: true, from: done.from, to: done.to, fromVersion: done.fromVersion, toVersion: done.toVersion, restarting: !done.pending, pending: done.pending, runningSessions: done.runningSessions };
		},
	});
	app.delete("/server/update", {
		schema: { response: { 200: S.UpdateCancelResult, ...S.errors(401, 403) } },
		handler: async () => ({ ok: true, cancelled: updater.cancelPending() }),
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
		handler: async (req) => ({
			events: bus.history({ sessionId: req.query.sessionId, after: req.query.after ?? 0, limit: req.query.limit ?? 200 }),
			latestId: bus.latestId(),
		}),
	});
	app.get("/events/types", {
		schema: { response: { 200: S.EventTypeList, ...S.errors(401) } },
		handler: async () => ({
			events: S.EVENTS.map((e) => ({ type: e.type, persisted: e.persisted, description: e.description, data: e.data })),
		}),
	});
}

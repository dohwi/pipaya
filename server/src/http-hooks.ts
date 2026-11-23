import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isAdminOnlyRoute, isStreamPath, PUBLIC_PAIRING_PATH } from "./auth-policy.ts";
import type { AuthThrottle } from "./auth-throttle.ts";
import type { DeviceTokens } from "./device-tokens.ts";
import { HttpError } from "./errors.ts";
import type { ExtensionHost } from "./extensions/host.ts";
import { ROUTE_PREFIX } from "./extensions/host.ts";
import { parseExtensionRouteRequest } from "./extensions/route-path.ts";
import type { IdleSockets } from "./idle-sockets.ts";
import type { CorsPolicy } from "./security.ts";
import type { StreamTickets } from "./stream-tickets.ts";
import { MIN_CLIENT_PROTOCOL, PROTOCOL_HEADER, PROTOCOL_QUERY } from "./version.ts";

export interface HttpHooksDeps {
	token: string;
	corsPolicy: CorsPolicy;
	idleSockets: IdleSockets;
	deviceTokens: DeviceTokens;
	streamTickets: StreamTickets;
	authThrottle: AuthThrottle;
	extensions: ExtensionHost;
}

export interface HttpAuthContext {
	tokenMatches: (given: string | undefined) => boolean;
	bearerOf: (header: string | undefined) => string | undefined;
	/** The paired device a request was made by; absent for the admin token. */
	deviceOf: WeakMap<object, string>;
	/** Requests to a public extension route that still carried a valid token. */
	publicAuthed: WeakSet<object>;
}

/** Register request lifecycle hooks (idle socket tracking, protocol gate, auth, CORS stream guard, error & 404 handlers). */
export function registerHttpHooks(server: FastifyInstance, deps: HttpHooksDeps): HttpAuthContext {
	const { corsPolicy, idleSockets, deviceTokens, streamTickets, authThrottle, extensions } = deps;
	const deviceOf = new WeakMap<object, string>();
	const publicAuthed = new WeakSet<object>();
	const expected = Buffer.from(deps.token);

	const tokenMatches = (given: string | undefined): boolean => {
		if (!given) return false;
		const token = Buffer.from(given);
		return token.length === expected.length && timingSafeEqual(token, expected);
	};
	const bearerOf = (header: string | undefined): string | undefined => (header?.startsWith("Bearer ") ? header.slice(7) : undefined);

	server.addHook("onRequest", async (req) => idleSockets.requestStarted(req.raw.socket, req.raw));

	server.addHook("onRequest", async (req, reply) => {
		if (req.method === "OPTIONS") return;
		const path = req.url.split("?")[0] ?? "";
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
		// An extension route marked public (a webhook, a page) is open; the extension checks its own secret. A token that
		// comes along anyway is still recognised, so the handler can tell the owner from a stranger.
		// Normalize with the exact same helper as `extensions/routes.ts` so dot-segments cannot cause auth/dispatch mismatch.
		if (path.startsWith(ROUTE_PREFIX)) {
			const extRoute = parseExtensionRouteRequest(req.url);
			if (extRoute && extensions.isPublicRoute(req.method, extRoute.pathname)) {
				if (tokenMatches(bearer)) publicAuthed.add(req.raw);
				else {
					const device = bearer ? deviceTokens.verify(bearer) : null;
					if (device) {
						publicAuthed.add(req.raw);
						deviceOf.set(req.raw, device);
					}
				}
				return;
			}
		}
		// Too many wrong tokens from this address: nothing is checked until its minute has passed (auth-throttle.ts).
		const wait = authThrottle.blockedFor(req.ip);
		if (wait > 0) {
			void reply.header("retry-after", Math.ceil(wait / 1000));
			throw new HttpError(429, "auth_throttled", "too many wrong tokens from this address; wait a minute");
		}
		// A request that carries no credential at all is not a guess (a scanner, a monitor, a page without a server yet).
		const refuse = (wrong: string | undefined) => {
			if (wrong !== undefined) authThrottle.fail(req.ip, wrong);
			return new HttpError(401, "unauthorized", "missing or invalid token");
		};
		// Browser EventSource/WebSocket cannot set headers. REST requires a Bearer header.
		const browserStream = req.method === "GET" && isStreamPath(path);
		if ((browserStream || req.headers.upgrade !== undefined) && req.headers.origin !== undefined && !corsPolicy.allows(req.headers.origin)) {
			throw new HttpError(403, "forbidden_origin", "origin not allowed");
		}
		const query = browserStream ? (req.query as { token?: string; ticket?: string } | undefined) : undefined;
		let device: string | null;
		if (bearer === undefined && typeof query?.ticket === "string") {
			// A one-time ticket (stream-tickets.ts) keeps the access token itself out of the URL.
			const holder = streamTickets.redeem(query.ticket);
			if (!holder) throw refuse(query.ticket);
			if (holder.device === null) return; // asked for with the admin token
			// The device may have been revoked between asking for the ticket and using it.
			if (!deviceTokens.has(holder.device)) throw refuse(query.ticket);
			device = holder.device;
		} else {
			const given = bearer ?? query?.token;
			if (tokenMatches(given)) return; // the admin token
			device = deviceTokens.verify(given);
			if (!device) throw refuse(given);
		}
		// Judge by the route the router matched, not the raw URL: it decodes percent-escapes the raw text still carries.
		// No match (undefined) ends in a 404 anyway; the raw path is the safe stand-in for it.
		if (isAdminOnlyRoute(req.method, req.routeOptions.url ?? path)) {
			throw new HttpError(403, "admin_only", "this needs the server's admin token, not a paired device's");
		}
		deviceTokens.track(device, req.raw.socket);
		deviceOf.set(req.raw, device);
	});

	server.setErrorHandler((err: Error & { statusCode?: number; code?: string }, req, reply) => {
		if (err instanceof HttpError) return reply.status(err.status).send({ error: { code: err.code, message: err.message, ...(err.data ?? {}) } });
		const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
		if (status >= 500) req.log.error(err);
		return reply.status(status).send({
			error: { code: status === 500 ? "internal_error" : (err.code ?? "error"), message: status === 500 ? "internal server error" : err.message },
		});
	});

	server.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: { code: "not_found", message: "route not found" } }));

	return { tokenMatches, bearerOf, deviceOf, publicAuthed };
}

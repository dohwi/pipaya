import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { badRequest, notFound } from "../errors.ts";
import { errors, IdParams } from "../schemas.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";
import type { ExtensionHost } from "./host.ts";
import { installFromGit } from "./install.ts";

const Info = Type.Object({
	name: Type.String(),
	path: Type.String(),
	tools: Type.Array(Type.String()),
	commands: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()) })),
	methods: Type.Array(Type.String()),
	providers: Type.Array(Type.String()),
	flags: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), type: Type.String(), value: Type.Optional(Type.Union([Type.Boolean(), Type.String()])) })),
	events: Type.Array(Type.String()),
	companion: Type.Optional(Type.String()),
	error: Type.Optional(Type.String()),
});

/** Server extensions run code with the server's privileges, so every route here needs the admin token. */
export function registerServerExtensionRoutes(server: FastifyInstance, host: ExtensionHost, sessionExists: (id: string) => boolean, installDir: string): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.post("/server-extensions/install", {
		schema: {
			body: Type.Object({ id: Type.String(), repo: Type.String(), dir: Type.Optional(Type.String()), ref: Type.String(), commit: Type.String() }),
			response: { 200: Type.Object({ extensions: Type.Array(Info) }), ...errors(400, 401, 403) },
		},
		handler: async (req) => {
			const { id, ...src } = req.body;
			try {
				await installFromGit(id, src, installDir);
			} catch (e) {
				throw badRequest(e instanceof Error ? e.message : String(e));
			}
			return { extensions: await host.reload() };
		},
	});
	app.get("/server-extensions", {
		schema: { response: { 200: Type.Object({ extensions: Type.Array(Info), commands: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), extension: Type.String() })) }), ...errors(401) } },
		handler: async () => ({ extensions: host.list(), commands: host.commands() }),
	});
	app.post("/server-extensions/reload", {
		schema: { response: { 200: Type.Object({ extensions: Type.Array(Info) }), ...errors(401, 403) } },
		handler: async () => ({ extensions: await host.reload() }),
	});
	app.get("/server-extensions/errors", {
		schema: { response: { 200: Type.Object({ errors: Type.Array(Type.Object({ at: Type.Integer(), extension: Type.String(), where: Type.String(), message: Type.String() })) }), ...errors(401) } },
		handler: async () => ({ errors: host.errors }),
	});
	app.post("/server-extensions/:extension/methods/:method", {
		schema: {
			params: Type.Object({ extension: Type.String(), method: Type.String() }),
			querystring: Type.Object({ sessionId: Type.Optional(Type.String()) }),
			body: Type.Optional(Type.Unknown()),
			response: { 200: Type.Object({ result: Type.Unknown() }), ...errors(400, 401, 403, 404) },
		},
		handler: async (req) => {
			const { sessionId } = req.query;
			if (sessionId && !sessionExists(sessionId)) throw notFound("session");
			try {
				const r = await host.callMethod(req.params.extension, req.params.method, req.body ?? null, sessionId ?? null);
				if (!r.found) throw notFound("extension method");
				return { result: r.result ?? null };
			} catch (e) {
				if (e instanceof Error && "status" in e) throw e;
				throw badRequest(e instanceof Error ? e.message : String(e));
			}
		},
	});
	app.get("/sessions/:id/extension-entries", {
		schema: {
			params: IdParams,
			querystring: Type.Object({ extension: Type.Optional(Type.String()), type: Type.Optional(Type.String()) }),
			response: { 200: Type.Object({ entries: Type.Array(Type.Object({ id: Type.Integer(), extension: Type.String(), type: Type.String(), data: Type.Unknown(), createdAt: Type.Integer() })) }), ...errors(401, 404) },
		},
		handler: async (req) => {
			if (!sessionExists(req.params.id)) throw notFound("session");
			return { entries: host.allEntries(req.params.id, req.query.extension, req.query.type) };
		},
	});
}

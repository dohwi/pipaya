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
	commands: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), args: Type.Optional(Type.String()) })),
	commandFamilies: Type.Array(Type.Object({ prefix: Type.String(), label: Type.Optional(Type.String()) })),
	methods: Type.Array(Type.String()),
	providers: Type.Array(Type.String()),
	modelRunners: Type.Array(Type.String(), { description: "Kinds of model this extension runs (e.g. \"image\")" }),
	flags: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), type: Type.String(), value: Type.Optional(Type.Union([Type.Boolean(), Type.String()])) })),
	events: Type.Array(Type.String()),
	companion: Type.Optional(Type.String()),
	title: Type.Optional(Type.String()),
	version: Type.Optional(Type.String()),
	description: Type.Optional(Type.String()),
	descriptions: Type.Optional(Type.Record(Type.String(), Type.String())),
	settings: Type.Optional(Type.Array(Type.Unknown(), { description: "Fields of the settings form (`pipaya.settings` in package.json), same shape as a client manifest's `settings`" })),
	settingsId: Type.String({ description: "Id of the shared settings object behind the form (`GET/PUT /extensions/:id/settings`)" }),
	clientPackage: Type.Optional(Type.Boolean({ description: "The folder carries its client half (`pipaya.client`); `GET /server-extensions/:extension/client` serves it" })),
	error: Type.Optional(Type.String()),
});

/** Server extensions run code with the server's privileges, so every route here needs the admin token. */
export function registerServerExtensionRoutes(server: FastifyInstance, host: ExtensionHost, sessionExists: (id: string) => boolean, installDir: string, resolveCwd: (cwd?: string) => string): void {
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
		schema: { response: { 200: Type.Object({ extensions: Type.Array(Info), commands: Type.Array(Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), args: Type.Optional(Type.String()), extension: Type.String() })) }), ...errors(401) } },
		handler: async () => ({ extensions: host.list(), commands: host.commands() }),
	});
	const Entry = Type.Object({ name: Type.String(), description: Type.Optional(Type.String()), args: Type.Optional(Type.String()) });
	app.get("/server-extensions/commands", {
		schema: {
			querystring: Type.Object({ cwd: Type.Optional(Type.String({ description: "Working directory the entries are for; default: the server's" })) }),
			response: { 200: Type.Object({ cwd: Type.String(), families: Type.Array(Type.Object({ prefix: Type.String(), label: Type.Optional(Type.String()), extension: Type.String(), entries: Type.Array(Entry) })) }), ...errors(401) },
		},
		handler: async (req) => {
			const cwd = resolveCwd(req.query.cwd);
			return { cwd, families: await host.commandEntries(cwd) };
		},
	});
	app.get("/server-extensions/:extension/client", {
		schema: {
			params: Type.Object({ extension: Type.String() }),
			response: { 200: Type.Object({ package: Type.Unknown({ description: "The client extension package, as built; the client validates it" }) }), ...errors(400, 401, 404) },
		},
		handler: async (req) => {
			let pkg: unknown;
			try { pkg = host.clientPackage(req.params.extension); } catch (e) { throw badRequest(e instanceof Error ? e.message : String(e)); }
			if (pkg === undefined) throw notFound("client package");
			return { package: pkg };
		},
	});
	app.post("/server-extensions/reload", {
		schema: { response: { 200: Type.Object({ extensions: Type.Array(Info) }), ...errors(401, 403) } },
		handler: async () => ({ extensions: await host.reload() }),
	});
	app.get("/server-extensions/errors", {
		schema: {
			querystring: Type.Object({ extension: Type.Optional(Type.String({ description: "Only this extension's errors (its name, or a folder name for every entry of that folder)" })) }),
			response: { 200: Type.Object({ errors: Type.Array(Type.Object({ at: Type.Integer(), extension: Type.String(), where: Type.String(), message: Type.String() })) }), ...errors(401) },
		},
		handler: async (req) => {
			const name = req.query.extension;
			return { errors: name ? host.errors.filter((e) => e.extension === name || e.extension.startsWith(`${name}/`)) : host.errors };
		},
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
			querystring: Type.Object({
				extension: Type.Optional(Type.String()),
				type: Type.Optional(Type.String()),
				after: Type.Optional(Type.Integer({ minimum: 0, description: "Only entries with a larger id (paging)" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000, description: "At most this many (default and max 1000)" })),
			}),
			response: { 200: Type.Object({ entries: Type.Array(Type.Object({ id: Type.Integer(), extension: Type.String(), type: Type.String(), data: Type.Unknown(), createdAt: Type.Integer() })) }), ...errors(401, 404) },
		},
		handler: async (req) => {
			if (!sessionExists(req.params.id)) throw notFound("session");
			const { extension, type, after, limit } = req.query;
			return { entries: host.allEntries(req.params.id, extension, type, { after, limit }) };
		},
	});
}

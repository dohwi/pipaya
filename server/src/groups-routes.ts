import type { FastifyInstance } from "fastify";
import { CreateGroupBody, GroupList, GroupSchema, PatchGroupBody, type GroupManager } from "./groups.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Session groups: named split-window layouts shared by every client of this server. */
export function registerGroupRoutes(server: FastifyInstance, groups: GroupManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/groups", {
		schema: { response: { 200: GroupList, ...errors(401) } },
		handler: async () => ({ groups: groups.list() }),
	});
	app.post("/groups", {
		schema: { body: CreateGroupBody, response: { 201: GroupSchema, ...errors(400, 401, 404) } },
		handler: async (req, reply) => reply.status(201).send(groups.create(req.body)),
	});
	app.patch("/groups/:id", {
		schema: { params: IdParams, body: PatchGroupBody, response: { 200: GroupSchema, ...errors(400, 401, 404) } },
		handler: async (req) => groups.update(req.params.id, req.body),
	});
	app.delete("/groups/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404) } },
		handler: async (req) => {
			groups.delete(req.params.id);
			return { ok: true };
		},
	});
}

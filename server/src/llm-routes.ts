import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { CompleteBody, CompleteResult, type Llm } from "./llm.ts";
import { RolesBody, RolesResult, type ModelRoles } from "./model-roles.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Model roles and one-shot completion: generic parts that the server itself and client extensions build on. */
export function registerLlmRoutes(server: FastifyInstance, roles: ModelRoles, llm: Llm, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/model-roles", {
		schema: { response: { 200: RolesResult, ...errors(401) } },
		handler: async () => ({ roles: roles.list() }),
	});
	app.put("/model-roles", {
		schema: { body: RolesBody, response: { 200: RolesResult, ...errors(400, 401) } },
		handler: async (req) => {
			const saved = roles.set(req.body.roles);
			bus.publish(null, "configuration_updated", { scope: "model-roles", roles: saved });
			return { roles: saved };
		},
	});
	app.post("/llm/complete", {
		schema: { body: CompleteBody, response: { 200: CompleteResult, ...errors(400, 401, 502) } },
		handler: async (req) => {
			// Abort the upstream call when the caller goes away; a closed request must not keep spending tokens.
			const controller = new AbortController();
			req.raw.on("close", () => { if (!req.raw.complete) controller.abort(); });
			return llm.complete(req.body, controller.signal);
		},
	});
}

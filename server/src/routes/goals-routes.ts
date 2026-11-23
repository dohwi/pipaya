import type { FastifyInstance } from "fastify";
import { IdParams, Ok, errors } from "../schemas.ts";
import { GoalList, GoalQuery, GoalSchema, PatchGoalBody, PutGoalBody, type GoalManager } from "../goals.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

/** Per-session goals: automatic continuation until complete, blocked, paused or budget-limited. Broadcasts `goals_updated`. */
export function registerGoalRoutes(server: FastifyInstance, goals: GoalManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/goals", {
		schema: { querystring: GoalQuery, response: { 200: GoalList, ...errors(400, 401) } },
		handler: async (req) => ({ goals: goals.list(req.query.sessionId) }),
	});
	app.put("/sessions/:id/goal", {
		schema: { params: IdParams, body: PutGoalBody, response: { 200: GoalSchema, ...errors(400, 401, 404) } },
		handler: async (req) => goals.put(req.params.id, req.body),
	});
	app.patch("/sessions/:id/goal", {
		schema: { params: IdParams, body: PatchGoalBody, response: { 200: GoalSchema, ...errors(400, 401, 404) } },
		handler: async (req) => goals.patch(req.params.id, req.body),
	});
	app.delete("/sessions/:id/goal", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404) } },
		handler: async (req) => {
			goals.clear(req.params.id);
			return { ok: true };
		},
	});
}

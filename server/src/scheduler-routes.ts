import type { FastifyInstance } from "fastify";
import { IdParams, Ok, errors } from "./schemas.ts";
import { CreateScheduleBody, PatchScheduleBody, ScheduleList, ScheduleQuery, ScheduleSchema, type Scheduler } from "./scheduler.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Scheduled tasks: prompts sent to a session once or every so often. Changes reach the clients as `schedules_updated`. */
export function registerSchedulerRoutes(server: FastifyInstance, scheduler: Scheduler): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/schedules", {
		schema: { querystring: ScheduleQuery, response: { 200: ScheduleList, ...errors(400, 401) } },
		handler: async (req) => ({ schedules: scheduler.list(req.query.sessionId) }),
	});
	app.post("/schedules", {
		schema: { body: CreateScheduleBody, response: { 201: ScheduleSchema, ...errors(400, 401, 404) } },
		handler: async (req, reply) => reply.status(201).send(scheduler.create(req.body)),
	});
	app.patch("/schedules/:id", {
		schema: { params: IdParams, body: PatchScheduleBody, response: { 200: ScheduleSchema, ...errors(400, 401, 404) } },
		handler: async (req) => scheduler.update(req.params.id, req.body),
	});
	app.delete("/schedules/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404) } },
		handler: async (req) => {
			scheduler.delete(req.params.id);
			return { ok: true };
		},
	});
	app.post("/schedules/:id/run", {
		schema: { params: IdParams, response: { 200: ScheduleSchema, ...errors(401, 404, 409) } },
		handler: async (req) => scheduler.runNow(req.params.id),
	});
}

import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { RetentionInfo, RetentionRunResult, RetentionSettingsSchema, type Retention } from "./retention.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Deleting sessions not used for a while: the policy, the last clean-up and a "clean up now". */
export function registerRetentionRoutes(server: FastifyInstance, retention: Retention, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/retention", {
		schema: { response: { 200: RetentionInfo, ...errors(401) } },
		handler: async () => retention.info(),
	});
	app.put("/retention", {
		schema: { body: RetentionSettingsSchema, response: { 200: RetentionInfo, ...errors(400, 401) } },
		handler: async (req) => {
			retention.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "retention" });
			return retention.info();
		},
	});
	app.post("/retention/run", {
		schema: { response: { 200: RetentionRunResult, ...errors(401) } },
		handler: async () => ({ deleted: retention.run() }),
	});
}

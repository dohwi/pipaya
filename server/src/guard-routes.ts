import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { DEFAULT_GUARD_SETTINGS, GuardInfoSchema, GuardUpdateSchema, type GuardSettings } from "./guard.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Built-in bash command guard settings (`GET/PUT /guard`). */
export function registerGuardRoutes(server: FastifyInstance, guard: GuardSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: guard.get(), defaults: DEFAULT_GUARD_SETTINGS() });
	app.get("/guard", {
		schema: { response: { 200: GuardInfoSchema, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/guard", {
		schema: { body: GuardUpdateSchema, response: { 200: GuardInfoSchema, ...errors(400, 401) } },
		handler: async (req) => {
			guard.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "guard" });
			return view();
		},
	});
}

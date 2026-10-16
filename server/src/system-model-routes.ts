import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { errors } from "./schemas.ts";
import { DEFAULT_SYSTEM_MODEL, SystemModelResult, SystemModelSchema, type SystemModelSettings } from "./system-model.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** The light model that writes session titles and roles (null = off). */
export function registerSystemModelRoutes(server: FastifyInstance, settings: SystemModelSettings, bus: EventBus, onChange: () => void = () => {}): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_SYSTEM_MODEL() });
	app.get("/system-model", {
		schema: { response: { 200: SystemModelResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/system-model", {
		schema: { body: SystemModelSchema, response: { 200: SystemModelResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "system-model" });
			onChange(); // sessions that already talked get their role now, not only on their next message
			return view();
		},
	});
}

import type { FastifyInstance } from "fastify";
import type { EventBus } from "../events.ts";
import { DEFAULT_FALLBACK_MODEL, FallbackModelResult, FallbackModelSchema, type FallbackModelSettings } from "../fallback-model.ts";
import { errors } from "../schemas.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

/** Automatic fallback model used after repeated zero-output upstream failures (null = off). */
export function registerFallbackModelRoutes(server: FastifyInstance, settings: FallbackModelSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_FALLBACK_MODEL() });
	app.get("/fallback-model", {
		schema: { response: { 200: FallbackModelResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/fallback-model", {
		schema: { body: FallbackModelSchema, response: { 200: FallbackModelResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "fallback-model" });
			return view();
		},
	});
}

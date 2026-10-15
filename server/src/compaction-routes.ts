import type { FastifyInstance } from "fastify";
import { CompactionSettingsBody, CompactionSettingsResult, DEFAULT_COMPACTION_SETTINGS, type CompactionSettings } from "./compaction.ts";
import type { EventBus } from "./events.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Which model writes compaction summaries (null = the session's own model) and whether compaction runs by itself. */
export function registerCompactionRoutes(server: FastifyInstance, settings: CompactionSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_COMPACTION_SETTINGS() });
	app.get("/compaction", {
		schema: { response: { 200: CompactionSettingsResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/compaction", {
		schema: { body: CompactionSettingsBody, response: { 200: CompactionSettingsResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.set(req.body);
			bus.publish(null, "configuration_updated", { scope: "compaction" });
			return view();
		},
	});
}

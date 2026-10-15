import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { errors } from "./schemas.ts";
import { DEFAULT_SUBAGENT_SETTINGS, SUBAGENT_TOOL_CHOICES, SubAgentSettingsBody, SubAgentSettingsResult, type SubAgentSettings } from "./subagent-settings.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Whether the `delegate` tool is on, and the read-only helpers it can hand work to. */
export function registerSubAgentRoutes(server: FastifyInstance, settings: SubAgentSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = () => ({ settings: settings.get(), defaults: DEFAULT_SUBAGENT_SETTINGS(), toolChoices: [...SUBAGENT_TOOL_CHOICES] });
	app.get("/subagents", {
		schema: { response: { 200: SubAgentSettingsResult, ...errors(401) } },
		handler: async () => view(),
	});
	app.put("/subagents", {
		schema: { body: SubAgentSettingsBody, response: { 200: SubAgentSettingsResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.set(req.body.settings);
			bus.publish(null, "configuration_updated", { scope: "subagents" });
			return view();
		},
	});
}

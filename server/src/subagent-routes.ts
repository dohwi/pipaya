import type { FastifyInstance } from "fastify";
import type { EventBus } from "./events.ts";
import { errors, IdParams } from "./schemas.ts";
import { SUBAGENT_TOOL_CHOICES, SubAgentListQuery, SubAgentListResult, SubAgentSwitchBody, type SubAgentSettings } from "./subagent-settings.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/**
 * Sub-agents are Markdown files (`~/.agents/subagents/*.md`, `<dir>/.agents/subagents/*.md`), like skills. The server
 * only stores two kinds of switch: the master one and a per-helper on/off. Everything else is edited in the files.
 */
export function registerSubAgentRoutes(server: FastifyInstance, settings: SubAgentSettings, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const view = (cwd?: string) => ({ ...settings.list(cwd), toolChoices: [...SUBAGENT_TOOL_CHOICES] });
	app.get("/subagents", {
		schema: { querystring: SubAgentListQuery, response: { 200: SubAgentListResult, ...errors(400, 401) } },
		handler: async (req) => view(req.query.cwd),
	});
	app.put("/subagents", {
		schema: { querystring: SubAgentListQuery, body: SubAgentSwitchBody, response: { 200: SubAgentListResult, ...errors(400, 401) } },
		handler: async (req) => {
			settings.setEnabled(req.body.enabled);
			bus.publish(null, "configuration_updated", { scope: "subagents" });
			return view(req.query.cwd);
		},
	});
	app.put("/subagents/:id", {
		schema: { params: IdParams, querystring: SubAgentListQuery, body: SubAgentSwitchBody, response: { 200: SubAgentListResult, ...errors(400, 401, 404) } },
		handler: async (req) => {
			settings.setAgentEnabled(req.params.id, req.body.enabled, req.query.cwd);
			bus.publish(null, "configuration_updated", { scope: "subagents" });
			return view(req.query.cwd);
		},
	});
}

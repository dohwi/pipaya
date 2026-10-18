import type { FastifyInstance } from "fastify";
import { Configuration, ConfigurationResult, CustomProviderBody, CustomProviderPublic, ApprovalBody, ApprovalInfo, AskUserBody, AskUserInfo, ToolsBody, ToolsInfo, DefaultsBody, DefaultsResult, DiscoverBody, DiscoverResult, ConnectionResult, Selection, WorkdirBody, WorkdirInfo } from "./configuration.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";
import type { EventBus } from "./events.ts";
import { catalogEntries } from "./thinking-catalog.ts";
import Type from "typebox";

const CatalogResult = Type.Object({
	models: Type.Array(Type.Object({
		id: Type.String(), name: Type.String(), contextWindow: Type.Integer(), maxTokens: Type.Integer(),
		reasoning: Type.Boolean(), vision: Type.Boolean(), levels: Type.Array(Type.String()),
	}), { description: "Bundled OpenRouter catalog, for model id autocomplete" }),
});

/** Authenticated configuration API for any client. No assets or frontend build. */
export function registerConfigurationRoutes(server: FastifyInstance, config: Configuration, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	config.onModelsChanged = (id) => bus.publish(null, "configuration_updated", { scope: "provider", id, action: "saved" });
	app.get("/configuration", {
		schema: { response: { 200: ConfigurationResult, ...errors(401) } },
		handler: async () => { config.refreshStale(); return config.snapshot(); },
	});
	app.get("/configuration/catalog", {
		schema: { response: { 200: CatalogResult, ...errors(401) } },
		handler: async () => ({ models: catalogEntries() }),
	});
	app.post("/configuration/discover", {
		schema: { body: DiscoverBody, response: { 200: DiscoverResult, ...errors(400, 401) } },
		handler: async (req) => config.discover(req.body),
	});
	app.put("/configuration/providers/:id", {
		schema: { params: IdParams, body: CustomProviderBody, response: { 200: CustomProviderPublic, ...errors(400, 401, 409) } },
		handler: async (req) => {
			const saved = await config.save(req.params.id, req.body);
			bus.publish(null, "configuration_updated", { scope: "provider", id: req.params.id, action: "saved" });
			return saved;
		},
	});
	app.post("/configuration/providers/:id/refresh", {
		schema: {
			description: "Read the connection's model list from its upstream now: new models are added, missing ones flagged unavailable",
			params: IdParams, response: { 200: CustomProviderPublic, ...errors(400, 401, 404) },
		},
		handler: async (req) => {
			const refreshed = await config.refreshNow(req.params.id);
			bus.publish(null, "configuration_updated", { scope: "provider", id: req.params.id, action: "saved" });
			return refreshed;
		},
	});
	app.delete("/configuration/providers/:id", {
		schema: { params: IdParams, response: { 200: Ok, ...errors(401, 404, 409) } },
		handler: async (req) => {
			await config.delete(req.params.id);
			bus.publish(null, "configuration_updated", { scope: "provider", id: req.params.id, action: "deleted" });
			return { ok: true };
		},
	});
	app.put("/configuration/defaults", {
		schema: { body: DefaultsBody, response: { 200: DefaultsResult, ...errors(400, 401) } },
		handler: async (req) => {
			const defaults = config.setDefaults(req.body);
			bus.publish(null, "configuration_updated", { scope: "defaults", ...defaults });
			return defaults;
		},
	});
	app.put("/configuration/workdir", {
		schema: { body: WorkdirBody, response: { 200: WorkdirInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const workdir = config.setWorkdir(req.body.path);
			bus.publish(null, "configuration_updated", { scope: "workdir", ...workdir });
			return workdir;
		},
	});
	app.put("/configuration/approval", {
		schema: { body: ApprovalBody, response: { 200: ApprovalInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const approval = config.setApproval(req.body.approval);
			bus.publish(null, "configuration_updated", { scope: "approval", ...approval });
			return approval;
		},
	});
	app.put("/configuration/ask-user", {
		schema: { body: AskUserBody, response: { 200: AskUserInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const askUser = config.setAskUser(req.body.enabled);
			bus.publish(null, "configuration_updated", { scope: "ask_user", ...askUser });
			bus.publish(null, "configuration_updated", { scope: "tools", ...config.toolsInfo() });
			return askUser;
		},
	});
	app.put("/configuration/tools", {
		schema: { body: ToolsBody, response: { 200: ToolsInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const tools = config.setDisabledTools(req.body.disabled);
			bus.publish(null, "configuration_updated", { scope: "tools", ...tools });
			// Keep older clients' ask_user switch in step.
			bus.publish(null, "configuration_updated", { scope: "ask_user", enabled: !tools.disabled.includes("ask_user") });
			return tools;
		},
	});
	app.post("/configuration/test", {
		schema: { body: Selection, response: { 200: ConnectionResult, ...errors(400, 401, 404) } },
		handler: async (req) => config.test(req.body),
	});
}

import type { FastifyInstance } from "fastify";
import { Configuration, ConfigurationResult, CustomProviderBody, CustomProviderPublic, ToolsBody, ToolsInfo, DefaultsBody, DefaultsResult, DiscoverBody, DiscoverResult, ConnectionResult, Selection, WorkdirBody, WorkdirInfo } from "./configuration.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";
import type { EventBus } from "./events.ts";
import { catalogEntries } from "./thinking-catalog.ts";
import { badRequest, notFound } from "./errors.ts";
import { MAX_ICON_BYTES } from "./model-icons.ts";
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
	app.post("/configuration/icons", {
		schema: {
			description: "Upload an image (PNG, JPEG or WebP, up to 256 KB) to use as a model icon. Returns the value to put in a model's `icon`.",
			body: Type.Object({ data: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_ICON_BYTES * 1.4), description: "base64 of the image bytes" }) }, { additionalProperties: false }),
			response: { 200: Type.Object({ icon: Type.String() }), ...errors(400, 401) },
		},
		handler: async (req) => {
			if (!/^[A-Za-z0-9+/]+={0,2}$/.test(req.body.data)) throw badRequest("data must be base64");
			return { icon: config.images.add(Buffer.from(req.body.data, "base64")) };
		},
	});
	app.get("/configuration/icons", {
		schema: { description: "Icon values of the uploaded images, newest first", response: { 200: Type.Object({ icons: Type.Array(Type.String()) }), ...errors(401) } },
		handler: async () => ({ icons: config.images.list() }),
	});
	app.get("/configuration/icons/:id", {
		schema: { params: IdParams, response: { ...errors(401, 404) } },
		handler: async (req, reply) => {
			const icon = config.images.get(req.params.id);
			if (!icon) throw notFound("icon");
			return reply
				.header("content-type", icon.mime)
				.header("x-content-type-options", "nosniff")
				.header("content-security-policy", "sandbox; default-src 'none'")
				.header("cache-control", "private, max-age=31536000, immutable")
				.send(icon.data);
		},
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
	app.put("/configuration/tools", {
		schema: { body: ToolsBody, response: { 200: ToolsInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const tools = config.setDisabledTools(req.body.disabled);
			bus.publish(null, "configuration_updated", { scope: "tools", ...tools });
			return tools;
		},
	});
	app.post("/configuration/test", {
		schema: { body: Selection, response: { 200: ConnectionResult, ...errors(400, 401, 404) } },
		handler: async (req) => config.test(req.body),
	});
}

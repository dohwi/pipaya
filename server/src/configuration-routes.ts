import type { FastifyInstance } from "fastify";
import { Configuration, ConfigurationResult, CustomProviderBody, CustomProviderPublic, ToolsBody, ToolsInfo, DelegatePolicy, DefaultsBody, DefaultsResult, DiscoverBody, DiscoverResult, ConnectionResult, Selection, WorkdirBody, WorkdirInfo } from "./configuration.ts";
import { IdParams, Ok, errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";
import type { EventBus } from "./events.ts";
import { catalogEntries } from "./thinking-catalog.ts";
import { badRequest, notFound } from "./errors.ts";
import { MAX_ICON_BYTES } from "./model-icons.ts";
import Type from "typebox";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { helperTools, listSubagents, removeSubagent, saveSubagent, subagentKey } from "./subagents.ts";
import { TOOL_DEFS } from "./tools.ts";
import { THINKING_LEVELS } from "./store.ts";
const Scope = Type.Union([Type.Literal("global"), Type.Literal("project")], { description: "global: ~/.agents/subagents; project: .agents/subagents of the server's default working folder" });
const SubagentInfo = Type.Object({
	name: Type.String(), description: Type.String(), model: Type.Optional(Type.String()), thinking: Type.Optional(Type.String()),
	tools: Type.Array(Type.String()), maxTurns: Type.Integer(), prompt: Type.String(), file: Type.String(), scope: Scope,
	overridden: Type.Boolean({ description: "A project role of the same name wins over this global one" }),
	enabled: Type.Boolean({ description: "Switched off roles cannot be started by `delegate`" }),
});
const SubagentList = Type.Object({
	subagents: Type.Array(SubagentInfo),
	tools: Type.Array(Type.String(), { description: "Tool names a helper may be given" }),
	projectDir: Type.String({ description: "Folder the project scope writes to" }),
});
const SubagentFields = {
	description: Type.String({ maxLength: 500 }),
	model: Type.Optional(Type.String({ minLength: 3, maxLength: 200 })),
	thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)))),
	tools: Type.Array(Type.String({ pattern: "^[\\w.-]+$", maxLength: 80 }), { maxItems: 50 }),
	maxTurns: Type.Integer({ minimum: 1, maximum: 30 }),
	prompt: Type.String({ maxLength: 20000, description: "The role's instructions (the file's body)" }),
};
const SubagentCreate = Type.Object({ name: Type.String({ maxLength: 40 }), scope: Scope, ...SubagentFields }, { additionalProperties: false });
const SubagentUpdate = Type.Object({ scope: Scope, ...SubagentFields }, { additionalProperties: false });
const SubagentCwd = Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Folder whose `.agents/subagents` is the project scope; the default working folder when left out" })) });
const SubagentScope = Type.Object({ scope: Scope, cwd: Type.Optional(Type.String({ maxLength: 4096 })) });
const SubagentName = Type.Object({ name: Type.String() });
const SubagentEnabled = Type.Object({ scope: Scope, enabled: Type.Boolean(), cwd: Type.Optional(Type.String({ maxLength: 4096 })) }, { additionalProperties: false });

const CatalogResult = Type.Object({
	models: Type.Array(Type.Object({
		id: Type.String(), name: Type.String(), contextWindow: Type.Integer(), maxTokens: Type.Integer(),
		reasoning: Type.Boolean(), vision: Type.Boolean(), image: Type.Boolean(), levels: Type.Array(Type.String()),
	}), { description: "Bundled OpenRouter catalog, for model id autocomplete" }),
});

/** Authenticated configuration API for any client. No assets or frontend build. */
export function registerConfigurationRoutes(server: FastifyInstance, config: Configuration, bus: EventBus, home: string = homedir()): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	config.onModelsChanged = (id) => bus.publish(null, "configuration_updated", { scope: "provider", id, action: "saved" });
	app.get("/configuration", {
		schema: { response: { 200: ConfigurationResult, ...errors(401) } },
		handler: async () => { config.refreshStale(); return config.snapshot(); },
	});
	// Project roles live in `<cwd>/.agents/subagents`. `cwd` is the folder of the conversation asking (the footer); without it the
	// default working folder is used (the settings page). Relative paths resolve against the default working folder.
	const where = (cwd?: string) => (cwd?.trim() ? resolve(config.defaultWorkdir(), cwd.trim()) : config.defaultWorkdir());
	const roles = (cwd?: string) => ({ subagents: listSubagents(where(cwd), home, config.disabledSubagents()), tools: helperTools(Object.keys(TOOL_DEFS)), projectDir: join(where(cwd), ".agents", "subagents") });
	const changed = () => bus.publish(null, "skills_updated", { name: "", scope: "global", project: "", source: "files" });
	app.get("/configuration/subagents", {
		schema: { querystring: SubagentCwd, response: { 200: SubagentList, ...errors(400, 401) } },
		handler: async (req) => roles(req.query.cwd),
	});
	app.post("/configuration/subagents", {
		schema: { querystring: SubagentCwd, body: SubagentCreate, response: { 200: SubagentList, ...errors(400, 401, 409) } },
		handler: async (req) => {
			const { name, scope, ...input } = req.body;
			saveSubagent(scope, where(req.query.cwd), home, name, input, true);
			changed();
			return roles(req.query.cwd);
		},
	});
	app.put("/configuration/subagents/:name", {
		schema: { params: SubagentName, querystring: SubagentCwd, body: SubagentUpdate, response: { 200: SubagentList, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const { scope, ...input } = req.body;
			saveSubagent(scope, where(req.query.cwd), home, req.params.name, input, false);
			changed();
			return roles(req.query.cwd);
		},
	});
	app.put("/configuration/subagents/:name/enabled", {
		schema: { params: SubagentName, body: SubagentEnabled, response: { 200: SubagentList, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const { scope, enabled, cwd } = req.body;
			// Only roles that exist can be switched, so the saved list never collects keys of deleted files.
			if (!listSubagents(where(cwd), home).some((d) => d.scope === scope && d.name === req.params.name)) throw notFound(`helper role "${req.params.name}"`);
			config.setSubagentEnabled(subagentKey({ scope, name: req.params.name }), enabled);
			changed();
			return roles(cwd);
		},
	});
	app.delete("/configuration/subagents/:name", {
		schema: { params: SubagentName, querystring: SubagentScope, response: { 200: SubagentList, ...errors(400, 401, 404) } },
		handler: async (req) => {
			removeSubagent(req.query.scope, where(req.query.cwd), home, req.params.name);
			config.setSubagentEnabled(subagentKey({ scope: req.query.scope, name: req.params.name }), true); // a deleted role leaves no switch behind
			changed();
			return roles(req.query.cwd);
		},
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
	app.put("/configuration/delegate", {
		schema: { body: DelegatePolicy, response: { 200: ToolsInfo, ...errors(400, 401) } },
		handler: async (req) => {
			const tools = config.setDelegatePolicy(req.body);
			bus.publish(null, "configuration_updated", { scope: "tools", ...tools });
			return tools;
		},
	});
	app.post("/configuration/test", {
		schema: { body: Selection, response: { 200: ConnectionResult, ...errors(400, 401, 404) } },
		handler: async (req) => config.test(req.body),
	});
}

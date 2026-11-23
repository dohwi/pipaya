import type { FastifyInstance } from "fastify";
import { homedir } from "node:os";
import Type from "typebox";
import type { EventBus } from "../events.ts";
import { errors } from "../schemas.ts";
import { listTemplates, MAX_TEMPLATE_BYTES, MAX_TEMPLATE_DESCRIPTION, MAX_TEMPLATE_NAME, removeTemplate, resolveTemplateCwd, saveTemplate } from "../templates.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

const Scope = Type.Union([Type.Literal("global"), Type.Literal("project")], {
	description: "global: ~/.agents/templates; project: .agents/templates of the working folder",
});

const TemplateInfo = Type.Object({
	name: Type.String(),
	description: Type.String(),
	body: Type.String(),
	path: Type.String(),
	scope: Scope,
	overridden: Type.Boolean({ description: "A closer project template (or project over global) wins for this name" }),
});

const TemplateListSchema = Type.Object({
	cwd: Type.String(),
	globalDir: Type.String(),
	projectDir: Type.String(),
	templates: Type.Array(TemplateInfo),
	warnings: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
});

const CwdQuery = Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096 })) });
const NameParams = Type.Object({ name: Type.String({ maxLength: MAX_TEMPLATE_NAME }) });
const ScopeQuery = Type.Object({ scope: Scope, cwd: Type.Optional(Type.String({ maxLength: 4096 })) });

const TemplateCreateBody = Type.Object(
	{
		name: Type.String({ minLength: 1, maxLength: MAX_TEMPLATE_NAME }),
		scope: Scope,
		description: Type.Optional(Type.String({ maxLength: MAX_TEMPLATE_DESCRIPTION })),
		body: Type.String({ minLength: 1, maxLength: MAX_TEMPLATE_BYTES }),
	},
	{ additionalProperties: false },
);

const TemplateUpdateBody = Type.Object(
	{
		scope: Scope,
		description: Type.Optional(Type.String({ maxLength: MAX_TEMPLATE_DESCRIPTION })),
		body: Type.String({ minLength: 1, maxLength: MAX_TEMPLATE_BYTES }),
	},
	{ additionalProperties: false },
);

/** Built-in prompt template CRUD routes (`GET/POST/PUT/DELETE /templates`). */
export function registerTemplateRoutes(
	server: FastifyInstance,
	defaultWorkdir: () => string,
	bus: EventBus,
	home: string = homedir(),
): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	const where = (cwd?: string) => resolveTemplateCwd(defaultWorkdir(), cwd);
	const changed = () => bus.publish(null, "skills_updated", { name: "", scope: "global", project: "", source: "files" });

	app.get("/templates", {
		schema: { querystring: CwdQuery, response: { 200: TemplateListSchema, ...errors(400, 401) } },
		handler: async (req) => listTemplates(defaultWorkdir(), req.query.cwd, home),
	});

	app.post("/templates", {
		schema: { querystring: CwdQuery, body: TemplateCreateBody, response: { 200: TemplateListSchema, ...errors(400, 401, 409) } },
		handler: async (req) => {
			const cwd = where(req.query.cwd);
			const { name, scope, ...input } = req.body;
			saveTemplate(scope, cwd, home, name, input, true);
			changed();
			return listTemplates(defaultWorkdir(), cwd, home);
		},
	});

	app.put("/templates/:name", {
		schema: { params: NameParams, querystring: CwdQuery, body: TemplateUpdateBody, response: { 200: TemplateListSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = where(req.query.cwd);
			const { scope, ...input } = req.body;
			saveTemplate(scope, cwd, home, req.params.name, input, false);
			changed();
			return listTemplates(defaultWorkdir(), cwd, home);
		},
	});

	app.delete("/templates/:name", {
		schema: { params: NameParams, querystring: ScopeQuery, response: { 200: TemplateListSchema, ...errors(400, 401, 404) } },
		handler: async (req) => {
			const cwd = where(req.query.cwd);
			removeTemplate(req.query.scope, cwd, home, req.params.name);
			changed();
			return listTemplates(defaultWorkdir(), cwd, home);
		},
	});
}

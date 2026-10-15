import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { errors } from "./schemas.ts";
import type { TemplateService } from "./templates.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

export const TemplateListResult = Type.Object({
	cwd: Type.String(),
	templates: Type.Array(Type.Object({
		name: Type.String(),
		description: Type.String(),
		path: Type.String(),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
	})),
	warnings: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
});

const ListQuery = Type.Object({ cwd: Type.Optional(Type.String({ maxLength: 4096 })) });

/** Templates are plain files discovered on every request; there is nothing to store. */
export function registerTemplateRoutes(server: FastifyInstance, templates: TemplateService): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/templates", {
		schema: { querystring: ListQuery, response: { 200: TemplateListResult, ...errors(400, 401) } },
		handler: async (req) => templates.list(req.query.cwd),
	});
}

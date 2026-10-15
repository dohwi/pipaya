import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import { errors, IdParams } from "./schemas.ts";
import type { SkillService } from "./skills.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

export const SkillListResult = Type.Object({
	cwd: Type.String(),
	project: Type.String({ description: "Key of the project override bucket (git root of cwd, else cwd)" }),
	skills: Type.Array(Type.Object({
		name: Type.String(),
		description: Type.String(),
		path: Type.String(),
		scope: Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("builtin")], { description: "builtin: ships with the server" }),
		modelInvocable: Type.Boolean({ description: "false: disable-model-invocation, never advertised to the model" }),
		enabled: Type.Boolean({ description: "Effective state in this project" }),
		globalEnabled: Type.Boolean(),
		override: Type.Union([Type.Boolean(), Type.Null()], { description: "Project override; null follows the global default" }),
		sessionOverride: Type.Union([Type.Boolean(), Type.Null()], { description: "Override for the requested sessionId only; null when none" }),
	})),
	warnings: Type.Array(Type.Object({ path: Type.String(), message: Type.String() })),
});

const ListQuery = Type.Object({
	cwd: Type.Optional(Type.String({ maxLength: 4096 })),
	sessionId: Type.Optional(Type.String({ maxLength: 128, description: "Include this session's overrides in `enabled`" })),
});
const SetBody = Type.Object({
	scope: Type.Union([Type.Literal("global"), Type.Literal("project"), Type.Literal("session")]),
	enabled: Type.Union([Type.Boolean(), Type.Null()], { description: "null removes a project/session override" }),
	cwd: Type.Optional(Type.String({ maxLength: 4096 })),
	sessionId: Type.Optional(Type.String({ maxLength: 128, description: "Required for scope session" })),
});

/** Skills are discovered from disk on every request; only on/off switches are stored. */
export function registerSkillRoutes(server: FastifyInstance, skills: SkillService, bus: EventBus): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/skills", {
		schema: { querystring: ListQuery, response: { 200: SkillListResult, ...errors(400, 401) } },
		handler: async (req) => skills.list(req.query.cwd, req.query.sessionId),
	});
	app.put("/skills/:id", {
		schema: { params: IdParams, body: SetBody, response: { 200: SkillListResult, ...errors(400, 401, 404, 409) } },
		handler: async (req) => {
			const result = skills.set(req.params.id, req.body);
			bus.publish(null, "skills_updated", { name: req.params.id, scope: req.body.scope, project: result.project, ...(req.body.sessionId ? { sessionId: req.body.sessionId } : {}) });
			return result;
		},
	});
}

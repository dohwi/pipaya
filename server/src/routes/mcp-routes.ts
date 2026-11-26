import type { FastifyInstance } from "fastify";
import Type from "typebox";
import { McpBody, McpInfo, McpServerBody, McpServerPatchBody, type McpManager } from "../mcp.ts";
import { errors } from "../schemas.ts";
import type { TypeBoxProvider } from "../typebox-provider.ts";

const NameParam = Type.Object({ name: Type.String({ minLength: 1, maxLength: 64 }) });

/** MCP servers: list with connection state, add/patch/remove one server, replace the whole list, and reconnect. */
export function registerMcpRoutes(server: FastifyInstance, mcp: McpManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/mcp", {
		schema: { response: { 200: McpInfo, ...errors(401) } },
		handler: async () => mcp.info(),
	});
	app.post("/mcp", {
		schema: { body: McpServerBody, response: { 201: McpInfo, ...errors(400, 401, 409) } },
		handler: async (req, reply) => reply.code(201).send(mcp.add(req.body)),
	});
	app.patch("/mcp/:name", {
		schema: { params: NameParam, body: McpServerPatchBody, response: { 200: McpInfo, ...errors(400, 401, 404) } },
		handler: async (req) => mcp.patch(req.params.name, req.body),
	});
	app.delete("/mcp/:name", {
		schema: { params: NameParam, response: { 200: McpInfo, ...errors(401, 404) } },
		handler: async (req) => mcp.remove(req.params.name),
	});
	app.put("/mcp", {
		schema: { body: McpBody, response: { 200: McpInfo, ...errors(400, 401) } },
		handler: async (req) => mcp.set(req.body.servers),
	});
	app.post("/mcp/reload", {
		schema: { body: Type.Object({ name: Type.Optional(Type.String()) }), response: { 200: McpInfo, ...errors(400, 401) } },
		handler: async (req) => mcp.reload(req.body.name),
	});
}

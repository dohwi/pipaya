import type { FastifyInstance } from "fastify";
import Type from "typebox";
import type { EventBus } from "./events.ts";
import { McpBody, McpInfo, type McpManager } from "./mcp.ts";
import { errors } from "./schemas.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** MCP servers: the list with each one's connection state, saving the list, and reconnecting. */
export function registerMcpRoutes(server: FastifyInstance, mcp: McpManager): void {
	const app = server.withTypeProvider<TypeBoxProvider>();
	app.get("/mcp", {
		schema: { response: { 200: McpInfo, ...errors(401) } },
		handler: async () => mcp.info(),
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

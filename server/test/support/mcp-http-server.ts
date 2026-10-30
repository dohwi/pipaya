// A tiny MCP server over Streamable HTTP for tests (stateless): one tool, `shout`. Needs the header `x-key: secret`.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

export function startMcpHttp(): { url: string; stop(): void } {
	const srv = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.headers.get("x-key") !== "secret") return new Response("unauthorized", { status: 401 });
			const server = new McpServer({ name: "shout", version: "1.0.0" });
			server.registerTool("shout", { description: "Upper-case the text", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
			const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
			await server.connect(transport);
			return transport.handleRequest(req);
		},
	});
	return { url: `http://127.0.0.1:${srv.port}/mcp`, stop: () => srv.stop(true) };
}

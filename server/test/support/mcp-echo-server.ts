// A tiny MCP server over stdio for tests: one tool, `echo`.
import { appendFileSync, existsSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.MCP_START_LOG) {
	appendFileSync(process.env.MCP_START_LOG, `${process.pid}\n`);
}
if (process.env.MCP_FAIL_FILE && existsSync(process.env.MCP_FAIL_FILE)) {
	console.error(`forced startup failure ${process.env.PREFIX ?? ""}`);
	process.exit(1);
}
const delayMs = Number(process.env.MCP_START_DELAY_MS ?? "0");
if (delayMs > 0) {
	await Bun.sleep(delayMs);
}

const server = new McpServer({ name: "echo", version: "1.0.0" });
server.registerTool("echo", { description: "Repeat the text back", inputSchema: { text: z.string() } }, async ({ text }) => ({
	content: [{ type: "text", text: `${process.env.PREFIX ?? ""}${text}` }],
}));
if (process.env.MCP_EXTRA_TOOL_FILE && existsSync(process.env.MCP_EXTRA_TOOL_FILE)) {
	server.registerTool("ping", { description: "Extra tool", inputSchema: {} }, async () => ({
		content: [{ type: "text", text: "pong" }],
	}));
}
await server.connect(new StdioServerTransport());

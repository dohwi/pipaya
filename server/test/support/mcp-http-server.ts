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

export interface StatefulMcpHttp {
	url: string;
	stop(): void;
	readonly initializeCount: number;
	readonly callCount: number;
	expireAllSessions(): void;
	setFailInitialize(status: number | null): void;
	setNextCallStatus(status: number | null): void;
	setAlwaysCallStatus(status: number | null): void;
	pauseInitialize(): { waitUntilStarted: Promise<void>; release: () => void };
}

/** A stateful Streamable HTTP MCP server for tests: issues mcp-session-id and returns 404 for unknown/expired sessions. */
export function startStatefulMcpHttp(): StatefulMcpHttp {
	const sessions = new Map<string, WebStandardStreamableHTTPServerTransport>();
	let initializeCount = 0;
	let callCount = 0;
	let failInitialize: number | null = null;
	let nextCallStatus: number | null = null;
	let alwaysCallStatus: number | null = null;
	let initGate: { started: () => void; wait: Promise<void> } | null = null;

	const srv = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.method === "GET") return new Response("Method Not Allowed", { status: 405 });
			if (req.method === "DELETE") {
				const sid = req.headers.get("mcp-session-id");
				if (sid) sessions.delete(sid);
				return new Response(null, { status: 204 });
			}
			const raw = await req.text();
			let parsed: { method?: string } | undefined;
			try {
				parsed = JSON.parse(raw) as { method?: string };
			} catch {
				return new Response(JSON.stringify({ error: "Invalid JSON" }), { status: 400, headers: { "content-type": "application/json" } });
			}
			const forwarded = new Request(req.url, { method: req.method, headers: req.headers, body: raw });

			if (parsed?.method === "initialize") {
				initializeCount++;
				if (initGate) {
					const gate = initGate;
					initGate = null;
					gate.started();
					await gate.wait;
				}
				if (failInitialize !== null) {
					return new Response(JSON.stringify({ error: `Init failed (${failInitialize})` }), {
						status: failInitialize,
						headers: { "content-type": "application/json" },
					});
				}
				const server = new McpServer({ name: "stateful", version: "1.0.0" });
				server.registerTool("shout", { description: "Upper-case the text", inputSchema: { text: z.string() } }, async ({ text }) => ({
					content: [{ type: "text", text: text.toUpperCase() }],
				}));
				let createdId = "";
				const transport = new WebStandardStreamableHTTPServerTransport({
					sessionIdGenerator: () => {
						createdId = crypto.randomUUID();
						return createdId;
					},
					enableJsonResponse: true,
					onsessioninitialized: (id) => {
						sessions.set(id, transport);
					},
				});
				await server.connect(transport);
				const res = await transport.handleRequest(forwarded);
				if (createdId && !sessions.has(createdId)) sessions.set(createdId, transport);
				return res;
			}

			const sid = req.headers.get("mcp-session-id");
			const transport = sid ? sessions.get(sid) : undefined;
			if (!transport) {
				return new Response(JSON.stringify({ error: "Unknown or expired MCP session" }), {
					status: 404,
					headers: { "content-type": "application/json" },
				});
			}

			if (parsed?.method === "tools/call") {
				callCount++;
				const status = nextCallStatus ?? alwaysCallStatus;
				if (nextCallStatus !== null) nextCallStatus = null;
				if (status !== null) {
					return new Response(JSON.stringify({ error: `Simulated HTTP ${status}` }), {
						status,
						headers: { "content-type": "application/json" },
					});
				}
			}

			return transport.handleRequest(forwarded);
		},
	});

	return {
		url: `http://127.0.0.1:${srv.port}/mcp`,
		stop: () => srv.stop(true),
		get initializeCount() {
			return initializeCount;
		},
		get callCount() {
			return callCount;
		},
		expireAllSessions() {
			sessions.clear();
		},
		setFailInitialize(status) {
			failInitialize = status;
		},
		setNextCallStatus(status) {
			nextCallStatus = status;
		},
		setAlwaysCallStatus(status) {
			alwaysCallStatus = status;
		},
		pauseInitialize() {
			let started!: () => void;
			let release!: () => void;
			const waitUntilStarted = new Promise<void>((r) => { started = r; });
			const wait = new Promise<void>((r) => { release = r; });
			initGate = { started, wait };
			return { waitUntilStarted, release };
		},
	};
}

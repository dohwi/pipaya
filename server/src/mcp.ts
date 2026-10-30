import type { Database } from "bun:sqlite";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Type, { type Static } from "typebox";
import { badRequest } from "./errors.ts";
import type { ToolDef } from "./tools.ts";

/** Shown instead of a stored secret (env value, header value); sending it back keeps the stored one. */
export const MASK = "••••••••";
const SETTING_KEY = "mcp_servers";
const NAME = /^[a-zA-Z0-9_-]{1,32}$/;
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
const MAX_RESULT_CHARS = 50_000;
const MAX_SERVERS = 50;
const MAX_TOOLS_PER_SERVER = 200;

const Strings = Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ maxLength: 4000 }), { maxProperties: 50 });

export const McpServerBody = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 32, description: "Letters, digits, - and _. Part of every tool name (mcp_<name>_<tool>)" }),
	enabled: Type.Boolean(),
	transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")], { description: "stdio: the server starts a local command. http: Streamable HTTP endpoint" }),
	command: Type.Optional(Type.String({ maxLength: 1000, description: "stdio: program to run" })),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 })),
	env: Type.Optional(Strings),
	url: Type.Optional(Type.String({ maxLength: 2000, description: "http: endpoint URL" })),
	headers: Type.Optional(Strings),
}, { additionalProperties: false });
export type McpServerConfig = Static<typeof McpServerBody>;

export const McpBody = Type.Object({ servers: Type.Array(McpServerBody, { maxItems: MAX_SERVERS }) }, { additionalProperties: false });

export const McpInfo = Type.Object({
	servers: Type.Array(Type.Object({
		...McpServerBody.properties,
		status: Type.Union([Type.Literal("off"), Type.Literal("connecting"), Type.Literal("ready"), Type.Literal("error")]),
		error: Type.Optional(Type.String()),
		tools: Type.Array(Type.Object({ name: Type.String(), tool: Type.String(), description: Type.String() })),
	})),
	ready: Type.Integer({ description: "Servers connected right now" }),
	tools: Type.Integer({ description: "Tools the connected servers offer" }),
});

type Status = "off" | "connecting" | "ready" | "error";
interface RemoteTool { name: string; tool: string; description: string; schema: Record<string, unknown> }
interface Conn { status: Status; error?: string; client?: Client; tools: RemoteTool[]; gen: number }

const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const mask = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.keys(r).map((k) => [k, MASK])) : undefined);

/** Servers that speak the Model Context Protocol; their tools reach every session as `mcp_<server>_<tool>`. */
export class McpManager {
	private conns = new Map<string, Conn>();
	private gen = 0;

	constructor(private db: Database, private onChange: () => void = () => {}) {}

	private config(): McpServerConfig[] {
		const row = this.db.query("SELECT data FROM settings WHERE key = $k").get({ k: SETTING_KEY }) as { data: string } | null;
		if (!row) return [];
		try {
			const parsed: unknown = JSON.parse(row.data);
			return Array.isArray(parsed) ? (parsed as McpServerConfig[]) : [];
		} catch {
			return [];
		}
	}

	/** Connect everything that is switched on (in the background; failures show up as a server's error). */
	start(): void {
		this.sync(this.config());
	}

	info(): Static<typeof McpInfo> {
		const servers = this.config().map((c) => {
			const conn = this.conns.get(c.name);
			const status: Status = !c.enabled ? "off" : (conn?.status ?? "connecting");
			return {
				...c,
				env: mask(c.env),
				headers: mask(c.headers),
				status,
				...(conn?.error && status === "error" ? { error: conn.error } : {}),
				tools: status === "ready" ? (conn?.tools ?? []).map(({ name, tool, description }) => ({ name, tool, description })) : [],
			};
		});
		return { servers, ready: servers.filter((s) => s.status === "ready").length, tools: servers.reduce((n, s) => n + s.tools.length, 0) };
	}

	set(input: McpServerConfig[]): Static<typeof McpInfo> {
		const old = new Map(this.config().map((c) => [c.name, c]));
		const seen = new Set<string>();
		const next = input.map((raw) => {
			const c: McpServerConfig = { ...raw, name: raw.name.trim() };
			if (!NAME.test(c.name)) throw badRequest(`invalid server name "${c.name}": use letters, digits, - and _ (up to 32)`);
			if (seen.has(c.name.toLowerCase())) throw badRequest(`duplicate server name "${c.name}"`);
			seen.add(c.name.toLowerCase());
			if (c.transport === "stdio") {
				if (!c.command?.trim()) throw badRequest(`${c.name}: command is required`);
				delete c.url;
				delete c.headers;
			} else {
				try {
					const u = new URL(c.url ?? "");
					if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error();
				} catch {
					throw badRequest(`${c.name}: url must be an http(s) address`);
				}
				delete c.command;
				delete c.args;
				delete c.env;
			}
			// A masked value means "unchanged": put the stored secret back.
			const before = old.get(c.name);
			for (const key of ["env", "headers"] as const) {
				const rec = c[key];
				if (!rec) continue;
				c[key] = Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, v === MASK ? (before?.[key]?.[k] ?? "") : v]));
			}
			return c;
		});
		this.db.query("INSERT INTO settings (key, data) VALUES ($k, $d) ON CONFLICT(key) DO UPDATE SET data = $d").run({ k: SETTING_KEY, d: JSON.stringify(next) });
		this.sync(next, old);
		return this.info();
	}

	/** Reconnect one server (or all). */
	reload(name?: string): Static<typeof McpInfo> {
		const cfg = this.config();
		if (name && !cfg.some((c) => c.name === name)) throw badRequest(`unknown server "${name}"`);
		this.sync(cfg, undefined, name ?? "");
		return this.info();
	}

	private sync(cfg: McpServerConfig[], old?: Map<string, McpServerConfig>, force?: string): void {
		const names = new Set(cfg.map((c) => c.name));
		for (const name of [...this.conns.keys()]) if (!names.has(name)) this.drop(name);
		for (const c of cfg) {
			const unchanged = !old || JSON.stringify(old.get(c.name)) === JSON.stringify(c);
			const forced = force === "" || force === c.name;
			if (this.conns.has(c.name) && unchanged && !forced) continue;
			this.drop(c.name);
			if (c.enabled) void this.connect(c);
		}
		this.onChange();
	}

	private drop(name: string): void {
		const conn = this.conns.get(name);
		this.conns.delete(name);
		if (conn?.client) void conn.client.close().catch(() => {});
	}

	private async connect(c: McpServerConfig): Promise<void> {
		const conn: Conn = { status: "connecting", tools: [], gen: ++this.gen };
		this.conns.set(c.name, conn);
		const current = () => this.conns.get(c.name) === conn;
		const client = new Client({ name: "pipaya", version: "1.0.0" });
		try {
			const transport = c.transport === "stdio"
				? new StdioClientTransport({ command: c.command!, args: c.args ?? [], env: { ...(process.env as Record<string, string>), ...(c.env ?? {}) }, stderr: "ignore" })
				: new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers: c.headers ?? {} } });
			conn.client = client;
			client.onclose = () => {
				if (current() && conn.status === "ready") {
					conn.status = "error";
					conn.error = "Connection closed";
					conn.tools = [];
					this.onChange();
				}
			};
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
			const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
			if (!current()) {
				void client.close().catch(() => {});
				return;
			}
			const used = new Set<string>();
			conn.tools = listed.tools.slice(0, MAX_TOOLS_PER_SERVER).map((t) => {
				const base = `mcp_${clean(c.name)}_${clean(t.name)}`.slice(0, 64);
				let name = base;
				for (let i = 2; used.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
				used.add(name);
				return { name, tool: t.name, description: t.description ?? t.title ?? "", schema: { ...(t.inputSchema as Record<string, unknown>), type: "object" } };
			});
			conn.status = "ready";
		} catch (e) {
			if (!current()) return;
			conn.status = "error";
			conn.error = (e instanceof Error ? e.message : String(e)).slice(0, 500);
			conn.tools = [];
			void client.close().catch(() => {});
		}
		this.onChange();
	}

	/** Tools of the connected servers, ready to be added to the built-in ones. */
	toolDefs(): Record<string, ToolDef> {
		const defs: Record<string, ToolDef> = {};
		for (const [server, conn] of this.conns) {
			if (conn.status !== "ready") continue;
			for (const t of conn.tools) {
				const description = `[MCP: ${server}] ${t.description || t.tool}`.slice(0, 2000);
				defs[t.name] = {
					name: t.name,
					description,
					create: () => ({
						name: t.name,
						label: `${server}: ${t.tool}`,
						description,
						parameters: t.schema as any,
						execute: (_id, params, signal) => this.call(server, t.tool, params as Record<string, unknown>, signal),
					}) as AgentTool<any>,
				};
			}
		}
		return defs;
	}

	/** Every MCP tool is offered to every session while its server is connected. */
	toolNames(): string[] {
		return Object.keys(this.toolDefs());
	}

	private async call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<any>> {
		const conn = this.conns.get(server);
		if (!conn?.client || conn.status !== "ready") throw new Error(`MCP server "${server}" is not connected`);
		const res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
		const content: AgentToolResult<any>["content"] = [];
		let chars = 0;
		const push = (s: string) => {
			const room = Math.max(0, MAX_RESULT_CHARS - chars);
			chars += s.length;
			content.push({ type: "text", text: s.length > room ? `${s.slice(0, room)}\n[truncated]` : s });
		};
		for (const part of (res.content as any[] | undefined) ?? []) {
			if (part.type === "text") push(String(part.text ?? ""));
			else if (part.type === "image" && typeof part.data === "string") content.push({ type: "image", data: part.data, mimeType: String(part.mimeType ?? "image/png") });
			else if (part.type === "resource" && part.resource && typeof part.resource.text === "string") push(part.resource.text);
			else push(JSON.stringify(part));
		}
		if (!content.length) push(res.structuredContent ? JSON.stringify(res.structuredContent) : "(no output)");
		const out: AgentToolResult<any> = { content, details: { server, tool } };
		if (res.isError) (out as { isError?: boolean }).isError = true;
		return out;
	}

	async close(): Promise<void> {
		const all = [...this.conns.keys()];
		for (const name of all) this.drop(name);
	}
}

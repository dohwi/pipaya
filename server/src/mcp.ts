import type { Database } from "bun:sqlite";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport, StreamableHTTPError } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Type, { type Static } from "typebox";
import { badRequest, conflict, notFound } from "./errors.ts";
import { DEFAULT_LIMITS } from "./image-resize-core.ts";
import { resizeImage } from "./image-resize.ts";
import { buildChildEnv, type ToolDef } from "./tools.ts";

/** Shown instead of a stored secret (env value, header value); sending it back keeps the stored one. */
export const MASK = "••••••••";
const SETTING_KEY = "mcp_servers";
const NAME = /^[a-zA-Z0-9_-]{1,32}$/;
const CONNECT_TIMEOUT_MS = 20_000;
const CALL_TIMEOUT_MS = 120_000;
export const MAX_RESULT_CHARS = 50_000;
const MAX_SERVERS = 50;
const MAX_TOOLS_PER_SERVER = 200;
export const MAX_TOTAL_MCP_TOOLS = 128;
export const MAX_MCP_IMAGE_RAW_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 2000;
const MAX_ERROR_CHARS = 1000;

const Strings = Type.Record(Type.String({ minLength: 1, maxLength: 200 }), Type.String({ maxLength: 4000 }), { maxProperties: 50 });
const PatchStrings = Type.Record(
	Type.String({ minLength: 1, maxLength: 200 }),
	Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
	{ maxProperties: 50 },
);
const ToolFilterList = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 });

export const McpServerBody = Type.Object({
	name: Type.String({ minLength: 1, maxLength: 32, description: "Letters, digits, - and _. Part of every tool name (mcp_<name>_<tool>)" }),
	enabled: Type.Boolean(),
	transport: Type.Union([Type.Literal("stdio"), Type.Literal("http")], { description: "stdio: the server starts a local command. http: Streamable HTTP endpoint" }),
	command: Type.Optional(Type.String({ maxLength: 1000, description: "stdio: program to run" })),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 })),
	env: Type.Optional(Strings),
	inheritEnv: Type.Optional(Type.Boolean({ description: "stdio: inherit full host environment (still excluding PIPAYA_*) instead of filtered defaults" })),
	url: Type.Optional(Type.String({ maxLength: 2000, description: "http: endpoint URL" })),
	headers: Type.Optional(Strings),
	allowTools: Type.Optional(ToolFilterList),
	denyTools: Type.Optional(ToolFilterList),
}, { additionalProperties: false });
export type McpServerConfig = Static<typeof McpServerBody>;

export const McpServerPatchBody = Type.Object({
	enabled: Type.Optional(Type.Boolean()),
	transport: Type.Optional(Type.Union([Type.Literal("stdio"), Type.Literal("http")])),
	command: Type.Optional(Type.String({ maxLength: 1000 })),
	args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50 })),
	env: Type.Optional(Type.Union([PatchStrings, Type.Null()])),
	inheritEnv: Type.Optional(Type.Boolean()),
	url: Type.Optional(Type.String({ maxLength: 2000 })),
	headers: Type.Optional(Type.Union([PatchStrings, Type.Null()])),
	allowTools: Type.Optional(Type.Union([ToolFilterList, Type.Null()])),
	denyTools: Type.Optional(Type.Union([ToolFilterList, Type.Null()])),
}, { additionalProperties: false });
export type McpServerPatch = Static<typeof McpServerPatchBody>;

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
	truncatedTools: Type.Optional(Type.Integer({ description: "Tools dropped because total MCP tools exceeded MAX_TOTAL_MCP_TOOLS" })),
});

/** Builds the environment for a stdio MCP server: filtered by default, or full host env (excluding PIPAYA_*) when `inheritEnv` is true. */
export function buildMcpStdioEnv(
	c: Pick<McpServerConfig, "env" | "inheritEnv">,
	source: Record<string, string | undefined> = process.env,
): Record<string, string> {
	if (c.inheritEnv) {
		const base: Record<string, string> = {};
		for (const [k, v] of Object.entries(source)) {
			if (v !== undefined && !/^PIPAYA_/i.test(k)) base[k] = v;
		}
		return { ...base, ...(c.env ?? {}) };
	}
	return { ...buildChildEnv(source), ...(c.env ?? {}) };
}

type Status = "off" | "connecting" | "ready" | "error";
interface RemoteTool { name: string; tool: string; description: string; schema: Record<string, unknown> }
interface Conn {
	status: Status;
	error?: string;
	stderrTail: string;
	client?: Client;
	tools: RemoteTool[];
	gen: number;
	ready: Promise<void>;
	resolveReady: () => void;
	config: McpServerConfig;
	replacedByReconnect?: boolean;
}

/** Returns true when a Streamable HTTP MCP error signals an unknown or expired server session (HTTP 404). */
export function isHttpSessionExpiredError(err: unknown): boolean {
	return err instanceof StreamableHTTPError && err.code === 404;
}

function abortError(signal: AbortSignal): Error {
	if (signal.reason instanceof Error) return signal.reason;
	const err = new Error(typeof signal.reason === "string" && signal.reason ? signal.reason : "Aborted");
	err.name = "AbortError";
	return err;
}

async function waitForReady(conn: Conn, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError(signal);
	if (!signal) {
		await conn.ready;
		return;
	}
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(abortError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			conn.ready.then(resolve);
		});
	} finally {
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}

const clean = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, "_");
const mask = (r?: Record<string, string>) => (r ? Object.fromEntries(Object.keys(r).map((k) => [k, MASK])) : undefined);

function mergePatchRecord(
	existing: Record<string, string> | undefined,
	patch: Record<string, string | null> | null | undefined,
	field: string,
): Record<string, string> | undefined {
	if (patch === undefined) return existing;
	if (patch === null) return undefined;
	const merged: Record<string, string> = { ...(existing ?? {}) };
	for (const [k, v] of Object.entries(patch)) {
		if (v === null) delete merged[k];
		else if (v === MASK) {
			if (existing && k in existing) merged[k] = existing[k]!;
		} else merged[k] = v;
	}
	if (Object.keys(merged).length > 50) throw badRequest(`${field}: at most 50 entries are allowed`);
	return Object.keys(merged).length ? merged : undefined;
}

function redactSecrets(text: string, config: McpServerConfig): string {
	const raw = [
		...Object.values(config.env ?? {}),
		...Object.values(config.headers ?? {}),
	];
	const secrets = new Set<string>();
	for (const v of raw) {
		if (v.length >= 4) secrets.add(v);
		// Also redact the credential part after a scheme prefix (e.g. "Bearer <token>").
		const scheme = /^\S+\s+(.{4,})$/.exec(v.trim());
		if (scheme?.[1]) secrets.add(scheme[1]);
	}
	if (!secrets.size) return text;
	// Longest first so a shorter secret substring cannot split a longer secret mid-replacement.
	const ordered = [...secrets].sort((a, b) => b.length - a.length);
	let out = text;
	for (const s of ordered) out = out.replaceAll(s, MASK);
	return out;
}

function formatConnectError(base: string, stderrTail: string, config: McpServerConfig): string {
	const safeBase = redactSecrets(base.trim(), config);
	const safeStderr = redactSecrets(stderrTail.trim(), config);
	if (!safeStderr || safeBase.includes(safeStderr)) return safeBase.slice(0, MAX_ERROR_CHARS);
	const basePart = safeBase.slice(0, Math.min(safeBase.length, 300));
	const budget = MAX_ERROR_CHARS - basePart.length - 1;
	if (budget <= 0) return basePart.slice(0, MAX_ERROR_CHARS);
	// Keep the tail of stderr, where the actual failure cause usually appears.
	const tail = safeStderr.length > budget ? `…${safeStderr.slice(-(budget - 1))}` : safeStderr;
	return `${basePart}\n${tail}`;
}

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
		const usedNames = new Set<string>();
		const servers = this.config().map((c) => {
			const conn = this.conns.get(c.name);
			const status: Status = !c.enabled ? "off" : (conn?.status ?? "connecting");
			const tools = status === "ready"
				? (conn?.tools ?? []).map(({ name, tool, description }) => {
					let unique = name;
					for (let i = 2; usedNames.has(unique); i++) {
						const suffix = `_${i}`;
						unique = `${name.slice(0, 64 - suffix.length)}${suffix}`;
					}
					usedNames.add(unique);
					return { name: unique, tool, description };
				})
				: [];
			return {
				...c,
				env: mask(c.env),
				headers: mask(c.headers),
				status,
				...(conn?.error && status === "error" ? { error: conn.error } : {}),
				tools,
			};
		});
		const totalTools = servers.reduce((n, s) => n + s.tools.length, 0);
		return {
			servers,
			ready: servers.filter((s) => s.status === "ready").length,
			tools: Math.min(totalTools, MAX_TOTAL_MCP_TOOLS),
			truncatedTools: Math.max(0, totalTools - MAX_TOTAL_MCP_TOOLS),
		};
	}

	set(input: McpServerConfig[]): Static<typeof McpInfo> {
		if (input.length > MAX_SERVERS) throw badRequest(`at most ${MAX_SERVERS} MCP servers are allowed`);
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
				delete c.inheritEnv;
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

	/** Add a single MCP server without touching existing servers. */
	add(raw: McpServerConfig): Static<typeof McpInfo> {
		const name = raw.name.trim();
		const cfg = this.config();
		if (cfg.some((c) => c.name.toLowerCase() === name.toLowerCase())) throw conflict(`MCP server "${name}" already exists`);
		if (cfg.length >= MAX_SERVERS) throw badRequest(`at most ${MAX_SERVERS} MCP servers are allowed`);
		return this.set([...cfg, { ...raw, name }]);
	}

	/** Update one MCP server in place, merging env/headers and preserving untouched fields and secrets. */
	patch(name: string, patch: McpServerPatch): Static<typeof McpInfo> {
		const target = name.trim();
		const cfg = this.config();
		const idx = cfg.findIndex((c) => c.name.toLowerCase() === target.toLowerCase());
		if (idx < 0) throw notFound(`MCP server "${target}"`);
		const cur = cfg[idx]!;
		const merged: McpServerConfig = {
			...cur,
			...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
			...(patch.transport !== undefined ? { transport: patch.transport } : {}),
			...(patch.command !== undefined ? { command: patch.command } : {}),
			...(patch.args !== undefined ? { args: patch.args } : {}),
			...(patch.inheritEnv !== undefined ? { inheritEnv: patch.inheritEnv } : {}),
			...(patch.url !== undefined ? { url: patch.url } : {}),
		};
		const env = mergePatchRecord(cur.env, patch.env, "env");
		if (env) merged.env = env;
		else delete merged.env;
		const headers = mergePatchRecord(cur.headers, patch.headers, "headers");
		if (headers) merged.headers = headers;
		else delete merged.headers;
		if (patch.allowTools === null) delete merged.allowTools;
		else if (patch.allowTools !== undefined) merged.allowTools = patch.allowTools;
		if (patch.denyTools === null) delete merged.denyTools;
		else if (patch.denyTools !== undefined) merged.denyTools = patch.denyTools;
		const next = cfg.slice();
		next[idx] = merged;
		return this.set(next);
	}

	/** Remove a single MCP server by name. */
	remove(name: string): Static<typeof McpInfo> {
		const target = name.trim();
		const cfg = this.config();
		const idx = cfg.findIndex((c) => c.name.toLowerCase() === target.toLowerCase());
		if (idx < 0) throw notFound(`MCP server "${target}"`);
		const next = cfg.slice();
		next.splice(idx, 1);
		return this.set(next);
	}

	/** Reconnect one server (or all). */
	reload(name?: string): Static<typeof McpInfo> {
		const cfg = this.config();
		const resolved = name ? cfg.find((c) => c.name.toLowerCase() === name.trim().toLowerCase())?.name : undefined;
		if (name && !resolved) throw badRequest(`unknown server "${name}"`);
		this.sync(cfg, undefined, resolved ?? "");
		return this.info();
	}

	/** Wait for one server (or all currently connecting servers) to finish their connection attempt, up to `timeoutMs`. */
	async waitFor(name?: string, timeoutMs = 25_000, signal?: AbortSignal): Promise<Static<typeof McpInfo>> {
		if (signal?.aborted) return this.info();
		const targetKey = name
			? [...this.conns.keys()].find((k) => k.toLowerCase() === name.trim().toLowerCase())
			: undefined;
		const pending = name
			? [targetKey ? this.conns.get(targetKey)?.ready : undefined].filter((p): p is Promise<void> => !!p)
			: [...this.conns.values()].map((c) => c.ready);
		if (!pending.length) return this.info();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			await Promise.race([
				Promise.all(pending),
				new Promise<void>((resolve) => {
					timer = setTimeout(resolve, Math.max(0, timeoutMs));
					if (signal) {
						onAbort = () => resolve();
						signal.addEventListener("abort", onAbort, { once: true });
					}
				}),
			]);
		} finally {
			if (timer !== undefined) clearTimeout(timer);
			if (signal && onAbort) signal.removeEventListener("abort", onAbort);
		}
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
			if (c.enabled) this.connect(c);
		}
		this.onChange();
	}

	private drop(name: string): void {
		const conn = this.conns.get(name);
		this.conns.delete(name);
		conn?.resolveReady();
		if (conn?.client) void conn.client.close().catch(() => {});
	}

	private connect(c: McpServerConfig): Conn {
		let resolveReady!: () => void;
		const ready = new Promise<void>((resolve) => { resolveReady = resolve; });
		const conn: Conn = { status: "connecting", stderrTail: "", tools: [], gen: ++this.gen, ready, resolveReady, config: c };
		this.conns.set(c.name, conn);
		void this.runConnect(c, conn);
		return conn;
	}

	private async runConnect(c: McpServerConfig, conn: Conn): Promise<void> {
		const current = () => this.conns.get(c.name) === conn;
		const client = new Client({ name: "pipaya", version: "1.0.0" });
		try {
			const transport = c.transport === "stdio"
				? new StdioClientTransport({ command: c.command!, args: c.args ?? [], env: buildMcpStdioEnv(c), stderr: "pipe" })
				: new StreamableHTTPClientTransport(new URL(c.url!), { requestInit: { headers: c.headers ?? {} } });
			if (transport instanceof StdioClientTransport && transport.stderr) {
				transport.stderr.on("data", (chunk: Buffer | string) => {
					const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
					const next = redactSecrets(conn.stderrTail + piece, c);
					conn.stderrTail = next.length > MAX_STDERR_CHARS ? next.slice(-MAX_STDERR_CHARS) : next;
				});
			}
			conn.client = client;
			client.onclose = () => {
				if (current() && conn.status === "ready") {
					conn.status = "error";
					conn.error = formatConnectError("Connection closed", conn.stderrTail, c);
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
			const allow = c.allowTools !== undefined ? new Set(c.allowTools) : null;
			const deny = c.denyTools?.length ? new Set(c.denyTools) : null;
			const used = new Set<string>();
			conn.tools = listed.tools
				.slice(0, MAX_TOOLS_PER_SERVER)
				.map((t) => {
					const base = `mcp_${clean(c.name)}_${clean(t.name)}`.slice(0, 64);
					let name = base;
					for (let i = 2; used.has(name); i++) name = `${base.slice(0, 60)}_${i}`;
					used.add(name);
					return { name, tool: t.name, description: t.description ?? t.title ?? "", schema: { ...(t.inputSchema as Record<string, unknown>), type: "object" } };
				})
				.filter((t) => {
					if (allow && !allow.has(t.tool) && !allow.has(t.name)) return false;
					if (deny && (deny.has(t.tool) || deny.has(t.name))) return false;
					return true;
				});
			conn.status = "ready";
		} catch (e) {
			if (!current()) return;
			conn.status = "error";
			conn.error = formatConnectError(e instanceof Error ? e.message : String(e), conn.stderrTail, c);
			conn.tools = [];
			void client.close().catch(() => {});
		} finally {
			conn.resolveReady();
		}
		this.onChange();
	}

	/** Tools of the connected servers, in deterministic config/sorted order, capped globally at MAX_TOTAL_MCP_TOOLS. */
	toolDefs(): Record<string, ToolDef> {
		const defs: Record<string, ToolDef> = {};
		const orderedNames: string[] = [];
		const seen = new Set<string>();
		for (const c of this.config()) {
			if (this.conns.has(c.name) && !seen.has(c.name)) {
				seen.add(c.name);
				orderedNames.push(c.name);
			}
		}
		for (const name of [...this.conns.keys()].sort()) {
			if (!seen.has(name)) orderedNames.push(name);
		}
		let total = 0;
		const usedNames = new Set<string>();
		for (const server of orderedNames) {
			const conn = this.conns.get(server);
			if (!conn || conn.status !== "ready") continue;
			for (const t of conn.tools) {
				if (total >= MAX_TOTAL_MCP_TOOLS) return defs;
				total++;
				let exposedName = t.name;
				for (let i = 2; usedNames.has(exposedName); i++) {
					const suffix = `_${i}`;
					exposedName = `${t.name.slice(0, 64 - suffix.length)}${suffix}`;
				}
				usedNames.add(exposedName);
				const description = `[MCP: ${server}] ${t.description || t.tool}`.slice(0, 2000);
				defs[exposedName] = {
					name: exposedName,
					description,
					create: () => ({
						name: exposedName,
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

	private async reconnectHttp(server: string, stale: Conn, originalError: unknown, signal?: AbortSignal): Promise<Conn> {
		if (signal?.aborted) throw abortError(signal);
		let target = this.conns.get(server);
		if (!target) throw new Error(`MCP server "${server}" is not connected`);
		if (target === stale) {
			// Single-flight leader: install the replacement Conn synchronously before closing the stale client so
			// stale.client.onclose sees current() === false and concurrent callers share `target.ready`.
			stale.replacedByReconnect = true;
			target = this.connect(stale.config);
			if (stale.client) void stale.client.close().catch(() => {});
		}
		await waitForReady(target, signal);
		if (signal?.aborted) throw abortError(signal);
		if (this.conns.get(server) !== target) throw new Error(`MCP server "${server}" is not connected`);
		if (!target.client || target.status !== "ready") {
			throw target.error
				? new Error(`MCP server "${server}" reconnect failed: ${target.error}`, { cause: originalError })
				: new Error(`MCP server "${server}" is not connected`, { cause: originalError });
		}
		return target;
	}

	private async call(server: string, tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<AgentToolResult<any>> {
		if (signal?.aborted) throw abortError(signal);
		let conn = this.conns.get(server);
		while (conn?.status === "connecting") {
			const cur = conn;
			await waitForReady(cur, signal);
			if (signal?.aborted) throw abortError(signal);
			conn = this.conns.get(server);
			if (conn === cur) break;
		}
		if (!conn?.client || conn.status !== "ready") throw new Error(`MCP server "${server}" is not connected`);
		let res: unknown;
		try {
			res = await conn.client.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
		} catch (err) {
			if (signal?.aborted || conn.config.transport !== "http" || (!isHttpSessionExpiredError(err) && !conn.replacedByReconnect)) {
				throw err;
			}
			const next = await this.reconnectHttp(server, conn, err, signal);
			res = await next.client!.callTool({ name: tool, arguments: args }, undefined, { signal, timeout: CALL_TIMEOUT_MS });
		}
		return formatMcpToolResult(server, tool, res as { content?: unknown; structuredContent?: unknown; isError?: unknown }, signal);
	}

	async close(): Promise<void> {
		const all = [...this.conns.keys()];
		for (const name of all) this.drop(name);
	}
}

export async function formatMcpToolResult(
	server: string,
	tool: string,
	res: { content?: unknown; structuredContent?: unknown; isError?: unknown },
	signal?: AbortSignal,
	resizer: typeof resizeImage = resizeImage,
): Promise<AgentToolResult<any>> {
	const content: AgentToolResult<any>["content"] = [];
	let chars = 0;
	let truncated = false;
	const push = (s: string) => {
		if (truncated) return;
		const room = MAX_RESULT_CHARS - chars;
		if (s.length > room) {
			truncated = true;
			chars = MAX_RESULT_CHARS;
			content.push({ type: "text", text: `${s.slice(0, Math.max(0, room))}\n[truncated]` });
		} else {
			chars += s.length;
			content.push({ type: "text", text: s });
		}
	};
	for (const part of (Array.isArray(res.content) ? res.content : []) as any[]) {
		if (part.type === "text") {
			push(String(part.text ?? ""));
		} else if (part.type === "image" && typeof part.data === "string") {
			const approxBytes = Math.floor((part.data.length * 3) / 4);
			if (approxBytes > MAX_MCP_IMAGE_RAW_BYTES) {
				push("[MCP image omitted: exceeds 10 MB size limit]");
				continue;
			}
			const raw = Buffer.from(part.data, "base64");
			if (raw.byteLength > MAX_MCP_IMAGE_RAW_BYTES) {
				push("[MCP image omitted: exceeds 10 MB size limit]");
				continue;
			}
			const resized = await resizer(raw, DEFAULT_LIMITS, signal);
			if (resized) {
				content.push({ type: "image", data: resized.data, mimeType: resized.mimeType });
			} else {
				push("[MCP image omitted: image could not be decoded or resized to fit model limits]");
			}
		} else if (part.type === "resource" && part.resource && typeof part.resource.text === "string") {
			push(part.resource.text);
		} else {
			push(JSON.stringify(part));
		}
	}
	if (!content.length) push(res.structuredContent ? JSON.stringify(res.structuredContent) : "(no output)");
	const out: AgentToolResult<any> = { content, details: { server, tool } };
	if (res.isError) (out as { isError?: boolean }).isError = true;
	return out;
}

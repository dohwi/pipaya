import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
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
const MAX_CACHED_TOOLS_JSON_CHARS = 512_000;
const CACHED_TOOL_NAME_RE = /^mcp_[a-zA-Z0-9_-]{1,60}$/;
export const MAX_TOTAL_MCP_TOOLS = 128;
/** When active MCP tools exceed this count, sessions expose `mcp_search` instead of injecting every MCP tool schema upfront. */
export const MCP_DEFERRED_THRESHOLD = 15;
export const MCP_SEARCH_TOOL = "mcp_search";
export const MAX_MCP_IMAGE_RAW_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_CHARS = 2000;
const MAX_ERROR_CHARS = 1000;
const MAX_SEARCH_SUMMARY_CHARS = 120;
const DEFAULT_SEARCH_LIMIT = 20;
const DEFAULT_BROWSE_LIMIT = 50;

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
export interface McpCatalogEntry {
	name: string;
	server: string;
	tool: string;
	description: string;
	fullDescription: string;
	schema: Record<string, unknown>;
}
export interface McpSearchSessionHooks {
	getLoaded(): ReadonlySet<string>;
	load(names: readonly string[]): { loaded: string[]; alreadyLoaded: string[] };
}
export interface McpSearchResult {
	entries: McpCatalogEntry[];
	totalMatched: number;
	totalTools: number;
	servers: { name: string; count: number }[];
	unknownServer?: string;
}

const McpSearchParams = Type.Object({
	query: Type.Optional(Type.String({
		maxLength: 200,
		description: "Case-insensitive keyword(s) matched against tool name, server name, or description. Omit (with no load args) to browse a compact summary of available MCP tools.",
	})),
	server: Type.Optional(Type.String({
		maxLength: 64,
		description: "Filter search results to a single MCP server name (case-insensitive).",
	})),
	limit: Type.Optional(Type.Integer({
		minimum: 1,
		maximum: 100,
		description: "Maximum number of search results to return (default 20 for filtered search, 50 for full browse; max 100).",
	})),
	load: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 100 }), {
		maxItems: 50,
		description: "Exact exposed MCP tool names (e.g. `mcp_search_web_search`) to load into this session. Loaded tools become callable starting on the next step.",
	})),
	loadServer: Type.Optional(Type.String({
		maxLength: 64,
		description: "Load all active tools from this MCP server (case-insensitive server name) into this session.",
	})),
}, { additionalProperties: false });

function summarizeCatalogServers(catalog: readonly McpCatalogEntry[]): { name: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const entry of catalog) {
		counts.set(entry.server, (counts.get(entry.server) ?? 0) + 1);
	}
	return [...counts.entries()].map(([name, count]) => ({ name, count }));
}

function oneLineSummary(text: string): string {
	const line = text.replace(/\r?\n[\s\S]*/, "").trim();
	if (line.length <= MAX_SEARCH_SUMMARY_CHARS) return line;
	return `${line.slice(0, MAX_SEARCH_SUMMARY_CHARS - 1)}…`;
}
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
	lazyStarting?: Promise<void>;
}

/** Deterministic SHA-256 hash of a stdio MCP server's launch & filter config (never stores plaintext env/secrets). */
export function computeStdioConfigHash(c: McpServerConfig): string {
	const sortedEnv = c.env
		? Object.keys(c.env).sort().map((k) => [k, c.env![k]])
		: [];
	const payload = JSON.stringify({
		v: 1,
		name: c.name,
		transport: c.transport,
		command: c.command ?? "",
		args: c.args ?? [],
		env: sortedEnv,
		inheritEnv: Boolean(c.inheritEnv),
		allowTools: c.allowTools ?? null,
		denyTools: c.denyTools ?? null,
	});
	return createHash("sha256").update(payload).digest("hex");
}

function isRemoteTool(v: unknown): v is RemoteTool {
	if (!v || typeof v !== "object" || Array.isArray(v)) return false;
	const o = v as Record<string, unknown>;
	return typeof o.name === "string"
		&& CACHED_TOOL_NAME_RE.test(o.name)
		&& typeof o.tool === "string"
		&& o.tool.length > 0
		&& typeof o.description === "string"
		&& !!o.schema
		&& typeof o.schema === "object"
		&& !Array.isArray(o.schema)
		&& (o.schema as Record<string, unknown>).type === "object";
}

function parseCachedToolsJson(raw: string): RemoteTool[] | null {
	if (raw.length > MAX_CACHED_TOOLS_JSON_CHARS) return null;
	const parsed: unknown = JSON.parse(raw, (key, value) => (key === "__proto__" ? undefined : value));
	if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_TOOLS_PER_SERVER) return null;
	const tools: RemoteTool[] = [];
	for (const item of parsed) {
		if (!isRemoteTool(item)) return null;
		tools.push({
			name: item.name,
			tool: item.tool,
			description: item.description,
			schema: item.schema,
		});
	}
	return tools;
}

function buildRemoteTools(
	c: McpServerConfig,
	listedTools: Awaited<ReturnType<Client["listTools"]>>["tools"],
): RemoteTool[] {
	const allow = c.allowTools !== undefined ? new Set(c.allowTools) : null;
	const deny = c.denyTools?.length ? new Set(c.denyTools) : null;
	const used = new Set<string>();
	return listedTools
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

async function waitForPromise(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
	if (signal?.aborted) throw abortError(signal);
	if (!signal) {
		await promise;
		return;
	}
	let onAbort: (() => void) | undefined;
	try {
		await new Promise<void>((resolve, reject) => {
			onAbort = () => reject(abortError(signal));
			signal.addEventListener("abort", onAbort, { once: true });
			promise.then(resolve, reject);
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
	private initialReady: Promise<void> = Promise.resolve();

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

	/** Connect everything that is switched on (in the background; failures show up as a server's error). Stdio servers with a valid SQLite tool cache start lazily on first tool call. */
	start(): void {
		this.sync(this.config(), undefined, undefined, true);
		const pending = [...this.conns.values()].map((c) => c.ready);
		this.initialReady = pending.length ? Promise.allSettled(pending).then(() => {}) : Promise.resolve();
	}

	private loadToolCache(c: McpServerConfig): RemoteTool[] | null {
		if (c.transport !== "stdio") return null;
		try {
			const row = this.db.query("SELECT config_hash, tools_json FROM mcp_tool_cache WHERE server_name = $name").get({ name: c.name }) as { config_hash: string; tools_json: string } | null;
			if (!row || row.config_hash !== computeStdioConfigHash(c)) return null;
			return parseCachedToolsJson(row.tools_json);
		} catch {
			return null;
		}
	}

	private saveToolCache(c: McpServerConfig, tools: RemoteTool[]): void {
		if (c.transport !== "stdio") return;
		if (tools.length === 0) {
			this.deleteToolCache(c.name);
			return;
		}
		try {
			this.db.query(
				"INSERT INTO mcp_tool_cache (server_name, config_hash, tools_json, updated_at) VALUES ($name, $hash, $tools, $at) ON CONFLICT(server_name) DO UPDATE SET config_hash = $hash, tools_json = $tools, updated_at = $at",
			).run({
				name: c.name,
				hash: computeStdioConfigHash(c),
				tools: JSON.stringify(tools),
				at: Date.now(),
			});
		} catch {
			// Cache persistence is best-effort and must never tear down an active MCP connection.
		}
	}

	private deleteToolCache(name: string): void {
		try {
			this.db.query("DELETE FROM mcp_tool_cache WHERE server_name = $name").run({ name });
		} catch {
			// Best-effort cache cleanup.
		}
	}

	/** Resolves once the initial `start()` connection attempts have settled (ready or error). */
	waitInitial(): Promise<void> {
		return this.initialReady;
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
		const stdioNames = new Set(next.filter((c) => c.transport === "stdio").map((c) => c.name));
		for (const prev of old.values()) {
			if (!stdioNames.has(prev.name)) this.deleteToolCache(prev.name);
		}
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

	private sync(cfg: McpServerConfig[], old?: Map<string, McpServerConfig>, force?: string, useCache = false): void {
		const names = new Set(cfg.map((c) => c.name));
		for (const name of [...this.conns.keys()]) if (!names.has(name)) this.drop(name);
		for (const c of cfg) {
			const unchanged = !old || JSON.stringify(old.get(c.name)) === JSON.stringify(c);
			const forced = force === "" || force === c.name;
			if (this.conns.has(c.name) && unchanged && !forced) continue;
			this.drop(c.name);
			if (!c.enabled) continue;
			if (useCache && !forced && c.transport === "stdio") {
				const cached = this.loadToolCache(c);
				if (cached !== null) {
					this.connectCached(c, cached);
					continue;
				}
			}
			this.connect(c);
		}
		this.onChange();
	}

	private connectCached(c: McpServerConfig, tools: RemoteTool[]): Conn {
		const conn: Conn = {
			status: "ready",
			stderrTail: "",
			tools,
			gen: ++this.gen,
			ready: Promise.resolve(),
			resolveReady: () => {},
			config: c,
		};
		this.conns.set(c.name, conn);
		return conn;
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
			conn.tools = buildRemoteTools(c, listed.tools);
			conn.status = "ready";
			this.saveToolCache(c, conn.tools);
		} catch (e) {
			void client.close().catch(() => {});
			if (!current()) return;
			conn.status = "error";
			conn.error = formatConnectError(e instanceof Error ? e.message : String(e), conn.stderrTail, c);
			conn.tools = [];
			if (c.transport === "stdio") this.deleteToolCache(c.name);
		} finally {
			conn.resolveReady();
		}
		this.onChange();
	}

	private async runLazyConnect(c: McpServerConfig, conn: Conn): Promise<void> {
		const current = () => this.conns.get(c.name) === conn;
		const client = new Client({ name: "pipaya", version: "1.0.0" });
		let connected = false;
		try {
			const transport = new StdioClientTransport({ command: c.command!, args: c.args ?? [], env: buildMcpStdioEnv(c), stderr: "pipe" });
			if (transport.stderr) {
				transport.stderr.on("data", (chunk: Buffer | string) => {
					const piece = typeof chunk === "string" ? chunk : chunk.toString("utf8");
					const next = redactSecrets(conn.stderrTail + piece, c);
					conn.stderrTail = next.length > MAX_STDERR_CHARS ? next.slice(-MAX_STDERR_CHARS) : next;
				});
			}
			conn.client = client;
			client.onclose = () => {
				if (connected && current() && conn.status === "ready" && conn.client === client) {
					conn.status = "error";
					conn.error = formatConnectError("Connection closed", conn.stderrTail, c);
					conn.tools = [];
					conn.client = undefined;
					this.onChange();
				}
			};
			await client.connect(transport, { timeout: CONNECT_TIMEOUT_MS });
			const listed = await client.listTools(undefined, { timeout: CONNECT_TIMEOUT_MS });
			if (!current()) {
				void client.close().catch(() => {});
				return;
			}
			connected = true;
			const prevJson = JSON.stringify(conn.tools);
			conn.tools = buildRemoteTools(c, listed.tools);
			this.saveToolCache(c, conn.tools);
			if (JSON.stringify(conn.tools) !== prevJson) this.onChange();
		} catch (e) {
			void client.close().catch(() => {});
			if (!current()) return;
			conn.client = undefined;
			conn.status = "error";
			conn.error = formatConnectError(e instanceof Error ? e.message : String(e), conn.stderrTail, c);
			conn.tools = [];
			this.deleteToolCache(c.name);
			this.onChange();
		}
	}

	private async ensureLazyConnected(server: string, conn: Conn, signal?: AbortSignal): Promise<Conn> {
		if (signal?.aborted) throw abortError(signal);
		if (!conn.lazyStarting) {
			const p = this.runLazyConnect(conn.config, conn);
			conn.lazyStarting = p;
			void p.finally(() => {
				if (conn.lazyStarting === p) conn.lazyStarting = undefined;
			});
		}
		await waitForPromise(conn.lazyStarting, signal);
		if (signal?.aborted) throw abortError(signal);
		if (this.conns.get(server) !== conn) throw new Error(`MCP server "${server}" is not connected`);
		if (!conn.client || conn.status !== "ready") {
			throw conn.error
				? new Error(`MCP server "${server}" failed to start: ${conn.error}`)
				: new Error(`MCP server "${server}" is not connected`);
		}
		return conn;
	}

	/** Active MCP tools in deterministic config/sorted order, capped globally at MAX_TOTAL_MCP_TOOLS. Never spawns lazy stdio servers. */
	private resolveCatalog(): McpCatalogEntry[] {
		const entries: McpCatalogEntry[] = [];
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
		const usedNames = new Set<string>();
		for (const server of orderedNames) {
			const conn = this.conns.get(server);
			if (!conn || conn.status !== "ready") continue;
			for (const t of conn.tools) {
				if (entries.length >= MAX_TOTAL_MCP_TOOLS) return entries;
				let exposedName = t.name;
				for (let i = 2; usedNames.has(exposedName); i++) {
					const suffix = `_${i}`;
					exposedName = `${t.name.slice(0, 64 - suffix.length)}${suffix}`;
				}
				usedNames.add(exposedName);
				const description = t.description || t.tool;
				const fullDescription = `[MCP: ${server}] ${description}`.slice(0, 2000);
				entries.push({
					name: exposedName,
					server,
					tool: t.tool,
					description,
					fullDescription,
					schema: t.schema,
				});
			}
		}
		return entries;
	}

	/** Tools of the connected servers, in deterministic config/sorted order, capped globally at MAX_TOTAL_MCP_TOOLS. */
	toolDefs(): Record<string, ToolDef> {
		const defs: Record<string, ToolDef> = {};
		for (const e of this.resolveCatalog()) {
			defs[e.name] = {
				name: e.name,
				description: e.fullDescription,
				create: () => ({
					name: e.name,
					label: `${e.server}: ${e.tool}`,
					description: e.fullDescription,
					parameters: e.schema as any,
					execute: (_id, params, signal) => this.call(e.server, e.tool, params as Record<string, unknown>, signal),
				}) as AgentTool<any>,
			};
		}
		return defs;
	}

	/** Every MCP tool is offered to every session while its server is connected. */
	toolNames(): string[] {
		return this.resolveCatalog().map((e) => e.name);
	}

	/** True when active MCP tools exceed MCP_DEFERRED_THRESHOLD and sessions should use on-demand loading via `mcp_search`. */
	isDeferred(): boolean {
		return this.resolveCatalog().length > MCP_DEFERRED_THRESHOLD;
	}

	/**
	 * Removes tool names from `loaded` that are permanently gone (server removed/disabled, or server is `ready` and no
	 * longer exposes the tool due to allowTools/denyTools/update). Tools of enabled servers currently in `connecting` or
	 * transient `error` state are preserved so they return automatically on recovery.
	 */
	pruneStaleLoadedTools(loaded: Set<string>): void {
		if (!loaded.size) return;
		const readyNames = new Set(this.toolNames());
		const transientPrefixes: string[] = [];
		for (const c of this.config()) {
			if (!c.enabled) continue;
			const status = this.conns.get(c.name)?.status ?? "connecting";
			if (status === "connecting" || status === "error") {
				transientPrefixes.push(`mcp_${clean(c.name)}_`);
			}
		}
		for (const name of loaded) {
			if (readyNames.has(name)) continue;
			if (transientPrefixes.some((p) => name.startsWith(p))) continue;
			loaded.delete(name);
		}
	}

	/** Search cached/active MCP tool metadata without spawning lazy stdio processes. */
	searchCatalog(opts?: { query?: string; server?: string; limit?: number }): McpSearchResult {
		const catalog = this.resolveCatalog();
		const servers = summarizeCatalogServers(catalog);
		const serverFilter = opts?.server?.trim() ?? "";
		const queryText = opts?.query?.trim() ?? "";
		let pool = catalog;
		let unknownServer: string | undefined;
		if (serverFilter) {
			const lower = serverFilter.toLowerCase();
			pool = catalog.filter((e) => e.server.toLowerCase() === lower);
			if (pool.length === 0 && !servers.some((s) => s.name.toLowerCase() === lower)) {
				unknownServer = serverFilter;
			}
		}
		let matched: McpCatalogEntry[];
		if (queryText) {
			const lowerQuery = queryText.toLowerCase();
			const tokens = lowerQuery.split(/\s+/).filter(Boolean);
			const ranked: { entry: McpCatalogEntry; tier: number; idx: number }[] = [];
			for (let idx = 0; idx < pool.length; idx++) {
				const entry = pool[idx]!;
				const nameLower = entry.name.toLowerCase();
				const toolLower = entry.tool.toLowerCase();
				const identity = `${nameLower} ${entry.server.toLowerCase()} ${toolLower}`;
				const haystack = `${identity} ${entry.description.toLowerCase()}`;
				if (!tokens.every((tok) => haystack.includes(tok))) continue;
				const tier = (nameLower === lowerQuery || toolLower === lowerQuery)
					? 0
					: tokens.every((tok) => identity.includes(tok))
						? 1
						: 2;
				ranked.push({ entry, tier, idx });
			}
			ranked.sort((a, b) => (a.tier - b.tier) || (a.idx - b.idx));
			matched = ranked.map((r) => r.entry);
		} else {
			matched = pool;
		}
		const defaultLimit = queryText || serverFilter ? DEFAULT_SEARCH_LIMIT : DEFAULT_BROWSE_LIMIT;
		const rawLimit = opts?.limit;
		const limit = typeof rawLimit === "number" && Number.isInteger(rawLimit)
			? Math.max(1, Math.min(100, rawLimit))
			: defaultLimit;
		return {
			entries: matched.slice(0, limit),
			totalMatched: matched.length,
			totalTools: catalog.length,
			servers,
			...(unknownServer ? { unknownServer } : {}),
		};
	}

	/** Lightweight meta-tool for searching and loading deferred MCP tools into a single session. */
	searchToolDef(hooks: McpSearchSessionHooks): ToolDef {
		const initialCatalog = this.resolveCatalog();
		const initialServers = summarizeCatalogServers(initialCatalog);
		const serverSummary = initialServers.map((s) => `${s.name} (${s.count})`).join(", ");
		const description = [
			`Search and load deferred MCP tools into this session (${initialCatalog.length} active tools across ${initialServers.length} server(s): ${serverSummary}).`,
			"Full JSON schemas for MCP tools are not loaded upfront to keep context small.",
			"- Pass `query` (keyword) and/or `server` to find matching tools. Omit both to browse a compact summary of available MCP tools.",
			"- Pass `load` (exact `mcp_<server>_<tool>` names) and/or `loadServer` (server name) to attach their full schemas to this session; loaded tools become callable starting on the next step.",
			"You can search and load in one call or separately. Loaded tools stay available for the rest of this session.",
		].join("\n");

		return {
			name: MCP_SEARCH_TOOL,
			description,
			create: () => ({
				name: MCP_SEARCH_TOOL,
				label: "Search MCP tools",
				description,
				parameters: McpSearchParams,
				execute: async (_id, rawParams) => {
					const params = (rawParams ?? {}) as Static<typeof McpSearchParams>;
					const catalog = this.resolveCatalog();
					const byLowerName = new Map(catalog.map((e) => [e.name.toLowerCase(), e.name]));
					const serverListText = summarizeCatalogServers(catalog).map((s) => `${s.name} (${s.count})`).join(", ") || "none";

					const hasLoadIntent = params.load !== undefined || params.loadServer !== undefined;
					const hasSearchIntent = params.query !== undefined || params.server !== undefined || !hasLoadIntent;

					const toLoad = new Set<string>();
					const notFoundSet = new Set<string>();
					if (Array.isArray(params.load)) {
						for (const raw of params.load) {
							if (typeof raw !== "string") {
								notFoundSet.add(String(raw));
								continue;
							}
							const trimmed = raw.trim();
							const canonical = trimmed ? byLowerName.get(trimmed.toLowerCase()) : undefined;
							if (canonical) toLoad.add(canonical);
							else notFoundSet.add(trimmed || raw);
						}
					}
					if (params.loadServer !== undefined) {
						const target = typeof params.loadServer === "string" ? params.loadServer.trim() : "";
						const lower = target.toLowerCase();
						const serverTools = target ? catalog.filter((e) => e.server.toLowerCase() === lower) : [];
						if (serverTools.length === 0) {
							notFoundSet.add(`server:${target || "(empty)"}`);
						} else {
							for (const e of serverTools) toLoad.add(e.name);
						}
					}

					const { loaded, alreadyLoaded } = hasLoadIntent
						? hooks.load([...toLoad])
						: { loaded: [] as string[], alreadyLoaded: [] as string[] };
					const notFound = [...notFoundSet];

					const sections: string[] = [];
					let matchedCount: number | undefined;

					if (hasLoadIntent) {
						const loadLines: string[] = [];
						if (loaded.length) {
							loadLines.push(`Loaded ${loaded.length} MCP tool(s) into this session (callable from the next step): ${loaded.join(", ")}`);
						}
						if (alreadyLoaded.length) {
							loadLines.push(`Already loaded in this session: ${alreadyLoaded.join(", ")}`);
						}
						if (notFound.length) {
							loadLines.push(`Not found: ${notFound.join(", ")} (available servers: ${serverListText})`);
						}
						if (!loadLines.length) {
							loadLines.push(
								toLoad.size > 0
									? "MCP tool loading is not available in preview mode."
									: `No MCP tools were loaded (empty load list). Available servers: ${serverListText}`,
							);
						}
						sections.push(loadLines.join("\n"));
					}

					if (hasSearchIntent) {
						const res = this.searchCatalog({ query: params.query, server: params.server, limit: params.limit });
						matchedCount = res.totalMatched;
						const currentlyLoaded = hooks.getLoaded();
						const availText = res.servers.map((s) => `${s.name} (${s.count})`).join(", ") || "none";
						if (res.unknownServer) {
							sections.push(`No ready MCP server named "${res.unknownServer}". Available servers: ${availText}`);
						} else if (res.entries.length === 0) {
							const qPart = params.query?.trim() ? ` query "${params.query.trim()}"` : "";
							const sPart = params.server?.trim() ? ` on server "${params.server.trim()}"` : "";
							sections.push(`No MCP tools matched${qPart}${sPart}. Available servers: ${availText}`);
						} else {
							const isBrowse = !params.query?.trim() && !params.server?.trim();
							const lines: string[] = [
								`MCP tools (${res.totalMatched} matching / ${res.totalTools} total; servers: ${availText}):`,
							];
							if (isBrowse) {
								const grouped = new Map<string, McpCatalogEntry[]>();
								for (const entry of res.entries) {
									let list = grouped.get(entry.server);
									if (!list) {
										list = [];
										grouped.set(entry.server, list);
									}
									list.push(entry);
								}
								for (const [server, list] of grouped) {
									lines.push(`\n[${server}]`);
									for (const e of list) {
										const mark = currentlyLoaded.has(e.name) ? " [loaded]" : "";
										lines.push(`- ${e.name}: ${oneLineSummary(e.description)}${mark}`);
									}
								}
							} else {
								for (const e of res.entries) {
									const mark = currentlyLoaded.has(e.name) ? " [loaded]" : "";
									lines.push(`- ${e.name} [${e.server}]: ${oneLineSummary(e.description)}${mark}`);
								}
							}
							if (res.totalMatched > res.entries.length) {
								lines.push(`\nShowing ${res.entries.length} of ${res.totalMatched} matching tools. Narrow with \`query\`, \`server\`, or a higher \`limit\`.`);
							}
							sections.push(lines.join("\n"));
						}
					}

					return {
						content: [{ type: "text", text: sections.join("\n\n") }],
						details: {
							loaded,
							alreadyLoaded,
							notFound,
							...(matchedCount !== undefined ? { matched: matchedCount } : {}),
							totalTools: catalog.length,
						},
					};
				},
			}) as AgentTool<any>,
		};
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
		await waitForPromise(target.ready, signal);
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
			await waitForPromise(cur.ready, signal);
			if (signal?.aborted) throw abortError(signal);
			conn = this.conns.get(server);
			if (conn === cur) break;
		}
		if (conn && conn.status === "ready" && (conn.lazyStarting || (!conn.client && conn.config.transport === "stdio"))) {
			conn = await this.ensureLazyConnected(server, conn, signal);
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

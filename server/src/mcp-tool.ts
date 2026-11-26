import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import Type, { type Static, type TSchema } from "typebox";
import type { McpInfo, McpServerConfig, McpServerPatch } from "./mcp.ts";
import type { ToolDef } from "./tools.ts";

/**
 * `mcp`: inspect, add, update, enable, disable, reload and remove MCP servers configured on this pipaya server.
 * Matches Pipaya's action-dispatched built-in tool pattern (`peer`, `schedule`, `goal`, `workdir`).
 */
export const MCP_TOOL = "mcp";

const ACTIONS = ["list", "add", "update", "remove", "enable", "disable", "reload"] as const;
type Action = (typeof ACTIONS)[number];

const WAIT_TIMEOUT_MS = 25_000;
const MAX_LISTED_TOOLS = 25;

export type McpInfoData = Static<typeof McpInfo>;
type McpServerView = McpInfoData["servers"][number];

/** What the `mcp` tool may ask of the server; SessionManager wires it to McpManager. */
export interface McpOps {
	info(): McpInfoData;
	add(server: McpServerConfig): McpInfoData;
	patch(name: string, patch: McpServerPatch): McpInfoData;
	remove(name: string): McpInfoData;
	reload(name?: string): McpInfoData;
	waitFor(name?: string, timeoutMs?: number, signal?: AbortSignal): Promise<McpInfoData>;
}

const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;
const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({ content: [{ type: "text", text: t }], details });

const need = <T>(v: T | undefined, what: string, action: Action): T => {
	if (v === undefined || (typeof v === "string" && !v.trim())) throw new Error(`mcp ${action} needs \`${what}\``);
	return v;
};

function formatServer(s: McpServerView): string {
	const endpoint = s.transport === "stdio"
		? `stdio: ${[s.command ?? "", ...(s.args ?? [])].filter(Boolean).join(" ")}`
		: `http: ${s.url ?? ""}`;
	const flags: string[] = [];
	if (s.inheritEnv) flags.push("inheritEnv");
	const envKeys = s.env ? Object.keys(s.env) : [];
	if (envKeys.length) flags.push(`env keys: ${envKeys.join(", ")}`);
	const headerKeys = s.headers ? Object.keys(s.headers) : [];
	if (headerKeys.length) flags.push(`header keys: ${headerKeys.join(", ")}`);
	if (s.allowTools !== undefined) flags.push(`allowTools: ${s.allowTools.length ? s.allowTools.join(", ") : "(none)"}`);
	if (s.denyTools?.length) flags.push(`denyTools: ${s.denyTools.join(", ")}`);

	const lines = [`- ${s.name} [${s.status}] · ${endpoint}${flags.length ? ` (${flags.join("; ")})` : ""}`];
	if (s.status === "ready") {
		if (s.tools.length) {
			const shown = s.tools.slice(0, MAX_LISTED_TOOLS).map((t) => t.name);
			const extra = s.tools.length > MAX_LISTED_TOOLS ? ` (+${s.tools.length - MAX_LISTED_TOOLS} more)` : "";
			lines.push(`  tools (${s.tools.length}): ${shown.join(", ")}${extra}`);
		} else {
			lines.push("  tools: none");
		}
	} else if (s.status === "error" && s.error) {
		lines.push(`  error: ${s.error}`);
		if (/\bENOENT\b/i.test(s.error)) {
			lines.push("  hint: the executable must be installed and on the server process's PATH, or pass an absolute path.");
		}
	} else if (s.status === "connecting") {
		lines.push("  still connecting; check again with mcp(action=\"list\").");
	}
	return lines.join("\n");
}

function formatSummary(info: McpInfoData): string {
	if (!info.servers.length) return "No MCP servers configured.";
	const head = `${info.servers.length} MCP server(s) (${info.ready} ready, ${info.tools} tool(s)${info.truncatedTools ? `, ${info.truncatedTools} truncated` : ""}):`;
	return `${head}\n${info.servers.map(formatServer).join("\n")}`;
}

function formatSingle(verb: string, info: McpInfoData, name: string): string {
	const s = info.servers.find((x) => x.name.toLowerCase() === name.toLowerCase());
	if (!s) return `${verb} MCP server "${name}".`;
	const readyNote = s.status === "ready" && s.tools.length > 0 ? "\nNew MCP tools are available from the next turn." : "";
	const truncNote = info.truncatedTools ? `\nNote: ${info.truncatedTools} MCP tool(s) were omitted because total tools exceeded the server limit.` : "";
	return `${verb} MCP server "${s.name}":\n${formatServer(s)}${readyNote}${truncNote}`;
}

const DESCRIPTION = [
	"Manage MCP servers configured on this pipaya server (same list as Settings → MCP servers). Pick `action`; only add, change, or remove servers when the user asks to configure them.",
	"list: show all configured MCP servers, their connection status, env/header key names (values are never returned), and exposed `mcp_<server>_<tool>` names.",
	"add (name, transport: stdio|http, command/args/env/inheritEnv or url/headers, enabled?, allowTools?, denyTools?): register a new server (enabled defaults to true) and wait briefly for its connection.",
	"update (name, ...fields): change one server without touching others; env/headers merge keys (set a key to null to delete it; omitted keys keep stored secrets); allowTools/denyTools accept null to clear.",
	"enable / disable (name): turn a server on or off. remove (name): delete a server. reload (name?): reconnect one server or all.",
	"For API keys or tokens, prefer having the user enter secrets in Settings → MCP servers (or add placeholders) so secrets are not stored in chat history.",
].join("\n");

const PatchRecordSchema = Type.Record(
	Type.String({ minLength: 1, maxLength: 200 }),
	Type.Union([Type.String({ maxLength: 4000 }), Type.Null()]),
	{ maxProperties: 50 },
);
const ToolListSchema = Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { maxItems: 200 });

export const mcpTool: ToolDef = {
	name: MCP_TOOL,
	description: "List, add, update, enable, disable, reload and remove MCP servers on this server.",
	create: (_cwd, _roots, ctx) =>
		defineTool({
			name: MCP_TOOL,
			label: "MCP servers",
			description: DESCRIPTION,
			parameters: Type.Object({
				action: Type.Unsafe<Action>({ type: "string", enum: [...ACTIONS], description: "Action: list, add, update, remove, enable, disable, or reload" }),
				name: Type.Optional(Type.String({ minLength: 1, maxLength: 32, description: "Server name (letters, digits, - and _; required for add/update/remove/enable/disable, optional for reload)" })),
				enabled: Type.Optional(Type.Boolean({ description: "add (default true) / update: whether the server is switched on" })),
				transport: Type.Optional(Type.Union([Type.Literal("stdio"), Type.Literal("http")], { description: "add (required) / update: stdio (local command) or http (Streamable HTTP)" })),
				command: Type.Optional(Type.String({ maxLength: 1000, description: "stdio: executable to run (e.g. uvx, npx, or an absolute path)" })),
				args: Type.Optional(Type.Array(Type.String({ maxLength: 2000 }), { maxItems: 50, description: "stdio: command arguments" })),
				env: Type.Optional(Type.Union([PatchRecordSchema, Type.Null()], { description: "stdio: environment variables (update merges keys; null value removes a key; null clears all)" })),
				inheritEnv: Type.Optional(Type.Boolean({ description: "stdio: inherit full host env (still excluding PIPAYA_*) instead of filtered defaults" })),
				url: Type.Optional(Type.String({ maxLength: 2000, description: "http: http(s) endpoint URL" })),
				headers: Type.Optional(Type.Union([PatchRecordSchema, Type.Null()], { description: "http: request headers (update merges keys; null value removes a key; null clears all)" })),
				allowTools: Type.Optional(Type.Union([ToolListSchema, Type.Null()], { description: "Only expose these tool names (null clears the allowlist in update)" })),
				denyTools: Type.Optional(Type.Union([ToolListSchema, Type.Null()], { description: "Hide these tool names (null clears the denylist in update)" })),
			}),
			executionMode: "sequential",
			async execute(_id, p, signal) {
				const ops = ctx?.mcp;
				if (!ops) throw new Error("MCP management is not available on this server");
				const a: Action = p.action;
				switch (a) {
					case "list": {
						const info = ops.info();
						return text(formatSummary(info), { action: a, count: info.servers.length, ready: info.ready, tools: info.tools });
					}
					case "add": {
						const name = need(p.name, "name", a).trim();
						const transport = need(p.transport, "transport", a);
						const enabled = p.enabled ?? true;
						const cleanRecord = (rec: Record<string, string | null> | null | undefined): Record<string, string> | undefined => {
							if (!rec) return undefined;
							const out: Record<string, string> = {};
							for (const [k, v] of Object.entries(rec)) {
								if (v !== null) out[k] = v;
							}
							return Object.keys(out).length ? out : undefined;
						};
						const cfg: McpServerConfig = {
							name,
							enabled,
							transport,
							...(p.command !== undefined ? { command: p.command } : {}),
							...(p.args !== undefined ? { args: p.args } : {}),
							...(cleanRecord(p.env) ? { env: cleanRecord(p.env) } : {}),
							...(p.inheritEnv !== undefined ? { inheritEnv: p.inheritEnv } : {}),
							...(p.url !== undefined ? { url: p.url } : {}),
							...(cleanRecord(p.headers) ? { headers: cleanRecord(p.headers) } : {}),
							...(Array.isArray(p.allowTools) ? { allowTools: p.allowTools } : {}),
							...(Array.isArray(p.denyTools) ? { denyTools: p.denyTools } : {}),
						};
						let info = ops.add(cfg);
						if (enabled) info = await ops.waitFor(name, WAIT_TIMEOUT_MS, signal);
						const srv = info.servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
						return text(formatSingle("Added", info, name), { action: a, name: srv?.name ?? name, status: srv?.status ?? "off", tools: srv?.tools.length ?? 0 });
					}
					case "update": {
						const name = need(p.name, "name", a).trim();
						const patch: McpServerPatch = {
							...(p.enabled !== undefined ? { enabled: p.enabled } : {}),
							...(p.transport !== undefined ? { transport: p.transport } : {}),
							...(p.command !== undefined ? { command: p.command } : {}),
							...(p.args !== undefined ? { args: p.args } : {}),
							...(p.env !== undefined ? { env: p.env } : {}),
							...(p.inheritEnv !== undefined ? { inheritEnv: p.inheritEnv } : {}),
							...(p.url !== undefined ? { url: p.url } : {}),
							...(p.headers !== undefined ? { headers: p.headers } : {}),
							...(p.allowTools !== undefined ? { allowTools: p.allowTools } : {}),
							...(p.denyTools !== undefined ? { denyTools: p.denyTools } : {}),
						};
						let info = ops.patch(name, patch);
						const target = info.servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
						if (target?.enabled) info = await ops.waitFor(name, WAIT_TIMEOUT_MS, signal);
						const srv = info.servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
						return text(formatSingle("Updated", info, name), { action: a, name: srv?.name ?? name, status: srv?.status ?? "off", tools: srv?.tools.length ?? 0 });
					}
					case "enable":
					case "disable": {
						const name = need(p.name, "name", a).trim();
						const enabled = a === "enable";
						let info = ops.patch(name, { enabled });
						if (enabled) info = await ops.waitFor(name, WAIT_TIMEOUT_MS, signal);
						const srv = info.servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
						return text(formatSingle(enabled ? "Enabled" : "Disabled", info, name), { action: a, name: srv?.name ?? name, status: srv?.status ?? "off", tools: srv?.tools.length ?? 0 });
					}
					case "remove": {
						const name = need(p.name, "name", a).trim();
						const info = ops.remove(name);
						return text(`Removed MCP server "${name}".`, { action: a, name, count: info.servers.length });
					}
					case "reload": {
						if (p.name !== undefined && !p.name.trim()) throw new Error("mcp reload: `name` cannot be empty; omit it to reload all servers");
						const name = p.name?.trim();
						ops.reload(name);
						const info = await ops.waitFor(name, WAIT_TIMEOUT_MS, signal);
						if (name) {
							const srv = info.servers.find((s) => s.name.toLowerCase() === name.toLowerCase());
							return text(formatSingle("Reloaded", info, name), { action: a, name: srv?.name ?? name, status: srv?.status ?? "off", tools: srv?.tools.length ?? 0 });
						}
						return text(`Reloaded MCP servers:\n${formatSummary(info)}`, { action: a, count: info.servers.length, ready: info.ready, tools: info.tools });
					}
					default:
						throw new Error(`unknown mcp action "${String(a)}"`);
				}
			},
		}),
};

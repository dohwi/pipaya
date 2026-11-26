/**
 * Sub-agents for the `delegate` tool: role definitions (`<home>/.agents/subagents/*.md`, then `<cwd>/.agents/subagents/*.md`,
 * the project one wins) and the limits that keep delegation from running away. Loading is pure over the file system, so it is
 * testable without a session.
 */
import type { AgentMessage, AgentTurnContext } from "@earendil-works/pi-agent-core";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { badRequest, conflict, notFound } from "./errors.ts";
import { parseFrontmatter } from "./skills.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./store.ts";

/** Subagents running at the same time for one session. */
export const MAX_CONCURRENT_SUBAGENTS = 4;
/** `delegate` calls in one run of the parent (the counter is reset when a new run starts). */
export const MAX_DELEGATES_PER_RUN = 12;
/** Model calls a subagent may use when its definition says nothing, and the most a definition may ask for. */
export const DEFAULT_SUBAGENT_TURNS = 12;
export const MAX_SUBAGENT_TURNS = 30;
/** `delegate` is for short, one-off work; longer jobs have their own session via `peer`. */
export const SUBAGENT_TIMEOUT_MS = 5 * 60_000;
export const SUBAGENT_ABORT_GRACE_MS = 3_000;

/** Maximum characters returned from a single subagent final report. */
export const MAX_SUBAGENT_OUTPUT_CHARS = 32_000;

export function capSubagentOutput(text: string, maxChars = MAX_SUBAGENT_OUTPUT_CHARS): string {
	if (text.length <= maxChars) return text;
	const omitted = text.length - maxChars;
	return `${text.slice(0, maxChars)}\n\n[subagent output truncated: ${omitted} characters omitted]`;
}

/** Time left for reporting when a tool-using turn finishes. Do not interrupt a running tool merely to report. */
export const subagentReportReserveMs = (timeoutMs: number) => Math.min(30_000, timeoutMs / 5);

/** Stop the work on expiry or parent cancellation; do not block the parent if the work ignores abort. */
export async function runDelegateWithinDeadline(
	run: () => Promise<void>, abort: () => void, parentSignal: AbortSignal | undefined, timeoutMs: number, graceMs = SUBAGENT_ABORT_GRACE_MS, onDetach?: () => void,
): Promise<"finished" | "deadline" | "cancelled"> {
	type Stop = "deadline" | "cancelled";
	let stopped: Stop | undefined;
	let grace: ReturnType<typeof setTimeout> | undefined;
	let detach!: (reason: Stop) => void;
	const abandoned = new Promise<Stop>((resolve) => { detach = resolve; });
	const stop = (reason: Stop) => {
		if (stopped) return;
		stopped = reason;
		abort();
		grace = setTimeout(() => {
			try { onDetach?.(); } catch { /* never block detach */ }
			detach(reason);
		}, graceMs);
		grace.unref?.();
	};
	const cancel = () => stop("cancelled");
	if (parentSignal?.aborted) return "cancelled";
	parentSignal?.addEventListener("abort", cancel, { once: true });
	const timer = setTimeout(() => stop("deadline"), timeoutMs);
	timer.unref?.();
	try {
		// Keep handlers on the actual run even after detaching so late completion or rejection cannot leak.
		return await Promise.race([abandoned, run().then(() => stopped ?? "finished", (error) => {
			if (!stopped) throw error;
			return stopped;
		})]);
	} finally {
		clearTimeout(timer);
		clearTimeout(grace);
		parentSignal?.removeEventListener("abort", cancel);
	}
}
/** Tools a subagent never gets, whatever its definition lists: it must not delegate again (depth 1), ask the user, reach other sessions, schedule prompts, mutate session goals/workdir, reconfigure MCP servers, or generate images. */
const FORBIDDEN = (n: string) =>
	n === "delegate" || n === "ask_user" || n === "peer" || n.startsWith("peer_") || n === "schedule"
	|| n === "goal" || n === "mcp" || n === "workdir" || n === "generate_image";
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "glob", "ls"];

export interface SubagentDef {
	name: string;
	description: string;
	/** `provider/model`; missing = the parent's model. */
	model?: string;
	thinking?: ThinkingLevel;
	tools: string[];
	maxTurns: number;
	/** The role's instructions (the file's body). */
	prompt: string;
	file: string;
	scope: "global" | "project";
}

function parseDef(file: string, scope: SubagentDef["scope"]): SubagentDef | null {
	let raw: string;
	try { raw = readFileSync(file, "utf8"); } catch { return null; }
	const meta = parseFrontmatter(raw) ?? {};
	const body = raw.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
	const name = basename(file, ".md");
	if (!/^[A-Za-z0-9][\w.-]*$/.test(name)) return null;
	const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
	const thinking = str(meta.thinking);
	const tools = Array.isArray(meta.tools) ? meta.tools.filter((t): t is string => typeof t === "string") : typeof meta.tools === "string" ? meta.tools.split(/[,\s]+/).filter(Boolean) : DEFAULT_SUBAGENT_TOOLS;
	const turns = typeof meta.maxTurns === "number" && Number.isFinite(meta.maxTurns) ? Math.floor(meta.maxTurns) : DEFAULT_SUBAGENT_TURNS;
	return {
		name,
		description: str(meta.description) ?? "",
		...(str(meta.model) ? { model: str(meta.model) } : {}),
		...(thinking && (THINKING_LEVELS as readonly string[]).includes(thinking) ? { thinking: thinking as ThinkingLevel } : {}),
		tools: [...new Set(tools.filter((t) => !FORBIDDEN(t)))],
		maxTurns: Math.min(Math.max(turns, 1), MAX_SUBAGENT_TURNS),
		prompt: body,
		file,
		scope,
	};
}

const dirOf = (scope: SubagentDef["scope"], cwd: string, home: string) => join(scope === "global" ? home : cwd, ".agents", "subagents");

const scopeCache = new Map<string, { fingerprint: string; defs: SubagentDef[] }>();

/** Clears the cached subagent definitions (primarily for tests; saveSubagent/removeSubagent invalidate their own scope via scopeCache.delete). */
export function clearSubagentCache(): void {
	scopeCache.clear();
}

/** Every readable definition of one scope, by file name, cached by directory & file mtime/size/inode fingerprint. */
function readScope(dir: string, scope: SubagentDef["scope"]): SubagentDef[] {
	const cacheKey = `${scope}\0${dir}`;
	let names: string[];
	try { names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch {
		scopeCache.delete(cacheKey);
		return [];
	}
	const files: string[] = [];
	const parts: string[] = [];
	for (const f of names) {
		const file = join(dir, f);
		try {
			const st = statSync(file);
			if (!st.isFile()) continue;
			files.push(file);
			parts.push(`${f}:${st.mtimeMs}:${st.size}:${st.ino}`);
		} catch { /* skip unreadable file */ }
	}
	const fingerprint = parts.join("\n");
	const cached = scopeCache.get(cacheKey);
	if (cached && cached.fingerprint === fingerprint) return cached.defs;

	const out: SubagentDef[] = [];
	for (const file of files) {
		const def = parseDef(file, scope);
		if (def) out.push(def);
	}
	scopeCache.set(cacheKey, { fingerprint, defs: out });
	return out;
}

/** Definitions by role name: global first, project ones replace global ones of the same name. Unreadable files are skipped. */
export function loadSubagents(cwd: string, home: string, disabled: readonly string[] = []): Map<string, SubagentDef> {
	const out = new Map<string, SubagentDef>();
	// A switched-off role is skipped before the project-over-global merge, so switching a project role off lets the global one of that name show again.
	for (const scope of ["global", "project"] as const) for (const def of readScope(dirOf(scope, cwd, home), scope)) if (!disabled.includes(subagentKey(def))) out.set(def.name, def);
	return out;
}

/** The key a role is switched on/off by: global and project roles of one name are separate switches. */
export const subagentKey = (d: { scope: string; name: string }) => `${d.scope}/${d.name}`;

/** Both scopes side by side for the settings list; a global role hidden by a project role of the same name is marked `overridden`. */
export function listSubagents(cwd: string, home: string, disabled: readonly string[] = []): (SubagentDef & { overridden: boolean; enabled: boolean })[] {
	const project = readScope(dirOf("project", cwd, home), "project");
	// A project role hides the global one of its name only while it is on.
	const names = new Set(project.filter((d) => !disabled.includes(subagentKey(d))).map((d) => d.name));
	const row = (d: SubagentDef, overridden: boolean) => ({ ...d, overridden, enabled: !disabled.includes(subagentKey(d)) });
	return [...readScope(dirOf("global", cwd, home), "global").map((d) => row(d, names.has(d.name))), ...project.map((d) => row(d, false))];
}

export const SUBAGENT_NAME = /^[A-Za-z0-9][\w.-]{0,39}$/;
export interface SubagentInput { description: string; model?: string; thinking?: ThinkingLevel; tools: string[]; maxTurns: number; prompt: string }

/** Tool names a role file may list: everything a subagent may get (never the ones in FORBIDDEN). */
export const subagentTools = (all: readonly string[]) => all.filter((n) => !FORBIDDEN(n));

/**
 * Writes `<dir>/<name>.md`. Frontmatter keys this editor does not know are kept as they are. `create` refuses to overwrite an
 * existing role, an update refuses to invent one, so two clients cannot silently replace each other's role.
 */
export function saveSubagent(scope: SubagentDef["scope"], cwd: string, home: string, name: string, input: SubagentInput, create: boolean): SubagentDef {
	if (!SUBAGENT_NAME.test(name)) throw badRequest("role names are letters, digits, '.', '_' and '-' (at most 40, starting with a letter or digit)");
	if (input.model !== undefined && !/^[^/\s]+\/\S+$/.test(input.model)) throw badRequest("model must be provider/model");
	const dir = dirOf(scope, cwd, home);
	const file = join(dir, `${name}.md`);
	const exists = existsSync(file);
	if (create && exists) throw conflict(`subagent role "${name}" already exists in the ${scope} folder`);
	if (!create && !exists) throw notFound(`subagent role "${name}"`);
	let meta: Record<string, unknown> = {};
	if (exists) { try { meta = parseFrontmatter(readFileSync(file, "utf8")) ?? {}; } catch { /* unreadable: rewritten from the form */ } }
	const set = (k: string, v: unknown) => { if (v === undefined || v === "") delete meta[k]; else meta[k] = v; };
	set("description", input.description.trim());
	set("model", input.model);
	set("thinking", input.model ? input.thinking : undefined);
	set("tools", [...new Set(input.tools.filter((t) => !FORBIDDEN(t)))]);
	set("maxTurns", Math.min(Math.max(Math.floor(input.maxTurns), 1), MAX_SUBAGENT_TURNS));
	mkdirSync(dir, { recursive: true });
	writeFileSync(file, `---\n${Bun.YAML.stringify(meta, null, 2)}\n---\n${input.prompt.trim()}\n`);
	scopeCache.delete(`${scope}\0${dir}`);
	const def = parseDef(file, scope);
	if (!def) throw badRequest("the role could not be read back");
	return def;
}

export function removeSubagent(scope: SubagentDef["scope"], cwd: string, home: string, name: string): void {
	if (!SUBAGENT_NAME.test(name)) throw badRequest("invalid role name");
	const dir = dirOf(scope, cwd, home);
	const file = join(dir, `${name}.md`);
	if (!existsSync(file)) throw notFound(`subagent role "${name}"`);
	rmSync(file);
	scopeCache.delete(`${scope}\0${dir}`);
}

/** What a subagent is told besides its role text. */
export const subagentSystem = (def: SubagentDef, cwd: string) =>
	`${def.prompt || `You are the "${def.name}" subagent.`}\n\nYou work for another agent and cannot ask questions: you get one task and answer with your final message only. Working directory: ${cwd}`;

export const SUBAGENT_WRAP_UP = "This is your final model call. No tools are available. Return a concise answer based only on the evidence already available. Say what you verified, what remains unverified, and what the calling agent should do next if the work is incomplete. Do not imply that you performed work that you could not do.";

export type SubagentLimit = "maxTurns" | "repeatedTools" | "deadline";

/**
 * Detects repeated identical successful read-only or `bash` tool turns (single call or multi-tool batch) with unchanged
 * text output. Failed calls and stateful write/edit tools keep the normal budget.
 */
export function repeatedReadSignature({ message, toolResults }: AgentTurnContext, readOnly: ReadonlySet<string>): string | undefined {
	if (message.stopReason !== "toolUse" || !toolResults.length) return;
	const calls = message.content.filter((block) => block.type === "toolCall");
	if (!calls.length || calls.length !== toolResults.length) return;
	const entries: string[] = [];
	for (let i = 0; i < calls.length; i++) {
		const call = calls[i];
		const result = toolResults[i];
		if (!call || !result || result.isError) return;
		if (!readOnly.has(call.name) && call.name !== "bash") return;
		if (result.content.some((block) => block.type !== "text")) return;
		entries.push(JSON.stringify([call.name, call.arguments, result.content]));
	}
	return entries.length === 1 ? entries[0] : JSON.stringify(entries.sort());
}

export const repeatedToolSignature = repeatedReadSignature;

/** The text of the last assistant message of a subagent run. */
export function finalText(messages: readonly AgentMessage[]): { text: string; error?: string } {
	const last = messages.findLast((m) => m.role === "assistant");
	if (!last) return { text: "" };
	const text = last.content.map((c) => (c.type === "text" ? c.text : "")).join("").trim();
	return { text, ...(last.stopReason === "error" || last.stopReason === "aborted" ? { error: last.errorMessage ?? `model call ${last.stopReason}` } : {}) };
}

/** Fallback for an empty or failed wrap-up: preserve earlier text without exposing raw tool results. */
export function subagentReport(messages: readonly AgentMessage[], limit: SubagentLimit, { turns, maxRepeated, timeoutMs, timedOut }: { turns: number; maxRepeated: number; timeoutMs: number; timedOut: boolean }): string {
	const last = messages.findLast((m) => m.role === "assistant");
	const { text, error } = finalText(messages);
	const askedForTools = last?.content.some((c) => c.type === "toolCall");
	const reason = limit === "maxTurns" ? "the model call budget was reached (maxTurns)"
		: limit === "repeatedTools" ? `the same tool call returned unchanged results ${maxRepeated} times in a row`
		: `the ${timeoutMs / 1000}s time limit was ${timedOut ? "reached" : "nearly reached"}`;
	const note = `[Subagent ended after ${turns} model call${turns === 1 ? "" : "s"}: ${reason}. The answer may be incomplete.]`;
	if (!timedOut && text && !error && !askedForTools) return `${text}\n\n${note}`;
	const assistants = messages.filter((m) => m.role === "assistant");
	const earlier = (!error && text) || assistants.slice(0, -1).map((m) => finalText([m])).findLast((m) => m.text && !m.error)?.text;
	const problem = timedOut ? "The subagent did not finish before the deadline." : error ? "The final model call failed." : askedForTools ? "The final model call requested unavailable tools." : "The final model call returned no text.";
	return `${note}\n${problem}${earlier ? `\n\nPartial assistant text (not a final answer):\n${earlier}` : ""}`;
}

/** Per-session bookkeeping of the limits: calls in the current run and subagents running now. Throws a conflict when one is hit. */
export class DelegateLimits {
	private use = new Map<string, { calls: number; running: number }>();
	constructor(private defaults = { calls: MAX_DELEGATES_PER_RUN, running: MAX_CONCURRENT_SUBAGENTS }) {}
	/** Takes a slot; the returned function gives it back. `limits` (the user's settings) replace the defaults. */
	acquire(id: string, limits?: { calls: number; running: number }): () => void {
		const max = limits ?? this.defaults;
		const u = this.use.get(id) ?? { calls: 0, running: 0 };
		this.use.set(id, u);
		if (u.calls >= max.calls) throw conflict(`at most ${max.calls} delegate calls per run; do the rest yourself or report to the user`);
		if (u.running >= max.running) throw conflict(`at most ${max.running} subagents can run at the same time; wait for one to finish`);
		u.calls++;
		u.running++;
		let done = false;
		return () => { if (!done) { done = true; u.running--; } };
	}
	/** A new run of the session starts: its call allowance is full again. */
	resetRun(id: string): void {
		const u = this.use.get(id);
		if (u) u.calls = 0;
	}
	forget(id: string): void { this.use.delete(id); }
}

/**
 * A subagent for a role name that has no file, under the free role policy: a general subagent with the default read-only tools
 * (never write, edit or bash), the calling session's model unless the model policy says otherwise, and the task as its instructions.
 */
export function freeRole(name: string): SubagentDef {
	return { name, description: "", tools: [...DEFAULT_SUBAGENT_TOOLS], maxTurns: DEFAULT_SUBAGENT_TURNS, prompt: "", file: "", scope: "global" };
}

export type ModelPolicy = { policy: "defined" | "allowlist" | "any"; models: string[] };

/** Which model a subagent runs on, or a conflict explaining why the request is refused. `requested` is the call's `model` argument. */
export function chooseModel(policy: ModelPolicy, requested: string | undefined, defined: string | undefined): string | undefined {
	if (!requested) return defined;
	if (policy.policy === "any") return requested;
	if (policy.policy === "allowlist") {
		if (policy.models.includes(requested)) return requested;
		throw conflict(`model ${requested} is not allowed for subagents; allowed: ${policy.models.join(", ")}. Omit \`model\` to use the role's own`);
	}
	throw conflict("choosing a subagent model is switched off in the settings; omit `model` to use the role's own");
}

/** What a subagent's model calls used, summed over its assistant messages (stored on the `delegate` result so the session's totals include it). */
export function subagentUsage(messages: readonly { role: string; usage?: any }[]) {
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const m of messages) {
		if (m.role !== "assistant" || !m.usage) continue;
		for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) sum[k] += Number(m.usage[k]) || 0;
		sum.cost += Number(m.usage.cost?.total) || 0;
	}
	return sum;
}

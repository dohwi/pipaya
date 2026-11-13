/**
 * Sub-agents for the `delegate` tool: role definitions (`<home>/.agents/subagents/*.md`, then `<cwd>/.agents/subagents/*.md`,
 * the project one wins) and the limits that keep delegation from running away. Loading is pure over the file system, so it is
 * testable without a session.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { badRequest, conflict, notFound } from "./errors.ts";
import { parseFrontmatter } from "./skills.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./store.ts";

/** Helpers running at the same time for one session. */
export const MAX_CONCURRENT_SUBAGENTS = 4;
/** `delegate` calls in one run of the parent (the counter is reset when a new run starts). */
export const MAX_DELEGATES_PER_RUN = 12;
/** Model calls a helper may use when its definition says nothing, and the most a definition may ask for. */
export const DEFAULT_SUBAGENT_TURNS = 12;
export const MAX_SUBAGENT_TURNS = 30;
/** Tools a helper never gets, whatever its definition lists: it must not delegate again (depth 1), ask the user, reach other sessions or schedule prompts. */
const FORBIDDEN = (n: string) => n === "delegate" || n === "ask_user" || n === "peer" || n.startsWith("peer_") || n === "schedule";
export const DEFAULT_SUBAGENT_TOOLS = ["read", "grep", "ls"];

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

/** Every readable definition of one scope, by file name. */
function readScope(dir: string, scope: SubagentDef["scope"]): SubagentDef[] {
	let names: string[];
	try { names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { return []; }
	const out: SubagentDef[] = [];
	for (const f of names) {
		const file = join(dir, f);
		try { if (!statSync(file).isFile()) continue; } catch { continue; }
		const def = parseDef(file, scope);
		if (def) out.push(def);
	}
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

/** Tool names a role file may list: everything a helper may get (never the ones in FORBIDDEN). */
export const helperTools = (all: readonly string[]) => all.filter((n) => !FORBIDDEN(n));

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
	if (create && exists) throw conflict(`helper role "${name}" already exists in the ${scope} folder`);
	if (!create && !exists) throw notFound(`helper role "${name}"`);
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
	const def = parseDef(file, scope);
	if (!def) throw badRequest("the role could not be read back");
	return def;
}

export function removeSubagent(scope: SubagentDef["scope"], cwd: string, home: string, name: string): void {
	if (!SUBAGENT_NAME.test(name)) throw badRequest("invalid role name");
	const file = join(dirOf(scope, cwd, home), `${name}.md`);
	if (!existsSync(file)) throw notFound(`helper role "${name}"`);
	rmSync(file);
}

/** What a helper is told besides its role text. */
export const subagentSystem = (def: SubagentDef, cwd: string) =>
	`${def.prompt || `You are the "${def.name}" helper.`}\n\nYou work for another agent and cannot ask questions: you get one task and answer with your final message only. Working directory: ${cwd}`;

/** The text of the last assistant message of a helper run. */
export function finalText(messages: readonly { role: string; content?: unknown; stopReason?: string; errorMessage?: string }[]): { text: string; error?: string } {
	const last = [...messages].reverse().find((m) => m.role === "assistant");
	if (!last) return { text: "" };
	const text = Array.isArray(last.content) ? last.content.map((c: any) => (c?.type === "text" ? c.text : "")).join("").trim() : typeof last.content === "string" ? last.content.trim() : "";
	return { text, ...(last.stopReason === "error" ? { error: last.errorMessage ?? "the model call failed" } : {}) };
}

/** Per-session bookkeeping of the limits: calls in the current run and helpers running now. Throws a conflict when one is hit. */
export class DelegateLimits {
	private use = new Map<string, { calls: number; running: number }>();
	constructor(private defaults = { calls: MAX_DELEGATES_PER_RUN, running: MAX_CONCURRENT_SUBAGENTS }) {}
	/** Takes a slot; the returned function gives it back. `limits` (the user's settings) replace the defaults. */
	acquire(id: string, limits?: { calls: number; running: number }): () => void {
		const max = limits ?? this.defaults;
		const u = this.use.get(id) ?? { calls: 0, running: 0 };
		this.use.set(id, u);
		if (u.calls >= max.calls) throw conflict(`at most ${max.calls} delegate calls per run; do the rest yourself or report to the user`);
		if (u.running >= max.running) throw conflict(`at most ${max.running} helpers can run at the same time; wait for one to finish`);
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
 * A helper for a role name that has no file, under the free role policy: a general helper with the default read-only tools
 * (never write, edit or bash), the calling session's model unless the model policy says otherwise, and the task as its instructions.
 */
export function freeRole(name: string): SubagentDef {
	return { name, description: "", tools: [...DEFAULT_SUBAGENT_TOOLS], maxTurns: DEFAULT_SUBAGENT_TURNS, prompt: "", file: "", scope: "global" };
}

export type ModelPolicy = { policy: "defined" | "allowlist" | "any"; models: string[] };

/** Which model a helper runs on, or a conflict explaining why the request is refused. `requested` is the call's `model` argument. */
export function chooseModel(policy: ModelPolicy, requested: string | undefined, defined: string | undefined): string | undefined {
	if (!requested) return defined;
	if (policy.policy === "any") return requested;
	if (policy.policy === "allowlist") {
		if (policy.models.includes(requested)) return requested;
		throw conflict(`model ${requested} is not allowed for helpers; allowed: ${policy.models.join(", ")}. Omit \`model\` to use the role's own`);
	}
	throw conflict("choosing a helper model is switched off in the settings; omit `model` to use the role's own");
}

/** What a helper's model calls used, summed over its assistant messages (stored on the `delegate` result so the session's totals include it). */
export function helperUsage(messages: readonly { role: string; usage?: any }[]) {
	const sum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
	for (const m of messages) {
		if (m.role !== "assistant" || !m.usage) continue;
		for (const k of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) sum[k] += Number(m.usage[k]) || 0;
		sum.cost += Number(m.usage.cost?.total) || 0;
	}
	return sum;
}

/**
 * Sub-agents for the `delegate` tool: role definitions (`<home>/.agents/subagents/*.md`, then `<cwd>/.agents/subagents/*.md`,
 * the project one wins) and the limits that keep delegation from running away. Loading is pure over the file system, so it is
 * testable without a session.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { conflict } from "./errors.ts";
import { parseFrontmatter } from "./skills.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./store.ts";

/** Helpers running at the same time for one session. */
export const MAX_CONCURRENT_SUBAGENTS = 4;
/** `delegate` calls in one run of the parent (the counter is reset when a new run starts). */
export const MAX_DELEGATES_PER_RUN = 12;
/** Model calls a helper may use when its definition says nothing, and the most a definition may ask for. */
export const DEFAULT_SUBAGENT_TURNS = 12;
export const MAX_SUBAGENT_TURNS = 30;
/** Tools a helper never gets, whatever its definition lists: it must not delegate again (depth 1), ask the user or reach other sessions. */
const FORBIDDEN = (n: string) => n === "delegate" || n === "ask_user" || n.startsWith("peer_");
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

/** Definitions by role name: global first, project ones replace global ones of the same name. Unreadable files are skipped. */
export function loadSubagents(cwd: string, home: string): Map<string, SubagentDef> {
	const out = new Map<string, SubagentDef>();
	for (const [dir, scope] of [[join(home, ".agents", "subagents"), "global"], [join(cwd, ".agents", "subagents"), "project"]] as const) {
		let names: string[];
		try { names = readdirSync(dir).filter((f) => f.endsWith(".md")).sort(); } catch { continue; }
		for (const f of names) {
			const file = join(dir, f);
			try { if (!statSync(file).isFile()) continue; } catch { continue; }
			const def = parseDef(file, scope);
			if (def) out.set(def.name, def);
		}
	}
	return out;
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

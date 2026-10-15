import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import Value from "typebox/value";
import { parseFrontmatter } from "./skills.ts";
import { DEFAULT_MAX_TURNS, SubAgentDef, type SubAgentDefinition } from "./subagent-settings.ts";
import { THINKING_LEVELS } from "./store.ts";

export interface SubAgentFileWarning {
	path: string;
	message: string;
}
export type FileAgent = SubAgentDefinition & { source: "global" | "project"; path: string };

const MAX_FILE_BYTES = 32 * 1024;

/** `<dir>/.agents/subagents` of every directory from the filesystem root down to cwd (nearest wins), then `<home>/.agents/subagents`. */
function projectDirs(cwd: string, home: string): string[] {
	const dirs: string[] = [];
	for (let d = resolve(cwd); ; d = dirname(d)) {
		if (d !== home) dirs.push(join(d, ".agents", "subagents"));
		if (dirname(d) === d) break;
	}
	return dirs.reverse();
}

const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** `provider/model` or `{provider, model}` -> model choice; the thinking level is merged in. */
function modelOf(raw: unknown, thinking: unknown): { ok: true; value: SubAgentDefinition["model"] } | { ok: false; message: string } {
	if (raw === undefined || raw === null || raw === "" || raw === "inherit") return { ok: true, value: null };
	let provider: unknown, model: unknown;
	if (typeof raw === "string") {
		const i = raw.indexOf("/");
		provider = i > 0 ? raw.slice(0, i) : undefined;
		model = i > 0 ? raw.slice(i + 1) : undefined;
	} else if (typeof raw === "object") {
		({ provider, model } = raw as Record<string, unknown>);
	}
	if (typeof provider !== "string" || typeof model !== "string" || !provider || !model) {
		return { ok: false, message: 'model must be "provider/model" (or "inherit")' };
	}
	if (thinking !== undefined && !(THINKING_LEVELS as readonly unknown[]).includes(thinking)) {
		return { ok: false, message: `thinking must be one of ${THINKING_LEVELS.join(", ")}` };
	}
	return { ok: true, value: { provider, model, ...(thinking !== undefined ? { thinkingLevel: thinking } : {}) } as SubAgentDefinition["model"] };
}

/** Parses one agent file. Frontmatter is the settings, the body is the extra prompt. */
export function parseAgentFile(text: string, file: string): { agent: SubAgentDefinition } | { error: string } {
	const meta = parseFrontmatter(text);
	if (!meta) return { error: "no valid YAML frontmatter" };
	const body = text.replace(/^\uFEFF?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "").trim();
	const model = modelOf(meta.model, meta.thinking);
	if (!model.ok) return { error: model.message };
	const tools = typeof meta.tools === "string" ? meta.tools.split(/[\s,]+/).filter(Boolean) : meta.tools;
	const def = {
		name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : basename(file).replace(/\.md$/i, ""),
		description: typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "",
		enabled: meta.enabled === undefined ? true : meta.enabled,
		model: model.value,
		tools: tools === undefined ? ["read", "grep", "ls"] : tools,
		maxTurns: meta.maxTurns === undefined ? DEFAULT_MAX_TURNS : meta.maxTurns,
		prompt: body,
	};
	if (!Value.Check(SubAgentDef, def)) {
		const first = [...Value.Errors(SubAgentDef, def)][0];
		return { error: first ? `${first.instancePath.slice(1) || "agent"}: ${first.message}` : "invalid agent definition" };
	}
	if (new Set(def.tools).size !== def.tools.length) return { error: "duplicate tools" };
	return { agent: def };
}

function loadDir(dir: string, source: FileAgent["source"], out: FileAgent[], warnings: SubAgentFileWarning[]): void {
	if (!isDir(dir)) return;
	let names: string[];
	try { names = readdirSync(dir).filter((n) => n.toLowerCase().endsWith(".md")).sort(); } catch { return; }
	for (const n of names) {
		const path = join(dir, n);
		try {
			const info = statSync(path);
			if (!info.isFile()) continue;
			if (info.size > MAX_FILE_BYTES) { warnings.push({ path, message: `Skipped: larger than ${MAX_FILE_BYTES} bytes` }); continue; }
			const parsed = parseAgentFile(readFileSync(path, "utf8"), path);
			if ("error" in parsed) warnings.push({ path, message: `Skipped: ${parsed.error}` });
			else out.push({ ...parsed.agent, source, path });
		} catch (e) {
			warnings.push({ path, message: `Unable to read: ${e instanceof Error ? e.message : String(e)}` });
		}
	}
}

/**
 * Agents defined as files: global `<home>/.agents/subagents/*.md`, then project `.agents/subagents/*.md` from the
 * root down to `cwd`. Later entries with the same name replace earlier ones (the nearest project file wins).
 */
export function loadAgentFiles(cwd: string | undefined, home = homedir()): { agents: FileAgent[]; warnings: SubAgentFileWarning[] } {
	const found: FileAgent[] = [];
	const warnings: SubAgentFileWarning[] = [];
	loadDir(join(home, ".agents", "subagents"), "global", found, warnings);
	if (cwd) for (const d of projectDirs(cwd, resolve(home))) loadDir(d, "project", found, warnings);
	const byName = new Map<string, FileAgent>();
	for (const a of found) byName.set(a.name, a);
	return { agents: [...byName.values()], warnings };
}

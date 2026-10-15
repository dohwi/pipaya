import type { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, fstatSync, openSync, readdirSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { badRequest, conflict, notFound } from "./errors.ts";

/** What a session snapshot stores about a skill that was advertised to the model. */
export interface SkillRef {
	name: string;
	description: string;
	/** Absolute path of SKILL.md as discovered (this is the `location` the model reads). */
	path: string;
	/** Directory of SKILL.md; the only extra location the `read` tool may open outside the cwd. */
	baseDir: string;
	/** builtin = ships with the server and is offered in every session (lowest priority, can be switched off). */
	scope: "global" | "project" | "builtin";
}

export interface Skill extends SkillRef {
	/** false = `disable-model-invocation: true`; listed in the UI but never advertised to the model. */
	modelInvocable: boolean;
}

export interface SkillWarning {
	path: string;
	message: string;
}

export interface SkillView extends Omit<Skill, "baseDir"> {
	/** Effective state: session override, else project override, else global default. */
	enabled: boolean;
	/** Global default (ignores project overrides). */
	globalEnabled: boolean;
	/** Project override; null = follows the global default. */
	override: boolean | null;
	/** Override for the requested session only; null = none (or no session requested). */
	sessionOverride: boolean | null;
}

export interface SkillList {
	cwd: string;
	/** Key of the project-level override bucket: nearest git root of cwd, else cwd itself. */
	project: string;
	skills: SkillView[];
	warnings: SkillWarning[];
}

/** Skills bundled with the server (`server/builtin-skills/<name>/SKILL.md`). */
export const BUILTIN_SKILLS_DIR = process.env.PIPAYA_BUILTIN_SKILLS || join(import.meta.dir, "..", "builtin-skills");

export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const MAX_SKILL_NAME = 64;
export const MAX_SKILL_DESCRIPTION = 1024;
export const MAX_SKILLS = 200;
const MAX_DEPTH = 4;
const MAX_ENTRIES_PER_DIR = 500;
const FRONTMATTER_BYTES = 32 * 1024;
const MAX_PROJECTS = 200;
const MAX_OVERRIDES = 500;

const isFile = (p: string) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p: string) => { try { return statSync(p).isDirectory(); } catch { return false; } };
const real = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };

function readHead(path: string, max: number): string {
	const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
	try {
		if (!fstatSync(fd).isFile()) throw new Error("not a regular file");
		const buffer = Buffer.alloc(max);
		let bytes = 0;
		while (bytes < max) {
			const n = readSync(fd, buffer, bytes, max - bytes, null);
			if (!n) break;
			bytes += n;
		}
		return buffer.subarray(0, bytes).toString("utf8");
	} finally {
		closeSync(fd);
	}
}

export function parseFrontmatter(text: string): Record<string, unknown> | null {
	const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
	if (!m) return null;
	try {
		const data = Bun.YAML.parse(m[1]!);
		return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function loadSkill(file: string, scope: Skill["scope"], warnings: SkillWarning[]): Skill | null {
	let head: string;
	try {
		head = readHead(file, FRONTMATTER_BYTES);
	} catch (e) {
		warnings.push({ path: file, message: `Unable to read skill: ${e instanceof Error ? e.message : String(e)}` });
		return null;
	}
	const meta = parseFrontmatter(head);
	if (!meta) {
		warnings.push({ path: file, message: "Skipped: SKILL.md has no valid YAML frontmatter" });
		return null;
	}
	const baseDir = dirname(file);
	const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : basename(baseDir);
	if (name.length > MAX_SKILL_NAME || !SKILL_NAME.test(name)) {
		warnings.push({ path: file, message: `Skipped: invalid skill name "${name.slice(0, 80)}" (lowercase letters, digits and single hyphens, max ${MAX_SKILL_NAME})` });
		return null;
	}
	let description = typeof meta.description === "string" ? meta.description.trim() : "";
	if (!description) {
		warnings.push({ path: file, message: "Skipped: skill has no description" });
		return null;
	}
	if (description.length > MAX_SKILL_DESCRIPTION) {
		warnings.push({ path: file, message: `Description truncated to ${MAX_SKILL_DESCRIPTION} characters` });
		description = description.slice(0, MAX_SKILL_DESCRIPTION);
	}
	return { name, description, path: file, baseDir, scope, modelInvocable: meta["disable-model-invocation"] !== true };
}

export function findRepoRoot(start: string): string | null {
	for (let dir = start; ; dir = dirname(dir)) {
		if (existsSync(join(dir, ".git"))) return dir;
		if (dirname(dir) === dir) return null;
	}
}

/** Per-directory skill folders, in priority order (pi layout first, then the Agent Skills standard). */
const PROJECT_SUBDIRS = [[".pi", "skills"], [".agents", "skills"]];
const globalSubdirs = (home: string) => [join(home, ".agents", "skills")];

/**
 * Global: `<home>/.agents/skills`. Project: `.pi/skills` and `.agents/skills`
 * from cwd up to the repository root (or the filesystem root without a repository).
 * Built-in: the server's own `builtin-skills/` (or `opts.builtin`; `false` disables it).
 * Nearer directories win name collisions, project beats global, and anything beats built-in.
 */
export function discoverSkills(cwd: string, opts: { home?: string; builtin?: string | false } = {}): { skills: Skill[]; warnings: SkillWarning[]; project: string } {
	const home = opts.home ?? homedir();
	const globalDirs = globalSubdirs(home);
	const globalReals = new Set(globalDirs.map(real).filter((p): p is string => p !== null));
	const start = real(cwd) ?? resolve(cwd);
	const repo = findRepoRoot(start);

	const roots: { dir: string; scope: Skill["scope"] }[] = [];
	for (let dir = start; ; dir = dirname(dir)) {
		for (const sub of PROJECT_SUBDIRS) {
			const candidate = join(dir, ...sub);
			// The global directories sit under home, an ancestor of most workspaces; never mistake them for project ones.
			const id = real(candidate);
			if (id === null || !globalReals.has(id)) roots.push({ dir: candidate, scope: "project" });
		}
		if (dir === repo || dirname(dir) === dir) break;
	}
	for (const dir of globalDirs) roots.push({ dir, scope: "global" });
	const builtinDir = opts.builtin === undefined ? BUILTIN_SKILLS_DIR : opts.builtin;
	if (builtinDir) roots.push({ dir: builtinDir, scope: "builtin" });

	const warnings: SkillWarning[] = [];
	const byName = new Map<string, Skill>();
	const seenFiles = new Set<string>();
	const seenDirs = new Set<string>();
	let capped = false;

	const add = (file: string, scope: Skill["scope"]) => {
		const id = real(file) ?? file;
		if (seenFiles.has(id)) return;
		seenFiles.add(id);
		const skill = loadSkill(file, scope, warnings);
		if (!skill) return;
		const existing = byName.get(skill.name);
		if (existing) {
			// A user skill replacing a built-in one is intended, not worth a warning.
			if (scope !== "builtin") warnings.push({ path: file, message: `Skipped: name "${skill.name}" is already provided by ${existing.path}` });
			return;
		}
		if (byName.size >= MAX_SKILLS) {
			if (!capped) warnings.push({ path: file, message: `Skipped: more than ${MAX_SKILLS} skills found` });
			capped = true;
			return;
		}
		byName.set(skill.name, skill);
	};

	const walk = (dir: string, depth: number, scope: Skill["scope"]) => {
		if (depth > 0) {
			const file = join(dir, "SKILL.md");
			if (isFile(file)) return add(file, scope);
		}
		if (depth >= MAX_DEPTH) return;
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch (e) {
			warnings.push({ path: dir, message: `Unable to list skills directory: ${e instanceof Error ? e.message : String(e)}` });
			return;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries.slice(0, MAX_ENTRIES_PER_DIR)) {
			if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
			const child = join(dir, entry.name);
			if (!(entry.isDirectory() || (entry.isSymbolicLink() && isDir(child)))) continue;
			const id = real(child);
			if (!id || seenDirs.has(id)) continue; // symlink loops and duplicates
			seenDirs.add(id);
			walk(child, depth + 1, scope);
		}
	};

	for (const root of roots) if (isDir(root.dir)) walk(root.dir, 0, root.scope);
	return { skills: [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1)), warnings, project: repo ?? start };
}

// ── enable/disable settings ─────────────────────────────────────────────────

interface StoredSkillSettings {
	/** Only `false` entries are kept: a skill is enabled unless switched off. */
	global: Record<string, boolean>;
	/** project key -> skill name -> explicit override */
	projects: Record<string, Record<string, boolean>>;
}

const plainBooleans = (v: unknown): Record<string, boolean> => {
	const out: Record<string, boolean> = {};
	if (v && typeof v === "object" && !Array.isArray(v)) {
		for (const [k, b] of Object.entries(v)) if (typeof b === "boolean" && SKILL_NAME.test(k)) out[k] = b;
	}
	return out;
};

export class SkillSettings {
	constructor(private db: Database) {}

	load(): StoredSkillSettings {
		const row = this.db.query("SELECT data FROM settings WHERE key = 'skills'").get() as { data: string } | null;
		const empty: StoredSkillSettings = { global: {}, projects: {} };
		if (!row) return empty;
		try {
			const data = JSON.parse(row.data) as Partial<StoredSkillSettings>;
			const projects: StoredSkillSettings["projects"] = {};
			if (data.projects && typeof data.projects === "object" && !Array.isArray(data.projects)) {
				for (const [key, value] of Object.entries(data.projects)) {
					const overrides = plainBooleans(value);
					if (Object.keys(overrides).length) projects[key] = overrides;
				}
			}
			return { global: plainBooleans(data.global), projects };
		} catch {
			return empty;
		}
	}

	save(settings: StoredSkillSettings): void {
		this.db.query("INSERT INTO settings (key, data) VALUES ('skills', $data) ON CONFLICT(key) DO UPDATE SET data = $data")
			.run({ data: JSON.stringify(settings) });
	}
}

export interface SetSkillInput {
	scope: "global" | "project" | "session";
	/** project/session scope: null removes the override. */
	enabled: boolean | null;
	cwd?: string;
	/** Required for scope "session". */
	sessionId?: string;
}

export class SkillService {
	private settings: SkillSettings;

	constructor(private db: Database, private opts: { home?: string; builtin?: string | false; defaultWorkdir: () => string }) {
		this.settings = new SkillSettings(db);
	}

	private sessionOverrides(sessionId?: string): Record<string, boolean> {
		if (!sessionId) return {};
		const rows = this.db.query("SELECT name, enabled FROM session_skills WHERE session_id = $id").all({ id: sessionId }) as { name: string; enabled: number }[];
		return Object.fromEntries(rows.map((r) => [r.name, r.enabled === 1]));
	}

	/**
	 * Relative paths resolve against the default working directory. A directory that does not exist yet
	 * (new chats create theirs on first use) resolves to its nearest existing ancestor, which sees the same skills.
	 */
	resolveCwd(input?: string): string {
		let abs = resolve(this.opts.defaultWorkdir(), input?.trim() || ".");
		while (!isDir(abs)) {
			const parent = dirname(abs);
			if (parent === abs) throw badRequest(`cwd is not a directory: ${abs}`);
			abs = parent;
		}
		return abs;
	}

	list(cwdInput?: string, sessionId?: string): SkillList {
		const cwd = this.resolveCwd(cwdInput);
		return this.view(cwd, sessionId);
	}

	/** Skills advertised to the model for a new snapshot: enabled and model-invocable. */
	active(cwd: string, sessionId?: string): SkillRef[] {
		return this.view(cwd, sessionId).skills
			.filter((s) => s.enabled && s.modelInvocable)
			.map(({ name, description, path, scope }) => ({ name, description, path, baseDir: dirname(path), scope }));
	}

	/** Skills the user may call by hand with `/skill:name`: switched on here, including manual-only ones. */
	callable(cwd: string, sessionId?: string): { name: string; path: string }[] {
		return this.view(cwd, sessionId).skills.filter((s) => s.enabled).map(({ name, path }) => ({ name, path }));
	}

	set(name: string, input: SetSkillInput): SkillList {
		const cwd = this.resolveCwd(input.cwd);
		if (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME) throw badRequest("invalid skill name");
		const { skills, project } = this.discover(cwd);
		if (!skills.some((s) => s.name === name)) throw notFound(`skill "${name}"`);
		if (input.scope === "session") {
			if (!input.sessionId) throw badRequest("session scope needs sessionId");
			if (!this.db.query("SELECT 1 AS x FROM sessions WHERE id = $id").get({ id: input.sessionId })) throw notFound("session");
			if (input.enabled === null) {
				this.db.query("DELETE FROM session_skills WHERE session_id = $id AND name = $name").run({ id: input.sessionId, name });
			} else {
				const n = (this.db.query("SELECT COUNT(*) AS n FROM session_skills WHERE session_id = $id AND name <> $name").get({ id: input.sessionId, name }) as { n: number }).n;
				if (n >= MAX_OVERRIDES) throw conflict("too many skill overrides for this session");
				this.db.query("INSERT INTO session_skills (session_id, name, enabled) VALUES ($id, $name, $enabled) ON CONFLICT(session_id, name) DO UPDATE SET enabled = $enabled")
					.run({ id: input.sessionId, name, enabled: input.enabled ? 1 : 0 });
			}
			return this.view(cwd, input.sessionId);
		}
		const stored = this.settings.load();
		if (input.scope === "global") {
			if (typeof input.enabled !== "boolean") throw badRequest("global scope needs enabled=true|false");
			if (input.enabled) delete stored.global[name];
			else if (!(name in stored.global) && Object.keys(stored.global).length >= MAX_OVERRIDES) throw conflict("too many disabled skills");
			else stored.global[name] = false;
		} else {
			const bucket = stored.projects[project] ?? {};
			if (input.enabled === null) delete bucket[name];
			else {
				if (!(project in stored.projects) && Object.keys(stored.projects).length >= MAX_PROJECTS) throw conflict("too many projects with skill overrides");
				if (!(name in bucket) && Object.keys(bucket).length >= MAX_OVERRIDES) throw conflict("too many skill overrides for this project");
				bucket[name] = input.enabled;
			}
			if (Object.keys(bucket).length) stored.projects[project] = bucket;
			else delete stored.projects[project];
		}
		this.settings.save(stored);
		return this.view(cwd, input.sessionId);
	}

	private discover(cwd: string) {
		return discoverSkills(cwd, { home: this.opts.home, builtin: this.opts.builtin });
	}

	/** Project key used for overrides (exposed so routes can include it in events). */
	projectOf(cwd: string): string {
		return this.discover(cwd).project;
	}

	private view(cwd: string, sessionId?: string): SkillList {
		const { skills, warnings, project } = this.discover(cwd);
		const stored = this.settings.load();
		const overrides = stored.projects[project] ?? {};
		const sessionOverrides = this.sessionOverrides(sessionId);
		return {
			cwd,
			project,
			warnings,
			skills: skills.map(({ baseDir: _baseDir, ...skill }) => {
				const globalEnabled = stored.global[skill.name] !== false;
				const override = skill.name in overrides ? overrides[skill.name]! : null;
				const sessionOverride = skill.name in sessionOverrides ? sessionOverrides[skill.name]! : null;
				return { ...skill, globalEnabled, override, sessionOverride, enabled: sessionOverride ?? override ?? globalEnabled };
			}),
		};
	}
}

/** Prefix of a manual skill call written in a message, e.g. `/skill:pipaya-usage`. */
export const SKILL_CALL_PREFIX = "/skill:";
const MAX_INLINE_SKILL_CHARS = 40_000;

/** Names written as `/skill:name` in a message, limited to skills in `names`, in order of appearance, without repeats. */
export function mentionedSkills(text: string, names: string[]): string[] {
	const out: string[] = [];
	for (const m of text.matchAll(/(?:^|\s)\/skill:([a-z0-9]+(?:-[a-z0-9]+)*)(?=$|[\s.,;:!?)])/g)) {
		const name = m[1]!;
		if (names.includes(name) && !out.includes(name)) out.push(name);
	}
	return out;
}

/**
 * Hidden note that carries a manually chosen skill to the model. The SKILL.md text is inlined, so it also works for
 * skills that are manual-only (`disable-model-invocation`) and therefore not in the system prompt.
 */
export function skillCallHint(skill: Pick<Skill, "name" | "path">, body: string, openTag: string): string {
	const cut = body.length > MAX_INLINE_SKILL_CHARS;
	const text = cut ? `${body.slice(0, MAX_INLINE_SKILL_CHARS)}\n[cut: read the rest from the file]` : body;
	return `${openTag}The user explicitly invoked the skill "${skill.name}" (written as ${SKILL_CALL_PREFIX}${skill.name}). Follow it for this request. Its file is ${skill.path}; resolve relative paths in it against ${dirname(skill.path)}.\n\n${text}</pipaya-hint>`;
}

/** Reads a skill file for inlining; null when it cannot be read. */
export function readSkillText(path: string): string | null {
	try {
		return readHead(path, MAX_INLINE_SKILL_CHARS * 4 + 1);
	} catch {
		return null;
	}
}

/** The block appended to the system prompt; same shape pi uses so skills stay portable. */
export function skillsPrompt(skills: SkillRef[]): string {
	const one = (s: string) => s.replace(/\s+/g, " ").trim();
	const items = skills.map((s) => `- ${one(s.name)}: ${one(s.description)} (${s.path})`);
	return [
		"Skills: when a task matches one, read its file first; resolve relative paths against the file's directory.",
		"<available_skills>",
		...items,
		"</available_skills>",
	].join("\n");
}

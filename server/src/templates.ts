import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { badRequest, conflict, notFound } from "./errors.ts";
import type { MessageNote } from "./extensions/types.ts";
import { findRepoRoot } from "./skills.ts";

/**
 * Prompt templates: reusable prompts stored as `<name>.md` and invoked with `/prompt:<name> [arguments]`.
 * Global: `<home>/.agents/templates`. Project: `.agents/templates` from cwd up to the repository root.
 * Optional YAML frontmatter: `description` (shown in menus; defaults to the first line of the body) and `name`.
 */

export const MAX_TEMPLATES = 200;
export const MAX_TEMPLATE_BYTES = 128 * 1024;
export const MAX_TEMPLATE_NAME = 64;
export const MAX_TEMPLATE_DESCRIPTION = 1024;
export const MAX_INLINE_TEMPLATE_CHARS = 60_000;
export const TEMPLATE_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export interface TemplateEntry {
	name: string;
	description: string;
	body: string;
	path: string;
	scope: "global" | "project";
	/** True when another template with higher precedence (closer project or project over global) wins for this name. */
	overridden: boolean;
}

export interface TemplateWarning {
	path: string;
	message: string;
}

export interface TemplateList {
	cwd: string;
	globalDir: string;
	projectDir: string;
	templates: TemplateEntry[];
	warnings: TemplateWarning[];
}

export interface TemplateInput {
	description?: string;
	body: string;
}

const isDir = (p: string) => {
	try { return statSync(p).isDirectory(); } catch { return false; }
};
const real = (p: string): string | null => {
	try { return realpathSync(p); } catch { return null; }
};

/** Splits optional YAML frontmatter from the prompt body. Invalid YAML is treated as no frontmatter. */
export function splitTemplate(text: string): { meta: Record<string, unknown>; body: string } {
	const m = FRONTMATTER.exec(text);
	if (!m) return { meta: {}, body: text };
	try {
		const data = Bun.YAML.parse(m[1]!);
		if (data && typeof data === "object" && !Array.isArray(data)) return { meta: data as Record<string, unknown>, body: text.slice(m[0].length) };
	} catch { /* fall through */ }
	return { meta: {}, body: text };
}

function firstLine(body: string): string {
	for (const raw of body.split(/\r?\n/)) {
		const line = raw.replace(/^[#>\-*\s]+/, "").trim();
		if (line) return line.length > 120 ? `${line.slice(0, 117)}...` : line;
	}
	return "";
}

function loadTemplate(file: string, scope: TemplateEntry["scope"], warnings: TemplateWarning[]): Omit<TemplateEntry, "overridden"> | null {
	let text: string;
	try {
		if (statSync(file).size > MAX_TEMPLATE_BYTES) {
			warnings.push({ path: file, message: `Skipped: template is larger than ${MAX_TEMPLATE_BYTES / 1024} KB` });
			return null;
		}
		text = readFileSync(file, "utf8");
	} catch (e) {
		warnings.push({ path: file, message: `Unable to read template: ${e instanceof Error ? e.message : String(e)}` });
		return null;
	}
	const { meta, body } = splitTemplate(text);
	const name = typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : basename(file).replace(/\.md$/i, "");
	if (name.length > MAX_TEMPLATE_NAME || !TEMPLATE_NAME.test(name)) {
		warnings.push({ path: file, message: `Skipped: invalid template name "${name.slice(0, 80)}" (lowercase letters, digits and single hyphens, max ${MAX_TEMPLATE_NAME})` });
		return null;
	}
	if (!body.trim()) {
		warnings.push({ path: file, message: "Skipped: template body is empty" });
		return null;
	}
	const given = typeof meta.description === "string" ? meta.description.replace(/\s+/g, " ").trim() : "";
	const description = (given || firstLine(body)).slice(0, MAX_TEMPLATE_DESCRIPTION);
	return { name, description, body: body.replace(/^\r?\n/, ""), path: file, scope };
}

/** Same cwd rules as skills: a directory that does not exist yet resolves to its nearest existing ancestor. */
export function resolveTemplateCwd(base: string, input?: string): string {
	let abs = resolve(base, input?.trim() || ".");
	while (!isDir(abs)) {
		const parent = dirname(abs);
		if (parent === abs) throw badRequest(`cwd is not a directory: ${abs}`);
		abs = parent;
	}
	return abs;
}

export function discoverTemplates(cwd: string, opts: { home?: string } = {}): { templates: TemplateEntry[]; warnings: TemplateWarning[] } {
	const home = opts.home ?? homedir();
	const globalDir = join(home, ".agents", "templates");
	const globalReal = real(globalDir);
	const start = real(cwd) ?? resolve(cwd);
	const repo = findRepoRoot(start);

	const roots: { dir: string; scope: TemplateEntry["scope"] }[] = [];
	for (let dir = start; ; dir = dirname(dir)) {
		const candidate = join(dir, ".agents", "templates");
		// The global directory sits under home, an ancestor of most workspaces; never mistake it for a project one.
		const id = real(candidate);
		if (id === null || id !== globalReal) roots.push({ dir: candidate, scope: "project" });
		if (dir === repo || dirname(dir) === dir) break;
	}
	roots.push({ dir: globalDir, scope: "global" });

	const warnings: TemplateWarning[] = [];
	const winners = new Map<string, TemplateEntry>();
	const all: TemplateEntry[] = [];
	const seen = new Set<string>();
	for (const root of roots) {
		if (!isDir(root.dir)) continue;
		let entries;
		try {
			entries = readdirSync(root.dir, { withFileTypes: true });
		} catch (e) {
			warnings.push({ path: root.dir, message: `Unable to list templates directory: ${e instanceof Error ? e.message : String(e)}` });
			continue;
		}
		entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const entry of entries) {
			if (entry.name.startsWith(".") || !/\.md$/i.test(entry.name)) continue;
			const file = join(root.dir, entry.name);
			try { if (!statSync(file).isFile()) continue; } catch { continue; }
			const id = real(file) ?? file;
			if (seen.has(id)) continue;
			seen.add(id);
			const parsed = loadTemplate(file, root.scope, warnings);
			if (!parsed) continue;
			const hasWinner = winners.has(parsed.name);
			if (!hasWinner && winners.size >= MAX_TEMPLATES) {
				warnings.push({ path: file, message: `Skipped: more than ${MAX_TEMPLATES} templates found` });
				continue;
			}
			const item: TemplateEntry = { ...parsed, overridden: hasWinner };
			if (!hasWinner) winners.set(parsed.name, item);
			all.push(item);
		}
	}
	all.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1));
	return { templates: all, warnings };
}

export function listTemplates(base: string, cwdInput: string | undefined, home: string): TemplateList {
	const cwd = resolveTemplateCwd(base, cwdInput);
	const globalDir = join(home, ".agents", "templates");
	const projectDir = join(cwd, ".agents", "templates");
	const { templates, warnings } = discoverTemplates(cwd, { home });
	return { cwd, globalDir, projectDir, templates, warnings };
}

export function saveTemplate(
	scope: TemplateEntry["scope"],
	cwd: string,
	home: string,
	name: string,
	input: TemplateInput,
	create: boolean,
): TemplateEntry {
	if (name.length > MAX_TEMPLATE_NAME || !TEMPLATE_NAME.test(name)) {
		throw badRequest("template names are lowercase letters, digits and single hyphens (at most 64 chars)");
	}
	const body = input.body.trim();
	if (!body) throw badRequest("template body must not be empty");
	if (Buffer.byteLength(body, "utf8") > MAX_TEMPLATE_BYTES) {
		throw badRequest(`template is larger than ${MAX_TEMPLATE_BYTES / 1024} KB`);
	}
	const dir = scope === "global" ? join(home, ".agents", "templates") : join(cwd, ".agents", "templates");
	const existing = discoverTemplates(cwd, { home }).templates.find((t) => t.name === name && t.scope === scope);
	const file = existing?.path ?? join(dir, `${name}.md`);
	const exists = existsSync(file);
	if (create && exists) throw conflict(`prompt template "${name}" already exists in the ${scope} folder`);
	if (!create && !exists) throw notFound(`prompt template "${name}"`);

	let meta: Record<string, unknown> = {};
	if (exists) {
		try { meta = splitTemplate(readFileSync(file, "utf8")).meta; } catch { /* rewrite cleanly */ }
	}
	const desc = input.description?.replace(/\s+/g, " ").trim().slice(0, MAX_TEMPLATE_DESCRIPTION) ?? "";
	if (desc) meta.description = desc;
	else delete meta.description;

	const content = Object.keys(meta).length > 0
		? `---\n${Bun.YAML.stringify(meta, null, 2).trimEnd()}\n---\n${body}\n`
		: `${body}\n`;

	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content, "utf8");
	const reloaded = discoverTemplates(cwd, { home }).templates.find((t) => t.name === name && t.scope === scope);
	if (!reloaded) throw badRequest("the template could not be read back");
	return reloaded;
}

export function removeTemplate(scope: TemplateEntry["scope"], cwd: string, home: string, name: string): void {
	if (name.length > MAX_TEMPLATE_NAME || !TEMPLATE_NAME.test(name)) throw badRequest("invalid template name");
	const existing = discoverTemplates(cwd, { home }).templates.find((t) => t.name === name && t.scope === scope);
	const file = existing?.path ?? join(scope === "global" ? join(home, ".agents", "templates") : join(cwd, ".agents", "templates"), `${name}.md`);
	if (!existsSync(file)) throw notFound(`prompt template "${name}"`);
	rmSync(file);
}

/** `$ARGUMENTS` is replaced by what followed the call; without a placeholder the arguments are appended. */
export function expandTemplate(body: string, args: string): string {
	const text = body.trim();
	if (/\$ARGUMENTS\b/.test(text)) return text.replace(/\$ARGUMENTS\b/g, () => args);
	return args ? `${text}\n\n${args}` : text;
}

/** Keeps a very long expanded template within the inline limit. */
export function limitTemplateText(expanded: string): string {
	return expanded.length > MAX_INLINE_TEMPLATE_CHARS ? `${expanded.slice(0, MAX_INLINE_TEMPLATE_CHARS)}\n[cut]` : expanded;
}

/** Resolves `/prompt:<name> [args]` in `cwd`. Returns null when the text is not a `/prompt:` call or no template matches. */
export function runPromptTemplate(
	text: string,
	cwd: string,
	home: string = homedir(),
): { prompt: string; note: MessageNote; title: string } | null {
	const m = /^\/prompt:([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
	if (!m) return null;
	const name = m[1]!;
	const args = (m[2] ?? "").trim();
	const entry = discoverTemplates(cwd, { home }).templates.find((t) => !t.overridden && t.name === name);
	if (!entry) return null;
	try {
		const raw = readFileSync(entry.path, "utf8");
		const { body } = splitTemplate(raw);
		if (!body.trim()) return null;
		return {
			prompt: limitTemplateText(expandTemplate(body, args)),
			note: { text: `Prompt template: ${name}`, collapse: true, data: { name } },
			title: name,
		};
	} catch {
		return null;
	}
}

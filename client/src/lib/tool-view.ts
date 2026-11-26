export interface GrepHit {
	line: number | null;
	text: string;
}

export interface GrepGroup {
	path: string;
	hits: GrepHit[];
}

export interface ParsedGrep {
	groups: GrepGroup[];
	moreNote: string;
	empty: boolean;
}

/** Pull trailing `[...]` notice lines (e.g. truncation or partial-result warnings) off tool output. */
function extractTrailingNotes(lines: string[]): { body: string[]; note: string } {
	const notes: string[] = [];
	let end = lines.length;
	while (end > 0) {
		const last = lines[end - 1]!.trim();
		if (last.startsWith("[") && last.endsWith("]") && last.length > 2) {
			notes.unshift(last.slice(1, -1));
			end--;
		} else {
			break;
		}
	}
	return { body: lines.slice(0, end), note: notes.join(" · ") };
}

/**
 * Parse ripgrep/grep `path:line:text` (and `-C` context `path-line-text` or `-l` file-only) lines
 * into file-grouped matches, separating any trailing `[...]` notices.
 * Unstructured lines fall back into a group with `path: ""`.
 */
export function parseGrepOutput(output: string): ParsedGrep {
	const trimmed = output.trim();
	if (!trimmed || trimmed === "No matches" || trimmed === "(no matches)") {
		return { groups: [], moreNote: "", empty: true };
	}
	const rawLines = trimmed.replace(/\r\n?/g, "\n").split("\n");
	const { body, note: moreNote } = extractTrailingNotes(rawLines);

	const byPath = new Map<string, GrepGroup>();
	const matchRe = /^(.+?):(\d+):(.*)$/;
	const ctxRe = /^(.+?)-(\d+)-(.*)$/;
	const fileOnlyRe = /^[^\s:]+(?:\/[^\s:]*|\.[a-zA-Z0-9_-]+)$/;
	for (const raw of body) {
		if (!raw || raw === "--") continue;
		const m = matchRe.exec(raw) ?? ctxRe.exec(raw);
		if (m) {
			const path = m[1]!;
			const line = Number(m[2]);
			const text = m[3]!;
			let group = byPath.get(path);
			if (!group) {
				group = { path, hits: [] };
				byPath.set(path, group);
			}
			group.hits.push({ line: Number.isSafeInteger(line) ? line : null, text });
			continue;
		}
		if (fileOnlyRe.test(raw)) {
			if (!byPath.has(raw)) {
				byPath.set(raw, { path: raw, hits: [] });
			}
			continue;
		}
		let group = byPath.get("");
		if (!group) {
			group = { path: "", hits: [] };
			byPath.set("", group);
		}
		group.hits.push({ line: null, text: raw });
	}
	const groups = [...byPath.values()];
	return { groups, moreNote, empty: groups.length === 0 };
}

export interface LsEntry {
	name: string;
	fullPath: string;
	isDir: boolean;
}

export interface ParsedLs {
	entries: LsEntry[];
	moreNote: string;
	empty: boolean;
}

/** Parse `ls` tool output (newline-separated names, directories ending with `/`, optional trailing `[...]` note). */
export function parseLsOutput(output: string, basePath = ""): ParsedLs {
	const trimmed = output.trim();
	if (!trimmed || trimmed === "(empty)") {
		return { entries: [], moreNote: "", empty: true };
	}
	const cleanBase = basePath.trim().replace(/\/+$/, "");
	const prefix = cleanBase && cleanBase !== "." ? `${cleanBase}/` : "";
	const rawLines = trimmed.replace(/\r\n?/g, "\n").split("\n");
	const { body, note: moreNote } = extractTrailingNotes(rawLines);
	const entries: LsEntry[] = [];
	for (const raw of body) {
		const name = raw.trim();
		if (!name) continue;
		const isDir = name.endsWith("/");
		const cleanName = isDir ? name.slice(0, -1) : name;
		entries.push({ name: cleanName, fullPath: `${prefix}${cleanName}`, isDir });
	}
	return { entries, moreNote, empty: entries.length === 0 };
}

export interface ParsedReadLine {
	lineNo: number;
	text: string;
}

export interface ParsedRead {
	code: string;
	lines: ParsedReadLine[];
	moreNote: string;
}

const NUMBERED_READ_RE = /^\s*(\d+)│(.*)$/;

/**
 * Parse `read` tool output into numbered code lines, stripping the server's `  12│` prefix so line
 * numbers are not doubled and highlight.js sees clean source. Returns null for meta messages like
 * `(empty file)` or `(file has N lines; offset … past EOF)`.
 */
export function parseReadOutput(output: string, fallbackFrom = 1): ParsedRead | null {
	const trimmed = output.trim();
	if (!trimmed) return null;
	if (trimmed === "(empty file)" || /^\(file has \d+ lines;/.test(trimmed)) return null;

	const m = /\n\[(\d+ more lines;[^\]]+)\]\s*$/.exec(output);
	const raw = m ? output.slice(0, m.index) : output;
	const moreNote = m ? m[1]! : "";
	const rawLines = raw.replace(/\r\n?/g, "\n").split("\n");

	const allNumbered = rawLines.length > 0 && rawLines.every((l) => NUMBERED_READ_RE.test(l));
	const lines: ParsedReadLine[] = [];
	const cleanTexts: string[] = [];
	for (let i = 0; i < rawLines.length; i++) {
		const line = rawLines[i]!;
		if (allNumbered) {
			const nm = NUMBERED_READ_RE.exec(line)!;
			lines.push({ lineNo: Number(nm[1]), text: nm[2]! });
			cleanTexts.push(nm[2]!);
		} else {
			lines.push({ lineNo: fallbackFrom + i, text: line });
			cleanTexts.push(line);
		}
	}
	return { code: cleanTexts.join("\n"), lines, moreNote };
}

export interface KvRow {
	key: string;
	value: string;
	multiline: boolean;
}

/**
 * Format tool arguments as clean key/value rows instead of a raw JSON dump.
 * Preserves falsy primitives (`0`, `false`, `null`), skips `undefined` and empty strings.
 */
export function formatKvArgs(args: Record<string, unknown>, omitKeys: readonly string[] = []): KvRow[] {
	const omit = new Set(omitKeys);
	const rows: KvRow[] = [];
	for (const [key, v] of Object.entries(args)) {
		if (omit.has(key) || v === undefined || v === "") continue;
		if (v === null || typeof v === "number" || typeof v === "boolean") {
			rows.push({ key, value: String(v), multiline: false });
			continue;
		}
		if (typeof v === "string") {
			const multiline = v.includes("\n") || v.length > 80;
			rows.push({ key, value: v, multiline });
			continue;
		}
		if (Array.isArray(v)) {
			const allScalar = v.every((x) => typeof x === "string" || typeof x === "number" || typeof x === "boolean");
			if (allScalar) {
				const joined = v.map(String).join(", ");
				if (joined.length <= 80 && !joined.includes("\n")) {
					rows.push({ key, value: joined || "[]", multiline: false });
					continue;
				}
			}
		}
		try {
			const pretty = JSON.stringify(v, null, 2);
			rows.push({ key, value: pretty, multiline: pretty.includes("\n") || pretty.length > 80 });
		} catch {
			rows.push({ key, value: String(v), multiline: false });
		}
	}
	return rows;
}

const MAX_PRETTY_JSON_CHARS = 20_000;

/** Pretty-print a JSON object/array string for highlighted display, or return null if not JSON. */
export function tryPrettyJson(text: string): string | null {
	const trimmed = text.trim();
	if (!trimmed || trimmed.length > MAX_PRETTY_JSON_CHARS) return null;
	const first = trimmed[0];
	if (first !== "{" && first !== "[") return null;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed === null || typeof parsed !== "object") return null;
		return JSON.stringify(parsed, null, 2);
	} catch {
		return null;
	}
}

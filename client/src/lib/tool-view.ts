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

/**
 * Parse ripgrep/grep `path:line:text` lines into file-grouped matches, separating any trailing
 * `[N more matches]` notice. Unstructured lines fall back into a group with `path: ""`.
 */
export function parseGrepOutput(output: string): ParsedGrep {
	const trimmed = output.trim();
	if (!trimmed || trimmed === "No matches") {
		return { groups: [], moreNote: "", empty: true };
	}
	const moreMatch = /\n\[(\d+ more matches)\]\s*$/.exec(trimmed);
	const body = moreMatch ? trimmed.slice(0, moreMatch.index) : trimmed;
	const moreNote = moreMatch ? moreMatch[1]! : "";

	const byPath = new Map<string, GrepGroup>();
	const lineRe = /^(.+?):(\d+):(.*)$/;
	for (const raw of body.replace(/\r\n?/g, "\n").split("\n")) {
		if (!raw) continue;
		const m = lineRe.exec(raw);
		const path = m ? m[1]! : "";
		const line = m ? Number(m[2]) : null;
		const text = m ? m[3]! : raw;
		let group = byPath.get(path);
		if (!group) {
			group = { path, hits: [] };
			byPath.set(path, group);
		}
		group.hits.push({ line: Number.isSafeInteger(line) ? line : null, text });
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
	empty: boolean;
}

/** Parse `ls` tool output (newline-separated names, directories ending with `/`). */
export function parseLsOutput(output: string, basePath = ""): ParsedLs {
	const trimmed = output.trim();
	if (!trimmed || trimmed === "(empty)") {
		return { entries: [], empty: true };
	}
	const cleanBase = basePath.trim().replace(/\/+$/, "");
	const prefix = cleanBase && cleanBase !== "." ? `${cleanBase}/` : "";
	const entries: LsEntry[] = [];
	for (const raw of trimmed.replace(/\r\n?/g, "\n").split("\n")) {
		const name = raw.trim();
		if (!name) continue;
		const isDir = name.endsWith("/");
		const cleanName = isDir ? name.slice(0, -1) : name;
		entries.push({ name: cleanName, fullPath: `${prefix}${cleanName}`, isDir });
	}
	return { entries, empty: entries.length === 0 };
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

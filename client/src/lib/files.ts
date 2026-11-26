import { uid } from "./format";
import type { UploadFile } from "./types";

/** Matches the server (server/src/file-routes.ts) */
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES_TOTAL = 100 * 1024 * 1024;

/** A file waiting in the composer. `preview` is a blob: URL for images, so the strip can show a thumbnail. */
export interface FileDraft extends UploadFile {
	id: string;
	preview?: string;
}

export type PreviewKind = "image" | "pdf" | "audio" | "video" | "markdown" | "html" | "table" | "text" | "other";

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|toml|ini|xml|html?|css|[cm]?[jt]sx?|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|sql|diff|patch|env)$/i;

export function previewKind(name: string, mimeType = ""): PreviewKind {
	if (/^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/.test(mimeType) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) return "image";
	if (mimeType === "application/pdf" || /\.pdf$/i.test(name)) return "pdf";
	if (/^audio\//.test(mimeType) || /\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(name)) return "audio";
	if (/^video\/(mp4|webm|ogg|quicktime)$/.test(mimeType) || /\.(mp4|m4v|webm|ogv|mov)$/i.test(name)) return "video";
	if (/\.(md|markdown)$/i.test(name)) return "markdown";
	if (/\.html?$/i.test(name)) return "html";
	if (/\.(csv|tsv)$/i.test(name)) return "table";
	if (mimeType.startsWith("text/") || mimeType === "application/json" || TEXT_EXT.test(name)) return "text";
	return "other";
}

export function sizeLabel(bytes?: number): string {
	if (bytes === undefined) return "";
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function extOf(name: string): string {
	const m = /\.([a-z0-9]{1,5})$/i.exec(name);
	return m ? m[1]!.toUpperCase() : "FILE";
}

const toBase64 = (buf: ArrayBuffer): string => {
	const bytes = new Uint8Array(buf);
	let out = "";
	for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	return btoa(out);
};

const isPreviewableImage = (name: string, mimeType: string): boolean => previewKind(name, mimeType) === "image" && mimeType !== "image/svg+xml";

const base64BlobUrl = (data: string, mimeType: string): string | undefined => {
	if (!data) return undefined;
	try {
		const bin = atob(data);
		const bytes = new Uint8Array(bin.length);
		for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
		return URL.createObjectURL(new Blob([bytes], { type: mimeType }));
	} catch {
		return undefined;
	}
};

/** Read any file as-is (no resizing: the agent gets the original bytes). */
export async function fileToDraft(file: File): Promise<FileDraft> {
	const mimeType = file.type || "application/octet-stream";
	const name = file.name || "file";
	return {
		id: uid(),
		name,
		size: file.size,
		mimeType,
		data: toBase64(await file.arrayBuffer()),
		preview: isPreviewableImage(name, mimeType) ? URL.createObjectURL(file) : undefined,
	};
}

/** Rebuild a composer `FileDraft` from an `UploadFile`, minting a fresh `blob:` preview URL for raster images. */
export function uploadFileToDraft(file: UploadFile, id = uid()): FileDraft {
	return {
		id,
		name: file.name,
		size: file.size,
		mimeType: file.mimeType,
		data: file.data,
		preview: isPreviewableImage(file.name, file.mimeType) ? base64BlobUrl(file.data, file.mimeType) : undefined,
	};
}

/** Last path segment of a relative path */
export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** Split a path with a directory prefix into `{ dir, base }` so a narrow chip can shrink `dir` before `base`. */
export function splitFilePath(path: string): { dir: string; base: string } | null {
	const idx = path.lastIndexOf("/");
	if (idx <= 0 || idx === path.length - 1) return null;
	return { dir: path.slice(0, idx + 1), base: path.slice(idx + 1) };
}

/** A markdown href that points into the working directory: relative, no scheme, not an anchor. */
export function isWorkdirPath(href: string): boolean {
	if (!href || href.startsWith("#") || href.startsWith("//") || href.startsWith("/") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
	return !href.split("/").includes("..");
}

/** A markdown href that names a file on the server's own disk: an absolute path, a Windows drive path or a file:// URL. */
export function isLocalFilePath(href: string): boolean {
	if (!href) return false;
	if (/^file:\/\/\//i.test(href)) return true;
	if (/^[a-z]:[\\/]/i.test(href)) return true;
	return href.startsWith("/") && !href.startsWith("//");
}

/** Extensions a browser draws inline; a link to one of these is shown as the picture itself. */
const INLINE_IMAGE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
export const isImagePath = (href: string): boolean => INLINE_IMAGE.test(href.replace(/[?#].*$/, ""));

/** A link to a video or audio file on the server is played inline; null for anything else. */
export function mediaKindOf(href: string): "video" | "audio" | null {
	const bare = href.replace(/[?#].*$/, "");
	if (/\.(mp4|m4v|webm|ogv|mov)$/i.test(bare)) return "video";
	if (/\.(mp3|wav|ogg|oga|m4a|aac|flac|opus)$/i.test(bare)) return "audio";
	return null;
}

/** What the file route is asked for: the path a pipaya session can read (relative to its folder, or absolute on the server). */
export function filePathOf(href: string): string {
	const bare = href.replace(/^file:\/\//i, "");
	return cleanWorkdirPath(/^\/[a-z]:[\\/]/i.test(bare) ? bare.slice(1) : bare);
}

/** Strip `./`, the query and the fragment, and decode. */
export function cleanWorkdirPath(href: string): string {
	const bare = href.replace(/[?#].*$/, "").replace(/^\.\//, "");
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

export interface ParsedFileRef {
	path: string;
	line?: number;
	endLine?: number;
}

const MAX_LINE = 1_000_000;
const validLine = (s: string | undefined): number | undefined => {
	if (!s) return undefined;
	const n = Number(s);
	return Number.isSafeInteger(n) && n >= 1 && n <= MAX_LINE ? n : undefined;
};

/**
 * Split optional line/range suffixes (`src/a.ts:42`, `src/a.ts:42-50`, `src/a.ts:42:10`, `src/a.ts#L42`, `src/a.ts#L42-L50`)
 * from a file path. Preserves Windows drive letters (`C:\a.ts:10`).
 */
export function splitFileRef(raw: string): ParsedFileRef {
	const hash = /^(.+?)#L(\d+)(?:-L?(\d+))?$/i.exec(raw);
	if (hash) {
		const line = validLine(hash[2]);
		const end = validLine(hash[3]);
		return line ? { path: hash[1]!, line, ...(end && end >= line ? { endLine: end } : {}) } : { path: hash[1]! };
	}
	const colon = /^(.+?):(\d+)(?:-(\d+)|:\d+)?$/.exec(raw);
	if (colon && !/^[A-Za-z]$/.test(colon[1]!)) {
		const line = validLine(colon[2]);
		const end = validLine(colon[3]);
		return line ? { path: colon[1]!, line, ...(end && end >= line ? { endLine: end } : {}) } : { path: colon[1]! };
	}
	return { path: raw };
}

/** Parse a markdown workdir link (`./src/a.ts#L42-L50`, `src/a.ts:42`, `src/a.ts?v=1`) into a clean path + optional line range. */
export function fileRefOfHref(href: string): ParsedFileRef {
	const hash = /#L(\d+)(?:-L?(\d+))?$/i.exec(href);
	const base = splitFileRef(cleanWorkdirPath(href));
	if (base.line || !hash) return base;
	const line = validLine(hash[1]);
	const end = validLine(hash[2]);
	return line ? { path: base.path, line, ...(end && end >= line ? { endLine: end } : {}) } : base;
}

/** Format an optional line range as `:42` or `:42-50` (empty string when no line). */
export const formatFileLine = (line?: number, endLine?: number): string =>
	line ? (endLine && endLine > line ? `:${line}-${endLine}` : `:${line}`) : "";

/** Known file extensions for recognizing unambiguous repo-relative file paths inside inline `<code>` spans. */
const CODE_FILE_EXT =
	/\.(?:[cm]?[jt]sx?|svelte|vue|astro|py|rb|go|rs|java|kt|kts|swift|c|h|cc|cpp|hpp|cs|php|sh|bash|zsh|fish|sql|html?|css|scss|less|jsonc?|ya?ml|toml|ini|conf|cfg|xml|svg|md|markdown|txt|csv|tsv|log|diff|patch|env|prisma|graphql|gql|proto|tf|hcl|png|jpe?g|gif|webp|pdf|mp3|mp4|wav|webm|mov)$/i;

/**
 * True when an inline `<code>` span's sole text is unambiguously a relative file path (has `/`, known extension,
 * no whitespace, no scheme, no `..`, no globs/domains, optional `:line(-end)?` or `#L42(-L50)?`). Rejects versions
 * (`model-v5.5`), domains (`github.com/a/b.md`), globs (`src/*.ts`), branch names (`feat/foo`), property access
 * (`console.log`), CSS selectors (`.vfade`), and absolute paths (`/etc/passwd`).
 */
export function parseInlineCodeFilePath(raw: string): ParsedFileRef | null {
	const s = raw.trim();
	if (!s || /[\s*?{}$<>]/.test(s) || s.startsWith("/") || s.startsWith("~") || s.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null;
	const normalized = s.replace(/^\.\//, "");
	const ref = splitFileRef(normalized);
	if (!ref.path.includes("/") || ref.path.startsWith("/") || ref.path.split("/").includes("..")) return null;
	// Reject bare domain-like prefixes such as `github.com/org/repo.md`, while still allowing dot-dirs like `.github/...`.
	const firstSeg = ref.path.slice(0, ref.path.indexOf("/"));
	if (/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(firstSeg)) return null;
	if (!CODE_FILE_EXT.test(ref.path)) return null;
	return ref;
}

/** Parse CSV/TSV (quotes, escaped quotes, newlines inside quotes). Small and forgiving; for previews only. */
export function parseTable(src: string, delimiter: string, maxRows = 1000): { rows: string[][]; more: boolean } {
	const rows: string[][] = [];
	let row: string[] = [];
	let cell = "";
	let quoted = false;
	let more = false;
	const text = src.replace(/^\uFEFF/, "");
	for (let i = 0; i < text.length; i++) {
		const c = text[i]!;
		if (quoted) {
			if (c === '"') {
				if (text[i + 1] === '"') { cell += '"'; i++; } else quoted = false;
			} else cell += c;
		} else if (c === '"' && cell === "") quoted = true;
		else if (c === delimiter) { row.push(cell); cell = ""; }
		else if (c === "\n" || c === "\r") {
			if (c === "\r" && text[i + 1] === "\n") i++;
			row.push(cell); cell = "";
			rows.push(row); row = [];
			if (rows.length >= maxRows) { more = i < text.length - 1; return { rows, more }; }
		} else cell += c;
	}
	if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
	return { rows, more };
}

/** Images one message can carry (vision models only; everything else is a file). */
export const MAX_IMAGES = 16;

/** Whether a picked file goes in as a downscaled image (the model can see it) rather than as a plain file. */
export const isInlineImage = (file: { type: string }, vision: boolean): boolean =>
	vision && file.type.startsWith("image/") && file.type !== "image/svg+xml";

/**
 * Why `file` cannot join the files already waiting, or null when it fits. `stop` means no further file can fit either,
 * so the caller should skip the rest of the batch instead of reporting every one.
 */
export function fileRejection(file: { size: number; name: string }, existing: readonly { size: number }[]): { reason: "count" | "size" | "total"; stop: boolean } | null {
	if (existing.length >= MAX_FILES) return { reason: "count", stop: true };
	if (file.size > MAX_FILE_BYTES) return { reason: "size", stop: false };
	if (existing.reduce((n, x) => n + x.size, file.size) > MAX_FILES_TOTAL) return { reason: "total", stop: false };
	return null;
}

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

/** Read any file as-is (no resizing: the agent gets the original bytes). */
export async function fileToDraft(file: File): Promise<FileDraft> {
	const mimeType = file.type || "application/octet-stream";
	return {
		id: uid(),
		name: file.name || "file",
		size: file.size,
		mimeType,
		data: toBase64(await file.arrayBuffer()),
		preview: previewKind(file.name, mimeType) === "image" && mimeType !== "image/svg+xml" ? URL.createObjectURL(file) : undefined,
	};
}

/** Last path segment of a relative path */
export const baseName = (path: string): string => path.split("/").filter(Boolean).pop() ?? path;

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

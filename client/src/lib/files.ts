import { uid } from "./format";
import type { UploadFile } from "./types";

/** Matches the server (server/src/file-routes.ts) */
export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 20 * 1024 * 1024;
export const MAX_FILES_TOTAL = 25 * 1024 * 1024;

/** A file waiting in the composer. `preview` is a blob: URL for images, so the strip can show a thumbnail. */
export interface FileDraft extends UploadFile {
	id: string;
	preview?: string;
}

export type PreviewKind = "image" | "text" | "other";

const TEXT_EXT = /\.(txt|md|markdown|json|csv|tsv|log|ya?ml|toml|ini|xml|html?|css|[cm]?[jt]sx?|svelte|py|rb|go|rs|java|kt|swift|c|h|cpp|hpp|sh|sql|diff|patch|env)$/i;

export function previewKind(name: string, mimeType = ""): PreviewKind {
	if (/^image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml)$/.test(mimeType) || /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i.test(name)) return "image";
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

/** Strip `./`, the query and the fragment, and decode. */
export function cleanWorkdirPath(href: string): string {
	const bare = href.replace(/[?#].*$/, "").replace(/^\.\//, "");
	try {
		return decodeURIComponent(bare);
	} catch {
		return bare;
	}
}

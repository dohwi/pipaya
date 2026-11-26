import { createHash, randomUUID } from "node:crypto";
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { previewImage } from "./image-resize.ts";
import type { PreviewResult } from "./image-resize-core.ts";
import { safePath } from "./tools.ts";

/** Max dimension (px) for archived assistant-image snapshots so session logs stay light on disk. */
export const SNAPSHOT_MAX_DIM = 2048;
/** Raster images larger than this are downscaled before archiving; smaller ones are kept as-is. */
const SNAPSHOT_MIN_RESIZE_BYTES = 100 * 1024;
/** Largest source image file we will read into RAM to snapshot. */
const MAX_SNAPSHOT_SOURCE_BYTES = 25 * 1024 * 1024;
/** Largest archived file we will keep on disk if it cannot be shrunk (e.g. GIF/SVG/unshrinkable PNG). */
const MAX_SNAPSHOT_STORED_BYTES = 8 * 1024 * 1024;

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|bmp|avif|svg)$/i;
const RESIZABLE_EXT = new Set(["png", "jpg", "jpeg", "webp", "bmp"]);
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;
/** Cap retained delete-generation counters so long-running servers do not accumulate dead session IDs. */
const MAX_GEN_ENTRIES = 2000;

const EXT_FOR_MIME: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
	"image/gif": "gif",
	"image/bmp": "bmp",
	"image/avif": "avif",
	"image/svg+xml": "svg",
};

/** Normalize a markdown href or `/files?path=` query into a canonical lookup key. */
export function normalizeMediaPath(raw: string): string {
	let s = raw.trim();
	if (!s) return "";
	s = s.replace(/^file:\/\//i, "");
	if (/^\/[a-z]:[\\/]/i.test(s)) s = s.slice(1);
	s = s.replace(/[?#].*$/, "");
	try {
		s = decodeURIComponent(s);
	} catch {
		/* keep undecoded string */
	}
	s = s.replace(/\\/g, "/").replace(/^\.\//, "");
	return s;
}

function isLocalCandidate(href: string): boolean {
	if (!href) return false;
	if (/^file:\/\/\//i.test(href)) return true;
	if (/^[a-z]:[\\/]/i.test(href)) return true;
	if (href.startsWith("/") && !href.startsWith("//")) return true;
	if (href.startsWith("#") || href.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return false;
	return !href.split(/[\\/]/).includes("..");
}

/** Strip fenced code blocks and inline code spans so example markdown inside code is ignored. */
function stripCode(text: string): string {
	return text
		.replace(/^(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1[ \t]*$/gm, "")
		.replace(/`+[^`]*`+/g, "");
}

/** Parse the destination from inside `(... )`, supporting `<path with spaces>` and optional `"title"`. */
function parseLinkDest(raw: string): string {
	const s = raw.trim();
	if (!s) return "";
	if (s.startsWith("<")) {
		const end = s.indexOf(">");
		return end > 1 ? s.slice(1, end).trim() : "";
	}
	const space = s.search(/\s/);
	return space === -1 ? s : s.slice(0, space);
}

/**
 * Extract unique local image paths referenced in assistant markdown (`![alt](path)` and `[label](path.png)`).
 * Mirrors the client's inline-image rules in `client/src/lib/markdown.ts` and `files.ts`.
 */
export function extractAssistantImagePaths(text: string): string[] {
	if (!text) return [];
	const cleaned = stripCode(text);
	const out: string[] = [];
	const seen = new Set<string>();
	// Matches both `![alt](dest)` and `[label](dest)` (including nested `[![alt](img)](img)`).
	const linkRe = /!?\[[^\]]*\]\(([^)\n]+)\)/g;
	for (const m of cleaned.matchAll(linkRe)) {
		const dest = parseLinkDest(m[1] ?? "");
		if (!dest || !isLocalCandidate(dest)) continue;
		const norm = normalizeMediaPath(dest);
		if (!norm || !IMAGE_EXT_RE.test(norm) || seen.has(norm)) continue;
		seen.add(norm);
		out.push(norm);
	}
	return out;
}

/** Extract all text blocks from a persisted assistant message. */
export function assistantMessageText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const m = message as { role?: unknown; content?: unknown };
	if (m.role !== "assistant") return "";
	if (typeof m.content === "string") return m.content;
	if (!Array.isArray(m.content)) return "";
	const parts: string[] = [];
	for (const block of m.content) {
		if (block && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string") {
			parts.push((block as { text: string }).text);
		}
	}
	return parts.join("\n");
}

const pathHash = (normalizedPath: string) => createHash("sha256").update(normalizedPath).digest("hex").slice(0, 32);

export interface SessionMediaOptions {
	preview?: (bytes: Uint8Array, maxDim: number, jpegQuality?: number) => Promise<PreviewResult | null>;
	maxDim?: number;
	minResizeBytes?: number;
	maxSourceBytes?: number;
	maxStoredBytes?: number;
	maxGenEntries?: number;
}

/**
 * Stores downscaled snapshots of assistant-referenced images per session under `<dataDir>/session-media/<sessionId>/`.
 * Used as a fallback by `GET /sessions/:id/files` when the original file in `tmp/` or a removed worktree is gone,
 * and deleted automatically when the session is deleted (or purged by retention).
 */
export class SessionMedia {
	private readonly previewFn: (bytes: Uint8Array, maxDim: number, jpegQuality?: number) => Promise<PreviewResult | null>;
	private readonly maxDim: number;
	private readonly minResizeBytes: number;
	private readonly maxSourceBytes: number;
	private readonly maxStoredBytes: number;
	private readonly maxGenEntries: number;
	/** Monotonic counter per session; incremented on delete so in-flight captures never resurrect a deleted folder. */
	private readonly gen = new Map<string, number>();
	private readonly inflight = new Map<string, Promise<void>>();

	constructor(
		private readonly root: string,
		private readonly isAlive: (sessionId: string) => boolean,
		opts: SessionMediaOptions = {},
	) {
		this.previewFn = opts.preview ?? previewImage;
		this.maxDim = opts.maxDim ?? SNAPSHOT_MAX_DIM;
		this.minResizeBytes = opts.minResizeBytes ?? SNAPSHOT_MIN_RESIZE_BYTES;
		this.maxSourceBytes = opts.maxSourceBytes ?? MAX_SNAPSHOT_SOURCE_BYTES;
		this.maxStoredBytes = opts.maxStoredBytes ?? MAX_SNAPSHOT_STORED_BYTES;
		this.maxGenEntries = opts.maxGenEntries ?? MAX_GEN_ENTRIES;
	}

	private sessionDir(sessionId: string): string | null {
		if (!SAFE_SESSION_ID.test(sessionId)) return null;
		return join(this.root, sessionId);
	}

	/** Archive any existing local images referenced in `text` for `sessionId`. Never throws. */
	async captureFromText(sessionId: string, dirs: readonly string[], text: string): Promise<void> {
		const dir = this.sessionDir(sessionId);
		if (!dir || !dirs.length || !text) return;
		const paths = extractAssistantImagePaths(text);
		if (!paths.length) return;
		const startGen = this.gen.get(sessionId) ?? 0;
		const jobs = paths.map((p) => this.captureOne(sessionId, dir, dirs, p, startGen));
		await Promise.allSettled(jobs);
	}

	private captureOne(sessionId: string, dir: string, dirs: readonly string[], normPath: string, startGen: number): Promise<void> {
		const hash = pathHash(normPath);
		const key = `${sessionId}\0${hash}`;
		const prev = this.inflight.get(key) ?? Promise.resolve();
		const next = prev.catch(() => {}).then(async () => {
			if (!this.stillLive(sessionId, startGen)) return;
			let abs = "";
			let info;
			for (const base of dirs) {
				try {
					abs = safePath(base, normPath);
				} catch {
					continue;
				}
				try {
					info = await stat(abs);
				} catch {
					continue;
				}
				if (info.isFile()) break;
				info = undefined;
			}
			if (!info || info.size <= 0 || info.size > this.maxSourceBytes) return;

			let raw: Buffer;
			try {
				raw = await readFile(abs);
			} catch {
				return;
			}
			if (!this.stillLive(sessionId, startGen)) return;

			const origExt = extname(abs).slice(1).toLowerCase() || "png";
			let outBytes: Uint8Array = raw;
			let outExt = origExt === "jpeg" ? "jpg" : origExt;

			if (RESIZABLE_EXT.has(origExt) && raw.byteLength > this.minResizeBytes) {
				try {
					const shrunk = await this.previewFn(raw, this.maxDim, 82);
					if (shrunk && shrunk.bytes.byteLength > 0 && shrunk.bytes.byteLength < raw.byteLength) {
						outBytes = shrunk.bytes;
						outExt = EXT_FOR_MIME[shrunk.mimeType] ?? outExt;
					}
				} catch {
					/* fall back to original bytes if within stored limit */
				}
			}

			if (outBytes.byteLength > this.maxStoredBytes) return;
			if (!this.stillLive(sessionId, startGen)) return;

			await mkdir(dir, { recursive: true });
			if (!this.stillLive(sessionId, startGen)) {
				await rm(dir, { recursive: true, force: true }).catch(() => {});
				return;
			}

			const target = join(dir, `${hash}.${outExt}`);
			const tmp = join(dir, `.${hash}.${randomUUID().slice(0, 8)}.tmp`);
			try {
				await writeFile(tmp, outBytes);
				if (!this.stillLive(sessionId, startGen)) {
					await unlink(tmp).catch(() => {});
					return;
				}
				await rename(tmp, target);
				// Remove stale snapshot if the same path previously archived under a different extension (e.g. png -> jpg).
				const entries = await readdir(dir).catch(() => [] as string[]);
				const prefix = `${hash}.`;
				for (const name of entries) {
					if (name.startsWith(prefix) && name !== `${hash}.${outExt}`) {
						await unlink(join(dir, name)).catch(() => {});
					}
				}
			} catch {
				await unlink(tmp).catch(() => {});
			}
		});
		const tracked = next.finally(() => {
			if (this.inflight.get(key) === tracked) this.inflight.delete(key);
		});
		this.inflight.set(key, tracked);
		return tracked;
	}

	private stillLive(sessionId: string, startGen: number): boolean {
		return (this.gen.get(sessionId) ?? 0) === startGen && this.isAlive(sessionId);
	}

	/** Look up an archived snapshot for `queryPath` when the original file no longer exists on disk. */
	async resolve(sessionId: string, queryPath: string): Promise<string | null> {
		const dir = this.sessionDir(sessionId);
		if (!dir) return null;
		const norm = normalizeMediaPath(queryPath);
		if (!norm) return null;
		const prefix = `${pathHash(norm)}.`;
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch {
			return null;
		}
		const match = entries.find((name) => name.startsWith(prefix) && !name.endsWith(".tmp"));
		return match ? join(dir, match) : null;
	}

	/** Copy (hardlink when possible) a session's snapshots to a forked session. */
	async fork(fromId: string, toId: string): Promise<void> {
		const srcDir = this.sessionDir(fromId);
		const dstDir = this.sessionDir(toId);
		if (!srcDir || !dstDir) return;
		const startGen = this.gen.get(toId) ?? 0;
		let entries: string[];
		try {
			entries = await readdir(srcDir);
		} catch {
			return;
		}
		const files = entries.filter((name) => !name.startsWith(".") && !name.endsWith(".tmp"));
		if (!files.length || !this.stillLive(toId, startGen)) return;
		await mkdir(dstDir, { recursive: true });
		for (const name of files) {
			if (!this.stillLive(toId, startGen)) break;
			const src = join(srcDir, name);
			const dst = join(dstDir, name);
			try {
				await link(src, dst);
			} catch {
				await copyFile(src, dst).catch(() => {});
			}
		}
		if (!this.stillLive(toId, startGen)) {
			await rm(dstDir, { recursive: true, force: true }).catch(() => {});
		}
	}

	/** Delete all archived snapshots for a deleted session. */
	async delete(sessionId: string): Promise<void> {
		this.gen.set(sessionId, (this.gen.get(sessionId) ?? 0) + 1);
		if (this.gen.size > this.maxGenEntries) {
			for (const id of this.gen.keys()) {
				if (this.gen.size <= this.maxGenEntries) break;
				if (id !== sessionId && !this.isAlive(id)) this.gen.delete(id);
			}
		}
		const dir = this.sessionDir(sessionId);
		if (!dir) return;
		await rm(dir, { recursive: true, force: true }).catch(() => {});
	}

	/**
	 * Remove archived snapshot folders whose session no longer exists (e.g. after an ungraceful shutdown
	 * mid-delete). Non-directory files and unsafe names are ignored. Returns the number of folders removed.
	 */
	async sweepOrphans(): Promise<number> {
		let entries;
		try {
			entries = await readdir(this.root, { withFileTypes: true });
		} catch {
			return 0;
		}
		let removed = 0;
		for (const entry of entries) {
			if (!entry.isDirectory() || !SAFE_SESSION_ID.test(entry.name)) continue;
			if (this.isAlive(entry.name)) continue;
			try {
				await rm(join(this.root, entry.name), { recursive: true, force: true });
				removed++;
			} catch { /* best effort */ }
		}
		return removed;
	}
}

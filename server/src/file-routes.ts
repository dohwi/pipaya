import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import Type from "typebox";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { previewImage } from "./image-resize.ts";
import { errors } from "./schemas.ts";
import { safePath } from "./tools.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Files larger than this are streamed directly from disk instead of buffered whole into RAM. */
const STREAM_MIN_BYTES = 256 * 1024;

/** Parse a single `Range: bytes=...` header. Returns `invalid` (416), a concrete `{ start, end }` slice, or `null` (ignore). */
export function parseByteRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
	if (!header) return null;
	const m = /^bytes=(\d*)-(\d*)$/i.exec(header.trim());
	if (!m) return null;
	const [, a, b] = m;
	if (!a && !b) return null;
	if (size <= 0) return "unsatisfiable";
	if (!a) {
		const suffix = Number.parseInt(b!, 10);
		if (!Number.isFinite(suffix) || suffix <= 0) return "unsatisfiable";
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}
	const start = Number.parseInt(a, 10);
	const end = b ? Math.min(size - 1, Number.parseInt(b, 10)) : size - 1;
	if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return "unsatisfiable";
	return { start, end };
}

/** Where files the user attaches land, relative to the session's working directory. */
export const UPLOAD_DIR = ".pipaya/uploads";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 8;
/** One message may carry this many bytes of files in total. */
export const MAX_FILES_TOTAL = 100 * 1024 * 1024;

/** Images larger than this are downscaled when requested with `?max=` for fast inline preview. */
const PREVIEW_MIN_BYTES = 100 * 1024;
const PREVIEW_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/bmp"]);
const PREVIEW_CACHE_MAX_ENTRIES = 80;
const PREVIEW_CACHE_MAX_BYTES = 24 * 1024 * 1024;
const PREVIEW_CACHE_MAX_RAW_FALLBACK_BYTES = 4 * 1024 * 1024;
const FILE_CACHE_CONTROL = "private, max-age=60, must-revalidate";

const MIME: Record<string, string> = {
	png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", avif: "image/avif",
	svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", csv: "text/csv", md: "text/markdown", markdown: "text/markdown",
	txt: "text/plain", log: "text/plain", html: "text/plain", htm: "text/plain", css: "text/css", js: "text/plain", ts: "text/plain",
	xml: "text/plain", yaml: "text/plain", yml: "text/plain", zip: "application/zip",
	tsv: "text/tab-separated-values", mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4", aac: "audio/aac",
	flac: "audio/flac", opus: "audio/ogg", mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime",
};
export const mimeOf = (file: string) => MIME[extname(file).slice(1).toLowerCase()] ?? "application/octet-stream";

/** A name that is safe as one path segment: no separators and no spaces (so a `@path` mention stays one token). */
export function safeName(raw: string): string {
	const base = basename(raw.replace(/\\/g, "/")).replace(/[^\p{L}\p{N}._-]/gu, "_").replace(/^\.+/, "_");
	return (base || "file").slice(-120);
}

export interface SavedFile { path: string; name: string; size: number; mimeType: string }

/** Write the files a user attached into the session's working directory and say where they went. */
export async function saveUploads(cwd: string, files: { name: string; data: string }[]): Promise<SavedFile[]> {
	const decoded = files.map((f) => ({ name: safeName(f.name), bytes: Buffer.from(f.data, "base64") }));
	let total = 0;
	for (const f of decoded) {
		if (f.bytes.length > MAX_FILE_BYTES) throw new HttpError(413, "too_large", `${f.name} is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB`);
		total += f.bytes.length;
	}
	if (total > MAX_FILES_TOTAL) throw new HttpError(413, "too_large", `files in one message may total ${MAX_FILES_TOTAL / 1024 / 1024} MB`);
	const out: SavedFile[] = [];
	for (const f of decoded) {
		const path = `${UPLOAD_DIR}/${randomUUID().slice(0, 6)}-${f.name}`;
		let abs: string;
		try { abs = safePath(cwd, path); } catch (e) { throw badRequest((e as Error).message); }
		await mkdir(dirname(abs), { recursive: true });
		await writeFile(abs, f.bytes);
		out.push({ path, name: f.name, size: f.bytes.length, mimeType: mimeOf(path) });
	}
	return out;
}

export const FILES_OPEN = "<pipaya-files>";
/** The text block that tells the model where attachments went. The client reads the JSON back to draw file cards. */
export function filesNote(saved: SavedFile[]): string {
	const list = saved.map((f) => `- ${f.path} (${f.mimeType}, ${f.size} bytes)`).join("\n");
	return `${FILES_OPEN}${JSON.stringify(saved)}</pipaya-files>\nThe user attached these files (saved in the working directory):\n${list}`;
}

export const FileQuery = Type.Object({
	path: Type.String({ minLength: 1, description: "Relative to the session's working directory, or absolute" }),
	max: Type.Optional(Type.Integer({ minimum: 64, maximum: 4096, description: "Optional max dimension in pixels for raster image previews" })),
});

type CachedPreview = { bytes: Buffer; mimeType: string };

class PreviewCache {
	private readonly entries = new Map<string, CachedPreview>();
	private readonly inflight = new Map<string, Promise<CachedPreview>>();
	private totalBytes = 0;

	private touch(key: string, val: CachedPreview): CachedPreview {
		this.entries.delete(key);
		this.entries.set(key, val);
		return val;
	}

	private put(key: string, val: CachedPreview): void {
		const existing = this.entries.get(key);
		if (existing) {
			this.totalBytes -= existing.bytes.byteLength;
			this.entries.delete(key);
		}
		if (val.bytes.byteLength > PREVIEW_CACHE_MAX_BYTES) return;
		this.entries.set(key, val);
		this.totalBytes += val.bytes.byteLength;
		while (this.entries.size > PREVIEW_CACHE_MAX_ENTRIES || this.totalBytes > PREVIEW_CACHE_MAX_BYTES) {
			const oldest = this.entries.keys().next().value;
			if (oldest === undefined) break;
			const dropped = this.entries.get(oldest)!;
			this.entries.delete(oldest);
			this.totalBytes -= dropped.bytes.byteLength;
		}
	}

	async getOrBuild(key: string, abs: string, origMime: string, maxDim: number): Promise<CachedPreview> {
		const hit = this.entries.get(key);
		if (hit) return this.touch(key, hit);
		const pending = this.inflight.get(key);
		if (pending) return pending;
		const work = (async (): Promise<CachedPreview> => {
			const raw = await readFile(abs);
			const resized = await previewImage(raw, maxDim);
			if (resized) {
				const val: CachedPreview = { bytes: Buffer.from(resized.bytes), mimeType: resized.mimeType };
				this.put(key, val);
				return val;
			}
			const val: CachedPreview = { bytes: raw, mimeType: origMime };
			// Large raw fallbacks stay uncached in memory so a single unshrinkable file does not evict smaller previews.
			if (raw.byteLength <= PREVIEW_CACHE_MAX_RAW_FALLBACK_BYTES) this.put(key, val);
			return val;
		})().finally(() => {
			this.inflight.delete(key);
		});
		this.inflight.set(key, work);
		return work;
	}
}

const previewCache = new PreviewCache();

function etagMatches(header: string | string[] | undefined, etag: string): boolean {
	if (!header) return false;
	const raw = Array.isArray(header) ? header.join(",") : header;
	return raw.split(",").some((part) => part.trim() === etag || part.trim() === `W/${etag}` || part.trim() === "*");
}

/**
 * Read a file back for previews. Paths resolve against the session's working directory but are not confined to it
 * (see `safePath`): whoever holds a token can read any file the server user can, as the `read` tool already lets them.
 */
/** `dirsOf`: the folders a session's relative paths may be written against, first match wins (where it works now, then where it was made). */
export function registerFileRoutes(server: FastifyInstance, dirsOf: (sessionId: string) => string[] | undefined): void {
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/sessions/:id/files", {
		schema: { params: Type.Object({ id: Type.String() }), querystring: FileQuery, response: { ...errors(400, 401, 404, 413) } },
		handler: async (req, reply) => {
			const dirs = dirsOf(req.params.id);
			if (!dirs?.length) throw notFound("session");
			let abs = "";
			let info;
			for (const dir of dirs) {
				try { abs = safePath(dir, req.query.path); } catch (e) { throw badRequest((e as Error).message); }
				try { info = await stat(abs); } catch { continue; }
				if (info.isFile()) break;
				info = undefined;
			}
			if (!info) throw notFound("file");
			if (info.size > MAX_FILE_BYTES) throw new HttpError(413, "too_large", "file is too large to preview");

			const origMime = mimeOf(abs);
			const maxDim = req.query.max;
			const usePreview = maxDim !== undefined && PREVIEW_MIME.has(origMime) && info.size > PREVIEW_MIN_BYTES;
			const etag = `"${Math.trunc(info.mtimeMs)}-${info.size}${usePreview ? `-m${maxDim}` : ""}"`;

			if (etagMatches(req.headers["if-none-match"], etag)) {
				return reply
					.code(304)
					.header("etag", etag)
					.header("cache-control", FILE_CACHE_CONTROL)
					.send();
			}

			if (usePreview) {
				const body = await previewCache.getOrBuild(`${abs}\0${Math.trunc(info.mtimeMs)}\0${info.size}\0${maxDim}`, abs, origMime, maxDim);
				return reply
					.header("content-type", body.mimeType)
					.header("etag", etag)
					.header("cache-control", FILE_CACHE_CONTROL)
					.header("x-content-type-options", "nosniff")
					.header("content-security-policy", "sandbox; default-src 'none'")
					.send(body.bytes);
			}

			const rangeHeader = typeof req.headers.range === "string" ? req.headers.range : undefined;
			const range = parseByteRange(rangeHeader, info.size);
			if (range === "unsatisfiable") {
				return reply
					.code(416)
					.header("content-range", `bytes */${info.size}`)
					.header("accept-ranges", "bytes")
					.send();
			}
			if (range) {
				const length = range.end - range.start + 1;
				return reply
					.code(206)
					.header("content-type", origMime)
					.header("content-range", `bytes ${range.start}-${range.end}/${info.size}`)
					.header("content-length", String(length))
					.header("accept-ranges", "bytes")
					.header("etag", etag)
					.header("cache-control", FILE_CACHE_CONTROL)
					.header("x-content-type-options", "nosniff")
					.header("content-security-policy", "sandbox; default-src 'none'")
					.send(createReadStream(abs, { start: range.start, end: range.end }));
			}

			return reply
				.header("content-type", origMime)
				.header("content-length", String(info.size))
				.header("accept-ranges", "bytes")
				.header("etag", etag)
				.header("cache-control", FILE_CACHE_CONTROL)
				// bytes made by the user or the agent: never let a browser run them as a page
				.header("x-content-type-options", "nosniff")
				.header("content-security-policy", "sandbox; default-src 'none'")
				.send(info.size > STREAM_MIN_BYTES ? createReadStream(abs) : await readFile(abs));
		},
	});
}

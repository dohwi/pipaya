import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname } from "node:path";
import Type from "typebox";
import { badRequest, HttpError, notFound } from "./errors.ts";
import { errors } from "./schemas.ts";
import { safePath } from "./tools.ts";
import type { TypeBoxProvider } from "./typebox-provider.ts";

/** Where files the user attaches land, relative to the session's working directory. */
export const UPLOAD_DIR = ".pipaya/uploads";
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
export const MAX_FILES = 8;
/** One message may carry this many bytes of files in total. */
export const MAX_FILES_TOTAL = 100 * 1024 * 1024;

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

export const FileQuery = Type.Object({ path: Type.String({ minLength: 1, description: "Relative to the session's working directory" }) });

/** Read a file of a session's working directory back, for previews. Never leaves it (symlinks included). */
export function registerFileRoutes(server: FastifyInstance, cwdOf: (sessionId: string) => string | undefined): void {
	const app = server.withTypeProvider<TypeBoxProvider>();

	app.get("/sessions/:id/files", {
		schema: { params: Type.Object({ id: Type.String() }), querystring: FileQuery, response: { ...errors(400, 401, 404, 413) } },
		handler: async (req, reply) => {
			const cwd = cwdOf(req.params.id);
			if (!cwd) throw notFound("session");
			let abs: string;
			try { abs = safePath(cwd, req.query.path); } catch (e) { throw badRequest((e as Error).message); }
			let info;
			try { info = await stat(abs); } catch { throw notFound("file"); }
			if (!info.isFile()) throw notFound("file");
			if (info.size > MAX_FILE_BYTES) throw new HttpError(413, "too_large", "file is too large to preview");
			return reply
				.header("content-type", mimeOf(abs))
				// bytes made by the user or the agent: never let a browser run them as a page
				.header("x-content-type-options", "nosniff")
				.header("content-security-policy", "sandbox; default-src 'none'")
				.send(await readFile(abs));
		},
	});
}

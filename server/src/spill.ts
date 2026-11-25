import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { formatBytes } from "./image-file.ts";

/** Maximum spill files retained per directory; older files are evicted best-effort when exceeded. */
export const MAX_SPILL_FILES_PER_DIR = 50;

/**
 * Truncate a UTF-8 string to at most `maxBytes` from the start without splitting a multi-byte character
 * (so Korean/CJK/emoji never produce `\uFFFD`).
 */
export function truncateHeadBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: s.length > 0 };
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return { text: s, truncated: false };
	let end = maxBytes;
	// If buf[end] is a UTF-8 continuation byte (10xxxxxx), back up to the lead byte of that sequence.
	while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
	return { text: buf.subarray(0, end).toString("utf8"), truncated: true };
}

/**
 * Truncate a UTF-8 string to at most `maxBytes` from the end without splitting a multi-byte character
 * (so Korean/CJK/emoji never produce `\uFFFD`).
 */
export function truncateTailBytes(s: string, maxBytes: number): { text: string; truncated: boolean } {
	if (maxBytes <= 0) return { text: "", truncated: s.length > 0 };
	const buf = Buffer.from(s, "utf8");
	if (buf.length <= maxBytes) return { text: s, truncated: false };
	let start = buf.length - maxBytes;
	// Advance past any leading UTF-8 continuation bytes (10xxxxxx).
	while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
	return { text: buf.subarray(start).toString("utf8"), truncated: true };
}

export interface SpillResult {
	path: string;
	bytes: number;
	lines: number;
}

/** Atomically write large tool output to `<dir>/<prefix>-<id>.txt` and return its metadata. */
export async function spillText(dir: string, prefix: string, content: string): Promise<SpillResult> {
	const safePrefix = prefix.replace(/[^a-zA-Z0-9_-]/g, "") || "output";
	await mkdir(dir, { recursive: true });
	const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
	const finalPath = join(dir, `${safePrefix}-${id}.txt`);
	const tmpPath = join(dirname(finalPath), `.${basename(finalPath)}.tmp-${randomUUID().slice(0, 6)}`);
	try {
		await writeFile(tmpPath, content, "utf8");
		try {
			await rename(tmpPath, finalPath);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EXDEV" || code === "EPERM" || code === "EACCES") {
				await unlink(tmpPath).catch(() => {});
				await writeFile(finalPath, content, "utf8");
			} else {
				throw e;
			}
		}
	} catch (e) {
		await unlink(tmpPath).catch(() => {});
		throw e;
	}
	const bytes = Buffer.byteLength(content, "utf8");
	const lines = content.length === 0 ? 0 : content.split("\n").length;
	await pruneSpillDir(dir, finalPath).catch(() => {});
	return { path: finalPath, bytes, lines };
}

async function pruneSpillDir(dir: string, keepPath: string): Promise<void> {
	const entries = (await readdir(dir)).filter((name) => name.endsWith(".txt") && !name.startsWith("."));
	if (entries.length <= MAX_SPILL_FILES_PER_DIR) return;
	const withMtime = await Promise.all(
		entries.map(async (name) => {
			const full = join(dir, name);
			try {
				const st = await stat(full);
				return { full, mtimeMs: st.mtimeMs };
			} catch {
				return { full, mtimeMs: 0 };
			}
		}),
	);
	withMtime.sort((a, b) => a.mtimeMs - b.mtimeMs);
	const toDelete = withMtime.length - MAX_SPILL_FILES_PER_DIR;
	let removed = 0;
	for (const entry of withMtime) {
		if (removed >= toDelete) break;
		if (entry.full === keepPath) continue;
		await unlink(entry.full).catch(() => {});
		removed++;
	}
}

export interface FormatSpilledOptions {
	path: string;
	headBytes?: number;
	tailBytes?: number;
	totalBytes?: number;
	totalLines?: number;
}

const DEFAULT_PREVIEW_HEAD_BYTES = 16 * 1024;
const DEFAULT_PREVIEW_TAIL_BYTES = 16 * 1024;

/** Format spilled output as a UTF-8-safe head + tail preview with total size and path hint. */
export function formatSpilledOutput(content: string, opts: FormatSpilledOptions): string {
	const totalBytes = opts.totalBytes ?? Buffer.byteLength(content, "utf8");
	const totalLines = opts.totalLines ?? (content.length === 0 ? 0 : content.split("\n").length);
	const headBytes = opts.headBytes ?? DEFAULT_PREVIEW_HEAD_BYTES;
	const tailBytes = opts.tailBytes ?? DEFAULT_PREVIEW_TAIL_BYTES;

	if (headBytes + tailBytes >= totalBytes) {
		return content;
	}

	const notice = `[output truncated: ${totalLines} lines, ${formatBytes(totalBytes)} (${totalBytes} bytes); full output saved to ${opts.path} — use read/grep to inspect]`;

	if (headBytes <= 0 && tailBytes <= 0) {
		return notice;
	}
	if (tailBytes <= 0) {
		let head = truncateHeadBytes(content, headBytes).text;
		const lastNl = head.lastIndexOf("\n");
		if (lastNl > head.length / 2) head = head.slice(0, lastNl);
		return `${head}\n${notice}`;
	}
	if (headBytes <= 0) {
		let tail = truncateTailBytes(content, tailBytes).text;
		const firstNl = tail.indexOf("\n");
		if (firstNl !== -1 && firstNl < tail.length / 2) tail = tail.slice(firstNl + 1);
		return `${notice}\n${tail}`;
	}

	let head = truncateHeadBytes(content, headBytes).text;
	const lastNl = head.lastIndexOf("\n");
	if (lastNl > head.length / 2) head = head.slice(0, lastNl);

	let tail = truncateTailBytes(content, tailBytes).text;
	const firstNl = tail.indexOf("\n");
	if (firstNl !== -1 && firstNl < tail.length / 2) tail = tail.slice(firstNl + 1);

	return `${head}\n\n... ${notice} ...\n\n${tail}`;
}

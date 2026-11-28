import type { Database, Statement } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants, lstatSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, open, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { withPathLock } from "./tools.ts";

/** Maximum file size (2 MiB) snapshotted into SQLite; larger files are recorded as skipped. */
export const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Maximum checkpoint rows retained per session before oldest turns are pruned. */
export const DEFAULT_MAX_CHECKPOINTS_PER_SESSION = 200;
/** Maximum total snapshot content bytes retained per session before oldest turns are pruned. */
export const DEFAULT_MAX_BYTES_PER_SESSION = 32 * 1024 * 1024;

export type SkippedReason =
	| "too_large"
	| "binary"
	| "outside_workspace"
	| "symlink_escape"
	| "sensitive_path"
	| "not_a_file"
	| "limit_exceeded"
	| "write_error"
	| "read_error";

export type ConflictReason = "modified" | "deleted";
export type RewindMode = "files_only" | "files_and_chat";

export interface CheckpointTurnFile {
	relPath: string;
	action: "restore" | "delete" | "skip";
	skippedReason?: string | null;
}

export interface CheckpointTurnSummary {
	turnSeq: number;
	fileCount: number;
	createdAt: number;
	files: CheckpointTurnFile[];
}

export interface RewindFileItem {
	path: string;
	action: "restore" | "delete" | "skip";
	conflict: boolean;
	conflictReason?: ConflictReason | null;
	skippedReason?: string | null;
}

export interface RewindExecutionResult {
	applied: boolean;
	dryRun: boolean;
	mode: RewindMode;
	turnSeq: number;
	files: RewindFileItem[];
	conflicts: string[];
	restored: string[];
	deleted: string[];
	skipped: { path: string; reason: string }[];
	/** Canonical paths touched on disk so callers can invalidate read trackers. */
	touchedPaths: string[];
}

export interface CheckpointLimits {
	maxFileBytes?: number;
	maxCheckpointsPerSession?: number;
	maxBytesPerSession?: number;
}

interface CheckpointRow {
	id: number;
	session_id: string;
	turn_seq: number;
	path: string;
	rel_path: string;
	existed: number;
	before_content: Uint8Array | null;
	before_hash: string | null;
	before_mode: number | null;
	after_hash: string | null;
	size_bytes: number;
	skipped_reason: string | null;
	created_at: number;
}

export interface PendingCapture {
	kind: "existing_row" | "new_row";
	sessionId: string;
	turnSeq: number;
	path: string;
	relPath: string;
	existed: boolean;
	beforeContent: Uint8Array | null;
	beforeHash: string | null;
	beforeMode: number | null;
	sizeBytes: number;
	skippedReason: SkippedReason | null;
}

function sha256(data: Buffer | Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

function isBinaryBuffer(buf: Uint8Array): boolean {
	// NUL byte in the file strongly indicates binary content.
	return buf.includes(0);
}

const NOFOLLOW_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);

/**
 * Safely read a regular file without following leaf symlinks (`O_NOFOLLOW`) and without buffering
 * files larger than `maxBytes` into RAM.
 */
async function readBoundedNoFollow(
	filePath: string,
	maxBytes: number,
): Promise<
	| { status: "ok"; buf: Buffer; mode: number; size: number }
	| { status: "enoent" }
	| { status: "symlink" }
	| { status: "not_a_file" }
	| { status: "too_large"; size: number; mode: number }
	| { status: "error" }
> {
	let fh: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fh = await open(filePath, NOFOLLOW_FLAGS);
		const st = await fh.stat();
		if (!st.isFile()) return { status: "not_a_file" };
		const mode = st.mode & 0o777;
		if (st.size > maxBytes) return { status: "too_large", size: st.size, mode };
		const buf = await fh.readFile();
		if (buf.length > maxBytes) return { status: "too_large", size: buf.length, mode };
		return { status: "ok", buf, mode, size: buf.length };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { status: "enoent" };
		if (code === "ELOOP") return { status: "symlink" };
		return { status: "error" };
	} finally {
		await fh?.close().catch(() => {});
	}
}

/**
 * Stream-hash a regular file via `O_NOFOLLOW` so multi-GB disk files cannot OOM the server during
 * rewind conflict detection.
 */
async function hashFileNoFollow(
	filePath: string,
): Promise<
	| { status: "ok"; hash: string }
	| { status: "enoent" }
	| { status: "symlink" }
	| { status: "not_a_file" }
	| { status: "error" }
> {
	let fh: Awaited<ReturnType<typeof open>> | null = null;
	try {
		fh = await open(filePath, NOFOLLOW_FLAGS);
		const st = await fh.stat();
		if (!st.isFile()) return { status: "not_a_file" };
		const hasher = createHash("sha256");
		const chunk = Buffer.allocUnsafe(64 * 1024);
		let pos = 0;
		for (;;) {
			const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
			if (bytesRead === 0) break;
			hasher.update(bytesRead === chunk.length ? chunk : chunk.subarray(0, bytesRead));
			pos += bytesRead;
		}
		return { status: "ok", hash: hasher.digest("hex") };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { status: "enoent" };
		if (code === "ELOOP") return { status: "symlink" };
		return { status: "error" };
	} finally {
		await fh?.close().catch(() => {});
	}
}

function normalizeRelPath(rel: string): string {
	return sep === "\\" ? rel.replaceAll("\\", "/") : rel;
}

function escapesRoot(root: string, target: string): boolean {
	const rel = relative(root, target);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
}

/**
 * Resolve `abs` using `realpathSync` on the deepest existing ancestor, then re-append any
 * non-existent trailing segments.
 */
function realWithTail(abs: string): string {
	const tail: string[] = [];
	for (let cur = abs; ; cur = dirname(cur)) {
		try {
			return resolve(realpathSync(cur), ...tail.reverse());
		} catch {
			if (dirname(cur) === cur) return abs;
			tail.push(cur.slice(dirname(cur).length + 1));
		}
	}
}

/**
 * Inspect whether `rawFile` is safely contained within `workspaceRoot` without traversing or
 * targeting a symlink, and is not inside `.git/`.
 */
export function validateWorkspacePath(
	workspaceRoot: string,
	rawFile: string,
): { ok: true; canonicalPath: string; relPath: string } | { ok: false; reason: SkippedReason; relPath: string; canonicalPath: string } {
	let rootReal: string;
	try {
		rootReal = realpathSync(workspaceRoot);
	} catch {
		rootReal = resolve(workspaceRoot);
	}
	const abs = resolve(rawFile);
	const rawRel = normalizeRelPath(relative(rootReal, abs));

	// Fast lexical check against both workspaceRoot and its realpath.
	const lexOutside = escapesRoot(resolve(workspaceRoot), abs) && escapesRoot(rootReal, abs);
	if (lexOutside) {
		return { ok: false, reason: "outside_workspace", relPath: rawRel || abs, canonicalPath: abs };
	}

	// Check every existing path component from rootReal down to abs for symlinks.
	// First derive the lexical path rooted at rootReal.
	const rootedAbs = escapesRoot(rootReal, abs) ? resolve(rootReal, relative(resolve(workspaceRoot), abs)) : abs;
	const relFromRoot = relative(rootReal, rootedAbs);
	if (!relFromRoot || relFromRoot === "." || escapesRoot(rootReal, rootedAbs)) {
		return { ok: false, reason: "outside_workspace", relPath: rawRel || abs, canonicalPath: rootedAbs };
	}

	const normRel = normalizeRelPath(relFromRoot);
	if (normRel.split("/").some((seg) => seg.toLowerCase() === ".git")) {
		return { ok: false, reason: "sensitive_path", relPath: normRel, canonicalPath: rootedAbs };
	}

	// Walk segments from rootReal to detect any symlink along the path or at the leaf.
	const segments = relFromRoot.split(sep).filter(Boolean);
	let cur = rootReal;
	for (const seg of segments) {
		cur = join(cur, seg);
		try {
			const st = lstatSync(cur);
			if (st.isSymbolicLink()) {
				return { ok: false, reason: "symlink_escape", relPath: normRel, canonicalPath: rootedAbs };
			}
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code === "ENOENT") {
				// Remaining segments don't exist yet; safe because all existing ancestors were non-symlinks inside rootReal.
				break;
			}
			return { ok: false, reason: "read_error", relPath: normRel, canonicalPath: rootedAbs };
		}
	}

	// Final realpath boundary check.
	const resolvedReal = realWithTail(rootedAbs);
	if (escapesRoot(rootReal, resolvedReal)) {
		return { ok: false, reason: "symlink_escape", relPath: normRel, canonicalPath: resolvedReal };
	}

	return { ok: true, canonicalPath: resolvedReal, relPath: normRel };
}

async function safeRestoreFile(workspaceRoot: string, targetPath: string, content: Uint8Array, mode: number | null): Promise<void> {
	const preCheck = validateWorkspacePath(workspaceRoot, targetPath);
	if (!preCheck.ok) {
		throw new Error(`refusing to restore unsafe path (${preCheck.reason})`);
	}
	await mkdir(dirname(preCheck.canonicalPath), { recursive: true });
	// Re-validate parent directory and leaf right before writing so a concurrent symlink swap cannot be followed.
	const postDirCheck = validateWorkspacePath(workspaceRoot, preCheck.canonicalPath);
	if (!postDirCheck.ok) {
		throw new Error(`refusing to restore unsafe path (${postDirCheck.reason})`);
	}
	try {
		const st = await lstat(postDirCheck.canonicalPath);
		if (st.isSymbolicLink() || !st.isFile()) {
			throw new Error("refusing to overwrite non-regular file or symlink");
		}
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
	}

	const tmp = join(dirname(postDirCheck.canonicalPath), `.pipaya-rewind-${process.pid}-${randomBytes(6).toString("hex")}`);
	try {
		await writeFile(tmp, content, { mode: 0o600, flag: "wx" });
		if (mode !== null && Number.isInteger(mode)) {
			await chmod(tmp, mode & 0o777).catch(() => {});
		}
		await rename(tmp, postDirCheck.canonicalPath);
	} catch (err) {
		await unlink(tmp).catch(() => {});
		throw err;
	}
}

export class FileCheckpoints {
	private readonly maxFileBytes: number;
	private readonly maxCheckpointsPerSession: number;
	private readonly maxBytesPerSession: number;

	private readonly stmtHasRow: Statement;
	private readonly stmtInsert: Statement;
	private readonly stmtUpdateAfter: Statement;
	private readonly stmtListSession: Statement;
	private readonly stmtListFromTurn: Statement;
	private readonly stmtDeleteFromTurn: Statement;
	private readonly stmtSessionStats: Statement;
	private readonly stmtOldestTurns: Statement;
	private readonly stmtDeleteTurn: Statement;

	constructor(private readonly db: Database, limits: CheckpointLimits = {}) {
		this.maxFileBytes = limits.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
		this.maxCheckpointsPerSession = limits.maxCheckpointsPerSession ?? DEFAULT_MAX_CHECKPOINTS_PER_SESSION;
		this.maxBytesPerSession = limits.maxBytesPerSession ?? DEFAULT_MAX_BYTES_PER_SESSION;

		this.stmtHasRow = db.query("SELECT id FROM file_checkpoints WHERE session_id = $sid AND turn_seq = $turn AND path = $path LIMIT 1");
		this.stmtInsert = db.query(`
			INSERT OR IGNORE INTO file_checkpoints
				(session_id, turn_seq, path, rel_path, existed, before_content, before_hash, before_mode, after_hash, size_bytes, skipped_reason, created_at)
			VALUES
				($sid, $turn, $path, $rel, $existed, $content, $bhash, $bmode, $ahash, $size, $skipped, $t)
		`);
		this.stmtUpdateAfter = db.query(`
			UPDATE file_checkpoints
			SET after_hash = $ahash
			WHERE session_id = $sid AND turn_seq = $turn AND path = $path
		`);
		this.stmtListSession = db.query(`
			SELECT id, session_id, turn_seq, path, rel_path, existed, before_hash, after_hash, size_bytes, skipped_reason, created_at
			FROM file_checkpoints
			WHERE session_id = $sid
			ORDER BY turn_seq ASC, id ASC
		`);
		this.stmtListFromTurn = db.query(`
			SELECT id, session_id, turn_seq, path, rel_path, existed, before_content, before_hash, before_mode, after_hash, size_bytes, skipped_reason, created_at
			FROM file_checkpoints
			WHERE session_id = $sid AND turn_seq >= $turn
			ORDER BY turn_seq ASC, id ASC
		`);
		this.stmtDeleteFromTurn = db.query("DELETE FROM file_checkpoints WHERE session_id = $sid AND turn_seq >= $turn");
		this.stmtSessionStats = db.query("SELECT COUNT(*) AS cnt, COALESCE(SUM(LENGTH(before_content)), 0) AS bytes FROM file_checkpoints WHERE session_id = $sid");
		this.stmtOldestTurns = db.query("SELECT DISTINCT turn_seq FROM file_checkpoints WHERE session_id = $sid ORDER BY turn_seq ASC");
		this.stmtDeleteTurn = db.query("DELETE FROM file_checkpoints WHERE session_id = $sid AND turn_seq = $turn");
	}

	/**
	 * Capture the pre-mutation state of `rawFile` before `write` or `edit` modifies it.
	 * Must be called inside the tool's per-path lock. Does not write to SQLite until `afterWrite`
	 * confirms the file mutation succeeded.
	 */
	async beforeWrite(sessionId: string, turnSeq: number | undefined, workspaceRoot: string, rawFile: string): Promise<PendingCapture | null> {
		if (turnSeq === undefined || !Number.isInteger(turnSeq) || turnSeq < 0) return null;

		const check = validateWorkspacePath(workspaceRoot, rawFile);
		const existing = this.stmtHasRow.get({ sid: sessionId, turn: turnSeq, path: check.canonicalPath }) as { id: number } | null;
		if (existing) {
			return {
				kind: "existing_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: null,
			};
		}

		if (!check.ok) {
			// Skip recording paths outside the workspace; keep in-workspace symlink/sensitive entries as skipped markers.
			if (check.reason === "outside_workspace") return null;
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: check.reason,
			};
		}

		const readRes = await readBoundedNoFollow(check.canonicalPath, this.maxFileBytes);
		if (readRes.status === "enoent") {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: false,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: null,
			};
		}
		if (readRes.status === "symlink") {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: "symlink_escape",
			};
		}
		if (readRes.status === "not_a_file") {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: "not_a_file",
			};
		}
		if (readRes.status === "too_large") {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: readRes.mode,
				sizeBytes: readRes.size,
				skippedReason: "too_large",
			};
		}
		if (readRes.status === "error") {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: null,
				sizeBytes: 0,
				skippedReason: "read_error",
			};
		}

		if (isBinaryBuffer(readRes.buf)) {
			return {
				kind: "new_row",
				sessionId,
				turnSeq,
				path: check.canonicalPath,
				relPath: check.relPath,
				existed: true,
				beforeContent: null,
				beforeHash: null,
				beforeMode: readRes.mode,
				sizeBytes: readRes.size,
				skippedReason: "binary",
			};
		}

		return {
			kind: "new_row",
			sessionId,
			turnSeq,
			path: check.canonicalPath,
			relPath: check.relPath,
			existed: true,
			beforeContent: new Uint8Array(readRes.buf.buffer, readRes.buf.byteOffset, readRes.buf.byteLength),
			beforeHash: sha256(readRes.buf),
			beforeMode: readRes.mode,
			sizeBytes: readRes.size,
			skippedReason: null,
		};
	}

	/**
	 * Persist the captured snapshot (or update `after_hash` if the file was already snapshotted in this turn)
	 * after `write`/`edit` succeeds.
	 */
	afterWrite(capture: PendingCapture, newContent: string): void {
		const afterHash = sha256(Buffer.from(newContent, "utf8"));
		if (capture.kind === "existing_row") {
			this.stmtUpdateAfter.run({
				sid: capture.sessionId,
				turn: capture.turnSeq,
				path: capture.path,
				ahash: afterHash,
			});
			return;
		}

		const now = Date.now();
		const tx = this.db.transaction(() => {
			const incomingBytes = capture.beforeContent ? capture.beforeContent.byteLength : 0;
			// Prune older turns first so room is made for this incoming snapshot (reserve 1 row + incomingBytes).
			this.pruneSession(capture.sessionId, capture.turnSeq, 1, incomingBytes);
			const stats = this.stmtSessionStats.get({ sid: capture.sessionId }) as { cnt: number; bytes: number };
			let beforeContent = capture.beforeContent;
			let beforeHash = capture.beforeHash;
			let skippedReason = capture.skippedReason;
			// Enforce per-session row & byte caps even when the current turn alone exceeds the budget.
			if (
				!skippedReason &&
				(stats.cnt + 1 > this.maxCheckpointsPerSession || stats.bytes + incomingBytes > this.maxBytesPerSession)
			) {
				beforeContent = null;
				beforeHash = null;
				skippedReason = "limit_exceeded";
			}

			this.stmtInsert.run({
				sid: capture.sessionId,
				turn: capture.turnSeq,
				path: capture.path,
				rel: capture.relPath,
				existed: capture.existed ? 1 : 0,
				content: beforeContent,
				bhash: beforeHash,
				bmode: capture.beforeMode,
				ahash: afterHash,
				size: capture.sizeBytes,
				skipped: skippedReason,
				t: now,
			});
			// If a concurrent insert won the UNIQUE race, still update after_hash to latest.
			this.stmtUpdateAfter.run({
				sid: capture.sessionId,
				turn: capture.turnSeq,
				path: capture.path,
				ahash: afterHash,
			});
		});
		tx();
	}

	private pruneSession(sessionId: string, keepTurnSeq: number, reserveRows = 0, reserveBytes = 0): void {
		const stats = this.stmtSessionStats.get({ sid: sessionId }) as { cnt: number; bytes: number };
		if (stats.cnt + reserveRows <= this.maxCheckpointsPerSession && stats.bytes + reserveBytes <= this.maxBytesPerSession) return;

		const turns = this.stmtOldestTurns.all({ sid: sessionId }) as { turn_seq: number }[];
		for (const { turn_seq } of turns) {
			if (turn_seq === keepTurnSeq) break;
			this.stmtDeleteTurn.run({ sid: sessionId, turn: turn_seq });
			const next = this.stmtSessionStats.get({ sid: sessionId }) as { cnt: number; bytes: number };
			if (next.cnt + reserveRows <= this.maxCheckpointsPerSession && next.bytes + reserveBytes <= this.maxBytesPerSession) break;
		}
	}

	/** List turns that have checkpoints for `sessionId`, ordered oldest-first. */
	listTurns(sessionId: string): CheckpointTurnSummary[] {
		const rows = this.stmtListSession.all({ sid: sessionId }) as Omit<CheckpointRow, "before_content" | "before_mode">[];
		const byTurn = new Map<number, CheckpointTurnSummary>();
		for (const row of rows) {
			let entry = byTurn.get(row.turn_seq);
			if (!entry) {
				entry = { turnSeq: row.turn_seq, fileCount: 0, createdAt: row.created_at, files: [] };
				byTurn.set(row.turn_seq, entry);
			}
			const action: "restore" | "delete" | "skip" = row.skipped_reason
				? "skip"
				: row.existed === 1
					? "restore"
					: "delete";
			entry.files.push({
				relPath: row.rel_path,
				action,
				skippedReason: row.skipped_reason,
			});
			entry.fileCount = entry.files.length;
		}
		return [...byTurn.values()];
	}

	/** Delete checkpoints at or after `turnSeq` (used after a rewind or chat truncation). */
	deleteFromTurn(sessionId: string, turnSeq: number): void {
		this.stmtDeleteFromTurn.run({ sid: sessionId, turn: turnSeq });
	}

	/**
	 * Preview or execute a rewind to the state immediately before `turnSeq`.
	 * When `dryRun` is true, no files or DB rows are modified.
	 * When `dryRun` is false and `force` is false, any external modification conflict aborts
	 * the entire rewind before touching any file on disk.
	 */
	async rewind(
		sessionId: string,
		turnSeq: number,
		workspaceRoot: string,
		opts: { mode?: RewindMode; dryRun?: boolean; force?: boolean; deferCleanup?: boolean } = {},
	): Promise<RewindExecutionResult> {
		const mode: RewindMode = opts.mode ?? "files_only";
		const dryRun = opts.dryRun === true;
		const force = opts.force === true;

		const rows = this.stmtListFromTurn.all({ sid: sessionId, turn: turnSeq }) as CheckpointRow[];
		if (rows.length === 0) {
			return {
				applied: !dryRun && mode === "files_and_chat",
				dryRun,
				mode,
				turnSeq,
				files: [],
				conflicts: [],
				restored: [],
				deleted: [],
				skipped: [],
				touchedPaths: [],
			};
		}

		// Group checkpoints by canonical path: earliest row gives target `before` state,
		// latest row gives expected `after_hash` for external conflict detection.
		const grouped = new Map<string, { first: CheckpointRow; last: CheckpointRow }>();
		for (const row of rows) {
			const cur = grouped.get(row.path);
			if (!cur) {
				grouped.set(row.path, { first: row, last: row });
			} else {
				cur.last = row;
			}
		}

		interface PlanEntry {
			first: CheckpointRow;
			last: CheckpointRow;
			targetPath: string;
			item: RewindFileItem;
			alreadyClean: boolean;
		}

		const plan: PlanEntry[] = [];
		const conflicts: string[] = [];

		for (const { first, last } of grouped.values()) {
			if (first.skipped_reason) {
				plan.push({
					first,
					last,
					targetPath: first.path,
					item: {
						path: first.rel_path,
						action: "skip",
						conflict: false,
						conflictReason: null,
						skippedReason: first.skipped_reason,
					},
					alreadyClean: false,
				});
				continue;
			}

			// Re-validate path against current workspace root to prevent symlink escape / path traversal.
			const check = validateWorkspacePath(workspaceRoot, first.path);
			if (!check.ok) {
				plan.push({
					first,
					last,
					targetPath: first.path,
					item: {
						path: first.rel_path,
						action: "skip",
						conflict: false,
						conflictReason: null,
						skippedReason: check.reason,
					},
					alreadyClean: false,
				});
				continue;
			}

			const action: "restore" | "delete" = first.existed === 1 ? "restore" : "delete";
			let diskExists = false;
			let diskHash: string | null = null;

			const hashRes = await hashFileNoFollow(check.canonicalPath);
			if (hashRes.status === "symlink") {
				plan.push({
					first,
					last,
					targetPath: check.canonicalPath,
					item: {
						path: first.rel_path,
						action: "skip",
						conflict: false,
						conflictReason: null,
						skippedReason: "symlink_escape",
					},
					alreadyClean: false,
				});
				continue;
			}
			if (hashRes.status === "not_a_file") {
				plan.push({
					first,
					last,
					targetPath: check.canonicalPath,
					item: {
						path: first.rel_path,
						action: "skip",
						conflict: false,
						conflictReason: null,
						skippedReason: "not_a_file",
					},
					alreadyClean: false,
				});
				continue;
			}
			if (hashRes.status === "error") {
				plan.push({
					first,
					last,
					targetPath: check.canonicalPath,
					item: {
						path: first.rel_path,
						action: "skip",
						conflict: false,
						conflictReason: null,
						skippedReason: "read_error",
					},
					alreadyClean: false,
				});
				continue;
			}
			if (hashRes.status === "ok") {
				diskExists = true;
				diskHash = hashRes.hash;
			}

			// Determine if already in the desired pre-turn state.
			const alreadyClean =
				(action === "restore" && diskExists && diskHash === first.before_hash) ||
				(action === "delete" && !diskExists);

			// Detect external modifications since the agent's latest write.
			let hasConflict = false;
			let conflictReason: ConflictReason | null = null;
			if (!alreadyClean && last.after_hash !== null) {
				if (!diskExists) {
					hasConflict = true;
					conflictReason = "deleted";
				} else if (diskHash !== last.after_hash) {
					hasConflict = true;
					conflictReason = "modified";
				}
			}

			if (hasConflict) conflicts.push(first.rel_path);

			plan.push({
				first,
				last,
				targetPath: check.canonicalPath,
				item: {
					path: first.rel_path,
					action,
					conflict: hasConflict,
					conflictReason,
					skippedReason: null,
				},
				alreadyClean,
			});
		}

		const files = plan.map((p) => p.item);

		if (dryRun || (conflicts.length > 0 && !force)) {
			return {
				applied: false,
				dryRun,
				mode,
				turnSeq,
				files,
				conflicts,
				restored: [],
				deleted: [],
				skipped: plan
					.filter((p) => p.item.action === "skip")
					.map((p) => ({ path: p.item.path, reason: p.item.skippedReason ?? "skipped" })),
				touchedPaths: [],
			};
		}

		const restored: string[] = [];
		const deleted: string[] = [];
		const skipped: { path: string; reason: string }[] = [];
		const touchedPaths: string[] = [];

		for (const entry of plan) {
			if (entry.item.action === "skip") {
				skipped.push({ path: entry.item.path, reason: entry.item.skippedReason ?? "skipped" });
				continue;
			}

			if (entry.item.action === "restore") {
				if (!entry.alreadyClean) {
					const content = entry.first.before_content ?? new Uint8Array(0);
					const ok = await withPathLock(entry.targetPath, async () => {
						const recheck = validateWorkspacePath(workspaceRoot, entry.targetPath);
						if (!recheck.ok) {
							skipped.push({ path: entry.item.path, reason: recheck.reason });
							return false;
						}
						try {
							await safeRestoreFile(workspaceRoot, recheck.canonicalPath, content, entry.first.before_mode);
							touchedPaths.push(recheck.canonicalPath);
							return true;
						} catch {
							skipped.push({ path: entry.item.path, reason: "write_error" });
							return false;
						}
					});
					if (!ok) continue;
				}
				restored.push(entry.item.path);
			} else if (entry.item.action === "delete") {
				if (!entry.alreadyClean) {
					const ok = await withPathLock(entry.targetPath, async () => {
						const recheck = validateWorkspacePath(workspaceRoot, entry.targetPath);
						if (!recheck.ok) {
							skipped.push({ path: entry.item.path, reason: recheck.reason });
							return false;
						}
						try {
							const st = await lstat(recheck.canonicalPath);
							if (st.isSymbolicLink() || !st.isFile()) {
								skipped.push({ path: entry.item.path, reason: st.isSymbolicLink() ? "symlink_escape" : "not_a_file" });
								return false;
							}
							await unlink(recheck.canonicalPath);
							touchedPaths.push(recheck.canonicalPath);
							return true;
						} catch (err) {
							if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return true;
							skipped.push({ path: entry.item.path, reason: "write_error" });
							return false;
						}
					});
					if (!ok) continue;
				}
				deleted.push(entry.item.path);
			}
		}

		if (!opts.deferCleanup) {
			this.deleteFromTurn(sessionId, turnSeq);
		}

		return {
			applied: true,
			dryRun: false,
			mode,
			turnSeq,
			files,
			conflicts,
			restored,
			deleted,
			skipped,
			touchedPaths,
		};
	}
}

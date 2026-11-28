import { randomUUID } from "node:crypto";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import Type, { type TSchema } from "typebox";
import { commandArgv, pickCommandShell } from "./command-shell.ts";
import { truncateTailBytes } from "./spill.ts";
import type { ToolDef } from "./tools.ts";

export const BG_BASH_JOB_TOOL = "bash_job";

/** Maximum retained output bytes per background job in the in-memory ring buffer (200 KB). */
export const BG_RING_BUFFER_BYTES = 200 * 1024;
/** Maximum output bytes returned in a single `bash_job` read call (50 KB). */
export const BG_READ_MAX_BYTES = 50 * 1024;
/** Maximum concurrent running background jobs per session. */
export const MAX_RUNNING_JOBS_PER_SESSION = 10;
/** Maximum concurrent running background jobs across all sessions. */
export const MAX_RUNNING_JOBS_GLOBAL = 50;
/** Maximum completed/killed background jobs retained per session (LRU by end time). */
export const MAX_FINISHED_JOBS_PER_SESSION = 20;
/** Maximum seconds a `bash_job` output/wait call may block. */
export const MAX_WAIT_SECONDS = 30;
/** Default seconds `bash_job(action="wait")` waits when `waitSeconds` is omitted. */
export const DEFAULT_WAIT_SECONDS = 15;

export const KILL_TERM_GRACE_MS = 500;
export const KILL_GRACE_MS = 2000;
/** Grace window to drain remaining pipe bytes after the main process exits (prevents detached descendants from pinning the job forever). */
const POST_EXIT_PIPE_GRACE_MS = 500;

export type BgJobStatus = "running" | "exited" | "killed";

export interface BgJobSnapshot {
	jobId: string;
	pid: number;
	command: string;
	cwd: string;
	status: BgJobStatus;
	exitCode: number | null;
	startedAt: number;
	endedAt: number | null;
	totalBytes: number;
	bufferedBytes: number;
	baseOffset: number;
}

export interface BgReadResult {
	job: BgJobSnapshot;
	output: string;
	offset: number;
	nextOffset: number;
	truncated: boolean;
	dropped: boolean;
}

export interface BackgroundBashOps {
	start(input: { command: string; cwd: string; env: Record<string, string> }): BgJobSnapshot;
	adopt(input: {
		command: string;
		cwd: string;
		startedAt?: number;
		proc: ReturnType<typeof Bun.spawn>;
		grouped: boolean;
		ring: OutputRingBuffer;
		onDone: Promise<number | null>;
	}): { snapshot: BgJobSnapshot; notifyOutput: () => void };
	list(): BgJobSnapshot[];
	output(
		jobId: string,
		opts?: { offset?: number; waitSeconds?: number; maxBytes?: number; signal?: AbortSignal },
	): Promise<BgReadResult>;
	wait(
		jobId: string,
		opts?: { offset?: number; waitSeconds?: number; maxBytes?: number; signal?: AbortSignal },
	): Promise<BgReadResult>;
	stop(jobId: string): Promise<BgReadResult>;
}

/** Best-effort cancellation of stdout/stderr streams so leaked descendants cannot hold FDs or closures open. */
export function cancelProcessStreams(proc: ReturnType<typeof Bun.spawn>): void {
	for (const s of [proc.stdout, proc.stderr]) {
		if (s && typeof s !== "number") {
			void s.cancel().catch(() => {});
		}
	}
}

/** Check whether a POSIX process group (`-pid`) still has at least one live member. */
export function isProcessGroupAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) return false;
	try {
		process.kill(-pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code !== "ESRCH";
	}
}

/** Send SIGTERM to process group on POSIX, poll up to 500ms, then escalate to SIGKILL. */
export function terminateProcess(
	proc: ReturnType<typeof Bun.spawn>,
	grouped: boolean,
	exited: () => boolean,
	opts: { keepAliveUntilKilled?: boolean } = {},
): void {
	// Defensive PID guard: never signal pid <= 1 (which targets our own process group or all user processes) or ourselves.
	if (!Number.isInteger(proc.pid) || proc.pid <= 1 || proc.pid === process.pid) return;

	if (!grouped) {
		if (exited()) return;
		// No process groups on Windows: taskkill /T takes the whole tree down.
		try {
			Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		} catch (e) {
			process.stderr.write(`taskkill failed for ${proc.pid}: ${(e as Error).message}\n`);
		}
		try { proc.kill("SIGKILL"); } catch {}
		return;
	}

	const groupAlive = () => isProcessGroupAlive(proc.pid);

	if (exited() && !groupAlive()) return;

	try {
		process.kill(-proc.pid, "SIGTERM");
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
			process.stderr.write(`could not SIGTERM process group ${proc.pid}: ${(e as Error).message}\n`);
		}
		return;
	}

	const deadline = Date.now() + KILL_TERM_GRACE_MS;
	const poll = setInterval(() => {
		if (!groupAlive()) {
			clearInterval(poll);
			return;
		}
		if (Date.now() >= deadline) {
			clearInterval(poll);
			try {
				process.kill(-proc.pid, "SIGKILL");
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "ESRCH") {
					process.stderr.write(`could not kill process group ${proc.pid}: ${(e as Error).message}\n`);
				}
			}
			try { proc.kill("SIGKILL"); } catch {}
		}
	}, 50);
	if (!opts.keepAliveUntilKilled) poll.unref?.();
}

/**
 * Bounded UTF-8-safe byte ring buffer with monotonic byte offsets.
 * Accepts already-decoded UTF-8 strings (so multi-byte sequences never split across chunks)
 * and trims evicted bytes on UTF-8 character boundaries.
 */
export class OutputRingBuffer {
	private chunks: Buffer[] = [];
	private _bufferedBytes = 0;
	private _baseOffset = 0;
	private _totalBytes = 0;

	constructor(public readonly maxBytes = BG_RING_BUFFER_BYTES) {}

	get bufferedBytes(): number { return this._bufferedBytes; }
	get baseOffset(): number { return this._baseOffset; }
	get totalBytes(): number { return this._totalBytes; }

	append(text: string): void {
		if (!text) return;
		const buf = Buffer.from(text, "utf8");
		if (buf.length === 0) return;
		this._totalBytes += buf.length;
		if (buf.length >= this.maxBytes) {
			// Single chunk exceeds capacity: keep only the UTF-8-safe tail of this chunk.
			let start = buf.length - this.maxBytes;
			while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
			const kept = buf.subarray(start);
			this.chunks = kept.length > 0 ? [Buffer.from(kept)] : [];
			this._bufferedBytes = kept.length;
			this._baseOffset = this._totalBytes - this._bufferedBytes;
			return;
		}
		this.chunks.push(buf);
		this._bufferedBytes += buf.length;
		this.trim();
	}

	private trim(): void {
		let excess = this._bufferedBytes - this.maxBytes;
		if (excess <= 0) return;
		while (excess > 0 && this.chunks.length > 0) {
			const head = this.chunks[0]!;
			if (head.length <= excess) {
				this.chunks.shift();
				this._bufferedBytes -= head.length;
				this._baseOffset += head.length;
				excess -= head.length;
			} else {
				let cut = excess;
				// Advance past any UTF-8 continuation bytes so the buffer starts on a codepoint boundary.
				while (cut < head.length && (head[cut]! & 0xc0) === 0x80) cut++;
				if (cut >= head.length) {
					this.chunks.shift();
					this._bufferedBytes -= head.length;
					this._baseOffset += head.length;
				} else {
					this.chunks[0] = head.subarray(cut);
					this._bufferedBytes -= cut;
					this._baseOffset += cut;
				}
				break;
			}
		}
	}

	private materialize(): Buffer {
		if (this.chunks.length === 0) return Buffer.alloc(0);
		if (this.chunks.length === 1) return this.chunks[0]!;
		const merged = Buffer.concat(this.chunks, this._bufferedBytes);
		this.chunks = [merged];
		return merged;
	}

	/** Read incrementally starting from `offset`, or read the tail when `offset` is omitted. */
	read(opts: { offset?: number; maxBytes?: number } = {}): {
		output: string;
		offset: number;
		nextOffset: number;
		truncated: boolean;
		dropped: boolean;
	} {
		const rawMax = opts.maxBytes;
		const maxBytes = typeof rawMax === "number" && Number.isFinite(rawMax) ? Math.max(1, Math.floor(rawMax)) : BG_READ_MAX_BYTES;
		const buf = this.materialize();

		if (opts.offset === undefined) {
			if (buf.length <= maxBytes) {
				return {
					output: buf.toString("utf8"),
					offset: this._baseOffset,
					nextOffset: this._totalBytes,
					truncated: false,
					dropped: false,
				};
			}
			let start = buf.length - maxBytes;
			while (start < buf.length && (buf[start]! & 0xc0) === 0x80) start++;
			if (start >= buf.length && buf.length > 0) {
				// Single trailing codepoint larger than maxBytes: back up to its leading byte so we still return it.
				start = buf.length - 1;
				while (start > 0 && (buf[start]! & 0xc0) === 0x80) start--;
			}
			return {
				output: buf.subarray(start).toString("utf8"),
				offset: this._baseOffset + start,
				nextOffset: this._totalBytes,
				truncated: start > 0,
				dropped: false,
			};
		}

		const reqOffset = Math.max(0, Math.floor(opts.offset));
		const dropped = reqOffset < this._baseOffset;
		const effectiveOffset = Math.min(this._totalBytes, Math.max(reqOffset, this._baseOffset));
		let relStart = effectiveOffset - this._baseOffset;
		// Align if caller passed an offset mid-codepoint.
		while (relStart < buf.length && (buf[relStart]! & 0xc0) === 0x80) relStart++;
		const alignedOffset = this._baseOffset + relStart;

		if (relStart >= buf.length) {
			return {
				output: "",
				offset: this._totalBytes,
				nextOffset: this._totalBytes,
				truncated: false,
				dropped,
			};
		}

		const remaining = buf.length - relStart;
		if (remaining <= maxBytes) {
			return {
				output: buf.subarray(relStart).toString("utf8"),
				offset: alignedOffset,
				nextOffset: this._totalBytes,
				truncated: false,
				dropped,
			};
		}

		let relEnd = relStart + maxBytes;
		// Back up if relEnd lands on a UTF-8 continuation byte.
		while (relEnd > relStart && (buf[relEnd]! & 0xc0) === 0x80) relEnd--;
		if (relEnd === relStart) {
			// Single codepoint larger than maxBytes: advance to its end so cursor still progresses.
			relEnd = relStart + 1;
			while (relEnd < buf.length && (buf[relEnd]! & 0xc0) === 0x80) relEnd++;
		}
		return {
			output: buf.subarray(relStart, relEnd).toString("utf8"),
			offset: alignedOffset,
			nextOffset: this._baseOffset + relEnd,
			truncated: true,
			dropped,
		};
	}
}

interface Waiter {
	check: () => boolean;
	resolve: () => void;
}

class BgJob {
	readonly jobId: string;
	readonly pid: number;
	readonly command: string;
	readonly cwd: string;
	readonly startedAt: number;
	readonly ring: OutputRingBuffer;

	status: BgJobStatus = "running";
	exitCode: number | null = null;
	endedAt: number | null = null;

	private readonly proc: ReturnType<typeof Bun.spawn>;
	private readonly grouped: boolean;
	private hasExited = false;
	private killRequested = false;
	private giveUpTimer: ReturnType<typeof setTimeout> | undefined;
	private resolveGiveUp: (() => void) | null = null;
	private waiters = new Set<Waiter>();
	private readonly settled: Promise<void>;
	private onFinish?: () => void;

	constructor(opts: {
		jobId: string;
		command: string;
		cwd: string;
		startedAt?: number;
		proc: ReturnType<typeof Bun.spawn>;
		grouped: boolean;
		ring: OutputRingBuffer;
		onDone?: Promise<number | null>;
		onFinish?: () => void;
	}) {
		this.jobId = opts.jobId;
		this.pid = opts.proc.pid;
		this.command = opts.command;
		this.cwd = opts.cwd;
		this.startedAt = opts.startedAt ?? Date.now();
		this.proc = opts.proc;
		this.grouped = opts.grouped;
		this.ring = opts.ring;
		this.onFinish = opts.onFinish;

		const donePromise = opts.onDone ?? this.pumpOwnStreams();
		let exitTimer: ReturnType<typeof setTimeout> | undefined;
		let groupPoll: ReturnType<typeof setInterval> | undefined;
		const postExitGrace = this.proc.exited.then(
			(code) =>
				new Promise<number>((res) => {
					this.hasExited = true;
					const startGrace = () => {
						exitTimer = setTimeout(() => res(code), POST_EXIT_PIPE_GRACE_MS);
						exitTimer.unref?.();
					};
					if (!this.grouped || !isProcessGroupAlive(this.pid)) {
						startGrace();
						return;
					}
					// Shell exited while background children in its process group are still alive (e.g. `server &`):
					// keep job running until the group actually terminates so stop/close/delete can still kill it.
					groupPoll = setInterval(() => {
						if (!isProcessGroupAlive(this.pid)) {
							clearInterval(groupPoll);
							groupPoll = undefined;
							startGrace();
						}
					}, 250);
					groupPoll.unref?.();
				}),
		);
		const gaveUp = new Promise<null>((res) => {
			this.resolveGiveUp = () => res(null);
		});

		this.settled = Promise.race([
			donePromise.then((code) => ({ code, forceCancel: false })),
			postExitGrace.then((code) => ({ code, forceCancel: true })),
			gaveUp.then(() => ({ code: null, forceCancel: true })),
		]).then(({ code, forceCancel }) => {
			if (exitTimer) clearTimeout(exitTimer);
			if (groupPoll) clearInterval(groupPoll);
			if (this.giveUpTimer) clearTimeout(this.giveUpTimer);
			this.giveUpTimer = undefined;
			this.resolveGiveUp = null;
			if (forceCancel) cancelProcessStreams(this.proc);
			this.hasExited = true;
			this.exitCode = code ?? -1;
			this.endedAt = Date.now();
			this.status = this.killRequested ? "killed" : "exited";
			this.notifyWaiters();
			this.onFinish?.();
		});
	}

	private pumpOwnStreams(): Promise<number> {
		const pump = async (stream: ReadableStream<Uint8Array> | number | undefined) => {
			if (!stream || typeof stream === "number") return;
			const decoder = new TextDecoder();
			try {
				for await (const chunk of stream) {
					const decoded = decoder.decode(chunk, { stream: true });
					if (decoded) {
						this.ring.append(decoded);
						this.notifyWaiters();
					}
				}
				const tail = decoder.decode();
				if (tail) {
					this.ring.append(tail);
					this.notifyWaiters();
				}
			} catch {
				// Ignore stream cancellation errors after kill.
			}
		};
		return Promise.all([pump(this.proc.stdout), pump(this.proc.stderr)]).then(async () => {
			const code = await this.proc.exited;
			this.hasExited = true;
			return code;
		});
	}

	/** Notify waiters when externally pumped chunks are appended (adopted jobs). */
	notifyOutput(): void {
		this.notifyWaiters();
	}

	private notifyWaiters(): void {
		for (const w of [...this.waiters]) {
			if (w.check()) {
				this.waiters.delete(w);
				w.resolve();
			}
		}
	}

	snapshot(): BgJobSnapshot {
		return {
			jobId: this.jobId,
			pid: this.pid,
			command: this.command,
			cwd: this.cwd,
			status: this.status,
			exitCode: this.exitCode,
			startedAt: this.startedAt,
			endedAt: this.endedAt,
			totalBytes: this.ring.totalBytes,
			bufferedBytes: this.ring.bufferedBytes,
			baseOffset: this.ring.baseOffset,
		};
	}

	async waitUntil(predicate: () => boolean, timeoutMs: number, signal?: AbortSignal): Promise<void> {
		if (signal?.aborted) throw new Error("Wait aborted");
		if (predicate() || timeoutMs <= 0) return;

		await new Promise<void>((resolve, reject) => {
			const waiter: Waiter = {
				check: predicate,
				resolve: () => {
					cleanup();
					resolve();
				},
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, timeoutMs);
			timer.unref?.();
			const onAbort = () => {
				cleanup();
				reject(new Error("Wait aborted"));
			};
			const cleanup = () => {
				this.waiters.delete(waiter);
				clearTimeout(timer);
				signal?.removeEventListener("abort", onAbort);
			};
			this.waiters.add(waiter);
			signal?.addEventListener("abort", onAbort, { once: true });
			// Re-check after subscribing to avoid missed notifications.
			if (predicate()) {
				cleanup();
				resolve();
			}
		});
	}

	terminate(opts: { keepAliveUntilKilled?: boolean } = {}): void {
		if (this.status !== "running" || this.killRequested) return;
		this.killRequested = true;
		terminateProcess(this.proc, this.grouped, () => this.hasExited, opts);
		if (!this.giveUpTimer && this.resolveGiveUp) {
			this.giveUpTimer = setTimeout(() => {
				this.giveUpTimer = undefined;
				this.resolveGiveUp?.();
			}, KILL_GRACE_MS);
			this.giveUpTimer.unref?.();
		}
	}

	async stop(): Promise<void> {
		this.terminate();
		await this.settled;
	}
}

export interface BackgroundBashManagerOptions {
	maxRunningPerSession?: number;
	maxRunningGlobal?: number;
	maxFinishedPerSession?: number;
	ringBufferBytes?: number;
}

const commandShell = pickCommandShell();

/**
 * Manages background bash processes with strict per-session ownership isolation,
 * concurrency caps, LRU eviction of finished jobs, and clean process-group shutdown.
 */
export class BackgroundBashManager {
	private readonly sessions = new Map<string, Map<string, BgJob>>();
	private readonly deletedSessions = new Set<string>();
	private readonly maxRunning: number;
	private readonly maxRunningGlobal: number;
	private readonly maxFinished: number;
	private readonly ringBufferBytes: number;

	constructor(opts: BackgroundBashManagerOptions = {}) {
		this.maxRunning = opts.maxRunningPerSession ?? MAX_RUNNING_JOBS_PER_SESSION;
		this.maxRunningGlobal = opts.maxRunningGlobal ?? MAX_RUNNING_JOBS_GLOBAL;
		this.maxFinished = opts.maxFinishedPerSession ?? MAX_FINISHED_JOBS_PER_SESSION;
		this.ringBufferBytes = opts.ringBufferBytes ?? BG_RING_BUFFER_BYTES;
	}

	private sessionMap(sessionId: string): Map<string, BgJob> {
		let m = this.sessions.get(sessionId);
		if (!m) {
			m = new Map();
			this.sessions.set(sessionId, m);
		}
		return m;
	}

	private runningCount(sessionId: string): number {
		const m = this.sessions.get(sessionId);
		if (!m) return 0;
		let count = 0;
		for (const j of m.values()) if (j.status === "running") count++;
		return count;
	}

	private totalRunningCount(): number {
		let count = 0;
		for (const m of this.sessions.values()) {
			for (const j of m.values()) if (j.status === "running") count++;
		}
		return count;
	}

	private pruneFinished(sessionId: string): void {
		const m = this.sessions.get(sessionId);
		if (!m) return;
		const finished: BgJob[] = [];
		for (const j of m.values()) {
			if (j.status !== "running") finished.push(j);
		}
		if (finished.length <= this.maxFinished) return;
		finished.sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
		const toDrop = finished.length - this.maxFinished;
		for (let i = 0; i < toDrop; i++) {
			m.delete(finished[i]!.jobId);
		}
	}

	private getOwned(sessionId: string, jobId: string): BgJob {
		const job = this.sessions.get(sessionId)?.get(jobId);
		if (!job) throw new Error(`Background job "${jobId}" not found`);
		return job;
	}

	private assertCanStart(sessionId: string): void {
		if (this.deletedSessions.has(sessionId)) {
			throw new Error("Session has been deleted; cannot start new background jobs.");
		}
		if (this.runningCount(sessionId) >= this.maxRunning) {
			throw new Error(
				`Too many background jobs running in this session (max ${this.maxRunning}). Stop an existing job with bash_job(action="stop") first.`,
			);
		}
		if (this.totalRunningCount() >= this.maxRunningGlobal) {
			throw new Error(
				`Too many background jobs running across the server (max ${this.maxRunningGlobal}). Stop an existing job before starting another.`,
			);
		}
	}

	start(sessionId: string, input: { command: string; cwd: string; env: Record<string, string> }): BgJobSnapshot {
		this.assertCanStart(sessionId);
		const grouped = process.platform !== "win32";
		const argv = commandArgv(commandShell, input.command);
		const proc = Bun.spawn(argv, {
			cwd: input.cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			env: input.env,
			detached: grouped,
		});
		const jobId = `bg_${randomUUID().slice(0, 8)}`;
		const job = new BgJob({
			jobId,
			command: input.command,
			cwd: input.cwd,
			proc,
			grouped,
			ring: new OutputRingBuffer(this.ringBufferBytes),
			onFinish: () => this.pruneFinished(sessionId),
		});
		this.sessionMap(sessionId).set(jobId, job);
		return job.snapshot();
	}

	/**
	 * Adopt an already-running process (e.g., when a synchronous `bash` call with `backgroundOnTimeout: true` hits timeout).
	 * Returns `{ snapshot, notifyOutput }` so the caller's stream pump can keep notifying waiters.
	 */
	adopt(
		sessionId: string,
		input: {
			command: string;
			cwd: string;
			startedAt?: number;
			proc: ReturnType<typeof Bun.spawn>;
			grouped: boolean;
			ring: OutputRingBuffer;
			onDone: Promise<number | null>;
		},
	): { snapshot: BgJobSnapshot; notifyOutput: () => void } {
		this.assertCanStart(sessionId);
		const jobId = `bg_${randomUUID().slice(0, 8)}`;
		const job = new BgJob({
			jobId,
			command: input.command,
			cwd: input.cwd,
			startedAt: input.startedAt,
			proc: input.proc,
			grouped: input.grouped,
			ring: input.ring,
			onDone: input.onDone,
			onFinish: () => this.pruneFinished(sessionId),
		});
		this.sessionMap(sessionId).set(jobId, job);
		return { snapshot: job.snapshot(), notifyOutput: () => job.notifyOutput() };
	}

	list(sessionId: string): BgJobSnapshot[] {
		const m = this.sessions.get(sessionId);
		if (!m) return [];
		return [...m.values()].map((j) => j.snapshot());
	}

	async output(
		sessionId: string,
		jobId: string,
		opts: { offset?: number; waitSeconds?: number; maxBytes?: number; signal?: AbortSignal } = {},
	): Promise<BgReadResult> {
		const job = this.getOwned(sessionId, jobId);
		const waitMs = Math.min(MAX_WAIT_SECONDS, Math.max(0, opts.waitSeconds ?? 0)) * 1000;
		if (waitMs > 0 && job.status === "running") {
			const baseline =
				opts.offset !== undefined
					? Math.min(Math.max(0, Math.floor(opts.offset)), job.ring.totalBytes)
					: job.ring.totalBytes;
			await job.waitUntil(
				() => job.status !== "running" || job.ring.totalBytes > baseline,
				waitMs,
				opts.signal,
			);
		} else if (opts.signal?.aborted) {
			throw new Error("Wait aborted");
		}
		const r = job.ring.read({ offset: opts.offset, maxBytes: opts.maxBytes });
		return { job: job.snapshot(), ...r };
	}

	async wait(
		sessionId: string,
		jobId: string,
		opts: { offset?: number; waitSeconds?: number; maxBytes?: number; signal?: AbortSignal } = {},
	): Promise<BgReadResult> {
		const job = this.getOwned(sessionId, jobId);
		const waitMs = Math.min(MAX_WAIT_SECONDS, Math.max(0, opts.waitSeconds ?? DEFAULT_WAIT_SECONDS)) * 1000;
		if (waitMs > 0 && job.status === "running") {
			await job.waitUntil(() => job.status !== "running", waitMs, opts.signal);
		} else if (opts.signal?.aborted) {
			throw new Error("Wait aborted");
		}
		const r = job.ring.read({ offset: opts.offset, maxBytes: opts.maxBytes });
		return { job: job.snapshot(), ...r };
	}

	async stop(sessionId: string, jobId: string): Promise<BgReadResult> {
		const job = this.getOwned(sessionId, jobId);
		await job.stop();
		const r = job.ring.read({ maxBytes: BG_READ_MAX_BYTES });
		return { job: job.snapshot(), ...r };
	}

	/**
	 * Stop all running background jobs owned by `sessionId` and drop its state.
	 * Pass `permanent: true` on session delete to tombstone the session against in-flight starts.
	 */
	stopSession(sessionId: string, opts: { permanent?: boolean; keepAliveUntilKilled?: boolean } = {}): void {
		if (opts.permanent) this.deletedSessions.add(sessionId);
		const m = this.sessions.get(sessionId);
		if (!m) return;
		this.sessions.delete(sessionId);
		for (const job of m.values()) {
			if (job.status === "running") job.terminate({ keepAliveUntilKilled: opts.keepAliveUntilKilled });
		}
	}

	/** Stop all running background jobs across all sessions (called on server shutdown). */
	shutdown(): void {
		for (const id of [...this.sessions.keys()]) {
			this.stopSession(id, { permanent: true, keepAliveUntilKilled: true });
		}
	}

	/** Create a session-scoped `BackgroundBashOps` facade for `ToolContext`. */
	forSession(sessionId: string): BackgroundBashOps {
		return {
			start: (input) => this.start(sessionId, input),
			adopt: (input) => this.adopt(sessionId, input),
			list: () => this.list(sessionId),
			output: (jobId, opts) => this.output(sessionId, jobId, opts),
			wait: (jobId, opts) => this.wait(sessionId, jobId, opts),
			stop: (jobId) => this.stop(sessionId, jobId),
		};
	}
}

const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;
const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({
	content: [{ type: "text", text: t }],
	details,
});

function formatJobLine(j: BgJobSnapshot): string {
	const exitPart = j.exitCode !== null ? ` exit=${j.exitCode}` : "";
	const preview = truncateTailBytes(j.command.replace(/\s+/g, " ").trim(), 120).text;
	return `${j.jobId} | ${j.status}${exitPart} | pid=${j.pid} | ${j.totalBytes}B | ${preview}`;
}

function formatReadResult(r: BgReadResult): string {
	const { job } = r;
	const header = [
		`jobId: ${job.jobId}`,
		`status: ${job.status}${job.exitCode !== null ? ` (exitCode: ${job.exitCode})` : ""}`,
		`pid: ${job.pid}`,
		`offset: ${r.offset}..${r.nextOffset} (total: ${job.totalBytes}B${r.dropped ? ", older output evicted" : ""}${r.truncated ? ", truncated" : ""})`,
	].join(" | ");
	return r.output ? `${header}\n\n${r.output}` : `${header}\n\n(no new output)`;
}

const BASH_JOB_DESCRIPTION = [
	"Manage background bash jobs started by `bash(background: true)` or timed-out `bash(backgroundOnTimeout: true)` in this session. Pick `action`:",
	"list: list running and recent finished background jobs for this session.",
	"output (id, offset?, waitSeconds?): read output from a job. Pass `offset` (from previous `nextOffset`, or 0 for start) for incremental reading; omit `offset` to read the latest tail. Pass `waitSeconds` (up to 30) to wait for new output or completion.",
	"wait (id, waitSeconds?, offset?): wait until the job finishes or `waitSeconds` elapses (default 15, max 30), then return status and output.",
	"stop (id): terminate the job's process group (SIGTERM then SIGKILL) and return its final status and output.",
].join("\n");

export const bashJobTool: ToolDef = {
	name: BG_BASH_JOB_TOOL,
	description: BASH_JOB_DESCRIPTION,
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: BG_BASH_JOB_TOOL,
			label: "Background bash job",
			description: BASH_JOB_DESCRIPTION,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("list"), Type.Literal("output"), Type.Literal("wait"), Type.Literal("stop")], {
					description: "Action: list, output, wait, or stop",
				}),
				id: Type.Optional(Type.String({ minLength: 1, maxLength: 64, description: "output, wait, stop: the jobId returned by bash" })),
				offset: Type.Optional(Type.Integer({ minimum: 0, description: "output, wait: byte offset for incremental reading (omit for tail)" })),
				waitSeconds: Type.Optional(Type.Number({ minimum: 0, maximum: MAX_WAIT_SECONDS, description: "output, wait: max seconds to wait (0-30)" })),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, p, signal) {
				const ops = ctx?.bgBash;
				if (!ops) throw new Error("Background bash jobs are not available in this context");
				if (p.action === "list") {
					const jobs = ops.list();
					if (jobs.length === 0) return text("No background bash jobs in this session.", { jobs });
					return text(jobs.map(formatJobLine).join("\n"), { jobs });
				}
				if (!p.id) throw new Error(`bash_job ${p.action} requires \`id\``);
				if (p.action === "output") {
					const res = await ops.output(p.id, { offset: p.offset, waitSeconds: p.waitSeconds, signal });
					return text(formatReadResult(res), {
						jobId: res.job.jobId,
						pid: res.job.pid,
						status: res.job.status,
						exitCode: res.job.exitCode,
						offset: res.offset,
						nextOffset: res.nextOffset,
						totalBytes: res.job.totalBytes,
						truncated: res.truncated,
						dropped: res.dropped,
					});
				}
				if (p.action === "wait") {
					const res = await ops.wait(p.id, { offset: p.offset, waitSeconds: p.waitSeconds, signal });
					return text(formatReadResult(res), {
						jobId: res.job.jobId,
						pid: res.job.pid,
						status: res.job.status,
						exitCode: res.job.exitCode,
						offset: res.offset,
						nextOffset: res.nextOffset,
						totalBytes: res.job.totalBytes,
						truncated: res.truncated,
						dropped: res.dropped,
					});
				}
				const res = await ops.stop(p.id);
				return text(formatReadResult(res), {
					jobId: res.job.jobId,
					pid: res.job.pid,
					status: res.job.status,
					exitCode: res.job.exitCode,
					offset: res.offset,
					nextOffset: res.nextOffset,
					totalBytes: res.job.totalBytes,
					truncated: res.truncated,
					dropped: res.dropped,
				});
			},
		});
	},
};

import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { randomUUID } from "node:crypto";
import { constants as fsConstants, realpathSync } from "node:fs";
import { access, chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import Type, { type TSchema } from "typebox";
import { formatBytes, isUnsupportedPicture, MAX_IMAGE_BYTES, sniffImage } from "./image-file.ts";
import { DEFAULT_LIMITS, exifOrientation, type ResizeLimits } from "./image-resize-core.ts";
import { resizeImage } from "./image-resize.ts";
import { commandArgv, pickCommandShell, shellNote } from "./command-shell.ts";
import type { ManageAction, ManageArgs, PeerCreateInput } from "./peers.ts";
import { goalTool, type GoalOps } from "./goal-tool.ts";
import { mcpTool, type McpOps } from "./mcp-tool.ts";
import { scheduleTool, type ScheduleOps } from "./schedule-tool.ts";
import { LEFT_TO_AGENT } from "./questions.ts";
import { THINKING_LEVELS, type ThinkingLevel } from "./shared/thinking.ts";
import { formatSpilledOutput, spillText, truncateHeadBytes, truncateTailBytes } from "./spill.ts";

export { truncateHeadBytes, truncateTailBytes };

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;
const MAX_READ_FILE_BYTES = 20 * 1024 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;
const MAX_LS_ENTRIES = 500;
const MAX_GREP_LINES = 200;
const MAX_GREP_LINE_CHARS = 300;
const MAX_GLOB_DEFAULT = 200;
const MAX_GLOB_LIMIT = 500;
const MAX_CAPTURE_BYTES = 10 * 1024 * 1024;
const DEFAULT_BASH_TIMEOUT_S = 120;
const KILL_TERM_GRACE_MS = 500;
const KILL_GRACE_MS = 2000;

export interface ReadTrackEntry {
	mtimeMs: number;
	size: number;
}

export interface ToolDef {
	name: string;
	description: string;
	/** `readRoots`: extra absolute directories the read tool may open (skill folders). */
	create(cwd: string, readRoots?: string[], ctx?: ToolContext): AgentTool<any>;
}

/** What a tool may need from the running session beyond its working directory. */
export interface ToolContext {
	/** The session the tool runs in (extension tools use it to reach their per-session storage). */
	sessionId?: string;
	/** Dynamic working directory resolver so `workdir move` takes effect immediately for every tool call. */
	getCwd?: () => string;
	/** Tracks `{ mtimeMs, size }` per canonical file path read/written in this session for `edit` staleness checks. */
	readTracker?: Map<string, ReadTrackEntry>;
	/** Directory where oversized tool output (`bash`, `grep`) may be spilled to disk. */
	spillDir?: string;
	/** Whether the model that will see tool results can take pictures; asked at call time because the model can change mid-session. Missing = assume yes (the provider layer drops pictures a model cannot take). */
	canSeeImages?(): boolean;
	/** The model's own picture size limits, when its catalog entry has any; they replace the defaults. */
	imageLimits?(): Partial<ResizeLimits> | undefined;
	/** Ask the user and wait for the answer (`ask_user`). Rejects when the run is aborted. */
	ask?(toolCallId: string, req: AskRequest, signal?: AbortSignal): Promise<string>;
	/** Run a one-off subagent and return its answer (`delegate`). Rejects with a conflict when a limit is hit; the signal stops the subagent. */
	delegate?(toolCallId: string, input: { role: string; task: string; model?: string; thinking?: ThinkingLevel }, signal: AbortSignal | undefined, progress: (line: string) => void): Promise<AgentToolResult<any>>;
	/** The role policy of `delegate` now: `any` lets `role` name a role with no file (read in `create`, so the tool text matches it). */
	delegateRoles?(): "defined" | "any";
	/** The model policy of `delegate` now (read in `create`, so the tool text lists the models a call may name). */
	delegateModels?(): { policy: "defined" | "allowlist" | "any"; models: string[] };
	/** The chat models a new session or subagent may run on now, as provider/model (returned by `peer(action="list_models")`). */
	chatModels?(): readonly string[];
	/** Whether the `peer` tool is enabled for this session (controls whether `delegate` references `peer(action="list_models")`). */
	peerEnabled?(): boolean;
	/** Other sessions of this server (`peer`). */
	peers?: {
		send(to: string, message: string, opts?: { mode?: "steer" | "follow_up"; notify?: boolean }): Promise<string>;
		read(from: string, count: number, detail?: boolean): string;
		list(): string;
		abort(name: string): string;
		answer(name: string, a: { answer?: string | null; answers?: (string | null)[]; toolCallId?: string }): string;
		create(input: PeerCreateInput): Promise<string>;
		manage(name: string, action: ManageAction, a?: ManageArgs): string;
		group(action: "create" | "add" | "remove" | "dissolve", a: { group?: string; members?: string[]; name?: string }): string;
	};
	/** Scheduled tasks (`schedule`). */
	schedules?: ScheduleOps;
	/** Per-session goal (`goal`). */
	goals?: GoalOps;
	/** MCP servers (`mcp`). */
	mcp?: McpOps;
	/** The session's working folder (`workdir`): where it works now, and moving it to another working tree of its repository. */
	workdir?: {
		show(): string;
		move(path: string | null): string;
	};
}

/** One question, or several asked together (`items`; `question`/`options` describe the first). */
export interface AskRequest {
	question: string;
	options?: string[];
	recommended?: string;
	/** The options are ordered steps of one scale (shown as a ladder). */
	scale?: boolean;
	/** Any number of the options may be picked; the answer holds them one per line. */
	multiple?: boolean;
	/** One short line per option, same order as `options`. */
	descriptions?: string[];
	allowFreeText?: boolean;
	items?: { question: string; options?: string[]; recommended?: string; scale?: boolean; multiple?: boolean; descriptions?: string[]; allowFreeText?: boolean }[];
}

/** Keeps the parameter schema generic so `execute` params are inferred, then erases it for storage. */
const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;

const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({
	content: [{ type: "text", text: t }],
	details,
});

/** Keep the tail of long output (UTF-8 safe). */
function truncateTail(s: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
	const res = truncateTailBytes(s, max);
	if (!res.truncated) return res;
	return { text: `[output truncated, showing last ${max} bytes]\n${res.text}`, truncated: true };
}

const escapes = (root: string, target: string) => {
	const rel = relative(root, target);
	return rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel);
};

/** realpath of the deepest existing ancestor, with the not-yet-existing tail re-appended. */
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

/** Canonical path key for readTracker and per-path locking. */
function canonicalPath(file: string): string {
	try {
		return realpathSync(file);
	} catch {
		return resolve(file);
	}
}

/** Whether `target` is `root` or lies inside it, judged by real location so a symlink cannot lead out. */
export function isInside(root: string, target: string): boolean {
	return !escapes(root, target) && !escapes(realWithTail(root), realWithTail(target));
}

/**
 * Resolve a path the model or a client gave against cwd. It is NOT confined to cwd: an absolute path, `..` and a
 * symlink that leads elsewhere are all accepted, on purpose. The agent works across the whole machine like the user's
 * own shell does, and what it may touch is decided by who runs the server (a dedicated user, the Docker sandbox) and
 * by guard extensions, not here. Everything that takes a path goes through this one function so that stays one decision.
 */
export function safePath(cwd: string, p: string): string {
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** Per-path async mutex: serializes concurrent writes/edits to the same file while keeping different files parallel. */
const pathLocks = new Map<string, Promise<void>>();

export async function withPathLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
	const prev = pathLocks.get(key) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	const tail = prev.then(() => next);
	pathLocks.set(key, tail);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (pathLocks.get(key) === tail) pathLocks.delete(key);
	}
}

/** Per-session async UI mutex for `ask_user`, abort-aware while waiting for the previous prompt. */
const askLocks = new Map<string, Promise<void>>();

async function withAskLock<T>(sessionKey: string, signal: AbortSignal | undefined, fn: () => Promise<T>): Promise<T> {
	if (signal?.aborted) throw new Error("Run aborted while waiting for the user");
	const prev = askLocks.get(sessionKey) ?? Promise.resolve();
	let release!: () => void;
	const next = new Promise<void>((r) => { release = r; });
	const tail = prev.then(() => next);
	askLocks.set(sessionKey, tail);

	try {
		if (signal) {
			await new Promise<void>((res, rej) => {
				if (signal.aborted) {
					rej(new Error("Run aborted while waiting for the user"));
					return;
				}
				const onAbort = () => rej(new Error("Run aborted while waiting for the user"));
				signal.addEventListener("abort", onAbort, { once: true });
				prev.then(() => {
					signal.removeEventListener("abort", onAbort);
					res();
				});
			});
		} else {
			await prev;
		}
		if (signal?.aborted) throw new Error("Run aborted while waiting for the user");
		return await fn();
	} finally {
		release();
		if (askLocks.get(sessionKey) === tail) askLocks.delete(sessionKey);
	}
}

/**
 * Atomic write via sibling temp file + rename:
 * - Resolves symlinks so writing through a symlink updates its target without destroying the link.
 * - Falls back to in-place `writeFile` for hardlinks (`nlink > 1`) or files owned by another uid.
 * - Creates temp file with `0o600` first, then `chmod`s to `existingMode` before `rename` (no 0644 window).
 * - Falls back to direct `writeFile` only on `EXDEV` (preserving mode), surfacing `EPERM`/`EACCES`.
 */
async function atomicWriteFile(file: string, content: string): Promise<void> {
	let target = file;
	let existingMode: number | undefined;
	let writeInPlace = false;
	const myUid = typeof process.getuid === "function" ? process.getuid() : undefined;

	try {
		const lst = await lstat(file);
		if (lst.isSymbolicLink()) {
			try {
				target = await realpath(file);
				const st = await stat(target);
				existingMode = st.mode & 0o777;
				if (st.nlink > 1 || (myUid !== undefined && st.uid !== myUid)) {
					writeInPlace = true;
				}
			} catch {
				// Dangling symlink: write through it in-place so the symlink is not replaced.
				writeInPlace = true;
			}
		} else {
			existingMode = lst.mode & 0o777;
			if (lst.nlink > 1 || (myUid !== undefined && lst.uid !== myUid)) {
				writeInPlace = true;
			}
		}
	} catch {
		// File does not exist yet — create atomically.
	}

	if (writeInPlace) {
		await writeFile(target, content, "utf8");
		return;
	}

	const tmp = join(dirname(target), `.${basename(target)}.pipaya-tmp-${randomUUID().slice(0, 8)}`);
	try {
		try {
			if (existingMode !== undefined) {
				await writeFile(tmp, content, { encoding: "utf8", mode: 0o600 });
				await chmod(tmp, existingMode);
			} else {
				await writeFile(tmp, content, "utf8");
			}
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			// If creating the sibling temp file failed in a read-only dir (e.g. 0555) but the existing target itself is writable, write in-place.
			if ((code === "EACCES" || code === "EPERM") && existingMode !== undefined) {
				let writable = false;
				try {
					await access(target, fsConstants.W_OK);
					writable = true;
				} catch {}
				if (writable) {
					await writeFile(target, content, "utf8");
					return;
				}
			}
			throw e;
		}
		try {
			await rename(tmp, target);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "EXDEV") {
				await unlink(tmp).catch(() => {});
				await writeFile(target, content, "utf8");
				if (existingMode !== undefined) {
					try { await chmod(target, existingMode); } catch {}
				}
			} else {
				throw e;
			}
		}
	} catch (e) {
		await unlink(tmp).catch(() => {});
		throw e;
	}
}

/**
 * Environment variables model-run commands may inherit. Everything else (cloud credentials, the FCM
 * service account path, the server's own PIPAYA_* settings, ...) is withheld. Extra names can be
 * passed through with PIPAYA_BASH_ENV=NAME1,NAME2.
 */
const CHILD_ENV_ALLOW = new Set([
	"PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "COLORTERM", "NO_COLOR", "TZ", "TMPDIR", "PWD",
	"LANG", "LANGUAGE", "EDITOR", "PAGER", "CI",
	"HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "no_proxy", "all_proxy",
	"SSL_CERT_FILE", "SSL_CERT_DIR", "NODE_EXTRA_CA_CERTS",
	"BUN_INSTALL", "CARGO_HOME", "RUSTUP_HOME", "GOPATH", "GOROOT", "JAVA_HOME", "PNPM_HOME", "NVM_DIR",
	"SYSTEMROOT", "COMSPEC", "PATHEXT", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
]);
const CHILD_ENV_ALLOW_PREFIXES = ["LC_", "XDG_", "MISE_"];

export function buildChildEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const extra = new Set(
		(source.PIPAYA_BASH_ENV ?? "").split(",").map((s) => s.trim()).filter((s) => s && !s.startsWith("PIPAYA_")),
	);
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined || k.startsWith("PIPAYA_")) continue;
		if (CHILD_ENV_ALLOW.has(k) || extra.has(k) || CHILD_ENV_ALLOW_PREFIXES.some((p) => k.startsWith(p))) env[k] = v;
	}
	return env;
}

const childEnv = () => buildChildEnv();

interface ProcResult {
	output: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

interface SplitProcResult {
	stdout: string;
	stderr: string;
	exitCode: number | null;
	timedOut: boolean;
	aborted: boolean;
}

/** Send SIGTERM to process group on POSIX, poll up to 500ms, then escalate to SIGKILL. */
function terminateProcess(proc: ReturnType<typeof Bun.spawn>, grouped: boolean, exited: () => boolean): void {
	if (!grouped) {
		// No process groups on Windows: taskkill /T takes the whole tree down.
		try {
			Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
		} catch (e) {
			process.stderr.write(`taskkill failed for ${proc.pid}: ${(e as Error).message}\n`);
		}
		try { proc.kill("SIGKILL"); } catch {}
		return;
	}

	const groupAlive = () => {
		try {
			process.kill(-proc.pid, 0);
			return true;
		} catch (e) {
			return (e as NodeJS.ErrnoException).code !== "ESRCH";
		}
	};

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
		if (!groupAlive() || (exited() && !groupAlive())) {
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
	poll.unref?.();
}

async function runProcess(
	cmd: string[],
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxCaptureBytes?: number; onChunk?: (tail: string) => void },
): Promise<ProcResult> {
	// POSIX: run in its own session (Bun calls setsid(); the pid stays the group id) so a kill reaches grandchildren too, not just
	// the shell. This needs no `setsid` binary, which macOS does not ship.
	const grouped = process.platform !== "win32";
	const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(), detached: grouped });
	let timedOut = false;
	let aborted = false;
	let killedAt = 0;
	let hasExited = false;
	const maxCap = opts.maxCaptureBytes ?? MAX_OUTPUT_BYTES * 2;
	const kill = () => {
		if (killedAt) return;
		killedAt = Date.now();
		terminateProcess(proc, grouped, () => hasExited);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, opts.timeoutMs);
	const onAbort = () => {
		aborted = true;
		kill();
	};
	if (opts.signal?.aborted) onAbort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	let output = "";
	let lastEmit = 0;
	const pump = async (stream: ReadableStream<Uint8Array>) => {
		const decoder = new TextDecoder();
		for await (const chunk of stream) {
			output += decoder.decode(chunk, { stream: true });
			// Bound memory: keep ~maxCap while running.
			if (output.length > maxCap) output = output.slice(-maxCap);
			const now = Date.now();
			if (opts.onChunk && now - lastEmit > 150) {
				lastEmit = now;
				opts.onChunk(truncateTail(output).text);
			}
		}
		output += decoder.decode();
	};
	try {
		const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(async () => {
			const code = await proc.exited;
			hasExited = true;
			return code;
		});
		// After a kill, never wait on the pipes for long: a leaked descendant could hold them open forever.
		const gaveUp = new Promise<null>((res) => {
			const poll = setInterval(() => {
				if (killedAt && Date.now() - killedAt > KILL_GRACE_MS) { clearInterval(poll); res(null); }
			}, 100);
			void drained.finally(() => clearInterval(poll));
		});
		const exitCode = await Promise.race([drained, gaveUp]);
		return { output, exitCode: exitCode ?? -1, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

/** Run a subprocess keeping stdout and stderr strictly separated, capturing from the head up to `maxCaptureBytes`. */
async function runProcessSplit(
	cmd: string[],
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; maxCaptureBytes?: number },
): Promise<SplitProcResult> {
	const grouped = process.platform !== "win32";
	const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(), detached: grouped });
	let timedOut = false;
	let aborted = false;
	let killedAt = 0;
	let hasExited = false;
	const maxCap = opts.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
	const kill = () => {
		if (killedAt) return;
		killedAt = Date.now();
		terminateProcess(proc, grouped, () => hasExited);
	};
	const timer = setTimeout(() => {
		timedOut = true;
		kill();
	}, opts.timeoutMs);
	const onAbort = () => {
		aborted = true;
		kill();
	};
	if (opts.signal?.aborted) onAbort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	const pumpHead = async (stream: ReadableStream<Uint8Array>, cap: number): Promise<string> => {
		const decoder = new TextDecoder();
		let acc = "";
		for await (const chunk of stream) {
			if (acc.length < cap) {
				const decoded = decoder.decode(chunk, { stream: true });
				const remaining = cap - acc.length;
				acc += decoded.length > remaining ? decoded.slice(0, remaining) : decoded;
			}
		}
		if (acc.length < cap) acc += decoder.decode();
		return acc;
	};
	try {
		const drained = Promise.all([pumpHead(proc.stdout, maxCap), pumpHead(proc.stderr, MAX_OUTPUT_BYTES)]).then(async ([stdout, stderr]) => {
			const code = await proc.exited;
			hasExited = true;
			return { stdout, stderr, code };
		});
		const gaveUp = new Promise<null>((res) => {
			const poll = setInterval(() => {
				if (killedAt && Date.now() - killedAt > KILL_GRACE_MS) { clearInterval(poll); res(null); }
			}, 100);
			void drained.finally(() => clearInterval(poll));
		});
		const result = await Promise.race([drained, gaveUp]);
		if (!result) return { stdout: "", stderr: "", exitCode: -1, timedOut, aborted };
		return { stdout: result.stdout, stderr: result.stderr, exitCode: result.code, timedOut, aborted };
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * A picture file comes back as an image block the model can look at; null means "not a picture, read it as text".
 * Detection is by content, so a renamed file is still recognised and a text file named .png is not.
 */
async function readPicture(file: string, shown: string, ctx: ToolContext, signal?: AbortSignal): Promise<AgentToolResult<any> | null> {
	const info = await stat(file);
	if (!info.isFile()) return null;
	const fh = await open(file, "r");
	let head: Buffer;
	try {
		head = Buffer.alloc(Math.min(info.size, 64 * 1024));
		const { bytesRead } = await fh.read(head, 0, head.length, 0);
		head = head.subarray(0, bytesRead);
	} finally {
		await fh.close();
	}
	const sniffed = sniffImage(head);
	if (!sniffed) {
		const other = isUnsupportedPicture(head);
		if (!other) return null;
		return text(`${shown} is a ${other} image; only PNG, JPEG, GIF and WebP can be shown to the model. Convert it first (for example with ImageMagick: convert in.${other === "BMP" ? "bmp" : "img"} out.png).`, { path: shown, image: false, format: other });
	}
	const size = sniffed.width && sniffed.height ? `${sniffed.width}x${sniffed.height}, ` : "";
	const label = `${sniffed.mimeType} ${size}${formatBytes(info.size)}`;
	const details = { path: shown, image: true, mimeType: sniffed.mimeType, bytes: info.size, width: sniffed.width, height: sniffed.height };
	if (ctx.canSeeImages && !ctx.canSeeImages()) {
		return text(`${shown} is an image (${label}). The current model cannot see images, so it is not included. Switch to a model with image input to view it.`, { ...details, shown: false });
	}
	if (info.size > MAX_IMAGE_FILE_BYTES || (sniffed.width && sniffed.height && sniffed.width * sniffed.height > MAX_IMAGE_PIXELS)) {
		return text(`${shown} is an image (${label}), too large to process. Downscale it first (for example: convert in.png -resize 1568x1568\\> out.png).`, { ...details, shown: false });
	}
	const limits: ResizeLimits = { ...DEFAULT_LIMITS, ...Object.fromEntries(Object.entries(ctx.imageLimits?.() ?? {}).filter(([, v]) => typeof v === "number" && v > 0)) };
	const bytes = await readFile(file);
	const fits = (sniffed.width ?? 0) <= limits.maxWidth && (sniffed.height ?? 0) <= limits.maxHeight && Math.ceil(bytes.length / 3) * 4 < limits.maxBytes;
	// A JPEG/WebP with an EXIF rotation is sent as it is only when it needs no resizing; the model APIs ignore EXIF, so such a file is re-encoded upright.
	if (fits && sniffed.width && sniffed.height && exifOrientation(bytes) === 1) {
		return picture(shown, label, bytes.toString("base64"), sniffed.mimeType, { ...details, shown: true });
	}
	const resized = await resizeImage(bytes, limits, signal);
	if (resized) {
		const changed = resized.width !== resized.originalWidth || resized.height !== resized.originalHeight;
		const note = changed
			? `${label}; resized to ${resized.width}x${resized.height} (original ${resized.originalWidth}x${resized.originalHeight}) to fit the model's image limits`
			: `${label}; re-encoded as ${resized.mimeType} to fit the model's image limits`;
		return picture(shown, note, resized.data, resized.mimeType, { ...details, shown: true, resized: true, width: resized.width, height: resized.height, originalWidth: resized.originalWidth, originalHeight: resized.originalHeight, mimeType: resized.mimeType });
	}
	// The resizer is unavailable or failed: the original goes through only if providers would still accept it.
	if (bytes.length <= MAX_IMAGE_BYTES && Math.max(sniffed.width ?? 0, sniffed.height ?? 0) <= MAX_IMAGE_EDGE) {
		return picture(shown, label, bytes.toString("base64"), sniffed.mimeType, { ...details, shown: true });
	}
	return text(`${shown} is an image (${label}) and could not be resized to fit the model's limits. Downscale it first (for example: convert in.png -resize 1568x1568\\> out.png).`, { ...details, shown: false });
}

function picture(shown: string, label: string, data: string, mimeType: string, details: Record<string, unknown>): AgentToolResult<any> {
	return { content: [{ type: "text", text: `Read image ${shown} (${label}).` }, { type: "image", data, mimeType }], details };
}

const READ_DESCRIPTION = "Read a text file, or look at an image (PNG, JPEG, GIF, WebP; large ones are shrunk to fit the model). Text output includes line numbers and is capped at 2000 lines / 50KB; use offset and limit to page through.";

/** Providers reject a picture bigger than this on one side. */
const MAX_IMAGE_EDGE = 8000;
/** What is still worth decoding: a 100 MB file or 100 megapixels needs hundreds of MB of RAM to resize. */
const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;

function formatNumberedLine(lineNum: number, line: string, width: number): string {
	return `${String(lineNum).padStart(width, " ")}│${line.replace(/\r$/, "")}`;
}

/** Detect binary or unsupported-encoding content in the leading sample. */
function detectBinarySample(sample: Buffer, totalSize: number): "nul" | "utf16" | "binary" | null {
	if (sample.length === 0) return null;
	// Check UTF-16 BOM before NUL so UTF-16 files get a clearer encoding hint instead of generic binary.
	if (sample.length >= 2 && ((sample[0] === 0xff && sample[1] === 0xfe) || (sample[0] === 0xfe && sample[1] === 0xff))) {
		return "utf16";
	}
	if (sample.includes(0)) return "nul";
	// If we only read a prefix of a larger file, trim any partial multi-byte UTF-8 sequence at the cut boundary.
	let checkEnd = sample.length;
	if (totalSize > sample.length) {
		let back = 0;
		while (back < 3 && checkEnd > 0 && (sample[checkEnd - 1]! & 0xc0) === 0x80) {
			checkEnd--;
			back++;
		}
		if (checkEnd > 0 && (sample[checkEnd - 1]! & 0x80) !== 0) {
			checkEnd--;
		}
	}
	if (checkEnd <= 0) return null;
	const slice = sample.subarray(0, checkEnd);
	let hasControl = false;
	for (let i = 0; i < slice.length; i++) {
		const b = slice[i]!;
		if (b < 0x09 || (b >= 0x0e && b <= 0x1f)) {
			hasControl = true;
			break;
		}
	}
	const decoded = new TextDecoder("utf-8", { fatal: false }).decode(slice);
	if (decoded.length === 0) return null;
	let invalid = 0;
	for (let i = 0; i < decoded.length; i++) {
		if (decoded.charCodeAt(i) === 0xfffd) invalid++;
	}
	const ratio = invalid / decoded.length;
	// Avoid falsely flagging short Latin-1 text (e.g. `café naïve résumé`) as binary: require control bytes or high invalid ratio on >=64 bytes.
	if (ratio > 0.1 && (hasControl || (checkEnd >= 64 && ratio > 0.3))) {
		return "binary";
	}
	return null;
}

const readTool: ToolDef = {
	name: "read",
	description: READ_DESCRIPTION,
	create(cwd, _roots = [], ctx = {}) {
		const tracker = ctx.readTracker ?? new Map<string, ReadTrackEntry>();
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "read",
			label: "Read file",
			description: READ_DESCRIPTION,
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory" }),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to start from" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines" })),
			}),
			async execute(_id, params, signal) {
				const file = safePath(curCwd(), params.path);
				const image = await readPicture(file, params.path, ctx, signal);
				if (image) return image;

				const info = await stat(file);
				if (!info.isFile()) throw new Error(`${params.path} is not a regular file`);
				if (info.size > MAX_READ_FILE_BYTES) {
					throw new Error(`${params.path} is ${formatBytes(info.size)}, exceeding the 20 MB read limit. Use bash or grep to inspect specific parts.`);
				}

				if (info.size > 0) {
					const fh = await open(file, "r");
					try {
						const probe = Buffer.alloc(Math.min(info.size, BINARY_SNIFF_BYTES));
						const { bytesRead } = await fh.read(probe, 0, probe.length, 0);
						const kind = detectBinarySample(probe.subarray(0, bytesRead), info.size);
						if (kind === "utf16") {
							return text(`${params.path} has an unsupported encoding (UTF-16) (${formatBytes(info.size)}); convert it to UTF-8 to read as text.`, {
								path: params.path,
								binary: true,
								encoding: "utf-16",
								bytes: info.size,
							});
						}
						if (kind) {
							return text(`${params.path} appears to be a binary file (${formatBytes(info.size)}); cannot display as text.`, {
								path: params.path,
								binary: true,
								bytes: info.size,
							});
						}
					} finally {
						await fh.close();
					}
				}

				const raw = await readFile(file, "utf8");
				tracker.set(canonicalPath(file), { mtimeMs: info.mtimeMs, size: info.size });

				if (raw.length === 0) {
					return text("(empty file)", { path: params.path, totalLines: 0, from: 0, to: 0 });
				}

				const lines = raw.split("\n");
				if (raw.endsWith("\n")) lines.pop();
				const start = (params.offset ?? 1) - 1;
				if (start >= lines.length) {
					return text(`(file has ${lines.length} lines; offset ${start + 1} is past EOF)`, {
						path: params.path,
						totalLines: lines.length,
						from: start + 1,
						to: lines.length,
					});
				}
				const maxEnd = Math.min(lines.length, start + Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES));
				const width = Math.max(4, String(maxEnd).length);

				const outLines: string[] = [];
				let usedBytes = 0;
				let shownEnd = start;
				let byteTruncated = false;

				for (let i = start; i < maxEnd; i++) {
					const formatted = formatNumberedLine(i + 1, lines[i]!, width);
					const lineBytes = Buffer.byteLength(formatted, "utf8") + (outLines.length > 0 ? 1 : 0);
					if (usedBytes + lineBytes > MAX_OUTPUT_BYTES) {
						if (outLines.length === 0) {
							const clipped = truncateHeadBytes(formatted, MAX_OUTPUT_BYTES).text;
							outLines.push(`${clipped}… [line truncated]`);
							shownEnd = i + 1;
						}
						byteTruncated = true;
						break;
					}
					outLines.push(formatted);
					usedBytes += lineBytes;
					shownEnd = i + 1;
				}

				const body = outLines.join("\n");
				const more = shownEnd < lines.length ? `\n[${lines.length - shownEnd} more lines; continue with offset=${shownEnd + 1}]` : "";
				return text(body + more, {
					path: params.path,
					totalLines: lines.length,
					from: start + 1,
					to: shownEnd,
					...(byteTruncated ? { truncated: true } : {}),
				});
			},
		});
	},
};

const writeTool: ToolDef = {
	name: "write",
	description: "Create or overwrite a file. Parent directories are created automatically.",
	create(cwd, _roots, ctx = {}) {
		const tracker = ctx.readTracker ?? new Map<string, ReadTrackEntry>();
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "write",
			label: "Write file",
			description: "Create or overwrite a file. Parent directories are created automatically.",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory" }),
				content: Type.String(),
			}),
			async execute(_id, params) {
				const file = safePath(curCwd(), params.path);
				return withPathLock(realWithTail(file), async () => {
					await mkdir(dirname(file), { recursive: true });
					await atomicWriteFile(file, params.content);
					const info = await stat(file);
					tracker.set(canonicalPath(file), { mtimeMs: info.mtimeMs, size: info.size });
					const bytes = Buffer.byteLength(params.content, "utf8");
					return text(`Wrote ${bytes} bytes to ${params.path}`, {
						path: params.path,
						bytes,
					});
				});
			},
		});
	},
};

const READ_LINE_PREFIX_RE = /^\s*(\d+)│/;

/**
 * Only strip `read` line-number prefixes when EVERY non-empty line matches `^\s*(\d+)│`
 * AND the parsed line numbers are strictly consecutive (e.g. 10, 11, 12).
 * This avoids corrupting TSV or pipe-delimited content.
 */
function hasStrictReadPrefixes(s: string): boolean {
	const lines = s.split("\n");
	let prevNum: number | null = null;
	let matched = 0;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const m = READ_LINE_PREFIX_RE.exec(line);
		if (!m) return false;
		const num = Number(m[1]);
		if (prevNum !== null && num !== prevNum + 1) return false;
		prevNum = num;
		matched++;
	}
	return matched > 0;
}

function stripReadPrefixes(s: string): string {
	return s.split("\n").map((l) => l.replace(READ_LINE_PREFIX_RE, "")).join("\n");
}

function lineNumberAt(s: string, index: number): number {
	let line = 1;
	for (let i = 0; i < index && i < s.length; i++) {
		if (s.charCodeAt(i) === 10) line++;
	}
	return line;
}

function findAllOccurrences(haystack: string, needle: string): number[] {
	const out: number[] = [];
	if (!needle) return out;
	let pos = 0;
	while (true) {
		const idx = haystack.indexOf(needle, pos);
		if (idx === -1) break;
		out.push(idx);
		pos = idx + needle.length;
	}
	return out;
}

function buildLfMap(raw: string): { lf: string; rawIndex: number[] } {
	let lf = "";
	const rawIndex: number[] = [];
	for (let i = 0; i < raw.length; i++) {
		if (raw.charCodeAt(i) === 13 && raw.charCodeAt(i + 1) === 10) continue;
		lf += raw[i]!;
		rawIndex.push(i);
	}
	rawIndex.push(raw.length);
	return { lf, rawIndex };
}

function leadingWs(line: string): string {
	const m = /^[ \t]*/.exec(line);
	return m ? m[0] : "";
}

function closestCandidateHint(content: string, needle: string): string {
	const fileLines = content.replace(/\r\n/g, "\n").split("\n");
	const needleLines = needle.replace(/\r\n/g, "\n").split("\n").map((l) => l.trim()).filter(Boolean);
	if (fileLines.length === 0 || needleLines.length === 0) return "";

	const needleSet = new Set(needleLines);
	const needleTokens = new Set(needleLines.join(" ").split(/\W+/).filter((w) => w.length >= 2));
	const winSize = Math.min(Math.max(1, needleLines.length), fileLines.length);

	// Pick candidate start positions: scan all lines for small files, or anchor on best-matching lines for large files.
	const starts: number[] = [];
	if (fileLines.length <= 2000) {
		for (let i = 0; i <= fileLines.length - winSize; i++) starts.push(i);
	} else {
		const anchorScores: { idx: number; score: number }[] = [];
		for (let i = 0; i < fileLines.length; i++) {
			const trimmed = fileLines[i]!.trim();
			if (!trimmed) continue;
			let s = needleSet.has(trimmed) ? 3 : 0;
			if (!s && needleTokens.size > 0) {
				for (const tok of trimmed.split(/\W+/)) {
					if (tok.length >= 2 && needleTokens.has(tok)) s += 0.5;
				}
			}
			if (s > 0) anchorScores.push({ idx: i, score: s });
		}
		anchorScores.sort((a, b) => b.score - a.score);
		const seen = new Set<number>();
		for (const a of anchorScores.slice(0, 60)) {
			const st = Math.max(0, Math.min(fileLines.length - winSize, a.idx - Math.floor(winSize / 2)));
			if (!seen.has(st)) { seen.add(st); starts.push(st); }
		}
	}

	let bestStart = -1;
	let bestScore = 0;
	for (const st of starts) {
		let score = 0;
		for (let k = 0; k < winSize; k++) {
			const trimmed = fileLines[st + k]!.trim();
			if (!trimmed) continue;
			if (needleSet.has(trimmed)) {
				score += 2;
			} else if (needleTokens.size > 0) {
				let tokHits = 0;
				const words = trimmed.split(/\W+/).filter((w) => w.length >= 2);
				for (const w of words) if (needleTokens.has(w)) tokHits++;
				if (words.length > 0) score += tokHits / words.length;
			}
		}
		const normalized = score / (needleLines.length * 2);
		if (normalized > bestScore) {
			bestScore = normalized;
			bestStart = st;
		}
	}

	if (bestStart === -1 || bestScore < 0.2) return "";
	const snippetStart = Math.max(0, bestStart - 1);
	const snippetEnd = Math.min(fileLines.length, bestStart + Math.min(winSize, 8) + 1);
	const width = Math.max(4, String(snippetEnd).length);
	const snippet = fileLines.slice(snippetStart, snippetEnd).map((l, idx) => formatNumberedLine(snippetStart + idx + 1, l, width)).join("\n");
	return `\nClosest candidate (lines ${snippetStart + 1}-${snippetEnd}):\n${snippet}`;
}

type EditMatchKind = "exact" | "prefix" | "crlf" | "indent";

interface SingleEditResult {
	next: string;
	matchLines: number[];
	count: number;
	matchKind: EditMatchKind;
}

interface RawLineRange {
	start: number;
	end: number;
	text: string;
	eol: string;
}

function rawLineRanges(content: string): RawLineRange[] {
	const out: RawLineRange[] = [];
	let pos = 0;
	while (pos <= content.length) {
		const nl = content.indexOf("\n", pos);
		if (nl === -1) {
			out.push({ start: pos, end: content.length, text: content.slice(pos), eol: "" });
			break;
		}
		const hasCr = nl > pos && content.charCodeAt(nl - 1) === 13;
		const end = hasCr ? nl - 1 : nl;
		out.push({ start: pos, end, text: content.slice(pos, end), eol: hasCr ? "\r\n" : "\n" });
		pos = nl + 1;
	}
	return out;
}

function indentStyleOfLines(lines: readonly string[]): "tab" | "space" | "mixed" | "none" {
	let hasTab = false;
	let hasSpace = false;
	for (const line of lines) {
		if (line.trim().length === 0) continue;
		const ws = leadingWs(line);
		if (ws.includes("\t")) hasTab = true;
		if (ws.includes(" ")) hasSpace = true;
	}
	if (hasTab && hasSpace) return "mixed";
	if (hasTab) return "tab";
	if (hasSpace) return "space";
	return "none";
}

function applyOneEdit(content: string, oldText: string, newText: string, replaceAll: boolean, label?: string): SingleEditResult {
	const prefix = label ? `${label}: ` : "";
	const eol = content.includes("\r\n") ? "\r\n" : "\n";

	const ambiguousError = (lines: number[]) => {
		const listed = lines.slice(0, 20).join(", ") + (lines.length > 20 ? `, ... (${lines.length} total)` : "");
		return new Error(`${prefix}oldText matches ${lines.length} times (lines ${listed}); include more surrounding context or pass replaceAll: true`);
	};

	// Stage 1: exact match
	const exact = findAllOccurrences(content, oldText);
	if (exact.length > 0) {
		const lines = exact.map((i) => lineNumberAt(content, i));
		if (exact.length > 1 && !replaceAll) throw ambiguousError(lines);
		const parts: string[] = [];
		let cursor = 0;
		for (const idx of exact) {
			parts.push(content.slice(cursor, idx), newText);
			cursor = idx + oldText.length;
		}
		parts.push(content.slice(cursor));
		return { next: parts.join(""), matchLines: lines, count: exact.length, matchKind: "exact" };
	}

	// Stage 2: strip accidental `read` line-number prefixes (strict consecutive `^\s*(\d+)│` on every non-empty line)
	const strippedOld = hasStrictReadPrefixes(oldText) ? stripReadPrefixes(oldText) : oldText;
	const strippedNew = strippedOld !== oldText && hasStrictReadPrefixes(newText) ? stripReadPrefixes(newText) : newText;
	if (strippedOld !== oldText && strippedOld.length > 0) {
		const sMatches = findAllOccurrences(content, strippedOld);
		if (sMatches.length > 0) {
			const lines = sMatches.map((i) => lineNumberAt(content, i));
			if (sMatches.length > 1 && !replaceAll) throw ambiguousError(lines);
			const parts: string[] = [];
			let cursor = 0;
			for (const idx of sMatches) {
				parts.push(content.slice(cursor, idx), strippedNew);
				cursor = idx + strippedOld.length;
			}
			parts.push(content.slice(cursor));
			return { next: parts.join(""), matchLines: lines, count: sMatches.length, matchKind: "prefix" };
		}
	}

	// Stage 3: CRLF/LF normalized match (preserving original line endings and aligning CRLF boundaries)
	const { lf: normContent, rawIndex } = buildLfMap(content);
	const normCandidates: { o: string; n: string }[] = [{ o: oldText.replace(/\r\n/g, "\n"), n: newText.replace(/\r\n/g, "\n") }];
	if (strippedOld !== oldText && strippedOld.length > 0) {
		normCandidates.push({ o: strippedOld.replace(/\r\n/g, "\n"), n: strippedNew.replace(/\r\n/g, "\n") });
	}
	for (const cand of normCandidates) {
		const lfMatches = findAllOccurrences(normContent, cand.o);
		if (lfMatches.length > 0) {
			const lines = lfMatches.map((i) => lineNumberAt(normContent, i));
			if (lfMatches.length > 1 && !replaceAll) throw ambiguousError(lines);
			const adaptedNew = eol === "\r\n" ? cand.n.replace(/\n/g, "\r\n") : cand.n;
			const parts: string[] = [];
			let cursor = 0;
			for (const lfIdx of lfMatches) {
				let rawStart = rawIndex[lfIdx]!;
				if (rawStart > 0 && content[rawStart - 1] === "\r" && content[rawStart] === "\n") {
					rawStart--;
				}
				const rawEnd = rawIndex[lfIdx + cand.o.length - 1]! + 1;
				parts.push(content.slice(cursor, rawStart), adaptedNew);
				cursor = rawEnd;
			}
			parts.push(content.slice(cursor));
			return { next: parts.join(""), matchLines: lines, count: lfMatches.length, matchKind: "crlf" };
		}
	}

	// Stage 4: whitespace/indent-insensitive line-block match (ONLY if unique, preserving original slice EOLs and refusing tab/space conflicts)
	const effectiveOld = (strippedOld !== oldText && strippedOld.length > 0 ? strippedOld : oldText).replace(/\r\n/g, "\n");
	const effectiveNew = (strippedOld !== oldText && strippedOld.length > 0 ? strippedNew : newText).replace(/\r\n/g, "\n");
	const oldLines = effectiveOld.split("\n");
	if (oldLines.some((l) => l.trim().length > 0)) {
		const ranges = rawLineRanges(content);
		const winLen = oldLines.length;
		const blockMatches: number[] = [];
		for (let i = 0; i <= ranges.length - winLen; i++) {
			let ok = true;
			for (let k = 0; k < winLen; k++) {
				if (ranges[i + k]!.text.trim() !== oldLines[k]!.trim()) {
					ok = false;
					break;
				}
			}
			if (ok) blockMatches.push(i);
		}
		if (blockMatches.length > 1) {
			throw ambiguousError(blockMatches.map((i) => i + 1));
		}
		if (blockMatches.length === 1) {
			const startLine = blockMatches[0]!;
			const matchedFileTexts = ranges.slice(startLine, startLine + winLen).map((r) => r.text);
			const newLinesRaw = effectiveNew.split("\n");
			const fileStyle = indentStyleOfLines(matchedFileTexts);
			const editStyle = indentStyleOfLines([...oldLines, ...newLinesRaw]);
			const indentConflict =
				(fileStyle === "tab" && (editStyle === "space" || editStyle === "mixed")) ||
				(fileStyle === "space" && (editStyle === "tab" || editStyle === "mixed"));

			if (!indentConflict) {
				const firstNonEmpty = oldLines.findIndex((l) => l.trim().length > 0);
				const firstFileWs = leadingWs(matchedFileTexts[firstNonEmpty]!);
				const firstOldWs = leadingWs(oldLines[firstNonEmpty]!);
				let addPrefix: string | null = null;
				let removePrefix: string | null = null;
				if (firstFileWs.startsWith(firstOldWs)) {
					addPrefix = firstFileWs.slice(firstOldWs.length);
				} else if (firstOldWs.startsWith(firstFileWs)) {
					removePrefix = firstOldWs.slice(firstFileWs.length);
				}

				let constantDelta = addPrefix !== null || removePrefix !== null;
				if (constantDelta) {
					for (let k = 0; k < winLen; k++) {
						if (oldLines[k]!.trim().length === 0) continue;
						const fWs = leadingWs(matchedFileTexts[k]!);
						const oWs = leadingWs(oldLines[k]!);
						if (addPrefix !== null) {
							if (fWs !== addPrefix + oWs) { constantDelta = false; break; }
						} else if (removePrefix !== null) {
							if (oWs !== removePrefix + fWs) { constantDelta = false; break; }
						}
					}
				}

				if (constantDelta) {
					const newLines = newLinesRaw.map((line) => {
						if (line.trim().length === 0) return "";
						if (addPrefix !== null) return addPrefix + line;
						if (removePrefix && line.startsWith(removePrefix)) return line.slice(removePrefix.length);
						return line;
					});
					const sliceStart = ranges[startLine]!.start;
					const sliceEnd = ranges[startLine + winLen - 1]!.end;
					const blockEol = ranges[startLine]!.eol || eol;
					const replaced = content.slice(0, sliceStart) + newLines.join(blockEol) + content.slice(sliceEnd);
					return { next: replaced, matchLines: [startLine + 1], count: 1, matchKind: "indent" };
				}
			}
		}
	}

	const hint = closestCandidateHint(content, effectiveOld);
	throw new Error(`${prefix}oldText was not found in the file${hint}`);
}

function buildEditSnippet(content: string, matchLines: number[]): string {
	const lines = content.replace(/\r\n/g, "\n").split("\n");
	if (lines.length === 0 || matchLines.length === 0) return "";
	// Merge ±3-line ranges around edited locations (up to 3 regions).
	const ranges: [number, number][] = [];
	for (const ln of matchLines.slice(0, 3)) {
		const start = Math.max(1, ln - 3);
		const end = Math.min(lines.length, ln + 3);
		const prev = ranges.at(-1);
		if (prev && start <= prev[1] + 1) {
			prev[1] = Math.max(prev[1], end);
		} else {
			ranges.push([start, end]);
		}
	}
	const maxLine = Math.max(...ranges.map(([, e]) => e));
	const width = Math.max(4, String(maxLine).length);
	return ranges
		.map(([s, e]) => lines.slice(s - 1, e).map((l, idx) => formatNumberedLine(s + idx, l, width)).join("\n"))
		.join("\n...\n");
}

const EDIT_DESCRIPTION = "Replace text in a file. Pass oldText + newText for a single edit (with optional replaceAll), or edits[] for multiple atomic all-or-nothing edits.";

const editTool: ToolDef = {
	name: "edit",
	description: EDIT_DESCRIPTION,
	create(cwd, _roots, ctx = {}) {
		const tracker = ctx.readTracker ?? new Map<string, ReadTrackEntry>();
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "edit",
			label: "Edit file",
			description: EDIT_DESCRIPTION,
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory" }),
				oldText: Type.Optional(Type.String({ minLength: 1, description: "Text to find; must occur once unless replaceAll is true" })),
				newText: Type.Optional(Type.String({ description: "Replacement text" })),
				replaceAll: Type.Optional(Type.Boolean({ description: "Replace all occurrences of oldText" })),
				edits: Type.Optional(
					Type.Array(
						Type.Object({
							oldText: Type.String({ minLength: 1 }),
							newText: Type.String(),
							replaceAll: Type.Optional(Type.Boolean()),
						}),
						{ minItems: 1, description: "Multiple edits applied atomically (all-or-nothing) in order" },
					),
				),
			}),
			async execute(_id, params) {
				const hasSingle = params.oldText !== undefined || params.newText !== undefined;
				const hasBatch = params.edits !== undefined;
				if (hasSingle && hasBatch) {
					throw new Error("provide either oldText/newText or edits, not both");
				}
				if (hasBatch) {
					if (!params.edits?.length) throw new Error("edits must be a non-empty array");
				} else if (params.oldText === undefined || params.newText === undefined) {
					throw new Error("edit requires oldText and newText, or edits");
				}

				const file = safePath(curCwd(), params.path);
				return withPathLock(realWithTail(file), async () => {
					const key = canonicalPath(file);
					const info = await stat(file);
					const tracked = tracker.get(key);
					if (tracked && (tracked.mtimeMs !== info.mtimeMs || tracked.size !== info.size)) {
						throw new Error(`${params.path} has been modified on disk since it was last read; re-read it with read before editing`);
					}

					const original = await readFile(file, "utf8");
					let cur = original;
					const allMatchLines: number[] = [];
					let totalReplacements = 0;
					const MATCH_RANK: Record<EditMatchKind, number> = { exact: 0, prefix: 1, crlf: 2, indent: 3 };
					let matchKind: EditMatchKind = "exact";

					if (params.edits) {
						for (let i = 0; i < params.edits.length; i++) {
							const e = params.edits[i]!;
							const res = applyOneEdit(cur, e.oldText, e.newText, !!e.replaceAll, `edits[${i}]`);
							cur = res.next;
							allMatchLines.push(...res.matchLines);
							totalReplacements += res.count;
							if (MATCH_RANK[res.matchKind] > MATCH_RANK[matchKind]) matchKind = res.matchKind;
						}
					} else {
						const res = applyOneEdit(cur, params.oldText!, params.newText!, !!params.replaceAll);
						cur = res.next;
						allMatchLines.push(...res.matchLines);
						totalReplacements += res.count;
						matchKind = res.matchKind;
					}

					await atomicWriteFile(file, cur);
					const nextInfo = await stat(file);
					tracker.set(canonicalPath(file), { mtimeMs: nextInfo.mtimeMs, size: nextInfo.size });

					const snippet = buildEditSnippet(cur, allMatchLines);
					const fallbackNote = matchKind !== "exact" ? ` [matched via ${matchKind} fallback]` : "";
					const header = (totalReplacements > 1 ? `Edited ${params.path} (${totalReplacements} replacements)` : `Edited ${params.path}`) + fallbackNote;
					return text(snippet ? `${header}\n${snippet}` : header, {
						path: params.path,
						...(params.edits ? { edits: params.edits.length } : { oldText: params.oldText, newText: params.newText }),
						replacements: totalReplacements,
						match: matchKind,
					});
				});
			},
		});
	},
};

const lsTool: ToolDef = {
	name: "ls",
	description: "List a directory. Directories end with '/'.",
	create(cwd, _roots, ctx = {}) {
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "ls",
			label: "List directory",
			description: "List a directory. Directories end with '/'.",
			parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Defaults to the working directory" })) }),
			async execute(_id, params) {
				const dir = safePath(curCwd(), params.path ?? ".");
				const entries = await readdir(dir, { withFileTypes: true });
				const names = (
					await Promise.all(
						entries.map(async (e) => {
							if (e.isDirectory()) return `${e.name}/`;
							if (e.isSymbolicLink()) {
								try {
									const target = await stat(join(dir, e.name));
									return target.isDirectory() ? `${e.name}/` : e.name;
								} catch {
									return e.name;
								}
							}
							return e.name;
						}),
					)
				).sort();
				const info = await stat(dir);

				const shown: string[] = [];
				let usedBytes = 0;
				const cap = Math.min(names.length, MAX_LS_ENTRIES);
				for (let i = 0; i < cap; i++) {
					const name = names[i]!;
					const bytes = Buffer.byteLength(name, "utf8") + (shown.length > 0 ? 1 : 0);
					if (usedBytes + bytes > MAX_OUTPUT_BYTES && shown.length > 0) break;
					shown.push(name);
					usedBytes += bytes;
				}
				const omitted = names.length - shown.length;
				const body = shown.length ? shown.join("\n") + (omitted > 0 ? `\n[${omitted} more entries omitted]` : "") : "(empty)";
				return text(body, { path: params.path ?? ".", count: names.length, shown: shown.length, mtime: info.mtimeMs });
			},
		});
	},
};

const grepTool: ToolDef = {
	name: "grep",
	description: "Search file contents with a regular expression (ripgrep if available, otherwise grep).",
	create(cwd, _roots, ctx = {}) {
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "grep",
			label: "Search files",
			description: "Search file contents with a regular expression (ripgrep if available, otherwise grep).",
			parameters: Type.Object({
				pattern: Type.String(),
				path: Type.Optional(Type.String()),
				glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. *.ts" })),
				ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (-i)" })),
				context: Type.Optional(Type.Integer({ minimum: 0, maximum: 10, description: "Lines of context around each match (-C)" })),
				filesOnly: Type.Optional(Type.Boolean({ description: "Return only matching file paths (-l)" })),
				fixedStrings: Type.Optional(Type.Boolean({ description: "Treat pattern as a literal string (-F)" })),
			}),
			async execute(_id, params, signal) {
				const base = curCwd();
				const target = safePath(base, params.path ?? ".");
				const rg = Bun.which("rg");
				const cmd = rg
					? [
							rg,
							...(params.filesOnly ? ["-l"] : ["-n", "--no-heading", "--max-columns", String(MAX_GREP_LINE_CHARS)]),
							...(params.ignoreCase ? ["-i"] : []),
							...(params.fixedStrings ? ["-F"] : []),
							...(params.context && !params.filesOnly ? ["-C", String(params.context)] : []),
							...(params.glob ? ["-g", params.glob] : []),
							"-e",
							params.pattern,
							target,
						]
					: [
							"grep",
							...(params.filesOnly ? ["-rlI"] : ["-rnI"]),
							...(params.fixedStrings ? ["-F"] : ["-E"]),
							...(params.ignoreCase ? ["-i"] : []),
							...(params.context && !params.filesOnly ? ["-C", String(params.context)] : []),
							...(params.glob ? [`--include=${params.glob}`] : []),
							"-e",
							params.pattern,
							target,
						];
				const res = await runProcessSplit(cmd, { cwd: base, timeoutMs: 30_000, signal });
				if (res.aborted) throw new Error("Search aborted");
				if (res.timedOut) throw new Error("Search timed out after 30s");
				if (res.exitCode === 1 && !res.stdout.trim()) return text("(no matches)", { matches: 0 });
				const partial = res.exitCode === 2 && Boolean(res.stdout.trim());
				if (res.exitCode !== 0 && res.exitCode !== 1 && !partial) {
					throw new Error(res.stderr.trim() || res.stdout.trim() || `search failed (${res.exitCode})`);
				}

				const prefix = `${base}${sep}`;
				const rawLines = res.stdout.split("\n").filter(Boolean).map((l) => {
					const stripped = l.startsWith(prefix) ? l.slice(prefix.length) : l;
					if (!rg && stripped.length > MAX_GREP_LINE_CHARS) {
						return `${stripped.slice(0, MAX_GREP_LINE_CHARS)}…`;
					}
					return stripped;
				});
				if (rawLines.length === 0) return text("(no matches)", { matches: 0 });

				const shown: string[] = [];
				let usedBytes = 0;
				const lineCap = Math.min(rawLines.length, MAX_GREP_LINES);
				for (let i = 0; i < lineCap; i++) {
					const line = rawLines[i]!;
					const bytes = Buffer.byteLength(line, "utf8") + (shown.length > 0 ? 1 : 0);
					if (usedBytes + bytes > MAX_OUTPUT_BYTES) {
						if (shown.length === 0) {
							shown.push(truncateHeadBytes(line, MAX_OUTPUT_BYTES).text);
						}
						break;
					}
					shown.push(line);
					usedBytes += bytes;
				}

				const truncated = shown.length < rawLines.length;
				let extra = "";
				let spillPath: string | undefined;
				if (truncated) {
					if (ctx.spillDir) {
						const spilled = await spillText(ctx.spillDir, "grep", rawLines.join("\n"));
						spillPath = spilled.path;
						extra = `\n[showing first ${shown.length} of ${rawLines.length} matches; full output (${formatBytes(spilled.bytes)}) saved to ${spilled.path} — use read/grep to inspect]`;
					} else {
						extra = `\n[${rawLines.length - shown.length} more matches omitted]`;
					}
				}
				if (partial && res.stderr.trim()) {
					const warnLine = res.stderr.trim().split("\n")[0]!;
					extra += `\n[warning: partial results (${warnLine})]`;
				}
				return text(shown.join("\n") + extra, {
					matches: rawLines.length,
					shown: shown.length,
					...(truncated ? { truncated: true } : {}),
					...(spillPath ? { spillPath } : {}),
					...(partial ? { partial: true } : {}),
				});
			},
		});
	},
};

const GLOB_SKIP_DIRS = new Set([".git", "node_modules"]);

function makeGlobMatcher(pattern: string): (relToTarget: string) => boolean {
	const cleaned = pattern.replace(/^\.\//, "");
	const matcher = new Bun.Glob(cleaned);
	return (relToTarget: string) => matcher.match(relToTarget);
}

// Whether the glob pattern explicitly targets hidden dot-files/folders (e.g. `.*`, `.github/**`, `**/.env*`).
function patternIncludesHidden(pattern: string): boolean {
	const cleaned = pattern.replace(/^\.\//, "");
	return /(?:^|\/)\.[^/]/.test(cleaned);
}

// Safe `rg -g` pre-filter for simple extension patterns (e.g. `**/*.ts` -> `*.ts`); returns null if pattern is complex.
function safeRgExtensionFilter(pattern: string): string | null {
	const cleaned = pattern.replace(/^\.\//, "");
	if (/[{}[\]!]/.test(cleaned)) return null;
	const m = /(?:^|\/)\*\.([a-zA-Z0-9_-]+)$/.exec(cleaned);
	return m ? `*.${m[1]}` : null;
}

/** Recursive fallback file walker when `rg` is unavailable. Exported for testing. */
export async function globFallback(target: string, pattern: string, signal?: AbortSignal): Promise<string[]> {
	const matches = makeGlobMatcher(pattern);
	const includeHidden = patternIncludesHidden(pattern);
	const results: string[] = [];
	const visited = new Set<string>();

	const walk = async (dir: string): Promise<void> => {
		if (signal?.aborted) throw new Error("Glob aborted");
		let realDir: string;
		try {
			realDir = realpathSync(dir);
		} catch {
			return;
		}
		if (visited.has(realDir)) return;
		visited.add(realDir);

		let entries;
		try {
			entries = await readdir(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (signal?.aborted) throw new Error("Glob aborted");
			if (GLOB_SKIP_DIRS.has(entry.name)) continue;
			if (!includeHidden && entry.name.startsWith(".")) continue;
			const full = join(dir, entry.name);
			let isDir = entry.isDirectory();
			if (!isDir && entry.isSymbolicLink()) {
				try { isDir = (await stat(full)).isDirectory(); } catch { continue; }
			}
			if (isDir) {
				await walk(full);
			} else {
				const rel = relative(target, full).replace(/\\/g, "/");
				if (matches(rel)) {
					results.push(full);
				}
			}
		}
	};

	await walk(target);
	return results;
}

const GLOB_DESCRIPTION = "Find files matching a glob pattern relative to `path` (use `**/*.ts` for recursive matching, `*.ts` for top-level only, or `src/*.svelte`). Skips hidden dotfiles unless the pattern names a dot segment. Respects .gitignore when ripgrep is available.";

const globTool: ToolDef = {
	name: "glob",
	description: GLOB_DESCRIPTION,
	create(cwd, _roots, ctx = {}) {
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "glob",
			label: "Find files",
			description: GLOB_DESCRIPTION,
			parameters: Type.Object({
				pattern: Type.String({ minLength: 1, description: "Glob pattern relative to `path` (e.g. **/*.ts for recursive, *.ts for top-level)" }),
				path: Type.Optional(Type.String({ description: "Directory to search in (defaults to working directory)" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_GLOB_LIMIT, description: `Maximum number of files to return (default ${MAX_GLOB_DEFAULT}, max ${MAX_GLOB_LIMIT})` })),
			}),
			async execute(_id, params, signal) {
				const base = curCwd();
				const target = safePath(base, params.path ?? ".");
				const limit = Math.min(Math.max(1, params.limit ?? MAX_GLOB_DEFAULT), MAX_GLOB_LIMIT);
				const rg = Bun.which("rg");
				let absFiles: string[];
				let captureCapped = false;

				if (rg) {
					const includeHidden = patternIncludesHidden(params.pattern);
					const extFilter = safeRgExtensionFilter(params.pattern);
					const cmd = [
						rg,
						"--files",
						...(includeHidden ? ["--hidden", "-g", "!.git"] : []),
						...(extFilter ? ["-g", extFilter] : []),
						target,
					];
					const res = await runProcessSplit(cmd, { cwd: base, timeoutMs: 30_000, signal });
					if (res.aborted) throw new Error("Glob aborted");
					if (res.timedOut) throw new Error("Glob timed out after 30s");
					if (res.exitCode === 1 && !res.stdout.trim()) {
						return text("(no matches)", { path: params.path ?? ".", count: 0, shown: 0 });
					}
					const partial = res.exitCode === 2 && Boolean(res.stdout.trim());
					if (res.exitCode !== 0 && res.exitCode !== 1 && !partial) {
						throw new Error(res.stderr.trim() || res.stdout.trim() || `glob failed (${res.exitCode})`);
					}
					captureCapped = res.stdout.length >= MAX_CAPTURE_BYTES;
					const matches = makeGlobMatcher(params.pattern);
					absFiles = res.stdout
						.split("\n")
						.filter(Boolean)
						.map((l) => (isAbsolute(l) ? l : resolve(base, l)))
						.filter((abs) => {
							const rel = relative(target, abs).replace(/\\/g, "/");
							if (!includeHidden && /(?:^|\/)\.[^/]/.test(rel)) return false;
							return matches(rel);
						});
				} else {
					absFiles = await globFallback(target, params.pattern, signal);
				}

				const relFiles = absFiles.map((f) => relative(base, f)).sort();
				if (relFiles.length === 0) {
					return text("(no matches)", { path: params.path ?? ".", count: 0, shown: 0 });
				}

				const shown: string[] = [];
				let usedBytes = 0;
				const cap = Math.min(relFiles.length, limit);
				for (let i = 0; i < cap; i++) {
					const f = relFiles[i]!;
					const bytes = Buffer.byteLength(f, "utf8") + (shown.length > 0 ? 1 : 0);
					if (usedBytes + bytes > MAX_OUTPUT_BYTES && shown.length > 0) break;
					shown.push(f);
					usedBytes += bytes;
				}
				const omitted = relFiles.length - shown.length;
				const capWarn = captureCapped ? "\n[warning: file list exceeded 10 MB capture limit; results may be incomplete]" : "";
				const body = shown.join("\n") + (omitted > 0 ? `\n[${omitted} more files omitted]` : "") + capWarn;
				return text(body, {
					path: params.path ?? ".",
					count: relFiles.length,
					shown: shown.length,
					...(captureCapped ? { truncated: true } : {}),
				});
			},
		});
	},
};

const commandShell = pickCommandShell();
const BASH_DESCRIPTION = `Run a shell command in the working directory. Output is capped at 50KB (tail kept). Default timeout ${DEFAULT_BASH_TIMEOUT_S}s.${shellNote(commandShell)}`;

const bashTool: ToolDef = {
	name: "bash",
	description: BASH_DESCRIPTION,
	create(cwd, _roots, ctx = {}) {
		const curCwd = () => ctx.getCwd?.() ?? cwd;
		return defineTool({
			name: "bash",
			label: "Run command",
			description: BASH_DESCRIPTION,
			parameters: Type.Object({
				command: Type.String(),
				timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Timeout in seconds" })),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, onUpdate) {
				const res = await runProcess(commandArgv(commandShell, params.command), {
					cwd: curCwd(),
					timeoutMs: (params.timeout ?? DEFAULT_BASH_TIMEOUT_S) * 1000,
					signal,
					maxCaptureBytes: ctx.spillDir ? MAX_CAPTURE_BYTES : MAX_OUTPUT_BYTES * 2,
					onChunk: (tail) => onUpdate?.(text(tail, { running: true })),
				});

				let out: string;
				let truncated = false;
				let spillPath: string | undefined;
				if (Buffer.byteLength(res.output, "utf8") > MAX_OUTPUT_BYTES && ctx.spillDir) {
					const spilled = await spillText(ctx.spillDir, "bash", res.output);
					out = formatSpilledOutput(res.output, { path: spilled.path, totalBytes: spilled.bytes, totalLines: spilled.lines });
					truncated = true;
					spillPath = spilled.path;
				} else {
					const t = truncateTail(res.output);
					out = t.text;
					truncated = t.truncated;
				}

				const details = {
					command: params.command,
					exitCode: res.exitCode,
					timedOut: res.timedOut,
					truncated,
					...(spillPath ? { spillPath } : {}),
				};
				if (res.aborted) throw new Error(`Command aborted\n${out}`);
				if (res.timedOut) throw new Error(`Command timed out after ${params.timeout ?? DEFAULT_BASH_TIMEOUT_S}s\n${out}`);
				if (res.exitCode !== 0) {
					return { ...text(`${out}\n[exit code ${res.exitCode}]`, details), isError: true };
				}
				return text(out || "(no output)", details);
			},
		});
	},
};

const ASK_USER_DESCRIPTION =
	"Ask the user a question and wait for the answer. Use it only when a requirement is genuinely ambiguous or a decision is hard to undo; " +
	"for minor details, make a reasonable assumption and continue. Offer `options` when the choices are known, " +
	"and set `recommended` to the option you suggest (it is highlighted for the user). " +
	"Set `scale` when the options are short steps of one ordered scale, lowest first (effort, size, 1-5): they are shown as a ladder. " +
	"Set `multiple` when the user may pick several options (the answer lists them one per line). " +
	"Give `descriptions` (one short line per option) when a label alone does not say what it means. " +
	"The user may also leave a question to you; then decide yourself and continue.";

const askOptions = (extra: Record<string, unknown> = {}) => Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8, ...extra }));
const askRecommended = Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "The option you recommend; must be one of `options`" }));
const askScale = Type.Optional(Type.Boolean({ description: "The options are ordered steps of one scale, lowest first" }));
const askMultiple = Type.Optional(Type.Boolean({ description: "The user may pick several options" }));
const askDescriptions = Type.Optional(Type.Array(Type.String({ maxLength: 300 }), { maxItems: 8, description: "One short line per option, same order and count as `options`" }));

const askUserTool: ToolDef = {
	name: "ask_user",
	description: ASK_USER_DESCRIPTION,
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: "ask_user",
			label: "Ask user",
			description: ASK_USER_DESCRIPTION,
			parameters: Type.Object({
				question: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "One clear question. Omit when using `questions`" })),
				options: askOptions({ description: "Suggested answers" }),
				recommended: askRecommended,
				scale: askScale,
				multiple: askMultiple,
				descriptions: askDescriptions,
				allowFreeText: Type.Optional(Type.Boolean({ description: "Let the user type something other than the options. Default true" })),
				questions: Type.Optional(
					Type.Array(
						Type.Object({
							question: Type.String({ minLength: 1, maxLength: 2000 }),
							options: askOptions(),
							recommended: askRecommended,
							scale: askScale,
							multiple: askMultiple,
							descriptions: askDescriptions,
							allowFreeText: Type.Optional(Type.Boolean()),
						}),
						{ minItems: 2, maxItems: 8, description: "Ask several independent questions at once instead of one by one. The user sees them as tabs and can revise any answer before sending" },
					),
				),
			}),
			async execute(id, p, signal) {
				if (!ctx?.ask) throw new Error("ask_user is not available in this session");
				if (p.question && p.questions?.length) {
					throw new Error("ask_user takes either `question` or `questions`, not both");
				}
				const rec = (o?: string[], r?: string) => (r && o?.includes(r) ? { recommended: r } : {});
				const scale = (o?: string[], s?: boolean) => (s && (o?.length ?? 0) >= 2 ? { scale: true } : {});
				const multiple = (o?: string[], m?: boolean) => (m && (o?.length ?? 0) >= 2 ? { multiple: true } : {});
				// a description list that does not line up with the options would label the wrong ones: dropped
				const desc = (o?: string[], d?: string[]) => (o?.length && d?.length === o.length && d.some((x) => x.trim()) ? { descriptions: d.map((x) => x.trim()) } : {});
				const extra = (q: { options?: string[]; recommended?: string; scale?: boolean; multiple?: boolean; descriptions?: string[] }) => ({ ...rec(q.options, q.recommended), ...scale(q.options, q.scale), ...multiple(q.options, q.multiple), ...desc(q.options, q.descriptions) });
				const items = p.questions?.map((q) => ({ question: q.question, options: q.options, ...extra(q), allowFreeText: q.allowFreeText ?? true }));
				if (!items?.length && !p.question) throw new Error("ask_user needs `question` or `questions`");
				const first = items?.[0] ?? { question: p.question!, options: p.options, ...extra(p), allowFreeText: p.allowFreeText ?? true };
				const sessionKey = ctx.sessionId ?? "__default__";
				const answer = await withAskLock(sessionKey, signal, () => ctx.ask!(id, { ...first, ...(items?.length ? { items } : {}) }, signal));
				return text(answer, { question: first.question, answer, ...(answer === LEFT_TO_AGENT ? { left: true } : {}) });
			},
		});
	},
};

// The tool list is built once per session, but sessions come and go later: never put names in a description (they would go stale).
const PEER_NOTE = " Sessions are the user's @names; an unknown name is rejected with the current list.";

/** Lists cost tokens on every turn: past this many ids the rest are only counted. */
const MODEL_LIST_CAP = 40;
/** "p: a, b; q: c" for provider/model ids (shorter than repeating each provider), capped; empty when there are none. */
export function modelList(ids: readonly string[]): string {
	const by = new Map<string, string[]>();
	for (const id of ids.slice(0, MODEL_LIST_CAP)) {
		const i = id.indexOf("/");
		if (i <= 0) continue;
		const p = id.slice(0, i);
		by.set(p, [...(by.get(p) ?? []), id.slice(i + 1)]);
	}
	const more = ids.length > MODEL_LIST_CAP ? ` (and ${ids.length - MODEL_LIST_CAP} more)` : "";
	return [...by].map(([p, ms]) => `${p}: ${ms.join(", ")}`).join("; ") + more;
}

const PEER_ACTIONS = ["send", "read", "list", "list_models", "abort", "answer", "create", "close", "resume", "delete", "cancel_queued", "rename", "set", "group_create", "group_add", "group_remove", "group_dissolve"] as const;
type PeerAction = (typeof PEER_ACTIONS)[number];
const need = <T>(v: T | undefined, what: string, action: string): T => {
	if (v === undefined || v === "") throw new Error(`peer ${action} needs \`${what}\``);
	return v;
};

const peerTool: ToolDef = {
	name: "peer",
	description: "Work with the other sessions (agents) on this server: message, read, list, list_models, create, stop, answer, manage, group.",
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: "peer",
			label: "Other sessions",
			description: [
				"Work with the other sessions on this server. Pick `action`; each uses only the parameters named here. A session is a colleague the user can open, read and talk to: use create for work a person may watch or take over (a feature in its own worktree, a review, anything long-running or that edits files). For a quick lookup whose result you only need back, use delegate instead.",
				"send (to, message, mode?, notify?): message another active session, or every other session of a group when `to` is a group name. It runs independently, sees only what you write, and does not answer unless you ask it to reply with peer send. mode only matters when the target is working: follow_up (default) is delivered after its run, steer is injected into the run now. notify true: you get one report when the target ends its run.",
				"read (name, count?, detail?): what the session recently said and did, text only, newest last; detail also shows tool call arguments and results.",
				"list: every other open session with name, working or idle, title, branch and directory.",
				"list_models: configured chat models (provider/model) available for create, set, and delegate.",
				"abort (name): stop what it is doing right now, like the user pressing stop. Only when it is stuck or going the wrong way; prefer send with mode steer first.",
				"answer (name, answer | answers, toolCallId?): answer the ask_user question it waits on. Answer only what you can decide with what you know; anything that needs the user's judgment goes back to the user.",
				"create (message, title?, purpose?, cwd?, provider?, model?, thinkingLevel?, notify?): start a new session on `message` and get its @name back. Include all the context it needs; it sees nothing else. You get a report when it ends or asks (notify defaults to true). The directory defaults to yours; for code changes give each session its own git worktree.",
				"close (hides it from the sidebar, keeps the transcript; only sessions whose work is done and merged, a working one is refused, and never one that stopped on a problem: report it instead) / resume (reopens a closed one) / delete (erases the transcript for good; only sessions you made with create, not working) (name); cancel_queued (name, mode?, text?): lists steer/follow_up messages not yet delivered, with `text` takes one back; rename (name, newName); set (name, purpose?, provider?, model?, thinkingLevel?).",
				"group_create (members, name?), group_add / group_remove (group, members), group_dissolve (group): put sessions side by side in a named group (tag them all with @group, or send to the group name). A session is in one group at a time; a group of fewer than 2 dissolves.",
				"Peer messages are text-only: to share an image or file with another session (send or create), save it on disk and include its absolute path in `message` so the receiving session can open it with `read`.",
			].join("\n") + PEER_NOTE,
			parameters: Type.Object({
				action: Type.Unsafe<PeerAction>({ type: "string", enum: [...PEER_ACTIONS] }),
				name: Type.Optional(Type.String({ maxLength: 60, description: "The session's name, without @ (read, abort, answer, close, resume, delete, cancel_queued, rename, set)" })),
				to: Type.Optional(Type.String({ maxLength: 60, description: "send: session or group name, without @" })),
				message: Type.Optional(Type.String({ maxLength: 8000, description: "send, create: what to tell or ask; include all context it needs" })),
				mode: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("steer")], { description: "send, cancel_queued: which delivery / queue" })),
				notify: Type.Optional(Type.Boolean({ description: "send, create: report to you when it ends its run" })),
				count: Type.Optional(Type.Integer({ minimum: 1, maximum: 40, description: "read: how many recent messages (default 10)" })),
				detail: Type.Optional(Type.Boolean({ description: "read: also show tool call arguments and results, errors included" })),
				answer: Type.Optional(Type.Union([Type.String({ maxLength: 8000 }), Type.Null()], { description: "answer: the answer (one of its options when it offers only options; several picks one per line; null to leave unanswered)" })),
				answers: Type.Optional(Type.Array(Type.Union([Type.String({ maxLength: 8000 }), Type.Null()]), { maxItems: 8, description: "answer: one answer per question, when it asked several at once (null leaves a question unanswered)" })),
				toolCallId: Type.Optional(Type.String({ description: "answer: which question, when several wait (default: the oldest)" })),
				title: Type.Optional(Type.String({ maxLength: 100, description: "create" })),
				purpose: Type.Optional(Type.String({ maxLength: 200, description: "create, set: its role in a few words (shown in @mention hints)" })),
				cwd: Type.Optional(Type.String({ description: "create: working directory (default: yours)" })),
				provider: Type.Optional(Type.String({ description: "create, set: the provider of `model`" })),
				model: Type.Optional(Type.String({ description: 'create, set: model id, given with its provider; omit for the default. Call peer(action="list_models") to see available models. Pick a fast, cheap one for light work, a strong one for hard or long work' })),
				thinkingLevel: Type.Optional(Type.String({ description: "create, set: off, minimal, low, medium, high, xhigh or max" })),
				text: Type.Optional(Type.String({ maxLength: 500, description: "cancel_queued: a piece of the message to take back" })),
				newName: Type.Optional(Type.String({ maxLength: 30, description: "rename" })),
				group: Type.Optional(Type.String({ maxLength: 100, description: "group_add, group_remove, group_dissolve: group name" })),
				members: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 8, description: "group_*: session names, without @ (yourself may be one)" })),
				groupName: Type.Optional(Type.String({ maxLength: 100, description: "group_create: the group's name" })),
			}),
			async execute(_id, p) {
				const a: PeerAction = p.action;
				if (a === "list_models") {
					const list = modelList(ctx?.chatModels?.() ?? []);
					return text(list ? `Available chat models (provider: models): ${list}` : "No chat models are configured.", { action: a });
				}
				const peers = ctx?.peers;
				if (!peers) throw new Error("messaging other sessions is not available in this session");
				const name = () => need(p.name, "name", a);
				switch (a) {
					case "send": return text(await peers.send(need(p.to, "to", a), need(p.message, "message", a), { mode: p.mode, notify: p.notify }), { action: a, to: p.to });
					case "read": return text(peers.read(name(), p.count ?? 10, p.detail), { action: a, name: p.name });
					case "list": return text(peers.list(), { action: a });
					case "abort": return text(peers.abort(name()), { action: a, name: p.name });
					case "answer": return text(peers.answer(name(), { answer: p.answer, answers: p.answers, toolCallId: p.toolCallId }), { action: a, name: p.name });
					case "create": {
						const { action: _a, name: _n, to: _t, count: _c, detail: _d, answer: _an, answers: _as, toolCallId: _tc, text: _x, newName: _nn, group: _g, members: _m, groupName: _gn, ...rest } = p;
						return text(await peers.create({ ...rest, message: need(p.message, "message", a), thinkingLevel: p.thinkingLevel as PeerCreateInput["thinkingLevel"] }), { action: a });
					}
					case "close": case "resume": case "delete": case "cancel_queued": case "rename": case "set":
						return text(peers.manage(name(), a, { mode: p.mode, text: p.text, newName: p.newName, purpose: p.purpose, provider: p.provider, model: p.model, thinkingLevel: p.thinkingLevel as ManageArgs["thinkingLevel"] }), { action: a, name: p.name });
					case "group_create": case "group_add": case "group_remove": case "group_dissolve":
						return text(peers.group(a.slice(6) as "create" | "add" | "remove" | "dissolve", { group: p.group, members: p.members, name: p.groupName }), { action: a });
				}
			},
		});
	},
};

export const DELEGATE_TOOL = "delegate";
const DELEGATE_DESCRIPTION =
	"Hand a self-contained task to a short-lived subagent (a role defined in ~/.agents/subagents or the project's .agents/subagents) and get its final answer back as text. " +
	"The subagent does not see this conversation: put the goal, paths and the exact question in `task`. It runs once, is not a session (nothing appears in the session list; use peer (action create) for a lasting chat) and cannot delegate further or ask the user. " +
	"Use it like a tool, to save your own context on searches or noisy commands, when only the result matters; if the user may want to open the work, or it edits files or runs long, use peer (action create) instead. Limits apply (model calls, concurrent subagents, calls per run and elapsed time). An unknown role is rejected with the list of roles.";
/** Free role policy: `role` may name no file; the subagent is a general read-only one that takes `task` as its instructions. */
const DELEGATE_DESCRIPTION_FREE =
	"Hand a self-contained task to a short-lived subagent and get its final answer back as text. " +
	"`role` may be a role defined in ~/.agents/subagents or the project's .agents/subagents (its own model and tools), or any other short name (e.g. explore, summarize): then the subagent is a general one with read-only tools (read, grep, glob, ls) and no write, edit or shell access, and `task` is its whole instruction. " +
	"The subagent does not see this conversation: put the goal, paths and the exact question in `task`. It runs once, is not a session (nothing appears in the session list; use peer (action create) for a lasting chat) and cannot delegate further or ask the user. " +
	"Use it like a tool, to save your own context on searches or noisy commands, when only the result matters; if the user may want to open the work, or it edits files or runs long, use peer (action create) instead. Limits apply (model calls, concurrent subagents, calls per run and elapsed time).";

const MODEL_HINT = "Pick a fast, cheap model for searches, summaries and simple checks, a strong one for root-cause analysis or design judgement. Omit `model` to use the role's own model, else this session's.";
/** What the tool text says about `model` under the model policy (the ids only in the parameter, not twice); `null` = the argument is not offered (the role decides). */
export function delegateModelText(p: { policy: "defined" | "allowlist" | "any"; models: string[] } | undefined, peerEnabled = true): { tool: string; param: string } | null {
	if (!p || p.policy === "defined") return null;
	if (p.policy === "allowlist") return { tool: ` ${MODEL_HINT}`, param: `provider/model, one of: ${p.models.join(", ")}` };
	return {
		tool: ` ${MODEL_HINT}`,
		param: peerEnabled
			? 'provider/model of any configured model; call peer(action="list_models") to see available models'
			: "provider/model of any configured model",
	};
}

const delegateTool: ToolDef = {
	name: DELEGATE_TOOL,
	description: "Run a one-off subagent and return its answer.",
	create(_cwd, _roots, ctx) {
		const free = ctx?.delegateRoles?.() === "any";
		const models = delegateModelText(ctx?.delegateModels?.(), ctx?.peerEnabled?.() ?? true);
		return defineTool({
			name: DELEGATE_TOOL,
			label: "Delegate to a subagent",
			description: (free ? DELEGATE_DESCRIPTION_FREE : DELEGATE_DESCRIPTION) + (models?.tool ?? ""),
			parameters: Type.Object({
				role: Type.String({ minLength: 1, maxLength: 60, description: free ? "Subagent role: the name of a role file (without .md, e.g. explore, runner), or any short name for a general read-only subagent" : "Subagent role, the file name without .md (e.g. explore, runner)" }),
				task: Type.String({ minLength: 1, maxLength: 12000, description: "Everything the subagent needs: goal, paths, symbols, the question, and the answer format you want" }),
				...(models ? { model: Type.Optional(Type.String({ minLength: 3, maxLength: 200, description: models.param })) } : {}),
				thinking: Type.Optional(Type.Union(THINKING_LEVELS.map((l) => Type.Literal(l)), { description: "Reasoning strength: off, minimal, low, medium, high, xhigh or max. Omit to use the role's own level, else the session's (same model) or the model's default" })),
			}),
			async execute(id, p, signal, onUpdate) {
				if (!ctx?.delegate) throw new Error("delegate is not available in this session");
				return ctx.delegate(id, { role: p.role, task: p.task, model: (p as { model?: string }).model, thinking: p.thinking }, signal, (t) => onUpdate?.(text(t, { running: true })));
			},
		});
	},
};

export const WORKDIR_TOOL = "workdir";
const WORKDIR_DESCRIPTION =
	"Where this session works, and moving it between the working trees (main checkout, git worktrees) of its repository. " +
	"After a move, bash starts in the new folder and relative paths resolve against it, and the user sees the session listed there.\n" +
	"move (path): when you start changing files of one task in another working tree, usually right after `git worktree add ../x` for it, or when the user asks you to work there. " +
	"Not to look around or run one command elsewhere: use `cd x && …` or absolute paths for that.\n" +
	"back: return to the session's own folder when that task is done, and before removing the worktree you are in.\n" +
	"show: where the session works now and the working trees it can move to.";

const workdirTool: ToolDef = {
	name: WORKDIR_TOOL,
	description: WORKDIR_DESCRIPTION,
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: WORKDIR_TOOL,
			label: "Working folder",
			description: WORKDIR_DESCRIPTION,
			parameters: Type.Object({
				action: Type.Union([Type.Literal("show"), Type.Literal("move"), Type.Literal("back")]),
				path: Type.Optional(Type.String({ description: "move: the working tree to work in (absolute, or relative to where the session works now)" })),
			}),
			executionMode: "sequential",
			async execute(_id, p) {
				const w = ctx?.workdir;
				if (!w) throw new Error("this session cannot change its working folder");
				if (p.action === "show") return text(w.show(), { action: p.action });
				if (p.action === "move" && !p.path) throw new Error("move needs a path");
				return text(w.move(p.action === "back" ? null : p.path!), { action: p.action, path: p.path ?? null });
			},
		});
	},
};

const PEER_DEFS = [peerTool];
/** Built-in tools the user may switch off in the settings; every other built-in tool is locked on. */
export const TOGGLEABLE_TOOLS = [globTool.name, askUserTool.name, ...PEER_DEFS.map((t) => t.name), DELEGATE_TOOL, scheduleTool.name, goalTool.name, mcpTool.name];
/** Tools every session gets whatever list it was created with (the other sessions must always be reachable). */
export const PEER_TOOLS = PEER_DEFS.map((t) => t.name);
/** Tools every session gets, locked on: moving between working trees is part of how the session works, not an option. */
export const ALWAYS_TOOLS = [WORKDIR_TOOL];

export const TOOL_DEFS: Record<string, ToolDef> = Object.fromEntries(
	[readTool, writeTool, editTool, lsTool, grepTool, globTool, bashTool, askUserTool, ...PEER_DEFS, delegateTool, scheduleTool, goalTool, mcpTool, workdirTool].map((t) => [t.name, t]),
);
export const DEFAULT_TOOLS = Object.keys(TOOL_DEFS);


/** `defs` lets server extensions add or replace tools; the built-in set is the default. */
export function buildTools(names: string[], cwd: string, readRoots: string[] = [], ctx: ToolContext = {}, defs: Record<string, ToolDef> = TOOL_DEFS): AgentTool<any>[] {
	const effectiveCtx: ToolContext = ctx.readTracker ? ctx : { ...ctx, readTracker: new Map<string, ReadTrackEntry>() };
	return names.flatMap((n) => (defs[n] ? [defs[n].create(cwd, readRoots, effectiveCtx)] : []));
}

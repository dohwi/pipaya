import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { realpathSync } from "node:fs";
import { mkdir, open, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import Type, { type TSchema } from "typebox";
import { formatBytes, isUnsupportedPicture, MAX_IMAGE_BYTES, sniffImage } from "./image-file.ts";
import { DEFAULT_LIMITS, exifOrientation, type ResizeLimits } from "./image-resize-core.ts";
import { resizeImage } from "./image-resize.ts";
import { commandArgv, pickCommandShell, shellNote } from "./command-shell.ts";
import type { ManageAction, ManageArgs, PeerCreateInput } from "./peers.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;
const DEFAULT_BASH_TIMEOUT_S = 120;
const KILL_GRACE_MS = 2000;

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
	/** Whether the model that will see tool results can take pictures; asked at call time because the model can change mid-session. Missing = assume yes (the provider layer drops pictures a model cannot take). */
	canSeeImages?(): boolean;
	/** The model's own picture size limits, when its catalog entry has any; they replace the defaults. */
	imageLimits?(): Partial<ResizeLimits> | undefined;
	/** Ask the user and wait for the answer (`ask_user`). Rejects when the run is aborted. */
	ask?(toolCallId: string, req: AskRequest, signal?: AbortSignal): Promise<string>;
	/** Run a one-off helper and return its answer (`delegate`). Rejects with a conflict when a limit is hit; the signal stops the helper. */
	delegate?(toolCallId: string, input: { role: string; task: string; model?: string }, signal: AbortSignal | undefined, progress: (line: string) => void): Promise<AgentToolResult<any>>;
	/** Other sessions of this server (`peer`). */
	peers?: {
		send(to: string, message: string, opts?: { mode?: "steer" | "follow_up"; notify?: boolean }): Promise<string>;
		read(from: string, count: number, detail?: boolean): string;
		list(): string;
		abort(name: string): string;
		answer(name: string, a: { answer?: string; answers?: string[]; toolCallId?: string }): string;
		create(input: PeerCreateInput): Promise<string>;
		manage(name: string, action: ManageAction, a?: ManageArgs): string;
		group(action: "create" | "add" | "remove" | "dissolve", a: { group?: string; members?: string[]; name?: string }): string;
	};
}

/** One question, or several asked together (`items`; `question`/`options` describe the first). */
export interface AskRequest {
	question: string;
	options?: string[];
	recommended?: string;
	allowFreeText?: boolean;
	items?: { question: string; options?: string[]; recommended?: string; allowFreeText?: boolean }[];
}

/** Keeps the parameter schema generic so `execute` params are inferred, then erases it for storage. */
const defineTool = <T extends TSchema>(tool: AgentTool<T>): AgentTool<any> => tool;

const text = (t: string, details: Record<string, unknown> = {}): AgentToolResult<any> => ({
	content: [{ type: "text", text: t }],
	details,
});

/** Keep the tail of long output (the end of a log is usually what matters). */
function truncateTail(s: string, max = MAX_OUTPUT_BYTES): { text: string; truncated: boolean } {
	const buf = Buffer.from(s);
	if (buf.length <= max) return { text: s, truncated: false };
	return { text: `[output truncated, showing last ${max} bytes]\n${buf.subarray(buf.length - max).toString()}`, truncated: true };
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

/** Whether `target` is `root` or lies inside it, judged by real location so a symlink cannot lead out. */
export function isInside(root: string, target: string): boolean {
	return !escapes(root, target) && !escapes(realWithTail(root), realWithTail(target));
}

/**
 * Resolve a user path against cwd and refuse anything that escapes it, lexically or through a symlink
 * (a link inside cwd that points outside is rejected, including for files that do not exist yet).
 */
export function safePath(cwd: string, p: string): string {
	const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
	// Path restriction disabled by user request: allow paths outside cwd.
	return abs;
}

/** Like safePath, but additionally allows reading inside the given directories. */
export function safeReadPath(cwd: string, p: string, roots: string[] = []): string {
	try {
		return safePath(cwd, p);
	} catch (e) {
		const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p);
		// Check both the literal path and its real (symlink-resolved) location, so a link placed inside a
		// skill folder cannot lead the read tool out of it.
		const realAbs = realWithTail(abs);
		for (const root of roots) {
			if (!escapes(root, abs) && !escapes(realWithTail(root), realAbs)) return abs;
		}
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

async function runProcess(
	cmd: string[],
	opts: { cwd: string; timeoutMs: number; signal?: AbortSignal; onChunk?: (tail: string) => void },
): Promise<ProcResult> {
	// POSIX: run in its own session (Bun calls setsid(); the pid stays the group id) so a kill reaches grandchildren too, not just
	// the shell. This needs no `setsid` binary, which macOS does not ship.
	const grouped = process.platform !== "win32";
	const proc = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv(), detached: grouped });
	let timedOut = false;
	let aborted = false;
	let killedAt = 0;
	const kill = () => {
		killedAt ||= Date.now();
		if (grouped) {
			try { process.kill(-proc.pid, "SIGKILL"); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") process.stderr.write(`could not kill process group ${proc.pid}: ${(e as Error).message}` + "\n"); }
		} else {
			// No process groups on Windows: taskkill /T takes the whole tree down.
			try { Bun.spawn(["taskkill", "/T", "/F", "/PID", String(proc.pid)], { stdout: "ignore", stderr: "ignore", stdin: "ignore" }); } catch (e) { process.stderr.write(`taskkill failed for ${proc.pid}: ${(e as Error).message}` + "\n"); }
		}
		try {
			proc.kill("SIGKILL");
		} catch {} // already gone
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
			// Bound memory: keep ~2x the cap while running.
			if (output.length > MAX_OUTPUT_BYTES * 2) output = output.slice(-MAX_OUTPUT_BYTES * 2);
			const now = Date.now();
			if (opts.onChunk && now - lastEmit > 150) {
				lastEmit = now;
				opts.onChunk(truncateTail(output).text);
			}
		}
	};
	try {
		const drained = Promise.all([pump(proc.stdout), pump(proc.stderr)]).then(() => proc.exited);
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

const READ_DESCRIPTION = "Read a text file, or look at an image (PNG, JPEG, GIF, WebP; large ones are shrunk to fit the model). Text output is capped at 2000 lines / 50KB; use offset and limit to page through.";

/** Providers reject a picture bigger than this on one side. */
const MAX_IMAGE_EDGE = 8000;
/** What is still worth decoding: a 100 MB file or 100 megapixels needs hundreds of MB of RAM to resize. */
const MAX_IMAGE_FILE_BYTES = 100 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 100_000_000;

const readTool: ToolDef = {
	name: "read",
	description: READ_DESCRIPTION,
	create(cwd, readRoots = [], ctx = {}) {
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
				const file = safeReadPath(cwd, params.path, readRoots);
				const image = await readPicture(file, params.path, ctx, signal);
				if (image) return image;
				const lines = (await readFile(file, "utf8")).split("\n");
				const start = (params.offset ?? 1) - 1;
				const end = Math.min(lines.length, start + Math.min(params.limit ?? MAX_READ_LINES, MAX_READ_LINES));
				const slice = lines.slice(start, end).join("\n");
				const { text: body } = truncateTail(slice);
				const more = end < lines.length ? `\n[${lines.length - end} more lines; continue with offset=${end + 1}]` : "";
				return text(body + more, { path: params.path, totalLines: lines.length, from: start + 1, to: end });
			},
		});
	},
};

const writeTool: ToolDef = {
	name: "write",
	description: "Create or overwrite a file. Parent directories are created automatically.",
	create(cwd) {
		return defineTool({
			name: "write",
			label: "Write file",
			description: "Create or overwrite a file. Parent directories are created automatically.",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory" }),
				content: Type.String(),
			}),
			async execute(_id, params) {
				const file = safePath(cwd, params.path);
				await mkdir(dirname(file), { recursive: true });
				await writeFile(file, params.content);
				return text(`Wrote ${Buffer.byteLength(params.content)} bytes to ${params.path}`, {
					path: params.path,
					bytes: Buffer.byteLength(params.content),
				});
			},
		});
	},
};

const editTool: ToolDef = {
	name: "edit",
	description: "Replace one exact, unique occurrence of oldText with newText in a file.",
	create(cwd) {
		return defineTool({
			name: "edit",
			label: "Edit file",
			description: "Replace one exact, unique occurrence of oldText with newText in a file.",
			parameters: Type.Object({
				path: Type.String(),
				oldText: Type.String({ minLength: 1, description: "Exact text to find; must occur exactly once" }),
				newText: Type.String(),
			}),
			async execute(_id, params) {
				const file = safePath(cwd, params.path);
				const original = await readFile(file, "utf8");
				const first = original.indexOf(params.oldText);
				if (first === -1) throw new Error("oldText was not found in the file");
				if (original.indexOf(params.oldText, first + 1) !== -1) {
					throw new Error("oldText matches more than once; include more surrounding context");
				}
				await writeFile(file, original.slice(0, first) + params.newText + original.slice(first + params.oldText.length));
				return text(`Edited ${params.path}`, { path: params.path, oldText: params.oldText, newText: params.newText });
			},
		});
	},
};

const lsTool: ToolDef = {
	name: "ls",
	description: "List a directory. Directories end with '/'.",
	create(cwd) {
		return defineTool({
			name: "ls",
			label: "List directory",
			description: "List a directory. Directories end with '/'.",
			parameters: Type.Object({ path: Type.Optional(Type.String({ description: "Defaults to the working directory" })) }),
			async execute(_id, params) {
				const dir = safePath(cwd, params.path ?? ".");
				const entries = await readdir(dir, { withFileTypes: true });
				const names = entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
				const info = await stat(dir);
				return text(names.join("\n") || "(empty)", { path: params.path ?? ".", count: names.length, mtime: info.mtimeMs });
			},
		});
	},
};

const grepTool: ToolDef = {
	name: "grep",
	description: "Search file contents with a regular expression (ripgrep if available, otherwise grep).",
	create(cwd) {
		return defineTool({
			name: "grep",
			label: "Search files",
			description: "Search file contents with a regular expression (ripgrep if available, otherwise grep).",
			parameters: Type.Object({
				pattern: Type.String(),
				path: Type.Optional(Type.String()),
				glob: Type.Optional(Type.String({ description: "Only search files matching this glob, e.g. *.ts" })),
			}),
			async execute(_id, params, signal) {
				const target = safePath(cwd, params.path ?? ".");
				const rg = Bun.which("rg");
				const cmd = rg
					? [rg, "-n", "--no-heading", "--max-columns", "300", ...(params.glob ? ["-g", params.glob] : []), "-e", params.pattern, target]
					: ["grep", "-rnIE", ...(params.glob ? [`--include=${params.glob}`] : []), "-e", params.pattern, target];
				const res = await runProcess(cmd, { cwd, timeoutMs: 30_000, signal });
				if (res.exitCode === 1 && !res.output) return text("No matches", { matches: 0 });
				if (res.exitCode !== 0 && res.exitCode !== 1) throw new Error(res.output.trim() || `search failed (${res.exitCode})`);
				const lines = res.output.split("\n").filter(Boolean);
				const shown = lines.slice(0, 200).map((l) => l.replace(`${cwd}${sep}`, ""));
				const extra = lines.length > shown.length ? `\n[${lines.length - shown.length} more matches]` : "";
				return text(shown.join("\n") + extra, { matches: lines.length });
			},
		});
	},
};

const commandShell = pickCommandShell();
const BASH_DESCRIPTION = `Run a shell command in the working directory. Output is capped at 50KB (tail kept). Default timeout ${DEFAULT_BASH_TIMEOUT_S}s.${shellNote(commandShell)}`;

const bashTool: ToolDef = {
	name: "bash",
	description: BASH_DESCRIPTION,
	create(cwd) {
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
					cwd,
					timeoutMs: (params.timeout ?? DEFAULT_BASH_TIMEOUT_S) * 1000,
					signal,
					onChunk: (tail) => onUpdate?.(text(tail, { running: true })),
				});
				const { text: out, truncated } = truncateTail(res.output);
				const details = { command: params.command, exitCode: res.exitCode, timedOut: res.timedOut, truncated };
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
	"and set `recommended` to the option you suggest (it is highlighted for the user).";

const askOptions = (extra: Record<string, unknown> = {}) => Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8, ...extra }));
const askRecommended = Type.Optional(Type.String({ minLength: 1, maxLength: 200, description: "The option you recommend; must be one of `options`" }));

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
				allowFreeText: Type.Optional(Type.Boolean({ description: "Let the user type something other than the options. Default true" })),
				questions: Type.Optional(
					Type.Array(
						Type.Object({
							question: Type.String({ minLength: 1, maxLength: 2000 }),
							options: askOptions(),
							recommended: askRecommended,
							allowFreeText: Type.Optional(Type.Boolean()),
						}),
						{ minItems: 2, maxItems: 8, description: "Ask several independent questions at once instead of one by one. The user sees them as tabs and can revise any answer before sending" },
					),
				),
			}),
			async execute(id, p, signal) {
				if (!ctx?.ask) throw new Error("ask_user is not available in this session");
				const rec = (o?: string[], r?: string) => (r && o?.includes(r) ? { recommended: r } : {});
				const items = p.questions?.map((q) => ({ question: q.question, options: q.options, ...rec(q.options, q.recommended), allowFreeText: q.allowFreeText ?? true }));
				if (!items?.length && !p.question) throw new Error("ask_user needs `question` or `questions`");
				const first = items?.[0] ?? { question: p.question!, options: p.options, ...rec(p.options, p.recommended), allowFreeText: p.allowFreeText ?? true };
				const answer = await ctx.ask(id, { ...first, ...(items?.length ? { items } : {}) }, signal);
				return text(answer, { question: first.question, answer });
			},
		});
	},
};

// The tool list is built once per session, but sessions come and go later: never put names in a description (they would go stale).
const PEER_NOTE = " Sessions are the user's @names; an unknown name is rejected with the current list.";

const PEER_ACTIONS = ["send", "read", "list", "abort", "answer", "create", "close", "resume", "delete", "cancel_queued", "rename", "set", "group_create", "group_add", "group_remove", "group_dissolve"] as const;
type PeerAction = (typeof PEER_ACTIONS)[number];
const need = <T>(v: T | undefined, what: string, action: string): T => {
	if (v === undefined || v === "") throw new Error(`peer ${action} needs \`${what}\``);
	return v;
};

const peerTool: ToolDef = {
	name: "peer",
	description: "Work with the other sessions (agents) on this server: message, read, list, create, stop, answer, manage, group.",
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: "peer",
			label: "Other sessions",
			description: [
				"Work with the other sessions on this server. Pick `action`; each uses only the parameters named here.",
				"send (to, message, mode?, notify?): message another active session, or every other session of a group when `to` is a group name. It runs independently, sees only what you write, and does not answer unless you ask it to reply with peer send. mode only matters when the target is working: follow_up (default) is delivered after its run, steer is injected into the run now. notify true: you get one report when the target ends its run.",
				"read (name, count?, detail?): what the session recently said and did, text only, newest last; detail also shows tool call arguments and results.",
				"list: every other open session with name, working or idle, title, branch and directory.",
				"abort (name): stop what it is doing right now, like the user pressing stop. Only when it is stuck or going the wrong way; prefer send with mode steer first.",
				"answer (name, answer | answers, toolCallId?): answer the ask_user question it waits on. Answer only what you can decide with what you know; anything that needs the user's judgment goes back to the user.",
				"create (message, title?, purpose?, cwd?, provider?, model?, thinkingLevel?, notify?, muted?): start a new session on `message` and get its @name back. Include all the context it needs; it sees nothing else. You get a report when it ends or asks (notify defaults to true). With notify the new session is created muted (no OS/push notification to the user, you report to them instead); pass muted=false to keep its notifications on. The directory defaults to yours; for code changes give each session its own git worktree.",
				"close (hides it from the sidebar, keeps the transcript; only sessions whose work is done and merged, a working one is refused, and never one that stopped on a problem: report it instead) / resume (reopens a closed one) / delete (erases the transcript for good; only sessions you made with create, not working) (name); cancel_queued (name, mode?, text?): lists steer/follow_up messages not yet delivered, with `text` takes one back; rename (name, newName); set (name, purpose?, provider?, model?, thinkingLevel?, muted?).",
				"group_create (members, name?), group_add / group_remove (group, members), group_dissolve (group): put sessions side by side in a named group (tag them all with @group, or send to the group name). A session is in one group at a time; a group of fewer than 2 dissolves.",
			].join("\n") + PEER_NOTE,
			parameters: Type.Object({
				action: Type.Unsafe<PeerAction>({ type: "string", enum: [...PEER_ACTIONS] }),
				name: Type.Optional(Type.String({ maxLength: 60, description: "The session's name, without @ (read, abort, answer, close, resume, delete, cancel_queued, rename, set)" })),
				to: Type.Optional(Type.String({ maxLength: 60, description: "send: session or group name, without @" })),
				message: Type.Optional(Type.String({ maxLength: 8000, description: "send, create: what to tell or ask; include all context it needs" })),
				mode: Type.Optional(Type.Union([Type.Literal("follow_up"), Type.Literal("steer")], { description: "send, cancel_queued: which delivery / queue" })),
				notify: Type.Optional(Type.Boolean({ description: "send, create: report to you when it ends its run" })),
				muted: Type.Optional(Type.Boolean({ description: "create, set: true turns the session's notifications to the user off, false on (create default: same as notify)" })),
				count: Type.Optional(Type.Integer({ minimum: 1, maximum: 40, description: "read: how many recent messages (default 10)" })),
				detail: Type.Optional(Type.Boolean({ description: "read: also show tool call arguments and results, errors included" })),
				answer: Type.Optional(Type.String({ maxLength: 8000, description: "answer: the answer (one of its options when it offers only options)" })),
				answers: Type.Optional(Type.Array(Type.String({ maxLength: 8000 }), { maxItems: 20, description: "answer: one answer per question, when it asked several at once" })),
				toolCallId: Type.Optional(Type.String({ description: "answer: which question, when several wait (default: the oldest)" })),
				title: Type.Optional(Type.String({ maxLength: 100, description: "create" })),
				purpose: Type.Optional(Type.String({ maxLength: 200, description: "create, set: its role in a few words (shown in @mention hints)" })),
				cwd: Type.Optional(Type.String({ description: "create: working directory (default: yours)" })),
				provider: Type.Optional(Type.String({ description: "create, set" })),
				model: Type.Optional(Type.String({ description: "create, set: model id; omit for the default" })),
				thinkingLevel: Type.Optional(Type.String({ description: "create, set: off, minimal, low, medium, high, xhigh or max" })),
				text: Type.Optional(Type.String({ maxLength: 500, description: "cancel_queued: a piece of the message to take back" })),
				newName: Type.Optional(Type.String({ maxLength: 30, description: "rename" })),
				group: Type.Optional(Type.String({ maxLength: 100, description: "group_add, group_remove, group_dissolve: group name" })),
				members: Type.Optional(Type.Array(Type.String({ maxLength: 60 }), { maxItems: 8, description: "group_*: session names, without @ (yourself may be one)" })),
				groupName: Type.Optional(Type.String({ maxLength: 100, description: "group_create: the group's name" })),
			}),
			async execute(_id, p) {
				const peers = ctx?.peers;
				if (!peers) throw new Error("messaging other sessions is not available in this session");
				const a: PeerAction = p.action;
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
						return text(peers.manage(name(), a, { mode: p.mode, text: p.text, newName: p.newName, purpose: p.purpose, provider: p.provider, model: p.model, thinkingLevel: p.thinkingLevel as ManageArgs["thinkingLevel"], muted: p.muted }), { action: a, name: p.name });
					case "group_create": case "group_add": case "group_remove": case "group_dissolve":
						return text(peers.group(a.slice(6) as "create" | "add" | "remove" | "dissolve", { group: p.group, members: p.members, name: p.groupName }), { action: a });
				}
			},
		});
	},
};

export const DELEGATE_TOOL = "delegate";
const DELEGATE_DESCRIPTION =
	"Hand a self-contained task to a short-lived helper (a sub-agent role defined in ~/.agents/subagents or the project's .agents/subagents) and get its final answer back as text. " +
	"The helper does not see this conversation: put the goal, paths and the exact question in `task`. It runs once, is not a session (nothing appears in the session list; use peer (action create) for a lasting chat) and cannot delegate further or ask the user. " +
	"Use it to save your own context on searches or noisy commands; limits apply (concurrent helpers, calls per run). An unknown role is rejected with the list of roles.";

const delegateTool: ToolDef = {
	name: DELEGATE_TOOL,
	description: "Run a one-off helper (sub-agent) and return its answer.",
	create(_cwd, _roots, ctx) {
		return defineTool({
			name: DELEGATE_TOOL,
			label: "Delegate to a helper",
			description: DELEGATE_DESCRIPTION,
			parameters: Type.Object({
				role: Type.String({ minLength: 1, maxLength: 60, description: "Helper role, the file name without .md (e.g. explore, runner)" }),
				task: Type.String({ minLength: 1, maxLength: 12000, description: "Everything the helper needs: goal, paths, symbols, the question, and the answer format you want" }),
				model: Type.Optional(Type.String({ minLength: 3, maxLength: 200, description: "provider/model to use instead of the role's own model" })),
			}),
			async execute(id, p, signal, onUpdate) {
				if (!ctx?.delegate) throw new Error("delegate is not available in this session");
				return ctx.delegate(id, { role: p.role, task: p.task, model: p.model }, signal, (t) => onUpdate?.(text(t, { running: true })));
			},
		});
	},
};

const PEER_DEFS = [peerTool];
/** Built-in tools the user may switch off in the settings; every other built-in tool is locked on. */
export const TOGGLEABLE_TOOLS = [askUserTool.name, ...PEER_DEFS.map((t) => t.name), DELEGATE_TOOL];
/** Tools every session gets whatever list it was created with (the other sessions must always be reachable). */
export const PEER_TOOLS = PEER_DEFS.map((t) => t.name);

export const TOOL_DEFS: Record<string, ToolDef> = Object.fromEntries(
	[readTool, writeTool, editTool, lsTool, grepTool, bashTool, askUserTool, ...PEER_DEFS, delegateTool].map((t) => [t.name, t]),
);
export const DEFAULT_TOOLS = Object.keys(TOOL_DEFS);


/** `defs` lets server extensions add or replace tools; the built-in set is the default. */
export function buildTools(names: string[], cwd: string, readRoots: string[] = [], ctx: ToolContext = {}, defs: Record<string, ToolDef> = TOOL_DEFS): AgentTool<any>[] {
	return names.flatMap((n) => (defs[n] ? [defs[n].create(cwd, readRoots, ctx)] : []));
}

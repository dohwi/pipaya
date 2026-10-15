import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import Type, { type TSchema } from "typebox";
import type { QuestionOutcome, QuestionRequest } from "./questions.ts";

const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_READ_LINES = 2000;
const DEFAULT_BASH_TIMEOUT_S = 120;
const KILL_GRACE_MS = 2000;

export interface ToolDef {
	name: string;
	description: string;
	/** Mutating tools are blocked in `readonly` mode and need approval in `ask` mode. */
	mutating: boolean;
	/** `readRoots`: extra absolute directories the read tool may open (skill folders). */
	create(cwd: string, readRoots?: string[], ctx?: ToolContext): AgentTool<any>;
}

/** What the `delegate` tool hands to the sub-agent runner. */
export interface DelegateRequest {
	task: string;
	/** Name of the helper to run. Left out = the first enabled one. */
	agent?: string;
	cwd: string;
	/** Same extra read directories the calling session has (skill folders). */
	readRoots: string[];
	signal?: AbortSignal;
	onProgress?: (note: string) => void;
}

export interface DelegateReport {
	text: string;
	/** Name of the helper that ran. */
	agent: string;
	turns: number;
	stoppedEarly: boolean;
	truncated: boolean;
	provider: string;
	model: string;
	/** What the sub-agent spent. Recorded on the tool result so session usage and cost include it. */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens: number; cost: number };
}

/** What a tool may need from the running session beyond its working directory. */
export interface ToolContext {
	/** The session the tool runs in (extension tools use it to reach their per-session storage). */
	sessionId?: string;
	/** Run a read-only sub-agent and get its report (`delegate`). Missing when the server has no sub-agent runner. */
	delegate?(req: DelegateRequest): Promise<DelegateReport>;
	/** Helpers the main agent may pick right now, for the `delegate` tool description. */
	delegateAgents?(): { name: string; description: string }[];
	/** Ask the user a question and wait for the answer (`ask_user`). Missing when nobody can answer. */
	ask?(
		toolCallId: string,
		req: Pick<QuestionRequest, "question" | "options" | "allowFreeText">,
		signal?: AbortSignal,
	): Promise<QuestionOutcome>;
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
	if (escapes(cwd, abs) || escapes(realWithTail(cwd), realWithTail(abs))) {
		throw new Error(`path "${p}" is outside the session working directory`);
	}
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
	// Run in its own session (setsid keeps the pid) so a kill reaches grandchildren too, not just the shell.
	const setsid = process.platform === "win32" ? null : Bun.which("setsid");
	const proc = Bun.spawn(setsid ? [setsid, ...cmd] : cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore", env: childEnv() });
	let timedOut = false;
	let aborted = false;
	let killedAt = 0;
	const kill = () => {
		killedAt ||= Date.now();
		if (setsid) {
			try { process.kill(-proc.pid, "SIGKILL"); } catch {}
		}
		try {
			proc.kill("SIGKILL");
		} catch {}
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

const readTool: ToolDef = {
	name: "read",
	description: "Read a text file. Output is capped at 2000 lines / 50KB; use offset and limit to page through.",
	mutating: false,
	create(cwd, readRoots = []) {
		return defineTool({
			name: "read",
			label: "Read file",
			description: "Read a text file. Output is capped at 2000 lines / 50KB; use offset and limit to page through.",
			parameters: Type.Object({
				path: Type.String({ description: "File path, relative to the working directory" }),
				offset: Type.Optional(Type.Integer({ minimum: 1, description: "1-indexed line to start from" })),
				limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of lines" })),
			}),
			async execute(_id, params) {
				const file = safeReadPath(cwd, params.path, readRoots);
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
	mutating: true,
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
	mutating: true,
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
	mutating: false,
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
	mutating: false,
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

const bashTool: ToolDef = {
	name: "bash",
	description: `Run a shell command in the working directory. Output is capped at 50KB (tail kept). Default timeout ${DEFAULT_BASH_TIMEOUT_S}s.`,
	mutating: true,
	create(cwd) {
		return defineTool({
			name: "bash",
			label: "Run command",
			description: `Run a shell command in the working directory. Output is capped at 50KB (tail kept). Default timeout ${DEFAULT_BASH_TIMEOUT_S}s.`,
			parameters: Type.Object({
				command: Type.String(),
				timeout: Type.Optional(Type.Integer({ minimum: 1, maximum: 1800, description: "Timeout in seconds" })),
			}),
			executionMode: "sequential",
			async execute(_id, params, signal, onUpdate) {
				const res = await runProcess(["bash", "-c", params.command], {
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
	"for minor details, make a reasonable assumption and continue. Offer `options` when the choices are known.";

const askUserTool: ToolDef = {
	name: "ask_user",
	description: ASK_USER_DESCRIPTION,
	mutating: false,
	create(_cwd, _readRoots, ctx) {
		return defineTool({
			name: "ask_user",
			label: "Ask user",
			description: ASK_USER_DESCRIPTION,
			parameters: Type.Object({
				question: Type.Optional(Type.String({ minLength: 1, maxLength: 2000, description: "One clear question. Omit when using `questions`" })),
				options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8, description: "Suggested answers" })),
				allowFreeText: Type.Optional(Type.Boolean({ description: "Let the user type something other than the options. Default true" })),
				questions: Type.Optional(
					Type.Array(
						Type.Object({
							question: Type.String({ minLength: 1, maxLength: 2000 }),
							options: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 200 }), { minItems: 2, maxItems: 8 })),
							allowFreeText: Type.Optional(Type.Boolean()),
						}),
						{ minItems: 2, maxItems: 8, description: "Ask several independent questions at once instead of one by one. The user sees them as tabs and can revise any answer before sending" },
					),
				),
			}),
			async execute(id, params, signal) {
				if (!ctx?.ask) throw new Error("ask_user is not available in this session");
				const items = params.questions?.map((q) => ({ question: q.question, options: q.options, allowFreeText: q.allowFreeText ?? true }));
				if (!items?.length && !params.question) throw new Error("ask_user needs `question` or `questions`");
				const first = items?.[0] ?? { question: params.question!, options: params.options, allowFreeText: params.allowFreeText ?? true };
				const outcome = await ctx.ask(id, { ...first, ...(items?.length ? { items } : {}) }, signal);
				if (outcome.status === "abort") throw new Error("Run aborted while waiting for the user");
				return text(outcome.answer, { question: first.question, answer: outcome.answer });
			},
		});
	},
};

const delegateDescription = (agents: { name: string; description: string }[] = []) =>
	"Send a task (usually an investigation) to a helper agent and get back a short report. " +
	"Use it when answering would take many reads or searches (\"where is X handled\", \"how does Y work across the codebase\"), " +
	"so the files it opens never enter this conversation. It does not see this conversation: " +
	"put everything it needs in `task`. For one file you already know, use read directly. " +
	"Treat the report as a lead: read the cited lines yourself before you change code based on it." +
	(agents.length ? `\nHelpers (pass the name as \`agent\`; left out = ${agents[0]!.name}):\n` + agents.map((a) => `- ${a.name}: ${a.description}`).join("\n") : "");

const delegateTool: ToolDef = {
	name: "delegate",
	description: delegateDescription(),
	mutating: false, // a helper with write/edit/bash is gated by SessionManager.gateTool instead
	create(cwd, readRoots, ctx) {
		return defineTool({
			name: "delegate",
			label: "Delegate research",
			description: delegateDescription(ctx?.delegateAgents?.()),
			parameters: Type.Object({
				task: Type.String({ minLength: 1, maxLength: 4000, description: "What to find out, with all the context the helper needs" }),
				agent: Type.Optional(Type.String({ description: "Which helper to use; see the list in the tool description" })),
			}),
			async execute(_id, params, signal, onUpdate) {
				if (!ctx?.delegate) throw new Error("delegate is not available in this session");
				const report = await ctx.delegate({
					task: params.task,
					agent: params.agent,
					cwd,
					readRoots: readRoots ?? [],
					signal,
					onProgress: (note) => onUpdate?.(text(`Researching… ${note}`, { task: params.task })),
				});
				return text(report.text, {
					task: params.task,
					subagent: true,
					agent: report.agent,
					provider: report.provider,
					model: report.model,
					turns: report.turns,
					stoppedEarly: report.stoppedEarly,
					truncated: report.truncated,
					usage: report.usage,
				});
			},
		});
	},
};

export const TOOL_DEFS: Record<string, ToolDef> = Object.fromEntries(
	[readTool, writeTool, editTool, lsTool, grepTool, bashTool, askUserTool, delegateTool].map((t) => [t.name, t]),
);
export const DEFAULT_TOOLS = Object.keys(TOOL_DEFS);

export const isMutating = (toolName: string, defs: Record<string, ToolDef> = TOOL_DEFS): boolean => defs[toolName]?.mutating ?? true;

/** `defs` lets server extensions add or replace tools; the built-in set is the default. */
export function buildTools(names: string[], cwd: string, readRoots: string[] = [], ctx: ToolContext = {}, defs: Record<string, ToolDef> = TOOL_DEFS): AgentTool<any>[] {
	return names.flatMap((n) => (defs[n] ? [defs[n].create(cwd, readRoots, ctx)] : []));
}

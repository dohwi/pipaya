import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { resolve } from "node:path";
import Type, { type Static } from "typebox";
import { badRequest, HttpError, notFound } from "./errors.ts";
import type { EventBus } from "./events.ts";
import { isInside } from "./tools.ts";

/**
 * Interactive shells on the server's own OS, shown in the client as panes next to conversations.
 *
 * Linux / macOS run the user's shell in a real pseudo-terminal (Bun's built-in PTY). Windows has no PTY in Bun, so the
 * shell (PowerShell by default) runs over plain pipes: the client echoes what is typed itself (`pty: false`).
 *
 * Terminals live in memory only: a server restart ends them. Every terminal keeps the tail of its output so a client
 * that (re)attaches sees the screen it left. Several clients may attach to one terminal at once.
 *
 * Ids start with `term_`, so they can share the group layout with session ids without ever clashing.
 */

export const TERMINAL_PREFIX = "term_";
export const isTerminalId = (id: string) => id.startsWith(TERMINAL_PREFIX);
export const MAX_TERMINALS = 16;
/** Output kept for re-attaching clients. */
export const SCROLLBACK_BYTES = 512 * 1024;

export const TerminalSchema = Type.Object({
	id: Type.String(),
	title: Type.String(),
	cwd: Type.String(),
	shell: Type.String({ description: "Executable path of the shell" }),
	pty: Type.Boolean({ description: "false: plain pipes (Windows), the client echoes input itself" }),
	pid: Type.Integer(),
	createdAt: Type.Integer({ description: "Unix ms" }),
});
export type TerminalInfo = Static<typeof TerminalSchema>;
export const TerminalList = Type.Object({ terminals: Type.Array(TerminalSchema) });
export const ShellSchema = Type.Object({ name: Type.String(), path: Type.String() });
export const TerminalSupport = Type.Object({
	enabled: Type.Boolean(),
	platform: Type.String({ description: "process.platform of the server: linux, darwin, win32, ..." }),
	pty: Type.Boolean(),
	shell: Type.Union([ShellSchema, Type.Null()], { description: "The default shell; null when none was found" }),
	shells: Type.Array(ShellSchema),
	max: Type.Integer(),
});
export const CreateTerminalBody = Type.Object({
	cwd: Type.Optional(Type.String({ description: "Absolute, or relative to the default working directory" })),
	shell: Type.Optional(Type.String({ description: "Path of one of the shells listed by GET /terminals/info" })),
	title: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
	cols: Type.Optional(Type.Integer({ minimum: 2, maximum: 1000 })),
	rows: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
});
export const PatchTerminalBody = Type.Object({ title: Type.String({ minLength: 1, maxLength: 100 }) });

type Shell = Static<typeof ShellSchema>;

/** Shells that exist on this machine, the preferred one first. */
export function detectShells(platform: NodeJS.Platform = process.platform, env: Record<string, string | undefined> = process.env, which: (cmd: string) => string | null = Bun.which): Shell[] {
	const out: Shell[] = [];
	const add = (name: string, path: string | null | undefined) => {
		if (path && !out.some((s) => s.path.toLowerCase() === path.toLowerCase())) out.push({ name, path });
	};
	if (platform === "win32") {
		add("PowerShell", which("pwsh"));
		add("Windows PowerShell", which("powershell"));
		add("Command Prompt", env.ComSpec && existsSync(env.ComSpec) ? env.ComSpec : which("cmd"));
		add("WSL", which("wsl"));
		return out;
	}
	if (env.SHELL && existsSync(env.SHELL)) add(leaf(env.SHELL), env.SHELL);
	for (const name of ["bash", "zsh", "fish", "sh"]) {
		const p = which(name);
		if (p) add(name, p);
	}
	return out;
}

/** Last path segment, for Windows and POSIX paths alike (the server may describe either). */
const leaf = (path: string) => path.split(/[\\/]/).pop() ?? path;

/** Arguments a shell is started with: a login shell on POSIX (so PATH matches a normal login), UTF-8 PowerShell on Windows. */
export function shellArgs(path: string, pty: boolean): string[] {
	const name = leaf(path).toLowerCase().replace(/\.exe$/, "");
	if (name === "pwsh" || name === "powershell") {
		const utf8 = "[Console]::InputEncoding=[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)";
		// Over pipes PowerShell reads commands from stdin without drawing a prompt of its own.
		return pty ? ["-NoLogo", "-NoExit", "-Command", utf8] : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "-"];
	}
	if (name === "cmd") return ["/Q", "/K", "chcp 65001>nul"];
	if (["bash", "zsh", "fish", "sh", "ksh", "dash"].includes(name)) return pty ? ["-l"] : ["-i"];
	return [];
}

/** The environment a shell gets: the server's own (the user's PATH, HOME, ...), minus every PIPAYA_* variable, with a terminal type xterm.js understands. */
export function shellEnv(source: Record<string, string | undefined> = process.env): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [k, v] of Object.entries(source)) {
		if (v === undefined) continue;
		if (k.startsWith("PIPAYA_")) continue; // like the agent's bash: nothing of the server's own configuration
		env[k] = v;
	}
	env.TERM = "xterm-256color";
	env.COLORTERM = "truecolor";
	env.TERM_PROGRAM = "pipaya";
	if (!env.LANG && process.platform !== "win32") env.LANG = "C.UTF-8";
	return env;
}

/** Fixed-size tail of a byte stream. */
export class Scrollback {
	private chunks: Uint8Array[] = [];
	private size = 0;
	constructor(private max = SCROLLBACK_BYTES) {}
	push(data: Uint8Array) {
		if (!data.length) return;
		this.chunks.push(data);
		this.size += data.length;
		while (this.size > this.max && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
		if (this.size > this.max) {
			const only = this.chunks[0]!;
			this.chunks[0] = only.subarray(only.length - this.max);
			this.size = this.max;
		}
	}
	bytes(): Uint8Array {
		const out = new Uint8Array(this.size);
		let at = 0;
		for (const c of this.chunks) (out.set(c, at), (at += c.length));
		return out;
	}
}

export interface TerminalClient {
	output(data: Uint8Array): void;
	exit(code: number | null): void;
}

interface Live {
	info: TerminalInfo;
	/** The user named it: the title no longer follows what runs in it. */
	named: boolean;
	/** The last title the shell set itself (OSC 0 / 2), if it ever did. */
	oscTitle: string | null;
	/** Bytes of an escape sequence split across output chunks. */
	oscCarry: string;
	proc: Bun.Subprocess;
	scrollback: Scrollback;
	clients: Set<TerminalClient>;
	write(data: string): void;
	resize(cols: number, rows: number): void;
	closed: boolean;
}

export interface TerminalOptions {
	enabled: boolean;
	defaultWorkdir: () => string;
	/** Set: a terminal may only start inside it. */
	confineTo?: string;
	platform?: NodeJS.Platform;
	shells?: Shell[];
}

export class TerminalManager {
	private live = new Map<string, Live>();
	private titleTimer: ReturnType<typeof setInterval> | null = null;
	private readonly platform: NodeJS.Platform;
	readonly shells: Shell[];
	readonly pty: boolean;

	constructor(
		private bus: EventBus,
		private opts: TerminalOptions,
	) {
		this.platform = opts.platform ?? process.platform;
		this.shells = opts.shells ?? detectShells(this.platform);
		this.pty = this.platform !== "win32";
	}

	support(): Static<typeof TerminalSupport> {
		return { enabled: this.opts.enabled, platform: this.platform, pty: this.pty, shell: this.shells[0] ?? null, shells: this.shells, max: MAX_TERMINALS };
	}

	has(id: string): boolean {
		return this.live.has(id);
	}

	list(): TerminalInfo[] {
		return [...this.live.values()].map((t) => t.info).sort((a, b) => a.createdAt - b.createdAt);
	}

	get(id: string): TerminalInfo {
		const t = this.live.get(id);
		if (!t) throw notFound("terminal");
		return t.info;
	}

	private resolveCwd(cwd?: string): string {
		const abs = resolve(this.opts.defaultWorkdir(), cwd?.trim() || ".");
		if (this.opts.confineTo && !isInside(this.opts.confineTo, abs)) throw badRequest(`cwd must be inside the workspace (${this.opts.confineTo}): ${abs}`);
		let dir = false;
		try {
			dir = statSync(abs).isDirectory();
		} catch {
			/* missing */
		}
		if (!dir) throw badRequest(`directory does not exist: ${abs}`);
		return abs;
	}

	create(input: Static<typeof CreateTerminalBody> = {}): TerminalInfo {
		if (!this.opts.enabled) throw new HttpError(403, "terminals_disabled", "terminals are turned off on this server (PIPAYA_TERMINAL=0)");
		if (this.live.size >= MAX_TERMINALS) throw new HttpError(409, "too_many_terminals", `at most ${MAX_TERMINALS} terminals can be open at once`);
		const shell = input.shell ? this.shells.find((s) => s.path === input.shell) : this.shells[0];
		if (!shell) throw badRequest(input.shell ? `unknown shell: ${input.shell}` : "no shell was found on this server");
		const cwd = this.resolveCwd(input.cwd);
		const id = TERMINAL_PREFIX + randomUUID();
		const cols = input.cols ?? 80;
		const rows = input.rows ?? 24;
		const scrollback = new Scrollback();
		const clients = new Set<TerminalClient>();
		const emit = (data: Uint8Array) => {
			scrollback.push(data);
			for (const c of clients) c.output(data);
			const t = this.live.get(id);
			if (t) this.readOsc(t, data);
		};
		const cmd = [shell.path, ...shellArgs(shell.path, this.pty)];
		const env = shellEnv();
		let live: Live;
		if (this.pty) {
			const proc = Bun.spawn(cmd, {
				cwd,
				env,
				terminal: { cols, rows, data: (_t, data) => emit(new Uint8Array(data)) },
			});
			live = {
				info: undefined as unknown as TerminalInfo,
				named: !!input.title?.trim(),
				oscTitle: null,
				oscCarry: "",
				proc,
				scrollback,
				clients,
				closed: false,
				write: (d) => proc.terminal?.write(d),
				resize: (c, r) => proc.terminal?.resize(c, r),
			};
		} else {
			// Windows: no PTY. Plain pipes, stderr merged into the same stream.
			const proc = Bun.spawn(cmd, { cwd, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
			const pump = async (stream: ReadableStream<Uint8Array>) => {
				for await (const chunk of stream) emit(normalizeNewlines(chunk));
			};
			void pump(proc.stdout).catch(() => {});
			void pump(proc.stderr).catch(() => {});
			live = {
				info: undefined as unknown as TerminalInfo,
				named: !!input.title?.trim(),
				oscTitle: null,
				oscCarry: "",
				proc,
				scrollback,
				clients,
				closed: false,
				write: (d) => {
					// xterm sends Enter as \r; a line-reading shell needs \r\n.
					proc.stdin.write(d.replace(/\r(?!\n)/g, "\r\n"));
					proc.stdin.flush();
				},
				resize: () => {},
			};
		}
		live.info = {
			id,
			title: input.title?.trim() || leaf(shell.path).replace(/\.exe$/i, ""),
			cwd,
			shell: shell.path,
			pty: this.pty,
			pid: live.proc.pid,
			createdAt: Date.now(),
		};
		this.live.set(id, live);
		void live.proc.exited.then((code) => this.finish(id, code));
		this.watchTitles();
		this.bus.publish(null, "terminal_created", live.info, { ephemeral: true });
		return live.info;
	}

	rename(id: string, title: string): TerminalInfo {
		const t = this.live.get(id);
		if (!t) throw notFound("terminal");
		t.info = { ...t.info, title: title.trim() || t.info.title };
		t.named = true;
		this.bus.publish(null, "terminal_updated", t.info, { ephemeral: true });
		return t.info;
	}

	/** Ends the shell (and what runs in it). The terminal disappears once the process has exited. */
	kill(id: string): void {
		const t = this.live.get(id);
		if (!t) throw notFound("terminal");
		this.stop(t);
	}

	private stop(t: Live) {
		try {
			t.proc.kill("SIGHUP");
		} catch {
			/* already gone */
		}
		const p = t.proc;
		setTimeout(() => {
			if (p.exitCode === null && p.signalCode === null) {
				try {
					p.kill("SIGKILL");
				} catch {
					/* gone */
				}
			}
		}, 2000).unref?.();
	}

	private finish(id: string, code: number | null) {
		const t = this.live.get(id);
		if (!t || t.closed) return;
		t.closed = true;
		this.live.delete(id);
		if (!this.live.size && this.titleTimer) (clearInterval(this.titleTimer), (this.titleTimer = null));
		try {
			t.proc.terminal?.close();
		} catch {
			/* already closed */
		}
		for (const c of t.clients) c.exit(code);
		t.clients.clear();
		this.bus.publish(null, "terminal_closed", { id, exitCode: code }, { ephemeral: true });
	}

	/** Attach a viewer: it gets the kept output at once, then everything new. */
	attach(id: string, client: TerminalClient): { info: TerminalInfo; scrollback: Uint8Array; detach(): void } {
		const t = this.live.get(id);
		if (!t) throw notFound("terminal");
		t.clients.add(client);
		return { info: t.info, scrollback: t.scrollback.bytes(), detach: () => t.clients.delete(client) };
	}

	write(id: string, data: string): void {
		this.live.get(id)?.write(data);
	}

	resize(id: string, cols: number, rows: number): void {
		if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 2 || rows < 1 || cols > 1000 || rows > 500) return;
		try {
			this.live.get(id)?.resize(cols, rows);
		} catch {
			/* closing */
		}
	}

	shutdown(): void {
		if (this.titleTimer) (clearInterval(this.titleTimer), (this.titleTimer = null));
		for (const t of this.live.values()) this.stop(t);
	}

	/* ---------- titles that follow what runs in the terminal ---------- */

	/** A title the shell sets itself (`ESC ] 0 ; title BEL`, as zsh / bash prompts and many programs do) wins. */
	private readOsc(t: Live, data: Uint8Array) {
		if (t.named) return;
		const text = t.oscCarry + new TextDecoder().decode(data);
		const { title, carry } = scanOscTitle(text);
		t.oscCarry = carry;
		if (title !== null) {
			t.oscTitle = title || null;
			this.retitle(t);
		}
	}

	private watchTitles() {
		if (this.titleTimer || this.platform !== "linux" || !this.pty) return;
		this.titleTimer = setInterval(() => {
			for (const t of this.live.values()) this.retitle(t);
		}, 1500);
		this.titleTimer.unref?.();
	}

	private retitle(t: Live) {
		if (t.named || t.closed) return;
		const shell = leaf(t.info.shell).replace(/\.exe$/i, "");
		const fg = this.platform === "linux" && this.pty ? foreground(t.proc.pid) : null;
		const title = autoTitle({ shell, osc: t.oscTitle, fg, shellPid: t.proc.pid });
		if (title === t.info.title) return;
		t.info = { ...t.info, title };
		this.bus.publish(null, "terminal_updated", t.info, { ephemeral: true });
	}
}

/** Pipe output uses bare \n; xterm needs \r\n to return to the line start. */
function normalizeNewlines(chunk: Uint8Array): Uint8Array {
	let extra = 0;
	for (let i = 0; i < chunk.length; i++) if (chunk[i] === 10 && (i === 0 || chunk[i - 1] !== 13)) extra++;
	if (!extra) return chunk;
	const out = new Uint8Array(chunk.length + extra);
	let j = 0;
	for (let i = 0; i < chunk.length; i++) {
		if (chunk[i] === 10 && (i === 0 || chunk[i - 1] !== 13)) out[j++] = 13;
		out[j++] = chunk[i]!;
	}
	return out;
}

/**
 * The last window title set in `text` (OSC 0 or 2, ended by BEL or ESC \\), or null when none; `carry` is an unfinished
 * sequence at the end, to be prefixed to the next chunk.
 */
export function scanOscTitle(text: string): { title: string | null; carry: string } {
	let title: string | null = null;
	const re = /\x1b\]([02]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g;
	let end = 0;
	for (let m = re.exec(text); m; m = re.exec(text)) {
		title = m[2]!.trim().slice(0, 100);
		end = re.lastIndex;
	}
	const open = text.lastIndexOf("\x1b]");
	const carry = open >= end && text.length - open < 512 ? text.slice(open) : "";
	return { title, carry };
}

/** What runs in the foreground of a terminal (Linux, from /proc): the process, its command line and folder. */
export interface Foreground {
	pid: number;
	argv: string[];
	cwd: string | null;
}

/** The foreground process group leader of the shell's terminal, read from /proc. null when it cannot be read. */
export function foreground(shellPid: number, proc = "/proc"): Foreground | null {
	try {
		const stat = readFileSync(`${proc}/${shellPid}/stat`, "utf8");
		// the command name may hold spaces and parentheses: fields start after the last ")"
		const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
		const tpgid = Number(fields[5]); // field 8 of stat
		const pid = tpgid > 0 ? tpgid : shellPid;
		const argv = readFileSync(`${proc}/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
		let cwd: string | null = null;
		try {
			cwd = readlinkSync(`${proc}/${pid}/cwd`);
		} catch {
			/* another user's process */
		}
		return { pid, argv, cwd };
	} catch {
		return null;
	}
}

/**
 * The title a terminal shows when the user has not named it: what the shell said (OSC), else the program in the
 * foreground with its first arguments (`vim notes.md`, `bun run dev`), else the shell and the folder it is in.
 */
export function autoTitle(x: { shell: string; osc: string | null; fg: Foreground | null; shellPid: number }): string {
	if (x.osc) return x.osc;
	const fg = x.fg;
	const folder = fg?.cwd ? (fg.cwd === "/" ? "/" : leaf(fg.cwd)) : null;
	if (!fg || fg.pid === x.shellPid || !fg.argv.length) return folder ? `${x.shell} · ${folder}` : x.shell;
	const [cmd, ...args] = fg.argv;
	const shown = [leaf(cmd!).replace(/^-/, ""), ...args.filter((a) => !a.startsWith("-")).slice(0, 2).map((a) => (a.includes("/") ? leaf(a) : a))];
	return shown.join(" ").slice(0, 60);
}

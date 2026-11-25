import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import Type, { type Static } from "typebox";

/**
 * Built-in command guard for `bash` tool calls: refuses destructive or high-risk shell commands across toggleable rule
 * groups. Core protections (`wipe`, `disk`, `fork`, `permissions`, `systemPower`, `forcePush`) default to ON;
 * `remoteExec` defaults to OFF so package/CLI installer pipes work unless the user opts in.
 *
 * Every regex here runs on the agent's hot path, so patterns stay linear (no nested quantifiers over overlapping
 * character classes). Multi-condition rules split the command quote-aware into pipelines/segments first and test each
 * requirement independently on the command's argument tail instead of chaining `.*` wildcards.
 */

const BOUNDARY = String.raw`(?=\s|[;|&<>()\n]|$)`;
const UNQUOTED_BOUNDARY = String.raw`(?=\s|["';|&<>()\n]|$)`;
const FLAG_END = String.raw`(?=\s|["';|&<>()\n]|$)`;

function pathArg(pathPattern: string, prefixPattern?: string): RegExp {
	const quotedPrefix = prefixPattern
		? String.raw`|"(?:${prefixPattern})"\/+\*?${BOUNDARY}|'(?:${prefixPattern})'\/+\*?${BOUNDARY}`
		: "";
	return new RegExp(
		String.raw`(?:\s)(?:(?:${pathPattern})${UNQUOTED_BOUNDARY}|"(?:${pathPattern})"${BOUNDARY}|'(?:${pathPattern})'${BOUNDARY}${quotedPrefix})`,
	);
}

const HOME_DIR = String.raw`~|\$HOME|\$\{HOME\}`;
const SYS_DIR = String.raw`\/+(?:etc|usr|var|boot|bin|sbin|lib|lib64|sys|proc|dev)`;
const ROOT_HOME_PATH = String.raw`\/+\*?|(?:${HOME_DIR})(?:\/+\*?)?`;
const SYS_PATH = String.raw`(?:${SYS_DIR})(?:\/+\*?)?`;

const ROOT_HOME_ARG = pathArg(ROOT_HOME_PATH, HOME_DIR);
const SYS_DIR_ARG = pathArg(SYS_PATH, SYS_DIR);
const PROTECTED_ARG = pathArg(`${ROOT_HOME_PATH}|${SYS_PATH}`, `${HOME_DIR}|${SYS_DIR}`);

const RM_RECURSIVE = new RegExp(String.raw`(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)${FLAG_END}`);
const PERM_RECURSIVE = new RegExp(String.raw`(?:^|\s)(?:-[a-zA-Z]*R[a-zA-Z]*|--recursive)${FLAG_END}`);
const FORCE = new RegExp(String.raw`(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--force)${FLAG_END}`);
const NO_PRESERVE_ROOT = new RegExp(String.raw`(?:^|\s)--no-preserve-root(?:=\S+)?${FLAG_END}`);
const FIND_DELETE = new RegExp(String.raw`(?:^|\s)-delete${FLAG_END}`);
const SGDISK_ZAP = new RegExp(String.raw`(?:^|\s)(?:--zap-all|-[a-zA-Z]*Z[a-zA-Z]*)${FLAG_END}`);

const BLOCK_DEV = String.raw`\/dev\/(?:sd|nvme|hd|vd|xvd|r?disk|mmcblk|md(?:\d|\/|$|["'\s;|&<>()])|dm-)`;
const DD_BLOCK_OF = new RegExp(String.raw`(?:^|\s)of=["']?${BLOCK_DEV}`);
const TEE_BLOCK_TARGET = new RegExp(String.raw`\s["']?${BLOCK_DEV}`);
const REDIRECT_BLOCK_TARGET = new RegExp(String.raw`>{1,2}\s*\|?\s*["']?${BLOCK_DEV}`);

/** Anchors a command to the start of a segment (after optional subshell/control keywords, env assignments, sudo/doas/nohup, or path prefix). */
const CMD_PREFIX = String.raw`^\s*(?:(?:[({]|!(?=\s)|(?:then|do|else|elif|time|exec)(?=\s))\s*)*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|doas|command|nohup|setsid|env)\s+(?:-[uUg]\s+\S+\s+|-(?![uUg]\s)[A-Za-z0-9-]+\s+|[A-Za-z_]\w*=\S*\s+)*)*(?:\/(?:usr\/)?s?bin\/)?`;

const PIPE_TO_SHELL = /\|(?!\|)\s*(?:(?:sudo|doas)\s+(?:-[uUg]\s+\S+\s+|-(?![uUg]\s)\S+\s+)*|(?:\/usr\/bin\/)?env\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*)*(?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash|ash|ksh|fish)\b/;
const SUBST_REMOTE_EXEC = new RegExp(
	String.raw`${CMD_PREFIX}(?:(?:sh|bash|zsh|dash|ash|ksh|fish)\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c\s+["']?\$\(\s*(?:curl|wget)\b|(?:sh|bash|zsh|dash|ash|ksh|fish|source|\.)\s+<\(\s*(?:curl|wget)\b|eval\s+["']?\$\(\s*(?:curl|wget)\b)`,
);

const GIT_PUSH_CMD = new RegExp(String.raw`${CMD_PREFIX}git(?:\s+(?:-[Cc]\s+\S+|--[a-z-]+(?:=\S+)?|-(?![Cc]\s|-)[a-zA-Z0-9]+))*\s+push\b`);
const GIT_FORCE_FLAG = new RegExp(String.raw`(?:^|\s)(?:--force${FLAG_END}|-[uvqnd46]*f[uvqnd46]*${FLAG_END}|\+[A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?${FLAG_END})`);

const SHELL_C_WRAPPER = new RegExp(String.raw`${CMD_PREFIX}(?:ba|z|da|a|k)?sh\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c\s+`);
const EVAL_WRAPPER = new RegExp(String.raw`${CMD_PREFIX}eval\s+`);

export type GuardRuleGroup = "wipe" | "disk" | "fork" | "permissions" | "remoteExec" | "systemPower" | "forcePush";
export type GuardRuleScope = "segment" | "pipeline" | "command";

export interface GuardRule {
	group: GuardRuleGroup;
	scope?: GuardRuleScope;
	/** When true, test against the quote-masked form so benign quoted strings (e.g. `echo "..."`) do not match. */
	maskQuotes?: boolean;
	/** When true, keep quotes immediately following redirection operators (`>`, `>>`, `>|`) intact while masking other quotes. */
	keepRedirectQuotes?: boolean;
	re: RegExp;
	needs?: readonly RegExp[];
	why: string;
}

export const GUARD_RULES: readonly GuardRule[] = [
	// wipe (default ON)
	{ group: "wipe", re: new RegExp(String.raw`${CMD_PREFIX}rm\b`), needs: [RM_RECURSIVE, FORCE, ROOT_HOME_ARG], why: "deletes the whole disk or home directory" },
	{ group: "wipe", re: new RegExp(String.raw`${CMD_PREFIX}rm\b`), needs: [RM_RECURSIVE, FORCE, SYS_DIR_ARG], why: "deletes a top-level system directory" },
	{ group: "wipe", re: new RegExp(String.raw`${CMD_PREFIX}rm\b`), needs: [NO_PRESERVE_ROOT], why: "deletes the whole disk" },
	{ group: "wipe", re: new RegExp(String.raw`${CMD_PREFIX}find\b(?:\s+-[HLP])*${PROTECTED_ARG.source}`), needs: [FIND_DELETE], why: "deletes files recursively from root, home, or a system directory" },

	// disk (default ON)
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}mkfs(?:\.[\w-]+)?\b`), why: "formats a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}wipefs\b`), needs: [/\s\S/], why: "wipes filesystem signatures" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}blkdiscard\b`), needs: [/\s\S/], why: "discards blocks on a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}sgdisk\b`), needs: [SGDISK_ZAP], why: "zaps a disk partition table" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}dd\b`), needs: [DD_BLOCK_OF], why: "overwrites a disk" },
	{ group: "disk", keepRedirectQuotes: true, re: REDIRECT_BLOCK_TARGET, why: "overwrites a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}tee\b`), needs: [TEE_BLOCK_TARGET], why: "overwrites a disk" },

	// fork (default ON)
	{ group: "fork", scope: "command", maskQuotes: true, re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", maskQuotes: true, re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\(\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^)]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", maskQuotes: true, re: /\bfunction\s+([a-zA-Z_:][\w:]*)(?![\w:])\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },

	// permissions (default ON)
	{ group: "permissions", re: new RegExp(String.raw`${CMD_PREFIX}chmod\b`), needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes permissions of the whole disk, home, or a system directory" },
	{ group: "permissions", re: new RegExp(String.raw`${CMD_PREFIX}chown\b`), needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the owner of the whole disk, home, or a system directory" },
	{ group: "permissions", re: new RegExp(String.raw`${CMD_PREFIX}chgrp\b`), needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the group of the whole disk, home, or a system directory" },

	// remoteExec (default OFF)
	{ group: "remoteExec", scope: "pipeline", maskQuotes: true, re: new RegExp(String.raw`${CMD_PREFIX}(?:curl|wget)\b`), needs: [PIPE_TO_SHELL], why: "pipes a remote script directly into a shell" },
	{ group: "remoteExec", scope: "pipeline", re: SUBST_REMOTE_EXEC, why: "executes a remote script directly in a shell" },

	// systemPower (default ON)
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}(?:shutdown|reboot|poweroff|halt)\b`), why: "shuts down or reboots the system" },
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}systemctl\b(?:\s+-[A-Za-z0-9-]+)*\s+(?:poweroff|reboot|halt)\b`), why: "shuts down or reboots the system" },
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}(?:tel)?init\s+[06]${FLAG_END}`), why: "shuts down or reboots the system" },

	// forcePush (default ON)
	{ group: "forcePush", re: GIT_PUSH_CMD, needs: [GIT_FORCE_FLAG], why: "force-pushes git history" },
];

export const GUARD_GROUPS: readonly GuardRuleGroup[] = [
	"wipe",
	"disk",
	"fork",
	"permissions",
	"remoteExec",
	"systemPower",
	"forcePush",
];

const GROUP_DESCRIPTIONS = {
	wipe: "Block recursive forced rm or find -delete on /, ~, $HOME, or top-level system directories, plus rm --no-preserve-root",
	disk: "Block mkfs, wipefs, blkdiscard, sgdisk --zap-all, dd to raw block devices, and redirections/tee to block devices",
	fork: "Block shell fork bombs (classic :() and named self-recursive functions)",
	permissions: "Block recursive chmod/chown/chgrp on /, ~, $HOME, or top-level system directories",
	remoteExec: "Block piping curl/wget output directly into sh/bash or evaluating it inline",
	systemPower: "Block shutdown, reboot, poweroff, halt, systemctl poweroff/reboot/halt, and init 0/6",
	forcePush: "Block git push --force/-f while allowing --force-with-lease",
} as const;

export const GuardSettingsSchema = Type.Object(
	{
		wipe: Type.Boolean({ description: GROUP_DESCRIPTIONS.wipe }),
		disk: Type.Boolean({ description: GROUP_DESCRIPTIONS.disk }),
		fork: Type.Boolean({ description: GROUP_DESCRIPTIONS.fork }),
		permissions: Type.Boolean({ description: GROUP_DESCRIPTIONS.permissions }),
		remoteExec: Type.Boolean({ description: GROUP_DESCRIPTIONS.remoteExec }),
		systemPower: Type.Boolean({ description: GROUP_DESCRIPTIONS.systemPower }),
		forcePush: Type.Boolean({ description: GROUP_DESCRIPTIONS.forcePush }),
	},
	{ additionalProperties: false },
);
export type GuardSettingsValue = Static<typeof GuardSettingsSchema>;

/** Accepts partial or legacy 4-key payloads on `PUT /guard` while still rejecting unknown keys or non-booleans. */
export const GuardUpdateSchema = Type.Partial(GuardSettingsSchema, { additionalProperties: false });
export type GuardUpdateValue = Static<typeof GuardUpdateSchema>;

const DEFAULTS: Readonly<GuardSettingsValue> = {
	wipe: true,
	disk: true,
	fork: true,
	permissions: true,
	remoteExec: false,
	systemPower: true,
	forcePush: true,
};

export const DEFAULT_GUARD_SETTINGS = (): GuardSettingsValue => ({ ...DEFAULTS });

export const GuardInfoSchema = Type.Object({
	settings: GuardSettingsSchema,
	defaults: GuardSettingsSchema,
});

/**
 * Coerces a partial or legacy settings object into valid booleans:
 * - default-ON groups (`wipe`, `disk`, `fork`, `permissions`, `systemPower`, `forcePush`) stay ON unless explicitly `false`;
 * - default-OFF group (`remoteExec`) stays OFF unless explicitly `true`.
 */
export function normalizeGuardSettings(raw: unknown): GuardSettingsValue {
	const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		wipe: saved.wipe !== false,
		disk: saved.disk !== false,
		fork: saved.fork !== false,
		permissions: saved.permissions !== false,
		remoteExec: saved.remoteExec === true,
		systemPower: saved.systemPower !== false,
		forcePush: saved.forcePush !== false,
	};
}

/** Quote-aware O(N) splitter for shell pipelines (`\n`, `;`, `&&`, `||`) or segments (`|`, `&`). */
function splitShell(cmd: string, mode: "pipeline" | "segment"): string[] {
	const out: string[] = [];
	let start = 0;
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
			if (ch === '"') quote = null;
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }

		if (mode === "pipeline") {
			if (ch === "\n" || ch === ";") {
				out.push(cmd.slice(start, i));
				start = i + 1;
			} else if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
				out.push(cmd.slice(start, i));
				i++;
				start = i + 1;
			}
		} else {
			if (ch === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|") {
				out.push(cmd.slice(start, i));
				start = i + 1;
			} else if (ch === "&" && cmd[i + 1] !== "&" && cmd[i - 1] !== "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && cmd[i + 1] !== ">") {
				out.push(cmd.slice(start, i));
				start = i + 1;
			}
		}
	}
	out.push(cmd.slice(start));
	return out;
}

/** Replace quoted string contents with empty quotes (`''` / `""`) in O(N); optionally preserves quotes right after redirections. */
function maskQuotedStrings(s: string, keepRedirectQuotes = false): string {
	let out = "";
	let i = 0;
	while (i < s.length) {
		const ch = s[i]!;
		if (ch === "\\" && i + 1 < s.length) {
			out += ch + s[i + 1]!;
			i += 2;
			continue;
		}
		if (ch === "'" || ch === '"') {
			const q = ch;
			const keep = keepRedirectQuotes && />\s*\|?\s*$/.test(out);
			let j = i + 1;
			while (j < s.length) {
				if (q === '"' && s[j] === "\\" && j + 1 < s.length) { j += 2; continue; }
				if (s[j] === q) { j++; break; }
				j++;
			}
			out += keep ? s.slice(i, j) : q + q;
			i = j;
			continue;
		}
		out += ch;
		i++;
	}
	return out;
}

/** Unquote one leading shell argument (single-quoted, double-quoted, or bare) from `s`. */
function readShellArg(s: string): string | null {
	const trimmed = s.trimStart();
	if (!trimmed) return null;
	const q = trimmed[0]!;
	if (q === "'") {
		const end = trimmed.indexOf("'", 1);
		return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
	}
	if (q === '"') {
		let res = "";
		for (let i = 1; i < trimmed.length; i++) {
			if (trimmed[i] === "\\" && i + 1 < trimmed.length) {
				res += trimmed[i + 1]!;
				i++;
				continue;
			}
			if (trimmed[i] === '"') return res;
			res += trimmed[i]!;
		}
		return res;
	}
	const sp = trimmed.search(/\s/);
	return sp === -1 ? trimmed : trimmed.slice(0, sp);
}

/** Extract `$(...)` and `` `...` `` command substitutions (outside single quotes) for recursive guard checking. */
function extractSubstitutions(cmd: string): string[] {
	const found: string[] = [];
	let quote: "'" | '"' | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
		if (quote === null && ch === "'") { quote = "'"; continue; }
		if (ch === '"') { quote = quote === '"' ? null : '"'; continue; }

		if (ch === "$" && cmd[i + 1] === "(") {
			let depth = 1;
			let j = i + 2;
			let innerQuote: "'" | '"' | null = null;
			while (j < cmd.length && depth > 0) {
				const c = cmd[j]!;
				if (innerQuote === "'") { if (c === "'") innerQuote = null; }
				else if (innerQuote === '"') { if (c === "\\" && j + 1 < cmd.length) j++; else if (c === '"') innerQuote = null; }
				else if (c === "\\" && j + 1 < cmd.length) { j++; }
				else if (c === "'" || c === '"') { innerQuote = c; }
				else if (c === "(") { depth++; }
				else if (c === ")") { depth--; }
				j++;
			}
			if (depth === 0) {
				found.push(cmd.slice(i + 2, j - 1));
				i = j - 1;
			}
		} else if (ch === "`") {
			let j = i + 1;
			while (j < cmd.length && cmd[j] !== "`") {
				if (cmd[j] === "\\" && j + 1 < cmd.length) j++;
				j++;
			}
			if (j < cmd.length) {
				found.push(cmd.slice(i + 1, j));
				i = j;
			}
		}
	}
	return found;
}

function matchesRule(rule: GuardRule, target: string): boolean {
	const s = rule.maskQuotes ? maskQuotedStrings(target) : rule.keepRedirectQuotes ? maskQuotedStrings(target, true) : target;
	const m = rule.re.exec(s);
	if (!m) return false;
	if (!rule.needs?.length) return true;
	const rest = s.slice(m.index + m[0].length);
	return rule.needs.every((need) => need.test(rest));
}

function checkCommand(command: string, groups: Partial<Record<GuardRuleGroup, boolean>>, depth: number): string | null {
	let pipelines: string[] | undefined;
	let segments: string[] | undefined;

	for (const rule of GUARD_RULES) {
		const enabled = groups[rule.group] ?? DEFAULTS[rule.group];
		if (!enabled) continue;
		const scope = rule.scope ?? "segment";
		if (scope === "command") {
			if (matchesRule(rule, command)) return rule.why;
			continue;
		}
		pipelines ??= splitShell(command, "pipeline");
		if (scope === "pipeline") {
			if (pipelines.some((p) => matchesRule(rule, p))) return rule.why;
			continue;
		}
		segments ??= pipelines.flatMap((p) => splitShell(p, "segment"));
		if (segments.some((s) => matchesRule(rule, s))) return rule.why;
	}

	if (depth >= 4) return null;

	// Recursively inspect `sh -c "..."`, `bash -c '...'`, `eval "..."` payloads.
	pipelines ??= splitShell(command, "pipeline");
	segments ??= pipelines.flatMap((p) => splitShell(p, "segment"));
	for (const seg of segments) {
		const m = SHELL_C_WRAPPER.exec(seg) ?? EVAL_WRAPPER.exec(seg);
		if (m) {
			const payload = readShellArg(seg.slice(m.index + m[0].length));
			if (payload) {
				const inner = checkCommand(payload, groups, depth + 1);
				if (inner) return inner;
			}
		}
	}

	// Recursively inspect `$(...)` and backtick command substitutions outside single quotes.
	for (const sub of extractSubstitutions(command)) {
		const inner = checkCommand(sub, groups, depth + 1);
		if (inner) return inner;
	}

	return null;
}

/** Returns the refusal reason if `command` matches an enabled rule, or `null` when allowed. */
export function guardRefusal(command: string, groups: Partial<Record<GuardRuleGroup, boolean>> = DEFAULTS): string | null {
	return checkCommand(command, groups, 0);
}

const KEY = "guard";

export class GuardSettings {
	constructor(private db: Database, seedFile?: string) {
		if (seedFile && this.readRaw() === undefined && existsSync(seedFile)) {
			try {
				const parsed = JSON.parse(readFileSync(seedFile, "utf8"));
				this.set(normalizeGuardSettings(parsed));
			} catch { /* ignore unreadable seed file; defaults remain intact */ }
		}
	}

	private readRaw(): unknown {
		const row = this.db.query("SELECT data FROM settings WHERE key = $key").get({ key: KEY }) as { data: string } | null;
		if (!row) return undefined;
		try { return JSON.parse(row.data); } catch { return undefined; }
	}

	get(): GuardSettingsValue {
		const raw = this.readRaw();
		if (raw === undefined) return DEFAULT_GUARD_SETTINGS();
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return DEFAULT_GUARD_SETTINGS();
		return normalizeGuardSettings(raw);
	}

	set(value: Partial<GuardSettingsValue>): GuardSettingsValue {
		const next = normalizeGuardSettings({ ...this.get(), ...value });
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(next) });
		return this.get();
	}

	/** Checks a `bash` command string against live settings; fails closed if reading fails. */
	check(command: string): string | null {
		let groups: GuardSettingsValue;
		try {
			groups = this.get();
		} catch {
			groups = DEFAULT_GUARD_SETTINGS();
		}
		const why = guardRefusal(command, groups);
		return why ? `refused by guard: ${why}` : null;
	}
}

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
const SUBST_REMOTE_EXEC = /\b(?:(?:sh|bash|zsh|dash|ash|ksh|fish)\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c\s+(?:--\s+)?["']?\$\(\s*(?:curl|wget)\b|(?:sh|bash|zsh|dash|ash|ksh|fish|source|\.)\s+<\(\s*(?:curl|wget)\b|eval\s+["']?\$\(\s*(?:curl|wget)\b)/;
const SUBST_CURL_WGET = /\$\(\s*(?:curl|wget)\b/;

const GIT_PUSH_CMD = new RegExp(String.raw`${CMD_PREFIX}git(?:\s+(?:-[Cc]\s+\S+|--[a-z-]+(?:=\S+)?|-(?![Cc]\s|-)[a-zA-Z0-9]+))*\s+push\b`);
const GIT_FORCE_FLAG = new RegExp(String.raw`(?:^|\s)(?:--force${FLAG_END}|-[uvqnd46]*f[uvqnd46]*${FLAG_END}|\+[A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?${FLAG_END})`);

const SHELL_C_WRAPPER = /\b(?:(?:ba|z|da|a|k)?sh|fish)\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c(?:\s+--)?(?=\s)/;
const EVAL_WRAPPER = new RegExp(String.raw`${CMD_PREFIX}eval(?=\s)`);

const LEGACY_PIPELINE_SPLIT = /\n|;|\|\||&&/g;
const LEGACY_SEGMENT_SPLIT = /\||(?<![<>])&(?![>&])/g;

export type GuardRuleGroup = "wipe" | "disk" | "fork" | "permissions" | "remoteExec" | "systemPower" | "forcePush";
export type GuardRuleScope = "segment" | "pipeline" | "command";

export interface GuardRule {
	group: GuardRuleGroup;
	scope?: GuardRuleScope;
	/**
	 * - `"trigger"`: match `re` against a same-length quote-masked view (keeping quoted command-position tokens like `"rm"`),
	 *   then test `needs` on the original unmasked tail so `rm -rf "/"` and `dd of="/dev/dm-0"` stay blocked while `echo "rm -rf /"` is allowed.
	 * - `"all"`: match both `re` and `needs` against the quote-masked view (e.g. `fork`, `curl | sh`).
	 * - `"redirect"`: mask quotes except those immediately following `>` / `>>` / `>|`.
	 * - `"singleOnly"`: mask only single-quoted strings (preserving double-quoted `$(...)` for `remoteExec`).
	 */
	mask?: "trigger" | "all" | "redirect" | "singleOnly";
	re: RegExp;
	needs?: readonly RegExp[];
	why: string;
}

export const GUARD_RULES: readonly GuardRule[] = [
	// wipe (default ON) — unanchored triggers with quote-masked trigger matching so wrappers (`xargs`, `timeout`, `nice`, `"rm"`, `if`, ...) stay blocked while `echo "rm -rf /"` is allowed
	{ group: "wipe", mask: "trigger", re: /\brm\b/, needs: [RM_RECURSIVE, FORCE, ROOT_HOME_ARG], why: "deletes the whole disk or home directory" },
	{ group: "wipe", mask: "trigger", re: /\brm\b/, needs: [RM_RECURSIVE, FORCE, SYS_DIR_ARG], why: "deletes a top-level system directory" },
	{ group: "wipe", mask: "trigger", re: /\brm\b/, needs: [NO_PRESERVE_ROOT], why: "deletes the whole disk" },
	{ group: "wipe", mask: "trigger", re: /\bfind\b/, needs: [PROTECTED_ARG, FIND_DELETE], why: "deletes files recursively from root, home, or a system directory" },

	// disk (default ON)
	{ group: "disk", mask: "trigger", re: /\bmkfs(?:\.[\w-]+)?\b/, why: "formats a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}wipefs\b`), needs: [/\s\S/], why: "wipes filesystem signatures" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}blkdiscard\b`), needs: [/\s\S/], why: "discards blocks on a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}sgdisk\b`), needs: [SGDISK_ZAP], why: "zaps a disk partition table" },
	{ group: "disk", mask: "trigger", re: /\bdd\b/, needs: [DD_BLOCK_OF], why: "overwrites a disk" },
	{ group: "disk", mask: "redirect", re: REDIRECT_BLOCK_TARGET, why: "overwrites a disk" },
	{ group: "disk", mask: "trigger", re: /\btee\b/, needs: [TEE_BLOCK_TARGET], why: "overwrites a disk" },

	// fork (default ON)
	{ group: "fork", scope: "command", mask: "all", re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", mask: "all", re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\(\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^)]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", mask: "all", re: /\bfunction\s+([a-zA-Z_:][\w:]*)(?![\w:])\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },

	// permissions (default ON)
	{ group: "permissions", mask: "trigger", re: /\bchmod\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes permissions of the whole disk, home, or a system directory" },
	{ group: "permissions", mask: "trigger", re: /\bchown\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the owner of the whole disk, home, or a system directory" },
	{ group: "permissions", mask: "trigger", re: /\bchgrp\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the group of the whole disk, home, or a system directory" },

	// remoteExec (default OFF)
	{ group: "remoteExec", scope: "pipeline", mask: "all", re: /\b(?:curl|wget)\b/, needs: [PIPE_TO_SHELL], why: "pipes a remote script directly into a shell" },
	{ group: "remoteExec", scope: "pipeline", mask: "singleOnly", re: SUBST_CURL_WGET, needs: [PIPE_TO_SHELL], why: "pipes a remote script directly into a shell" },
	{ group: "remoteExec", scope: "pipeline", mask: "singleOnly", re: SUBST_REMOTE_EXEC, why: "executes a remote script directly in a shell" },

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

const isWordBoundaryBeforeHash = (s: string, i: number): boolean =>
	i === 0 || /[\s;|&<>()]/.test(s[i - 1]!);

interface HeredocSpec {
	delim: string;
	stripTabs: boolean;
}

/** Parse a heredoc operator at `i` (where `s[i] === "<" && s[i+1] === "<"` and `s[i+2] !== "<"`). Returns `{ spec, nextIndex }` or null. */
function parseHeredocOp(s: string, i: number): { spec: HeredocSpec; nextIndex: number } | null {
	if (s[i] !== "<" || s[i + 1] !== "<" || s[i + 2] === "<") return null;
	let j = i + 2;
	let stripTabs = false;
	if (s[j] === "-") { stripTabs = true; j++; }
	while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
	if (j >= s.length || s[j] === "\n") return null;
	let delim = "";
	const ch = s[j]!;
	if (ch === "'" || ch === '"') {
		j++;
		const start = j;
		while (j < s.length && s[j] !== ch && s[j] !== "\n") j++;
		delim = s.slice(start, j);
		if (s[j] === ch) j++;
	} else {
		const start = j;
		while (j < s.length && !/[\s;|&<>()\n]/.test(s[j]!)) {
			if (s[j] === "\\" && j + 1 < s.length) {
				delim += s[j + 1]!;
				j += 2;
			} else {
				delim += s[j]!;
				j++;
			}
		}
		if (!delim) delim = s.slice(start, j);
	}
	return delim ? { spec: { delim, stripTabs }, nextIndex: j } : null;
}

/** Skip heredoc bodies starting right after a newline at index `nlIndex`, returning the index of the next command line (or `s.length`). */
function skipHeredocBodies(s: string, nlIndex: number, queue: HeredocSpec[]): number {
	let pos = nlIndex + 1;
	while (queue.length > 0 && pos <= s.length) {
		const spec = queue.shift()!;
		while (pos <= s.length) {
			const nextNl = s.indexOf("\n", pos);
			const lineEnd = nextNl === -1 ? s.length : nextNl;
			let line = s.slice(pos, lineEnd);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (spec.stripTabs) line = line.replace(/^\t+/, "");
			pos = nextNl === -1 ? s.length + 1 : nextNl + 1;
			if (line === spec.delim) break;
		}
	}
	return Math.min(pos, s.length);
}

/** Quote-, comment-, `$'...'`-, and heredoc-aware O(N) splitter for shell pipelines or segments. */
function splitShell(cmd: string, mode: "pipeline" | "segment"): { parts: string[]; unclosedQuote: boolean } {
	const parts: string[] = [];
	let start = 0;
	let quote: "'" | '"' | "$'" | null = null;
	const heredocs: HeredocSpec[] = [];

	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote === "'") {
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === "$'") {
			if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
			if (ch === "'") quote = null;
			continue;
		}
		if (quote === '"') {
			if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
			if (ch === '"') quote = null;
			continue;
		}

		// Unquoted state
		if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
		if (ch === "#" && isWordBoundaryBeforeHash(cmd, i)) {
			const nl = cmd.indexOf("\n", i);
			i = nl === -1 ? cmd.length - 1 : nl - 1;
			continue;
		}
		if (ch === "$" && cmd[i + 1] === "'") { quote = "$'"; i++; continue; }
		if (ch === "'" || ch === '"') { quote = ch; continue; }
		if (ch === "<" && cmd[i + 1] === "<" && cmd[i + 2] !== "<") {
			const hd = parseHeredocOp(cmd, i);
			if (hd) {
				heredocs.push(hd.spec);
				i = hd.nextIndex - 1;
				continue;
			}
		}

		if (mode === "pipeline") {
			if (ch === "\n") {
				parts.push(cmd.slice(start, i));
				if (heredocs.length > 0) {
					const afterBody = skipHeredocBodies(cmd, i, heredocs);
					start = afterBody;
					i = afterBody - 1;
				} else {
					start = i + 1;
				}
			} else if (ch === ";") {
				parts.push(cmd.slice(start, i));
				start = i + 1;
			} else if ((ch === "&" && cmd[i + 1] === "&") || (ch === "|" && cmd[i + 1] === "|")) {
				parts.push(cmd.slice(start, i));
				i++;
				start = i + 1;
			}
		} else {
			if (ch === "|" && cmd[i + 1] !== "|" && cmd[i - 1] !== "|") {
				parts.push(cmd.slice(start, i));
				start = i + 1;
			} else if (ch === "&" && cmd[i + 1] !== "&" && cmd[i - 1] !== "&" && cmd[i - 1] !== ">" && cmd[i - 1] !== "<" && cmd[i + 1] !== ">") {
				parts.push(cmd.slice(start, i));
				start = i + 1;
			}
		}
	}
	parts.push(cmd.slice(start));
	return { parts, unclosedQuote: quote !== null };
}

/**
 * Strictly O(N) quote-masking preserving exact string length (1-to-1 character indices with `s`).
 * - `"trigger"`: replaces quoted argument strings with spaces, EXCEPT single-word quoted command names at command position (e.g. `"rm"` → ` rm `).
 * - `"all"`: replaces all quoted strings and `#` comments with spaces.
 * - `"redirect"`: replaces all quoted strings with spaces EXCEPT quotes immediately after `>` / `>>` / `>|` (tracked in O(1)).
 * - `"singleOnly"`: replaces only single-quoted and `$'...'` strings with spaces (keeping double-quoted `$(...)` intact).
 */
function maskQuoted(s: string, mode: "trigger" | "all" | "redirect" | "singleOnly"): { masked: string; unclosedQuote: boolean } {
	const chunks: string[] = [];
	let i = 0;
	let unclosedQuote = false;
	let lastNonWs = "";
	let prevNonWs = "";
	let seenWord = false;
	const heredocs: HeredocSpec[] = [];

	const noteChar = (ch: string) => {
		if (ch !== " " && ch !== "\t" && ch !== "\r") {
			prevNonWs = lastNonWs;
			lastNonWs = ch;
		}
	};

	while (i < s.length) {
		const ch = s[i]!;
		if (ch === "\\" && i + 1 < s.length) {
			chunks.push(ch, s[i + 1]!);
			noteChar(ch);
			noteChar(s[i + 1]!);
			seenWord = true;
			i += 2;
			continue;
		}
		if (ch === "#" && isWordBoundaryBeforeHash(s, i)) {
			const nl = s.indexOf("\n", i);
			const end = nl === -1 ? s.length : nl;
			chunks.push(" ".repeat(end - i));
			i = end;
			continue;
		}
		if (ch === "\n") {
			chunks.push("\n");
			noteChar("\n");
			seenWord = false;
			if (heredocs.length > 0) {
				const afterBody = skipHeredocBodies(s, i, heredocs);
				if (afterBody > i + 1) chunks.push(" ".repeat(afterBody - (i + 1)));
				i = afterBody;
				continue;
			}
			i++;
			continue;
		}
		if (ch === "<" && s[i + 1] === "<" && s[i + 2] !== "<") {
			const hd = parseHeredocOp(s, i);
			if (hd) {
				heredocs.push(hd.spec);
				chunks.push(s.slice(i, hd.nextIndex));
				i = hd.nextIndex;
				continue;
			}
		}

		// ANSI-C quoting $'...'
		if (ch === "$" && s[i + 1] === "'") {
			let j = i + 2;
			let closed = false;
			while (j < s.length) {
				if (s[j] === "\\" && j + 1 < s.length) { j += 2; continue; }
				if (s[j] === "'") { j++; closed = true; break; }
				j++;
			}
			if (!closed) unclosedQuote = true;
			chunks.push(" ".repeat(j - i));
			noteChar("'");
			seenWord = true;
			i = j;
			continue;
		}

		if (ch === "'" || ch === '"') {
			const q = ch;
			let j = i + 1;
			let closed = false;
			while (j < s.length) {
				if (q === '"' && s[j] === "\\" && j + 1 < s.length) { j += 2; continue; }
				if (s[j] === q) { j++; closed = true; break; }
				j++;
			}
			if (!closed) unclosedQuote = true;
			const rawTok = s.slice(i, j);
			const inner = closed ? s.slice(i + 1, j - 1) : s.slice(i + 1);
			const afterRedirect = lastNonWs === ">" || (lastNonWs === "|" && prevNonWs === ">");

			if (mode === "singleOnly" && q === '"') {
				chunks.push(rawTok);
			} else if (mode === "redirect" && afterRedirect) {
				chunks.push(rawTok);
			} else if (mode === "trigger" && !seenWord && inner.length > 0 && !/\s/.test(inner)) {
				// Command-position single-word quoted executable (e.g. `"rm" -rf /` or `'/bin/rm' -rf /`): unmask with same length.
				chunks.push(" " + inner + (closed ? " " : ""));
			} else {
				chunks.push(" ".repeat(j - i));
			}
			noteChar(q);
			seenWord = true;
			i = j;
			continue;
		}

		if (ch === ";" || ch === "|" || ch === "&" || ch === "(" || ch === "{") {
			seenWord = false;
		} else if (ch !== " " && ch !== "\t" && ch !== "\r") {
			seenWord = true;
		}
		chunks.push(ch);
		noteChar(ch);
		i++;
	}
	return { masked: chunks.join(""), unclosedQuote };
}

/** Unquote one leading shell argument (single-quoted, `$'...'`, double-quoted, or bare) from `s`. */
function readShellArg(s: string): string | null {
	const trimmed = s.trimStart();
	if (!trimmed) return null;
	if (trimmed[0] === "$" && trimmed[1] === "'") {
		let res = "";
		for (let i = 2; i < trimmed.length; i++) {
			if (trimmed[i] === "\\" && i + 1 < trimmed.length) { res += trimmed[++i]!; continue; }
			if (trimmed[i] === "'") return res;
			res += trimmed[i]!;
		}
		return res;
	}
	const q = trimmed[0]!;
	if (q === "'") {
		const end = trimmed.indexOf("'", 1);
		return end === -1 ? trimmed.slice(1) : trimmed.slice(1, end);
	}
	if (q === '"') {
		let res = "";
		for (let i = 1; i < trimmed.length; i++) {
			if (trimmed[i] === "\\" && i + 1 < trimmed.length) { res += trimmed[++i]!; continue; }
			if (trimmed[i] === '"') return res;
			res += trimmed[i]!;
		}
		return res;
	}
	const sp = trimmed.search(/\s/);
	return sp === -1 ? trimmed : trimmed.slice(0, sp);
}

/** Extract `$(...)` and `` `...` `` command substitutions (outside single quotes and `#` comments) for recursive guard checking. */
function extractSubstitutions(cmd: string): string[] {
	const found: string[] = [];
	let quote: "'" | '"' | "$'" | null = null;
	for (let i = 0; i < cmd.length; i++) {
		const ch = cmd[i]!;
		if (quote === "'") { if (ch === "'") quote = null; continue; }
		if (quote === "$'") { if (ch === "\\" && i + 1 < cmd.length) i++; else if (ch === "'") quote = null; continue; }
		if (ch === "\\" && i + 1 < cmd.length) { i++; continue; }
		if (quote === null && ch === "#" && isWordBoundaryBeforeHash(cmd, i)) {
			const nl = cmd.indexOf("\n", i);
			i = nl === -1 ? cmd.length - 1 : nl - 1;
			continue;
		}
		if (quote === null && ch === "$" && cmd[i + 1] === "'") { quote = "$'"; i++; continue; }
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

function matchesRuleRaw(rule: GuardRule, target: string): boolean {
	const m = rule.re.exec(target);
	if (!m) return false;
	if (!rule.needs?.length) return true;
	const rest = target.slice(m.index + m[0].length);
	return rule.needs.every((need) => need.test(rest));
}

type MaskMode = "trigger" | "all" | "redirect" | "singleOnly";
type MaskResult = { masked: string; unclosedQuote: boolean };

function matchesRule(rule: GuardRule, target: string, getMasked: (s: string, mode: MaskMode) => MaskResult): boolean {
	if (!rule.mask) return matchesRuleRaw(rule, target);
	const { masked, unclosedQuote } = getMasked(target, rule.mask);
	if (rule.mask === "trigger") {
		const m = rule.re.exec(masked);
		if (m) {
			if (!rule.needs?.length) return true;
			const rest = target.slice(m.index + m[0].length);
			if (rule.needs.every((need) => need.test(rest))) return true;
		}
		// Fail closed if quote was unclosed
		return unclosedQuote ? matchesRuleRaw(rule, target) : false;
	}
	if (matchesRuleRaw(rule, masked)) return true;
	return unclosedQuote ? matchesRuleRaw(rule, target) : false;
}

/** Fail-closed fallback check using legacy raw splitting without quote masking (invoked only when an unclosed quote is detected). */
function checkRawFallback(command: string, groups: Partial<Record<GuardRuleGroup, boolean>>): string | null {
	let pipelines: string[] | undefined;
	let segments: string[] | undefined;
	for (const rule of GUARD_RULES) {
		const enabled = groups[rule.group] ?? DEFAULTS[rule.group];
		if (!enabled) continue;
		const scope = rule.scope ?? "segment";
		if (scope === "command") {
			if (matchesRuleRaw(rule, command)) return rule.why;
			continue;
		}
		pipelines ??= command.split(LEGACY_PIPELINE_SPLIT);
		if (scope === "pipeline") {
			if (pipelines.some((p) => matchesRuleRaw(rule, p))) return rule.why;
			continue;
		}
		segments ??= pipelines.flatMap((p) => p.split(LEGACY_SEGMENT_SPLIT));
		if (segments.some((s) => matchesRuleRaw(rule, s))) return rule.why;
	}
	return null;
}

function checkCommand(command: string, groups: Partial<Record<GuardRuleGroup, boolean>>, depth: number): string | null {
	let pipeSplit: { parts: string[]; unclosedQuote: boolean } | undefined;
	let segments: string[] | undefined;
	let anyUnclosed = false;

	const maskCache = new Map<string, Partial<Record<MaskMode, MaskResult>>>();
	const getMasked = (s: string, mode: MaskMode): MaskResult => {
		let entry = maskCache.get(s);
		if (!entry) {
			entry = {};
			maskCache.set(s, entry);
		}
		let res = entry[mode];
		if (!res) {
			res = maskQuoted(s, mode);
			entry[mode] = res;
		}
		return res;
	};

	for (const rule of GUARD_RULES) {
		const enabled = groups[rule.group] ?? DEFAULTS[rule.group];
		if (!enabled) continue;
		const scope = rule.scope ?? "segment";
		if (scope === "command") {
			if (matchesRule(rule, command, getMasked)) return rule.why;
			continue;
		}
		if (!pipeSplit) {
			pipeSplit = splitShell(command, "pipeline");
			if (pipeSplit.unclosedQuote) anyUnclosed = true;
		}
		if (scope === "pipeline") {
			if (pipeSplit.parts.some((p) => matchesRule(rule, p, getMasked))) return rule.why;
			continue;
		}
		if (!segments) {
			segments = pipeSplit.parts.flatMap((p) => {
				const s = splitShell(p, "segment");
				if (s.unclosedQuote) anyUnclosed = true;
				return s.parts;
			});
		}
		if (segments.some((s) => matchesRule(rule, s, getMasked))) return rule.why;
	}

	if (anyUnclosed) {
		const fallback = checkRawFallback(command, groups);
		if (fallback) return fallback;
	}

	if (depth >= 4) return null;

	// Recursively inspect `sh -c [--] "..."`, `bash -c`, `fish -c`, and `eval ...` payloads.
	pipeSplit ??= splitShell(command, "pipeline");
	segments ??= pipeSplit.parts.flatMap((p) => splitShell(p, "segment").parts);
	for (const seg of segments) {
		const { masked } = getMasked(seg, "trigger");
		const shMatch = SHELL_C_WRAPPER.exec(masked);
		if (shMatch) {
			const payload = readShellArg(seg.slice(shMatch.index + shMatch[0].length));
			if (payload) {
				const inner = checkCommand(payload, groups, depth + 1);
				if (inner) return inner;
			}
		}
		const evalMatch = EVAL_WRAPPER.exec(masked);
		if (evalMatch) {
			const tail = seg.slice(evalMatch.index + evalMatch[0].length).trim();
			if (tail) {
				// Check both the full remaining tail (for unquoted `eval rm -rf /`) and unquoted first arg (for `eval "rm -rf /"`).
				const innerTail = checkCommand(tail, groups, depth + 1);
				if (innerTail) return innerTail;
				const firstArg = readShellArg(tail);
				if (firstArg && firstArg !== tail) {
					const innerArg = checkCommand(firstArg, groups, depth + 1);
					if (innerArg) return innerArg;
				}
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

import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import Type, { type Static } from "typebox";

/**
 * Built-in command guard for `bash` tool calls: refuses destructive or high-risk shell commands across toggleable rule
 * groups. Core protections (`wipe`, `disk`, `fork`, `permissions`) default to ON; stricter operational protections
 * (`remoteExec`, `systemPower`, `forcePush`) default to OFF so users can opt in when needed.
 *
 * Every regex here runs on the agent's hot path, so patterns stay linear (no nested quantifiers over overlapping
 * character classes). Multi-condition rules split the command into pipelines/segments first and test each requirement
 * independently on the command's argument tail instead of chaining `.*` wildcards.
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

/** Anchors a command to the start of a segment (after optional env assignments, sudo/doas/nohup, or `sh -c "..."`). */
const CMD_PREFIX = String.raw`(?:^\s*[(\`]*|(?:ba|z|da|a|k)?sh\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c\s+["'])\s*(?:[A-Za-z_]\w*=\S*\s+)*(?:(?:sudo|doas|command|nohup|setsid)\s+(?:-[uUg]\s+\S+\s+|-(?![uUg]\s)[A-Za-z0-9-]+\s+)*)*(?:\/(?:usr\/)?s?bin\/)?`;

const PIPE_TO_SHELL = /\|(?!\|)\s*(?:(?:sudo|doas)\s+(?:-[uUg]\s+\S+\s+|-(?![uUg]\s)\S+\s+)*|(?:\/usr\/bin\/)?env\s+(?:-\S+\s+|[A-Za-z_]\w*=\S*\s+)*)*(?:\/[\w./-]*\/)?(?:sh|bash|zsh|dash|ash|ksh|fish)\b/;
const SUBST_REMOTE_EXEC = /\b(?:(?:sh|bash|zsh|dash|ash|ksh|fish)\s+(?:-[a-bd-zA-Z]+\s+)*-[a-zA-Z]*c\s+["']?\$\(\s*(?:curl|wget)\b|(?:sh|bash|zsh|dash|ash|ksh|fish|source|\.)\s+<\(\s*(?:curl|wget)\b|eval\s+["']?\$\(\s*(?:curl|wget)\b)/;

const GIT_PUSH_CMD = new RegExp(String.raw`${CMD_PREFIX}git(?:\s+(?:-[Cc]\s+\S+|--[a-z-]+(?:=\S+)?|-(?![Cc]\s|-)[a-zA-Z0-9]+))*\s+push\b`);
const GIT_FORCE_FLAG = new RegExp(String.raw`(?:^|\s)(?:--force${FLAG_END}|-[uvqnd46]*f[uvqnd46]*${FLAG_END}|\+[A-Za-z0-9_./-]+(?::[A-Za-z0-9_./-]+)?${FLAG_END})`);

const PIPELINE_SPLIT = /\n|;|\|\||&&/g;
const SEGMENT_SPLIT = /\||(?<![<>])&(?![>&])/g;

export type GuardRuleGroup = "wipe" | "disk" | "fork" | "permissions" | "remoteExec" | "systemPower" | "forcePush";
export type GuardRuleScope = "segment" | "pipeline" | "command";

export interface GuardRule {
	group: GuardRuleGroup;
	scope?: GuardRuleScope;
	re: RegExp;
	needs?: readonly RegExp[];
	why: string;
}

export const GUARD_RULES: readonly GuardRule[] = [
	// wipe (default ON)
	{ group: "wipe", re: /\brm\b/, needs: [RM_RECURSIVE, FORCE, ROOT_HOME_ARG], why: "deletes the whole disk or home directory" },
	{ group: "wipe", re: /\brm\b/, needs: [RM_RECURSIVE, FORCE, SYS_DIR_ARG], why: "deletes a top-level system directory" },
	{ group: "wipe", re: /\brm\b/, needs: [NO_PRESERVE_ROOT], why: "deletes the whole disk" },
	{ group: "wipe", re: new RegExp(String.raw`\bfind\b(?:\s+-[HLP])*${PROTECTED_ARG.source}`), needs: [FIND_DELETE], why: "deletes files recursively from root, home, or a system directory" },

	// disk (default ON)
	{ group: "disk", re: /\bmkfs(?:\.[\w-]+)?\b/, why: "formats a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}wipefs\b`), needs: [/\s\S/], why: "wipes filesystem signatures" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}blkdiscard\b`), needs: [/\s\S/], why: "discards blocks on a disk" },
	{ group: "disk", re: new RegExp(String.raw`${CMD_PREFIX}sgdisk\b`), needs: [SGDISK_ZAP], why: "zaps a disk partition table" },
	{ group: "disk", re: /\bdd\b/, needs: [DD_BLOCK_OF], why: "overwrites a disk" },
	{ group: "disk", re: REDIRECT_BLOCK_TARGET, why: "overwrites a disk" },
	{ group: "disk", re: /\btee\b/, needs: [TEE_BLOCK_TARGET], why: "overwrites a disk" },

	// fork (default ON)
	{ group: "fork", scope: "command", re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", re: /(?<![\w:])([a-zA-Z_:][\w:]*)(?![\w:])\s*\(\s*\)\s*\(\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^)]*&/, why: "fork bomb" },
	{ group: "fork", scope: "command", re: /\bfunction\s+([a-zA-Z_:][\w:]*)(?![\w:])\s*\{\s*\1(?![\w:])\s*\|\s*\1(?![\w:])[^}]*&/, why: "fork bomb" },

	// permissions (default ON)
	{ group: "permissions", re: /\bchmod\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes permissions of the whole disk, home, or a system directory" },
	{ group: "permissions", re: /\bchown\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the owner of the whole disk, home, or a system directory" },
	{ group: "permissions", re: /\bchgrp\b/, needs: [PERM_RECURSIVE, PROTECTED_ARG], why: "changes the group of the whole disk, home, or a system directory" },

	// remoteExec (default OFF)
	{ group: "remoteExec", scope: "pipeline", re: /\b(?:curl|wget)\b/, needs: [PIPE_TO_SHELL], why: "pipes a remote script directly into a shell" },
	{ group: "remoteExec", scope: "pipeline", re: SUBST_REMOTE_EXEC, why: "executes a remote script directly in a shell" },

	// systemPower (default OFF)
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}(?:shutdown|reboot|poweroff|halt)\b`), why: "shuts down or reboots the system" },
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}systemctl\b(?:\s+-[A-Za-z0-9-]+)*\s+(?:poweroff|reboot|halt)\b`), why: "shuts down or reboots the system" },
	{ group: "systemPower", re: new RegExp(String.raw`${CMD_PREFIX}(?:tel)?init\s+[06]${FLAG_END}`), why: "shuts down or reboots the system" },

	// forcePush (default OFF)
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
	systemPower: false,
	forcePush: false,
};

export const DEFAULT_GUARD_SETTINGS = (): GuardSettingsValue => ({ ...DEFAULTS });

export const GuardInfoSchema = Type.Object({
	settings: GuardSettingsSchema,
	defaults: GuardSettingsSchema,
});

/**
 * Coerces a partial or legacy settings object into valid booleans:
 * - default-ON groups (`wipe`, `disk`, `fork`, `permissions`) stay ON unless explicitly `false`;
 * - default-OFF groups (`remoteExec`, `systemPower`, `forcePush`) stay OFF unless explicitly `true`.
 */
export function normalizeGuardSettings(raw: unknown): GuardSettingsValue {
	const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		wipe: saved.wipe !== false,
		disk: saved.disk !== false,
		fork: saved.fork !== false,
		permissions: saved.permissions !== false,
		remoteExec: saved.remoteExec === true,
		systemPower: saved.systemPower === true,
		forcePush: saved.forcePush === true,
	};
}

function matchesRule(rule: GuardRule, target: string): boolean {
	const m = rule.re.exec(target);
	if (!m) return false;
	if (!rule.needs?.length) return true;
	const rest = target.slice(m.index + m[0].length);
	return rule.needs.every((need) => need.test(rest));
}

/** Returns the refusal reason if `command` matches an enabled rule, or `null` when allowed. */
export function guardRefusal(command: string, groups: Partial<Record<GuardRuleGroup, boolean>> = DEFAULTS): string | null {
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
		pipelines ??= command.split(PIPELINE_SPLIT);
		if (scope === "pipeline") {
			if (pipelines.some((p) => matchesRule(rule, p))) return rule.why;
			continue;
		}
		segments ??= pipelines.flatMap((p) => p.split(SEGMENT_SPLIT));
		if (segments.some((s) => matchesRule(rule, s))) return rule.why;
	}
	return null;
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

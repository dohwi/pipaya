import type { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import Type, { type Static } from "typebox";
import Value from "typebox/value";

/**
 * Built-in command guard for `bash` tool calls: refuses destructive shell commands across four toggleable rule
 * groups (`wipe`, `disk`, `fork`, `permissions`), all enabled by default.
 *
 * Every regex here runs on the agent's hot path, so patterns stay linear (no nested quantifiers over overlapping
 * character classes). Multi-condition rules (`rm`/`chmod`/`chown`: root target + recursive/force flag) keep those
 * checks separate in `re` and `needs`.
 */

const ROOT = String.raw`(?:\/|\/\*|~|~\/|~\/\*|\$HOME|\$HOME\/\*?)`;
const RECURSIVE = /(?:^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const FORCE = /(?:^|\s)(?:-[a-zA-Z]*f[a-zA-Z]*|--force)(?=\s|$)/;
const ARGS = String.raw`[^;|&\n]*`;

export type GuardRuleGroup = "wipe" | "disk" | "fork" | "permissions";

export interface GuardRule {
	group: GuardRuleGroup;
	re: RegExp;
	needs?: readonly RegExp[];
	why: string;
}

export const GUARD_RULES: readonly GuardRule[] = [
	{ group: "wipe", re: new RegExp(String.raw`\brm\b${ARGS}\s["']?${ROOT}["']?(?:\s|;|&|\||$)`), needs: [RECURSIVE, FORCE], why: "deletes the whole disk or home directory" },
	{ group: "wipe", re: /\brm\s+.*--no-preserve-root\b/, why: "deletes the whole disk" },
	{ group: "disk", re: /\bmkfs(?:\.\w+)?\b/, why: "formats a disk" },
	{ group: "disk", re: /\bdd\b[^|;&]*\bof=\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)/, why: "overwrites a disk" },
	{ group: "disk", re: />\s*\/dev\/(?:sd|nvme|hd|vd|disk|mmcblk)\w*/, why: "overwrites a disk" },
	{ group: "fork", re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, why: "fork bomb" },
	{ group: "permissions", re: new RegExp(String.raw`\bchmod\b${ARGS}\s${ROOT}(?:\s|;|&|\||$)`), needs: [RECURSIVE], why: "changes permissions of the whole disk" },
	{ group: "permissions", re: new RegExp(String.raw`\bchown\b${ARGS}\s${ROOT}(?:\s|;|&|\||$)`), needs: [RECURSIVE], why: "changes the owner of the whole disk" },
];

export const GUARD_GROUPS: readonly GuardRuleGroup[] = ["wipe", "disk", "fork", "permissions"];

export const GuardSettingsSchema = Type.Object(
	{
		wipe: Type.Boolean({ description: "Block recursive forced rm on /, ~, or $HOME and rm --no-preserve-root" }),
		disk: Type.Boolean({ description: "Block mkfs, dd to raw block devices, and redirections to /dev/* disks" }),
		fork: Type.Boolean({ description: "Block classic shell fork bombs" }),
		permissions: Type.Boolean({ description: "Block recursive chmod/chown on /, ~, or $HOME" }),
	},
	{ additionalProperties: false },
);
export type GuardSettingsValue = Static<typeof GuardSettingsSchema>;

export const DEFAULT_GUARD_SETTINGS = (): GuardSettingsValue => ({
	wipe: true,
	disk: true,
	fork: true,
	permissions: true,
});

export const GuardInfoSchema = Type.Object({
	settings: GuardSettingsSchema,
	defaults: GuardSettingsSchema,
});

/** Coerces a partial or legacy settings object into valid booleans (only explicit `false` turns a group off). */
export function normalizeGuardSettings(raw: unknown): GuardSettingsValue {
	const saved = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
	return {
		wipe: saved.wipe !== false,
		disk: saved.disk !== false,
		fork: saved.fork !== false,
		permissions: saved.permissions !== false,
	};
}

/** Returns the refusal reason if `command` matches an enabled rule, or `null` when allowed. */
export function guardRefusal(command: string, groups: Partial<Record<GuardRuleGroup, boolean>> = DEFAULT_GUARD_SETTINGS()): string | null {
	for (const rule of GUARD_RULES) {
		if (groups[rule.group] === false) continue;
		if (!rule.re.test(command)) continue;
		if (rule.needs?.some((need) => !need.test(command))) continue;
		return rule.why;
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
			} catch { /* ignore unreadable seed file; defaults remain all on */ }
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
		const merged = { ...DEFAULT_GUARD_SETTINGS(), ...(typeof raw === "object" && raw !== null ? raw as object : {}) };
		return Value.Check(GuardSettingsSchema, merged) ? merged : DEFAULT_GUARD_SETTINGS();
	}

	set(value: GuardSettingsValue): GuardSettingsValue {
		this.db.query("INSERT INTO settings (key, data) VALUES ($key, $data) ON CONFLICT(key) DO UPDATE SET data = $data").run({ key: KEY, data: JSON.stringify(value) });
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

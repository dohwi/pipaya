import type { Database } from "bun:sqlite";
import { HttpError, badRequest } from "./errors.ts";

/**
 * Client settings that belong to THIS server: every client connected to it sees the same value.
 * Anything a device decides for itself (theme, shortcuts, sound, language, sidebar, server list and tokens)
 * is deliberately absent and stays on the device.
 */
export const SERVER_SCOPED_KEYS = ["favModels", "extensions", "extensionStates", "notificationPolicy"] as const;
export type ClientSettingKey = (typeof SERVER_SCOPED_KEYS)[number];
/**
 * Per-key cap in characters of JSON. Extensions carry code and design files (a package is at most 1 MiB, client
 * MAX_PACKAGE_BYTES): the list as a whole stays under the request body limit.
 */
export const MAX_SETTING_CHARS: Record<ClientSettingKey, number> = { favModels: 100_000, extensions: 15_000_000, extensionStates: 20_000, notificationPolicy: 1_000 };

/** Minutes a notification shown on a PC may stay unread before it is also pushed to the phone; 0 = never. */
export const ESCALATE_MINUTES = [0, 1, 2, 3, 5, 10, 15, 30, 60] as const;
export const DEFAULT_ESCALATE_MINUTES = 3;
/** Keys the server itself acts on are checked here, so a client cannot store something the server cannot honour. */
const VALIDATORS: Partial<Record<ClientSettingKey, (value: unknown) => string | null>> = {
	extensionStates: (v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return "extensionStates must be an object";
		return Object.values(v).every((x) => typeof x === "boolean") ? null : "extensionStates values must be booleans";
	},
	notificationPolicy: (v) => {
		if (!v || typeof v !== "object" || Array.isArray(v)) return "notificationPolicy must be an object";
		const keys = Object.keys(v);
		if (keys.some((k) => k !== "escalateMinutes")) return "notificationPolicy only has escalateMinutes";
		const m = (v as { escalateMinutes?: unknown }).escalateMinutes;
		return (ESCALATE_MINUTES as readonly unknown[]).includes(m) ? null : `escalateMinutes must be one of ${ESCALATE_MINUTES.join(", ")}`;
	},
};
export const MAX_SETTING_BODY = 16 * 1024 * 1024;

export interface StoredSetting {
	value: unknown;
	updatedAt: number;
}
export interface WriteResult extends StoredSetting {
	/** false when a newer value was already stored; the caller should adopt the returned one */
	applied: boolean;
}

export const isServerScopedKey = (key: string): key is ClientSettingKey => (SERVER_SCOPED_KEYS as readonly string[]).includes(key);

export class ClientSettings {
	constructor(private db: Database) {}

	/** The escalation wait the server applies, in ms (0 = off) */
	escalateMs(): number {
		const v = this.get("notificationPolicy")?.value as { escalateMinutes?: unknown } | undefined;
		const m = (ESCALATE_MINUTES as readonly unknown[]).includes(v?.escalateMinutes) ? (v!.escalateMinutes as number) : DEFAULT_ESCALATE_MINUTES;
		return m * 60_000;
	}

	private check(key: string): ClientSettingKey {
		if (!isServerScopedKey(key)) throw badRequest(`"${key}" is not a server-scoped setting`);
		return key;
	}

	list(): Record<string, StoredSetting> {
		const rows = this.db.query("SELECT key, data, updated_at FROM client_settings ORDER BY key").all() as { key: string; data: string; updated_at: number }[];
		const out: Record<string, StoredSetting> = {};
		for (const r of rows) if (isServerScopedKey(r.key)) out[r.key] = { value: JSON.parse(r.data), updatedAt: r.updated_at };
		return out;
	}

	get(key: string): StoredSetting | undefined {
		this.check(key);
		const r = this.db.query("SELECT data, updated_at FROM client_settings WHERE key = $key").get({ key }) as { data: string; updated_at: number } | null;
		return r ? { value: JSON.parse(r.data), updatedAt: r.updated_at } : undefined;
	}

	/**
	 * Last write wins. `at` is when the user made the change on their device (offline edits keep their time);
	 * a write older than what is stored is not applied. Equal times: the incoming write wins, so a resend is harmless.
	 */
	put(key: string, value: unknown, at: number | undefined, now = Date.now()): WriteResult {
		this.check(key);
		const problem = VALIDATORS[key as ClientSettingKey]?.(value);
		if (problem) throw badRequest(problem);
		const json = JSON.stringify(value ?? null);
		const max = MAX_SETTING_CHARS[key as ClientSettingKey];
		if (json.length > max) throw new HttpError(413, "payload_too_large", `setting exceeds ${max} characters of JSON`);
		const stamp = Math.min(at ?? now, now); // a device clock in the future must not pin the key forever
		return this.db.transaction((): WriteResult => {
			const cur = this.get(key);
			if (cur && cur.updatedAt > stamp) return { ...cur, applied: false };
			this.db.query("INSERT INTO client_settings (key, data, updated_at) VALUES ($key, $data, $at) ON CONFLICT(key) DO UPDATE SET data = $data, updated_at = $at").run({ key, data: json, at: stamp });
			return { value: JSON.parse(json), updatedAt: stamp, applied: true };
		})();
	}
}

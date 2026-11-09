import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { HttpError, badRequest, conflict } from "./errors.ts";

export type ExtensionSettingsValue = Record<string, unknown>;

/** A stored value and when the user made the change (Unix ms). */
export interface StoredExtensionSettings {
	value: ExtensionSettingsValue;
	updatedAt: number;
}
export interface ExtensionSaveResult extends StoredExtensionSettings {
	/** false when a newer value was already stored; the caller should adopt the returned one */
	applied: boolean;
}

/** Must accept exactly what the client's manifest validator accepts (client/src/lib/extensions/schema.ts `ID`), including one-word ids like `sync`. */
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const MAX_EXTENSION_ID_LENGTH = 80;
/** Lowercase words joined by single dashes: the id of a catalog entry and the `companion` an extension names. Stricter than the id a folder extension may use. */
export const CATALOG_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SETTINGS_CHARS = 16000;
export const MAX_EXTENSIONS = 100;

const FILE = "settings.json";
/** The timestamp of a value, kept next to the file so the file itself stays the plain object extensions read. */
const STAMP = "settings.at";

/** Names the client refuses too (they would collide with object internals in id-keyed maps). */
const RESERVED_IDS = new Set(["constructor", "prototype"]);

export const isValidExtensionId = (id: unknown): id is string =>
	typeof id === "string" && id.length <= MAX_EXTENSION_ID_LENGTH && EXTENSION_ID_PATTERN.test(id) && !RESERVED_IDS.has(id);

export const isPlainObject = (v: unknown): v is ExtensionSettingsValue => {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
	const proto = Object.getPrototypeOf(v);
	return proto === Object.prototype || proto === null;
};

/**
 * Generic per-extension settings: `<dataDir>/extensions/<id>/settings.json`.
 * The server never interprets the content; it only stores one plain JSON object per extension.
 */
export class ExtensionSettings {
	readonly root: string;

	constructor(dataDir: string) {
		this.root = resolve(dataDir, "extensions");
	}

	/** Validates the id first, then resolves the folder and asserts it stays inside the root. */
	private dir(id: string): string {
		if (!isValidExtensionId(id)) throw badRequest("invalid extension id");
		const dir = resolve(this.root, id);
		if (!dir.startsWith(this.root + sep) || resolve(dir, "..") !== this.root) throw badRequest("invalid extension id");
		return dir;
	}

	private readFile(file: string): ExtensionSettingsValue | undefined {
		try {
			const st = lstatSync(file);
			if (!st.isFile()) return undefined;
			// Anything bigger than the cap (even at 4 bytes/char, plus slack) cannot be a valid store.
			if (st.size > MAX_SETTINGS_CHARS * 4 + 1024) return {};
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			return isPlainObject(parsed) ? parsed : {};
		} catch (err) {
			return (err as NodeJS.ErrnoException)?.code === "ENOENT" ? undefined : {};
		}
	}

	/**
	 * When the stored value was written. A file from before timestamps existed has none: its own mtime is the closest
	 * truth, and it is older than any write made after the upgrade.
	 */
	private readStamp(dir: string, file: string): number {
		try {
			const at = Number.parseInt(readFileSync(join(dir, STAMP), "utf8"), 10);
			if (Number.isFinite(at) && at > 0) return at;
		} catch { /* no stamp yet */ }
		try {
			return Math.floor(statSync(file).mtimeMs);
		} catch {
			return 0;
		}
	}

	private writeStamp(dir: string, at: number): void {
		const tmp = join(dir, `.${STAMP}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, String(at), { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, join(dir, STAMP));
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
	}

	/** Map of every extension that has a settings file. Unreadable/corrupt files count as `{}`. */
	list(): Record<string, ExtensionSettingsValue> {
		const out: Record<string, ExtensionSettingsValue> = {};
		for (const [id, stored] of Object.entries(this.listStored())) out[id] = stored.value;
		return out;
	}

	/** `list()` with the time of each value, for clients that resolve conflicts themselves. */
	listStored(): Record<string, StoredExtensionSettings> {
		const out: Record<string, StoredExtensionSettings> = {};
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(this.root, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (!entry.isDirectory() || !isValidExtensionId(entry.name)) continue;
			const dir = this.dir(entry.name);
			const file = join(dir, FILE);
			const value = this.readFile(file);
			if (value) out[entry.name] = { value, updatedAt: this.readStamp(dir, file) };
		}
		return out;
	}

	get(id: string): ExtensionSettingsValue | undefined {
		return this.getStored(id)?.value;
	}

	getStored(id: string): StoredExtensionSettings | undefined {
		const dir = this.dir(id);
		const file = join(dir, FILE);
		const value = this.readFile(file);
		return value ? { value, updatedAt: this.readStamp(dir, file) } : undefined;
	}

	/**
	 * Last write wins by the time the user made the change: `at` is that time (an offline edit keeps its own), and a write
	 * older than what is stored is not applied. Equal times: the incoming write wins, so a resend is harmless.
	 * `now` is the server clock; a device clock in the future must not pin the value forever.
	 */
	save(id: string, settings: unknown, at?: number, now = Date.now()): ExtensionSaveResult {
		const dir = this.dir(id);
		if (!isPlainObject(settings)) throw badRequest("settings must be a JSON object");
		const json = JSON.stringify(settings);
		if (json.length > MAX_SETTINGS_CHARS) {
			throw new HttpError(413, "payload_too_large", `settings exceed ${MAX_SETTINGS_CHARS} characters of JSON`);
		}
		if (!existsSync(dir) && this.count() >= MAX_EXTENSIONS) {
			throw conflict(`at most ${MAX_EXTENSIONS} extensions can store settings`);
		}
		const stamp = Math.min(at ?? now, now);
		const current = this.getStored(id);
		if (current && current.updatedAt > stamp) return { ...current, applied: false };
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		chmodSync(dir, 0o700);
		const file = join(dir, FILE);
		const tmp = join(dir, `.${FILE}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, json, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, file);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
		this.writeStamp(dir, stamp);
		return { value: JSON.parse(json) as ExtensionSettingsValue, updatedAt: stamp, applied: true };
	}

	/**
	 * Removes the extension's settings. Idempotent. The folder goes too only when nothing else is in it: a server extension
	 * with the same id is installed in this very folder, and its code must survive.
	 */
	delete(id: string): void {
		const dir = this.dir(id);
		rmSync(join(dir, FILE), { force: true });
		rmSync(join(dir, STAMP), { force: true });
		try { if (readdirSync(dir).length === 0) rmSync(dir, { recursive: true, force: true }); } catch { /* no folder */ }
	}

	private count(): number {
		try {
			return readdirSync(this.root, { withFileTypes: true }).filter((e) => e.isDirectory() && isValidExtensionId(e.name)).length;
		} catch {
			return 0;
		}
	}
}

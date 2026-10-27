import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { HttpError, badRequest, conflict } from "./errors.ts";

export type ExtensionSettingsValue = Record<string, unknown>;

/** Must accept exactly what the client's manifest validator accepts (client/src/lib/extensions/schema.ts `ID`), including one-word ids like `sync`. */
export const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
export const MAX_EXTENSION_ID_LENGTH = 80;
/** Lowercase words joined by single dashes: the id of a catalog entry and the `companion` an extension names. Stricter than the id a folder extension may use. */
export const CATALOG_ID_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const MAX_SETTINGS_CHARS = 16000;
export const MAX_EXTENSIONS = 100;

const FILE = "settings.json";

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

	/** Map of every extension that has a settings file. Unreadable/corrupt files count as `{}`. */
	list(): Record<string, ExtensionSettingsValue> {
		const out: Record<string, ExtensionSettingsValue> = {};
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(this.root, { withFileTypes: true });
		} catch {
			return out;
		}
		for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
			if (!entry.isDirectory() || !isValidExtensionId(entry.name)) continue;
			const value = this.readFile(join(this.dir(entry.name), FILE));
			if (value) out[entry.name] = value;
		}
		return out;
	}

	get(id: string): ExtensionSettingsValue | undefined {
		return this.readFile(join(this.dir(id), FILE));
	}

	save(id: string, settings: unknown): ExtensionSettingsValue {
		const dir = this.dir(id);
		if (!isPlainObject(settings)) throw badRequest("settings must be a JSON object");
		const json = JSON.stringify(settings);
		if (json.length > MAX_SETTINGS_CHARS) {
			throw new HttpError(413, "payload_too_large", `settings exceed ${MAX_SETTINGS_CHARS} characters of JSON`);
		}
		if (!existsSync(dir) && this.count() >= MAX_EXTENSIONS) {
			throw conflict(`at most ${MAX_EXTENSIONS} extensions can store settings`);
		}
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
		return JSON.parse(json) as ExtensionSettingsValue;
	}

	/**
	 * Removes the extension's settings. Idempotent. The folder goes too only when nothing else is in it: a server extension
	 * with the same id is installed in this very folder, and its code must survive.
	 */
	delete(id: string): void {
		const dir = this.dir(id);
		rmSync(join(dir, FILE), { force: true });
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

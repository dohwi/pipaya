import { chmodSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join, resolve, sep } from "node:path";
import { HttpError, badRequest, conflict, notFound } from "./errors.ts";
import { isValidExtensionId } from "./extension-settings.ts";

/** Simple BCP 47 shape: `ja`, `pt-br`, `zh-hant-tw`. Stored lowercase; the pattern also keeps the tag safe as a file name. */
export const LOCALE_TAG_PATTERN = /^[a-z]{2,3}(?:-[a-z0-9]{2,8}){0,3}$/;
/** Languages the client ships with; a pack cannot replace them. */
export const BUILT_IN_LOCALES: readonly string[] = ["ko", "en"];
export const MAX_LOCALES = 20;
export const MAX_LOCALE_MESSAGES = 3000;
export const MAX_LOCALE_KEY_CHARS = 1000;
export const MAX_LOCALE_VALUE_CHARS = 2000;
export const MAX_LOCALE_NAME_CHARS = 60;
export const MAX_LOCALE_JSON_CHARS = 400_000;

export interface LocalePack {
	tag: string;
	/** Name in its own language (shown in the language picker), e.g. `日本語`. */
	name: string;
	/** Korean source string -> translation. The Korean text is the key the client looks up. */
	messages: Record<string, string>;
	/** Extension id that published the pack, if any. */
	owner?: string;
	updatedAt: number;
}
export type LocaleSummary = Omit<LocalePack, "messages"> & { messages: number };

/** Normalises a user-supplied tag, or throws a 400. */
export function normalizeLocaleTag(tag: unknown): string {
	const value = typeof tag === "string" ? tag.toLowerCase() : "";
	if (!LOCALE_TAG_PATTERN.test(value) || value.length > 35) throw badRequest("invalid locale tag (expected e.g. ja, pt-br)");
	return value;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/**
 * Language packs: `<dataDir>/locales/<tag>.json`.
 * The server stores and serves them; it never interprets the messages. Clients look strings up by the Korean source text.
 */
export class LocaleStore {
	readonly root: string;

	constructor(dataDir: string) {
		this.root = resolve(dataDir, "locales");
	}

	private file(tag: string): string {
		const file = resolve(this.root, `${normalizeLocaleTag(tag)}.json`);
		if (!file.startsWith(this.root + sep)) throw badRequest("invalid locale tag");
		return file;
	}

	private read(file: string): LocalePack | undefined {
		try {
			const st = lstatSync(file);
			if (!st.isFile() || st.size > MAX_LOCALE_JSON_CHARS * 4 + 1024) return undefined;
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			return isRecord(parsed) ? this.check(parsed, { fromDisk: true }) : undefined;
		} catch {
			return undefined; // missing or corrupt: treated as absent
		}
	}

	/** Validates a pack. `fromDisk` skips only the tag/updatedAt requirements the writer supplies. */
	private check(input: Record<string, unknown>, opts: { fromDisk?: boolean } = {}): LocalePack {
		const { name, messages, owner } = input;
		if (typeof name !== "string" || !name.trim() || name.length > MAX_LOCALE_NAME_CHARS) throw badRequest(`name must be 1-${MAX_LOCALE_NAME_CHARS} characters`);
		if (!isRecord(messages)) throw badRequest("messages must be an object of strings");
		const keys = Object.keys(messages);
		if (!keys.length) throw badRequest("messages must not be empty");
		if (keys.length > MAX_LOCALE_MESSAGES) throw new HttpError(413, "payload_too_large", `at most ${MAX_LOCALE_MESSAGES} messages`);
		const clean: Record<string, string> = {};
		for (const key of keys) {
			const value = messages[key];
			if (key === "__proto__" || !key || key.length > MAX_LOCALE_KEY_CHARS) throw badRequest("invalid message key");
			if (typeof value !== "string" || !value || value.length > MAX_LOCALE_VALUE_CHARS) throw badRequest(`message "${key.slice(0, 40)}" must be a string of 1-${MAX_LOCALE_VALUE_CHARS} characters`);
			clean[key] = value;
		}
		if (owner !== undefined && !isValidExtensionId(owner)) throw badRequest("owner must be an extension id");
		const tag = opts.fromDisk ? normalizeLocaleTag(input.tag) : "";
		const updatedAt = opts.fromDisk && Number.isInteger(input.updatedAt) ? (input.updatedAt as number) : 0;
		return { tag, name: name.trim(), messages: clean, ...(owner !== undefined ? { owner } : {}), updatedAt };
	}

	/** Every pack, without the messages. */
	list(): LocaleSummary[] {
		let names: string[];
		try {
			names = readdirSync(this.root);
		} catch {
			return [];
		}
		const out: LocaleSummary[] = [];
		for (const file of names.sort()) {
			if (!file.endsWith(".json") || !LOCALE_TAG_PATTERN.test(file.slice(0, -5))) continue;
			const pack = this.read(join(this.root, file));
			if (pack) out.push({ tag: pack.tag, name: pack.name, ...(pack.owner ? { owner: pack.owner } : {}), messages: Object.keys(pack.messages).length, updatedAt: pack.updatedAt });
		}
		return out;
	}

	get(tag: string): LocalePack {
		const pack = this.read(this.file(tag));
		if (!pack) throw notFound("locale");
		return pack;
	}

	/**
	 * Stores a pack. `changed` is false when the same content is already stored (the pack and its `updatedAt` are left alone),
	 * so an extension that publishes on every start does not make every client download it again.
	 * A pack published by an extension cannot be overwritten by a different extension.
	 */
	save(tag: string, input: unknown): { pack: LocalePack; changed: boolean } {
		const normalized = normalizeLocaleTag(tag);
		if (BUILT_IN_LOCALES.includes(normalized)) throw conflict(`"${normalized}" is built into the client and cannot be replaced`);
		if (!isRecord(input)) throw badRequest("body must be an object");
		const checked = this.check(input);
		const file = this.file(normalized);
		const existing = this.read(file);
		if (existing?.owner && checked.owner && existing.owner !== checked.owner) throw conflict(`"${normalized}" is published by extension "${existing.owner}"`);
		const same = (a: LocalePack) => JSON.stringify([a.name, a.owner, a.messages]) === JSON.stringify([checked.name, checked.owner, checked.messages]);
		if (existing && same(existing)) return { pack: existing, changed: false };
		const pack = { ...checked, tag: normalized, updatedAt: Math.max(Date.now(), (existing?.updatedAt ?? 0) + 1) };
		const json = JSON.stringify(pack);
		if (json.length > MAX_LOCALE_JSON_CHARS) throw new HttpError(413, "payload_too_large", `language pack exceeds ${MAX_LOCALE_JSON_CHARS} characters of JSON`);
		if (!existing && this.list().length >= MAX_LOCALES) throw conflict(`at most ${MAX_LOCALES} language packs can be stored`);
		mkdirSync(this.root, { recursive: true, mode: 0o700 });
		chmodSync(this.root, 0o700);
		const tmp = join(this.root, `.${normalized}.${randomBytes(6).toString("hex")}.tmp`);
		try {
			writeFileSync(tmp, json, { mode: 0o600 });
			chmodSync(tmp, 0o600);
			renameSync(tmp, file);
		} catch (err) {
			rmSync(tmp, { force: true });
			throw err;
		}
		return { pack, changed: true };
	}

	/**
	 * Idempotent. With `owner`, only a pack published by that extension is removed (an extension must not delete another's
	 * pack). Returns whether a pack was removed.
	 */
	delete(tag: string, owner?: string): boolean {
		const file = this.file(tag);
		const existing = this.read(file);
		if (!existing || (owner !== undefined && existing.owner !== owner)) return false;
		rmSync(file, { force: true });
		return true;
	}
}

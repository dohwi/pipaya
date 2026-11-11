/**
 * The one place that decides where a client extension's settings live.
 *
 *  - The server is the source of truth: `<dataDir>/extensions/<id>/settings.json`, shared by every client of that server.
 *  - `secret: true` fields (and keys that look like credentials) never leave the device. The host splits them out before a
 *    write and merges them back after a read, so an extension author cannot leak one by forgetting `settingsScope`.
 *  - `settingsScope: "local"` in the manifest, or the per-extension "이 기기에만" switch, keeps the whole object here.
 *  - A write carries the time the user made the change; the server refuses anything older than what it holds, so two
 *    devices editing at once cannot silently overwrite each other.
 */
import type { SettingField } from "./schema";

/** A stored value and when the user made the change (Unix ms). */
export interface StoredExtensionSettings {
	value: Record<string, unknown>;
	updatedAt: number;
}
export interface ExtensionSaveResult extends StoredExtensionSettings {
	/** false when a newer value was already stored; the caller should adopt the returned one */
	applied: boolean;
}

/**
 * Keys that are treated as credentials even without `secret: true`. The same list the configuration export uses, so a
 * value that never leaves the device in an export does not leave it over the wire either.
 */
const CREDENTIAL_KEY = /token|secret|password|credential|authorization|api.?key|cookie|private|constructor|prototype|__proto__/i;

/**
 * True when this field of the schema must stay on the device: a secret, a key that looks like a credential, or a field the
 * extension itself marked `device` (a local path, this machine's own setting).
 */
export const isDeviceOnlyField = (field: Pick<SettingField, "key" | "secret" | "device">): boolean =>
	field.secret === true || field.device === true || CREDENTIAL_KEY.test(field.key);

/**
 * Split the values that may be shared from the ones that stay here.
 * Without a schema nothing marks a key as secret, so the whole object is shared (the extension declared no secrets).
 */
export function splitSettings(
	settings: Record<string, unknown>,
	fields: readonly SettingField[] | undefined,
): { shared: Record<string, unknown>; local: Record<string, unknown> } {
	if (!fields?.length) return { shared: { ...settings }, local: {} };
	const deviceOnly = new Set(fields.filter(isDeviceOnlyField).map((f) => f.key));
	const shared: Record<string, unknown> = {};
	const local: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(settings)) (deviceOnly.has(key) ? local : shared)[key] = value;
	return { shared, local };
}

/**
 * The keys a settings form edits: the declared fields the extension does not write itself (`readonly`). Sent as `keys`
 * with a save, so the server replaces only these and keeps everything else (what the extension keeps for itself, a
 * status it wrote). `undefined` without a schema: the raw object is the form, and it replaces the whole value.
 */
export const formKeys = (fields: readonly SettingField[] | undefined): string[] | undefined =>
	fields?.length ? fields.filter((f) => !f.readonly).map((f) => f.key) : undefined;

/**
 * A form save replaces the keys the form edits and leaves the others as they were: a key the extension keeps for itself,
 * and a `readonly` value it wrote. `next` is the validated form result, `existing` what is stored now.
 */
export function keepUnowned(fields: readonly SettingField[] | undefined, existing: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
	if (!fields?.length) return next;
	const owned = new Set(formKeys(fields));
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(existing)) if (!owned.has(key)) out[key] = value;
	return { ...out, ...next };
}

/** `formKeys` of what a client extension shares with the server: its device-only fields (secrets, `device`) never leave the device. */
export const writableKeys = (fields: readonly SettingField[] | undefined): string[] | undefined =>
	formKeys(fields?.filter((f) => !isDeviceOnlyField(f)));

/** The object a client may show or send: `splitSettings(...).shared`. */
export const sharedSettings = (settings: Record<string, unknown>, fields: readonly SettingField[] | undefined): Record<string, unknown> =>
	splitSettings(settings, fields).shared;

/** Put the device-only values back on top of what the server returned. */
export const mergeSettings = (shared: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> => ({ ...shared, ...local });

/**
 * The time of a write that has not been confirmed yet. A per-key clock that only moves forward, so a quick second edit
 * still counts as newer than the first even when both happen inside the same millisecond.
 */
export class WriteClock {
	private last = new Map<string, number>();

	/** The stamp for a change made now: at least one millisecond after the previous one for this id. */
	next(id: string, now = Date.now()): number {
		const at = Math.max(now, (this.last.get(id) ?? 0) + 1);
		this.last.set(id, at);
		return at;
	}

	/** Adopt a time the server reported, so a later local edit is newer than it. */
	see(id: string, at: number) {
		if (Number.isFinite(at) && at > (this.last.get(id) ?? 0)) this.last.set(id, at);
	}

	forget(id: string) {
		this.last.delete(id);
	}
}

/** What this device knows about an id: the time of the value it holds, and whether that value is not on the server yet. */
export interface PendingWrite {
	at: number;
	dirty: boolean;
}

/** The little bit of `Storage` the bookkeeping needs; tests pass a Map-backed one. */
export interface ClockStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/** Durable bookkeeping of unconfirmed writes, one entry per extension id. */
export class PendingWrites {
	private map: Record<string, PendingWrite> = {};

	constructor(private storage: ClockStorage, private key: string) {
		try {
			const raw: unknown = JSON.parse(storage.getItem(key) ?? "{}");
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
					const p = v as Partial<PendingWrite> | undefined;
					if (p && typeof p.at === "number" && Number.isFinite(p.at)) this.map[id] = { at: p.at, dirty: p.dirty === true };
				}
			}
		} catch {
			/* unreadable bookkeeping: treated as "nothing pending" */
		}
	}

	get(id: string): PendingWrite | undefined {
		return this.map[id];
	}
	/** Remember a local edit that has not reached the server yet. */
	mark(id: string, at: number) {
		this.map[id] = { at, dirty: true };
		this.save();
	}
	/** The server took this value. */
	confirm(id: string, at: number) {
		this.map[id] = { at, dirty: false };
		this.save();
	}
	/** A value that came from the server: not a local edit, nothing to upload. */
	adopt(id: string, at: number) {
		this.map[id] = { at, dirty: false };
		this.save();
	}
	forget(id: string) {
		if (!(id in this.map)) return;
		delete this.map[id];
		this.save();
	}
	/** Ids whose latest value still has to reach the server. */
	pending(): string[] {
		return Object.entries(this.map).filter(([, v]) => v.dirty).map(([id]) => id);
	}
	clear() {
		this.map = {};
		this.save();
	}
	private save() {
		try {
			this.storage.setItem(this.key, JSON.stringify(this.map));
		} catch {
			/* best effort */
		}
	}
}

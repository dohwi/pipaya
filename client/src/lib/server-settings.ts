/**
 * Settings that belong to a SERVER: every client connected to that server shows the same value.
 * This engine keeps one local copy per server in step with `GET/PUT /client-settings/:key`:
 *
 *  - an edit is uploaded after a short debounce, so other devices see it within a second or so;
 *  - other devices hear about it on the event stream (`client_settings_updated`), no polling;
 *  - last write wins per key, by the time the user made the change (an offline edit keeps its time);
 *  - an edit that could not be uploaded stays marked and is retried on the next connect.
 *
 * It knows nothing about Svelte or the stores: the owner supplies one adapter per key.
 */

export type SyncKey = "favModels" | "extensions" | "notificationPolicy";
export const SYNC_KEYS: readonly SyncKey[] = ["favModels", "extensions", "notificationPolicy"];

export interface SyncAdapter {
	/** The local value to upload, or `undefined` when there is nothing worth uploading (an empty list on a fresh server). */
	read(): unknown;
	/** Show a value that came from the server. The engine does not treat anything done inside as a local edit. */
	apply(value: unknown): void;
}

export interface StoredSetting {
	value: unknown;
	updatedAt: number;
}
export interface WrittenSetting extends StoredSetting {
	applied: boolean;
}

export interface SyncApi {
	clientSettings(signal?: AbortSignal): Promise<{ settings: Record<string, StoredSetting> }>;
	clientSetting(key: string, signal?: AbortSignal): Promise<StoredSetting>;
	putClientSetting(key: string, value: unknown, at: number, origin: string, signal?: AbortSignal): Promise<WrittenSetting>;
}

/** The little bit of `Storage` the engine needs; tests pass a Map-backed one. */
export interface MetaStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

/**
 * What this device knows about a key. `at` is the time of the version it holds (the edit time while `dirty`).
 * `base` is the last time the server itself confirmed, so a "change" that turns out to be nothing can go back to it.
 */
interface Meta {
	at: number;
	dirty: boolean;
	base: number;
}

export interface SyncOptions {
	api: SyncApi;
	adapters: Partial<Record<SyncKey, SyncAdapter>>;
	storage: MetaStorage;
	/** Where the per-key bookkeeping lives, one per server */
	storageKey: string;
	/** This device's id, echoed in events so a device ignores its own writes */
	origin: string;
	now?: () => number;
	debounceMs?: number;
	/** How long a single request may take before it counts as failed */
	timeoutMs?: number;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export class ServerSettingsSync {
	private meta: Partial<Record<SyncKey, Meta>> = {};
	/** JSON of the value the server is known to hold, so a no-op edit (or the echo of what we just applied) is never uploaded */
	private known: Partial<Record<SyncKey, string>> = {};
	private timers = new Map<SyncKey, ReturnType<typeof setTimeout>>();
	private chains = new Map<SyncKey, Promise<void>>();
	private revs = new Map<SyncKey, number>();
	private applying = false;
	private dead = false;
	private readonly now: () => number;
	private readonly debounce: number;
	private readonly timeout: number;

	constructor(private o: SyncOptions) {
		this.now = o.now ?? Date.now;
		this.debounce = o.debounceMs ?? 400;
		this.timeout = o.timeoutMs ?? 8000;
		try {
			const raw: unknown = JSON.parse(o.storage.getItem(o.storageKey) ?? "{}");
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				for (const key of SYNC_KEYS) {
					const m = (raw as Record<string, unknown>)[key] as Partial<Meta> | undefined;
					if (m && typeof m.at === "number") this.meta[key] = { at: m.at, dirty: m.dirty === true, base: typeof m.base === "number" ? m.base : m.dirty === true ? 0 : m.at };
				}
			}
		} catch {
			/* unreadable bookkeeping: treated as "never synced" */
		}
	}

	private save() {
		try {
			this.o.storage.setItem(this.o.storageKey, JSON.stringify(this.meta));
		} catch {
			/* best effort */
		}
	}

	private adapter(key: string): SyncAdapter | undefined {
		return (SYNC_KEYS as readonly string[]).includes(key) ? this.o.adapters[key as SyncKey] : undefined;
	}

	private show(key: SyncKey, value: unknown) {
		const a = this.adapter(key);
		if (!a) return;
		this.applying = true;
		try {
			a.apply(value);
		} finally {
			this.applying = false;
		}
		this.known[key] = JSON.stringify(value);
	}

	private within<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T> {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		const deadline = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				controller.abort();
				reject(new Error("timeout"));
			}, this.timeout);
		});
		return Promise.race([task(controller.signal), deadline]).finally(() => clearTimeout(timer));
	}

	/** Run per key, one at a time, so an older upload can never land after a newer one. */
	private serial(key: SyncKey, job: () => Promise<void>): Promise<void> {
		const next = (this.chains.get(key) ?? Promise.resolve()).then(job, job);
		this.chains.set(key, next);
		// `.catch` on the copy only: the caller still sees the failure, the bookkeeping chain never reports an unhandled rejection
		void next
			.finally(() => {
				if (this.chains.get(key) === next) this.chains.delete(key);
			})
			.catch(() => {});
		return next;
	}

	/** The user changed `key` on this device. */
	changed(key: SyncKey) {
		if (this.dead || this.applying || !this.adapter(key)) return;
		this.revs.set(key, (this.revs.get(key) ?? 0) + 1);
		this.meta[key] = { at: this.now(), dirty: true, base: this.meta[key]?.base ?? 0 };
		this.save();
		clearTimeout(this.timers.get(key));
		this.timers.set(
			key,
			setTimeout(() => {
				this.timers.delete(key);
				void this.push(key).catch(() => {});
			}, this.debounce),
		);
	}

	/** Upload `key` now if it is marked as changed. Failures leave it marked; they are retried by `pull()`. */
	push(key: SyncKey): Promise<void> {
		return this.serial(key, async () => {
			const a = this.adapter(key);
			const m = this.meta[key];
			if (this.dead || !a || !m?.dirty) return;
			const value = a.read();
			if (value === undefined || same(value, this.known[key] === undefined ? undefined : JSON.parse(this.known[key]!))) {
				// nothing to say (or the server already holds exactly this): the mark can go
				if (value !== undefined) this.known[key] = JSON.stringify(value);
				this.meta[key] = { at: m.base, dirty: false, base: m.base };
				this.save();
				return;
			}
			const rev = this.revs.get(key) ?? 0;
			const res = await this.within((signal) => this.o.api.putClientSetting(key, value, m.at, this.o.origin, signal));
			if (this.dead) return;
			if (!res.applied) {
				// the server holds something newer than this edit: it wins
				this.meta[key] = { at: res.updatedAt, dirty: false, base: res.updatedAt };
				this.save();
				if (!same(res.value, value)) this.show(key, res.value);
				else this.known[key] = JSON.stringify(res.value);
				return;
			}
			this.known[key] = JSON.stringify(value);
			// edited again while the request was in flight: that newer edit has its own push scheduled and keeps the mark
			this.meta[key] = (this.revs.get(key) ?? 0) === rev ? { at: res.updatedAt, dirty: false, base: res.updatedAt } : { at: this.meta[key]?.at ?? res.updatedAt, dirty: true, base: res.updatedAt };
			this.save();
		});
	}

	/**
	 * On every (re)connect: take what the server has, send what only this device has.
	 * Throws when the server cannot be read, so the caller can leave the local copy alone.
	 */
	async pull(): Promise<void> {
		const { settings } = await this.within((signal) => this.o.api.clientSettings(signal));
		if (this.dead) return;
		const pushes: Promise<void>[] = [];
		for (const key of SYNC_KEYS) {
			const a = this.adapter(key);
			if (!a) continue;
			const remote = settings[key];
			const m = this.meta[key];
			if (remote) this.known[key] = JSON.stringify(remote.value);
			if (m?.dirty) {
				if (remote && remote.updatedAt > m.at) {
					this.show(key, remote.value); // someone else changed it later than our offline edit
					this.meta[key] = { at: remote.updatedAt, dirty: false, base: remote.updatedAt };
					this.save();
				} else pushes.push(this.push(key).catch(() => {}));
			} else if (remote) {
				if (!same(a.read(), remote.value)) this.show(key, remote.value);
				this.meta[key] = { at: remote.updatedAt, dirty: false, base: remote.updatedAt };
				this.save();
			} else if (a.read() !== undefined) {
				// first contact with this server: what this device already had becomes the server's value
				this.meta[key] = { at: this.now(), dirty: true, base: 0 };
				this.save();
				pushes.push(this.push(key).catch(() => {}));
			}
		}
		await Promise.all(pushes);
	}

	/** `client_settings_updated` from the event stream. */
	async onEvent(data: { key?: unknown; updatedAt?: unknown; origin?: unknown }): Promise<void> {
		const key = data.key;
		if (this.dead || typeof key !== "string" || !this.adapter(key) || data.origin === this.o.origin) return;
		const k = key as SyncKey;
		const seen = this.meta[k];
		if (typeof data.updatedAt === "number" && seen && !seen.dirty && data.updatedAt <= seen.at) return;
		const remote = await this.within((signal) => this.o.api.clientSetting(k, signal)).catch(() => null);
		if (!remote || this.dead) return;
		const m = this.meta[k];
		if (m?.dirty && m.at >= remote.updatedAt) return; // this device edited later; its upload wins
		if (m && !m.dirty && remote.updatedAt <= m.at) return;
		this.known[k] = JSON.stringify(remote.value);
		if (!same(this.adapter(k)!.read(), remote.value)) this.show(k, remote.value);
		this.meta[k] = { at: remote.updatedAt, dirty: false, base: remote.updatedAt };
		this.save();
	}

	/** Upload everything still marked (the app is going away or the user pressed "sync now"). */
	async flush(): Promise<void> {
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
		await Promise.all(SYNC_KEYS.map((key) => this.push(key).catch(() => {})));
	}

	dispose() {
		this.dead = true;
		for (const timer of this.timers.values()) clearTimeout(timer);
		this.timers.clear();
	}
}

/** One message's media on one server/session. Pending slots share the same download and URL. */
export class MediaUrls {
	private readonly entries = new Map<string, Promise<string>>();
	private readonly urls = new Set<string>();
	private readonly lifetime = new AbortController();

	get(path: string, load: (signal: AbortSignal) => Promise<Blob>): Promise<string> {
		const hit = this.entries.get(path);
		if (hit) return hit;
		const signal = this.lifetime.signal;
		const pending = Promise.resolve().then(() => {
			signal.throwIfAborted();
			return load(signal);
		}).then((blob) => {
			signal.throwIfAborted(); // even if the fetch ignored cancellation, don't create an orphan URL
			const url = URL.createObjectURL(blob);
			this.urls.add(url);
			return url;
		}).catch((e: unknown) => { this.entries.delete(path); throw e; });
		this.entries.set(path, pending);
		return pending;
	}

	dispose() {
		this.lifetime.abort();
		for (const url of this.urls) URL.revokeObjectURL(url);
		this.urls.clear();
		this.entries.clear();
	}
}

const DEFAULT_MAX_CACHED = 240;

interface InflightMedia {
	promise: Promise<string>;
	ctl: AbortController;
	/** Active abortable callers waiting on this fetch. When it reaches 0 and `pinned` is false, the fetch is aborted. */
	waiters: number;
	/** True when an unscoped caller (no signal, or prefetch) also requested this key. */
	pinned: boolean;
}

/**
 * App-wide LRU cache of `blob:` object URLs so switching tabs, remounting Markdown after a stream settles, or
 * revisiting a session never re-downloads images that were already fetched.
 */
export class SharedMediaCache {
	private readonly resolved = new Map<string, string>();
	private readonly inflight = new Map<string, InflightMedia>();

	constructor(private readonly maxEntries = DEFAULT_MAX_CACHED) {}

	/** Synchronously return an already-resolved `blob:` URL and bump its recency, or null. */
	peek(key: string): string | null {
		const url = this.resolved.get(key);
		if (!url) return null;
		this.resolved.delete(key);
		this.resolved.set(key, url);
		return url;
	}

	get(key: string, load: (signal: AbortSignal) => Promise<Blob>, signal?: AbortSignal): Promise<string> {
		const hit = this.peek(key);
		if (hit) return Promise.resolve(hit);
		if (signal?.aborted) return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
		let entry = this.inflight.get(key);
		if (!entry) {
			const ctl = new AbortController();
			const promise = Promise.resolve()
				.then(() => {
					ctl.signal.throwIfAborted();
					return load(ctl.signal);
				})
				.then(
					(blob) => {
						this.inflight.delete(key);
						ctl.signal.throwIfAborted();
						const url = URL.createObjectURL(blob);
						this.resolved.set(key, url);
						this.trim();
						return url;
					},
					(err: unknown) => {
						this.inflight.delete(key);
						throw err;
					},
				);
			// Prevent unhandled rejection if all waiters aborted and detached before the fetch rejects.
			promise.catch(() => {});
			entry = { promise, ctl, waiters: 0, pinned: false };
			this.inflight.set(key, entry);
		}
		if (!signal) {
			entry.pinned = true;
			return entry.promise;
		}
		const active = entry;
		active.waiters++;
		return new Promise<string>((resolve, reject) => {
			let settled = false;
			const onAbort = () => {
				if (settled) return;
				settled = true;
				active.waiters--;
				if (active.waiters <= 0 && !active.pinned) active.ctl.abort(signal.reason);
				reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			active.promise.then(
				(url) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					resolve(url);
				},
				(err) => {
					if (settled) return;
					settled = true;
					signal.removeEventListener("abort", onAbort);
					reject(err);
				},
			);
		});
	}

	/** Start fetching into the cache without throwing if it fails (used while a message is still streaming). */
	prefetch(key: string, load: (signal: AbortSignal) => Promise<Blob>): void {
		if (this.resolved.has(key) || this.inflight.has(key)) return;
		void this.get(key, load).catch(() => {});
	}

	private trim(): void {
		while (this.resolved.size > this.maxEntries) {
			const oldest = this.resolved.keys().next().value;
			if (oldest === undefined) break;
			const url = this.resolved.get(oldest)!;
			this.resolved.delete(oldest);
			URL.revokeObjectURL(url);
		}
	}

	dispose(): void {
		for (const entry of this.inflight.values()) entry.ctl.abort();
		for (const url of this.resolved.values()) URL.revokeObjectURL(url);
		this.resolved.clear();
		this.inflight.clear();
	}
}

export const sharedMedia = new SharedMediaCache();

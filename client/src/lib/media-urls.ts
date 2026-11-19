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

import { expect, spyOn, test } from "bun:test";
import { MediaUrls, SharedMediaCache } from "../src/lib/media-urls";

test("duplicate media slots share the download and revoke their URL exactly once", async () => {
	const cache = new MediaUrls(), revoke = spyOn(URL, "revokeObjectURL");
	try {
		let loads = 0;
		const read = async () => { loads++; return new Blob(["media"]); };
		const a = cache.get("same", read), b = cache.get("same", read);
		expect(a).toBe(b);
		const src = await a;
		expect(await cache.get("same", read)).toBe(src);
		expect(loads).toBe(1);
		cache.dispose(); cache.dispose();
		expect(revoke.mock.calls).toEqual([[src]]);
	} finally { revoke.mockRestore(); }
});

test("failed downloads retry, and late results after disposal create no URL", async () => {
	const cache = new MediaUrls();
	await expect(cache.get("file", () => { throw new Error("offline"); })).rejects.toThrow("offline");
	const gate = Promise.withResolvers<Blob>();
	let received: AbortSignal | undefined;
	const late = cache.get("file", (signal) => { received = signal; return gate.promise; });
	await Promise.resolve();
	cache.dispose();
	expect(received?.aborted).toBe(true);
	gate.resolve(new Blob());
	await expect(late).rejects.toHaveProperty("name", "AbortError");
});

test("SharedMediaCache reuses URLs across callers, touches LRU on peek, evicts oldest and retries failures", async () => {
	const cache = new SharedMediaCache(2);
	const revoke = spyOn(URL, "revokeObjectURL");
	try {
		let loads = 0;
		expect(cache.peek("a")).toBeNull();
		const p1 = cache.get("a", async () => { loads++; return new Blob(["a"]); });
		const p2 = cache.get("a", async () => { loads++; return new Blob(["a2"]); });
		expect(p1).toBe(p2);
		const urlA = await p1;
		expect(loads).toBe(1);
		expect(cache.peek("a")).toBe(urlA);

		const urlB = await cache.get("b", async () => new Blob(["b"]));
		// Touch "a" so "b" becomes the oldest entry before inserting "c".
		expect(cache.peek("a")).toBe(urlA);
		await cache.get("c", async () => new Blob(["c"]));
		expect(revoke.mock.calls).toEqual([[urlB]]);
		expect(cache.peek("b")).toBeNull();
		expect(cache.peek("a")).toBe(urlA);

		// Failed load does not poison the cache and prefetch swallows errors.
		cache.prefetch("err", async () => { throw new Error("boom"); });
		await Bun.sleep(0);
		expect(cache.peek("err")).toBeNull();
		const urlErr = await cache.get("err", async () => new Blob(["ok"]));
		expect(urlErr).toBeTruthy();

		cache.dispose();
	} finally { revoke.mockRestore(); }
});

test("SharedMediaCache aborts fetch when the only waiter cancels, and keeps going while another waiter remains", async () => {
	const cache = new SharedMediaCache(4);
	// Single caller aborts -> underlying fetch receives abort signal
	const gate1 = Promise.withResolvers<Blob>();
	let sig1: AbortSignal | undefined;
	const c1 = new AbortController();
	const p1 = cache.get("only", (s) => { sig1 = s; return gate1.promise; }, c1.signal);
	await Promise.resolve();
	expect(sig1?.aborted).toBe(false);
	c1.abort();
	await expect(p1).rejects.toHaveProperty("name", "AbortError");
	expect(sig1?.aborted).toBe(true);
	gate1.resolve(new Blob(["late"]));
	await Bun.sleep(0);
	expect(cache.peek("only")).toBeNull();

	// Two callers share one fetch: aborting caller A must not abort caller B
	const gate2 = Promise.withResolvers<Blob>();
	let sig2: AbortSignal | undefined;
	const ca = new AbortController();
	const cb = new AbortController();
	const pa = cache.get("shared", (s) => { sig2 = s; return gate2.promise; }, ca.signal);
	const pb = cache.get("shared", (s) => { sig2 = s; return gate2.promise; }, cb.signal);
	await Promise.resolve();
	ca.abort();
	await expect(pa).rejects.toHaveProperty("name", "AbortError");
	expect(sig2?.aborted).toBe(false);
	gate2.resolve(new Blob(["ok"]));
	expect(await pb).toBeTruthy();
	cache.dispose();
});

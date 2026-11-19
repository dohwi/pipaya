import { expect, spyOn, test } from "bun:test";
import { MediaUrls } from "../src/lib/media-urls";

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
